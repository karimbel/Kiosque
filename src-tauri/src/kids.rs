//! Sessions et mode enfant.
//!
//! Une session est une liste de chaînes choisies par un parent. Le mode enfant limite Kiosque à une session :
//! seules ses chaînes et leurs vidéos sont visibles, et tout ce qui sort du lecteur (ajout de chaîne, réglages,
//! liens externes, mise à jour) est refusé tant que le code du parent n'a pas été saisi.
//!
//! Ce n'est pas un contrôle parental du système : un enfant qui a un clavier peut quitter l'application.
//! Les données sont rangées dans la table `settings` (JSON), sans nouvelle table.

use crate::db::Db;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const SESSIONS_KEY: &str = "sessions";
const PIN_KEY: &str = "kid_pin";
const ACTIVE_KEY: &str = "kid_session";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub channels: Vec<String>,
}

#[derive(Serialize)]
pub struct KidStatus {
    pub active: bool,
    pub session_name: String,
    pub has_pin: bool,
}

// ---------- SHA-256 (pour ne pas stocker le code en clair) ----------

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2,
];

pub fn sha256_hex(data: &[u8]) -> String {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

// ---------- code du parent ----------

/// Quatre chiffres exactement.
pub fn valid_pin(pin: &str) -> bool {
    pin.len() == 4 && pin.chars().all(|c| c.is_ascii_digit())
}

fn salted(salt: &str, pin: &str) -> String {
    sha256_hex(format!("{salt}:{pin}").as_bytes())
}

/// « sel$empreinte » : le code n'est jamais enregistré en clair.
pub fn hash_pin(pin: &str, salt: &str) -> String {
    format!("{salt}${}", salted(salt, pin))
}

pub fn check_pin(stored: &str, pin: &str) -> bool {
    let Some((salt, hash)) = stored.split_once('$') else { return false };
    let candidate = salted(salt, pin);
    // Comparaison sur toute la longueur, sans s'arrêter au premier écart.
    candidate.len() == hash.len() && candidate.bytes().zip(hash.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Limite les essais : après 5 codes faux, 30 secondes d'attente.
pub struct Attempts {
    fails: u32,
    blocked_until: Option<Instant>,
}

impl Attempts {
    pub fn new() -> Self {
        Self { fails: 0, blocked_until: None }
    }

    /// Secondes d'attente restantes, ou 0 si un essai est possible.
    pub fn wait(&self) -> u64 {
        match self.blocked_until {
            Some(until) if until > Instant::now() => (until - Instant::now()).as_secs() + 1,
            _ => 0,
        }
    }

    pub fn failed(&mut self) {
        self.fails += 1;
        if self.fails >= 5 {
            self.fails = 0;
            self.blocked_until = Some(Instant::now() + Duration::from_secs(30));
        }
    }

    pub fn succeeded(&mut self) {
        self.fails = 0;
        self.blocked_until = None;
    }
}

// ---------- stockage ----------

pub fn sessions(db: &Db) -> Result<Vec<Session>, String> {
    Ok(db
        .get_setting(SESSIONS_KEY)?
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default())
}

fn store_sessions(db: &Db, list: &[Session]) -> Result<(), String> {
    db.set_setting(SESSIONS_KEY, &serde_json::to_string(list).map_err(|err| err.to_string())?)
}

/// Crée ou met à jour une session (`id` vide = nouvelle session).
pub fn save_session(db: &Db, id: &str, name: &str, channels: Vec<String>, new_id: String) -> Result<Session, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err(crate::tr!(
            "Donne un nom à la session (40 caractères au plus).",
            "Give the session a name (40 characters at most)."
        ));
    }
    let mut channels = channels;
    channels.sort();
    channels.dedup();
    let mut list = sessions(db)?;
    let session = if let Some(existing) = list.iter_mut().find(|s| !id.is_empty() && s.id == id) {
        existing.name = name.to_string();
        existing.channels = channels;
        existing.clone()
    } else {
        let created = Session { id: new_id, name: name.to_string(), channels };
        list.push(created.clone());
        created
    };
    store_sessions(db, &list)?;
    Ok(session)
}

pub fn delete_session(db: &Db, id: &str) -> Result<(), String> {
    let mut list = sessions(db)?;
    list.retain(|s| s.id != id);
    store_sessions(db, &list)?;
    if db.get_setting(ACTIVE_KEY)?.as_deref() == Some(id) {
        db.set_setting(ACTIVE_KEY, "")?;
    }
    Ok(())
}

/// La session verrouillée en ce moment, s'il y en a une.
pub fn active(db: &Db) -> Result<Option<Session>, String> {
    let Some(id) = db.get_setting(ACTIVE_KEY)?.filter(|v| !v.is_empty()) else { return Ok(None) };
    Ok(sessions(db)?.into_iter().find(|s| s.id == id))
}

pub fn status(db: &Db) -> Result<KidStatus, String> {
    let session = active(db)?;
    Ok(KidStatus {
        active: session.is_some(),
        session_name: session.map(|s| s.name).unwrap_or_default(),
        has_pin: db.get_setting(PIN_KEY)?.is_some_and(|v| !v.is_empty()),
    })
}

pub fn set_pin(db: &Db, pin: &str, salt: &str) -> Result<(), String> {
    if !valid_pin(pin) {
        return Err(crate::tr!("Le code doit faire 4 chiffres.", "The code must be 4 digits."));
    }
    db.set_setting(PIN_KEY, &hash_pin(pin, salt))
}

pub fn pin_matches(db: &Db, pin: &str) -> Result<bool, String> {
    Ok(db.get_setting(PIN_KEY)?.is_some_and(|stored| check_pin(&stored, pin)))
}

pub fn start(db: &Db, session_id: &str) -> Result<(), String> {
    if !sessions(db)?.iter().any(|s| s.id == session_id) {
        return Err(crate::tr!("Session introuvable.", "Session not found."));
    }
    if !status(db)?.has_pin {
        return Err(crate::tr!("Choisis d'abord un code.", "Choose a code first."));
    }
    db.set_setting(ACTIVE_KEY, session_id)
}

pub fn stop(db: &Db) -> Result<(), String> {
    db.set_setting(ACTIVE_KEY, "")
}

/// Secours si le code est oublié : un fichier `reinitialiser-mode-enfant.txt` posé dans le dossier des données
/// de Kiosque efface le code et déverrouille l'application au prochain lancement.
pub fn reset_if_requested(db: &Db, dir: &std::path::Path) {
    let marker = dir.join("reinitialiser-mode-enfant.txt");
    if marker.exists() {
        let _ = db.set_setting(ACTIVE_KEY, "");
        let _ = db.set_setting(PIN_KEY, "");
        let _ = std::fs::remove_file(marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_connu() {
        assert_eq!(sha256_hex(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        // Plus d'un bloc de 64 octets.
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn code_du_parent() {
        assert!(valid_pin("0427"));
        assert!(!valid_pin("123"));
        assert!(!valid_pin("12345"));
        assert!(!valid_pin("12a4"));
        let stored = hash_pin("0427", "sel");
        assert!(!stored.contains("0427"));
        assert!(check_pin(&stored, "0427"));
        assert!(!check_pin(&stored, "0428"));
        assert!(!check_pin("n'importe quoi", "0427"));
    }

    #[test]
    fn essais_limites() {
        let mut a = Attempts::new();
        for _ in 0..4 {
            a.failed();
            assert_eq!(a.wait(), 0);
        }
        a.failed();
        assert!(a.wait() > 0);
        a.succeeded();
        assert_eq!(a.wait(), 0);
    }

    #[test]
    fn sessions_et_verrou() {
        let db = Db::open_in_memory().unwrap();
        assert!(sessions(&db).unwrap().is_empty());
        assert!(save_session(&db, "", "  ", vec![], "s1".into()).is_err());
        let s = save_session(&db, "", "Les enfants", vec!["b".into(), "a".into(), "a".into()], "s1".into()).unwrap();
        assert_eq!(s.channels, vec!["a", "b"]);
        // Mise à jour de la même session, pas de doublon.
        save_session(&db, "s1", "Petits", vec!["a".into()], "s2".into()).unwrap();
        assert_eq!(sessions(&db).unwrap().len(), 1);
        assert_eq!(sessions(&db).unwrap()[0].name, "Petits");

        // Pas de verrouillage sans code.
        assert!(start(&db, "s1").is_err());
        set_pin(&db, "1234", "sel").unwrap();
        assert!(set_pin(&db, "12", "sel").is_err());
        assert!(pin_matches(&db, "1234").unwrap());
        assert!(!pin_matches(&db, "0000").unwrap());
        assert!(start(&db, "inconnue").is_err());
        start(&db, "s1").unwrap();
        assert!(status(&db).unwrap().active);
        assert_eq!(active(&db).unwrap().unwrap().id, "s1");
        stop(&db).unwrap();
        assert!(!status(&db).unwrap().active);

        // Supprimer la session verrouillée déverrouille.
        start(&db, "s1").unwrap();
        delete_session(&db, "s1").unwrap();
        assert!(!status(&db).unwrap().active);
    }
}
