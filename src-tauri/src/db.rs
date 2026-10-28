//! Stockage local (SQLite) : chaînes suivies, vidéos et réglages.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::feed::ParsedVideo;

/// États d'une vidéo : à voir, plus tard, vue, ignorée.
pub const STATES: [&str; 4] = ["new", "later", "seen", "ignored"];

/// À l'ajout d'une chaîne, ses vidéos plus anciennes que 7 jours sont rangées comme « vues »
/// pour que la boîte de réception ne démarre pas pleine d'archives.
const BACKLOG_SECS: i64 = 7 * 86_400;

type R<T> = Result<T, String>;

fn db_err(err: rusqlite::Error) -> String {
    format!("Base de données : {err}")
}

#[derive(Serialize, Clone, Debug)]
pub struct Channel {
    pub id: String,
    pub title: String,
    pub avatar: Option<String>,
    pub description: Option<String>,
    /// Dossier choisi par l'utilisateur (proposé à l'import d'après la catégorie YouTube).
    pub category: Option<String>,
    pub new_count: i64,
}

#[derive(Serialize, Clone, Debug)]
pub struct Video {
    pub id: String,
    pub channel_id: String,
    pub channel_title: String,
    pub title: String,
    pub published: i64,
    pub thumb: Option<String>,
    pub state: String,
    pub category: Option<String>,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> R<Self> {
        Self::init(Connection::open(path).map_err(db_err)?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> R<Self> {
        Self::init(Connection::open_in_memory().map_err(db_err)?)
    }

    fn init(conn: Connection) -> R<Self> {
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS channels (
                 id       TEXT PRIMARY KEY,
                 title    TEXT NOT NULL,
                 added_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS videos (
                 id         TEXT PRIMARY KEY,
                 channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                 title      TEXT NOT NULL,
                 published  INTEGER NOT NULL,
                 thumb      TEXT,
                 state      TEXT NOT NULL DEFAULT 'new',
                 fetched_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS videos_state_published ON videos(state, published DESC);
             CREATE TABLE IF NOT EXISTS settings (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .map_err(db_err)?;
        // Colonne ajoutée après la première version : on la crée si la base est plus ancienne.
        for column in ["avatar", "description", "category"] {
            let exists = conn
                .prepare("SELECT 1 FROM pragma_table_info('channels') WHERE name = ?1")
                .map_err(db_err)?
                .exists([column])
                .map_err(db_err)?;
            if !exists {
                conn.execute(&format!("ALTER TABLE channels ADD COLUMN {column} TEXT"), [])
                    .map_err(db_err)?;
            }
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // ---------- chaînes ----------

    /// Retourne `true` si la chaîne vient d'être ajoutée, `false` si elle était déjà suivie.
    pub fn add_channel(&self, id: &str, title: &str, now: i64) -> R<bool> {
        let conn = self.lock();
        let added = conn
            .execute(
                "INSERT OR IGNORE INTO channels(id, title, added_at) VALUES (?1, ?2, ?3)",
                params![id, title, now],
            )
            .map_err(db_err)?;
        if added == 0 {
            conn.execute("UPDATE channels SET title = ?2 WHERE id = ?1", params![id, title])
                .map_err(db_err)?;
        }
        Ok(added > 0)
    }

    /// Enregistre l'avatar (s'il y en a un) et le descriptif ; `description` vide = « consulté, aucun ».
    /// `genre` ne sert que de dossier par défaut : il ne remplace jamais un dossier déjà choisi.
    pub fn set_profile(&self, id: &str, avatar: Option<&str>, description: &str, genre: Option<&str>) -> R<()> {
        self.lock()
            .execute(
                "UPDATE channels SET avatar = COALESCE(?2, avatar), description = ?3,
                 category = COALESCE(category, ?4) WHERE id = ?1",
                params![id, avatar, description, genre],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// Range une chaîne dans un dossier ; un nom vide la retire de son dossier.
    pub fn set_category(&self, id: &str, category: &str) -> R<()> {
        let name: String = category.split_whitespace().collect::<Vec<_>>().join(" ");
        let name: String = name.chars().take(40).collect();
        let value = if name.is_empty() { None } else { Some(name) };
        self.lock()
            .execute("UPDATE channels SET category = ?2 WHERE id = ?1", params![id, value])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn remove_channel(&self, id: &str) -> R<()> {
        self.lock()
            .execute("DELETE FROM channels WHERE id = ?1", params![id])
            .map_err(db_err)?;
        Ok(())
    }

    pub fn list_channels(&self) -> R<Vec<Channel>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.title, c.avatar, c.description, c.category, COALESCE(SUM(v.state = 'new'), 0)
                 FROM channels c LEFT JOIN videos v ON v.channel_id = c.id
                 GROUP BY c.id
                 ORDER BY c.title COLLATE NOCASE",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Channel {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    avatar: r.get(2)?,
                    description: r.get(3)?,
                    category: r.get(4)?,
                    new_count: r.get(5)?,
                })
            })
            .map_err(db_err)?;
        let channels = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(channels)
    }

    // ---------- vidéos ----------

    /// Ajoute les vidéos inconnues et retourne combien sont nouvelles.
    pub fn upsert_videos(
        &self,
        channel_id: &str,
        videos: &[ParsedVideo],
        first_fetch: bool,
        now: i64,
    ) -> R<usize> {
        let mut conn = self.lock();
        let tx = conn.transaction().map_err(db_err)?;
        let mut inserted = 0;
        {
            let mut insert = tx
                .prepare(
                    "INSERT OR IGNORE INTO videos(id, channel_id, title, published, thumb, state, fetched_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(db_err)?;
            let mut retitle = tx
                .prepare("UPDATE videos SET title = ?1 WHERE id = ?2 AND title <> ?1")
                .map_err(db_err)?;
            for v in videos {
                let state = if first_fetch && v.published < now - BACKLOG_SECS {
                    "seen"
                } else {
                    "new"
                };
                let added = insert
                    .execute(params![v.id, channel_id, v.title, v.published, v.thumb, state, now])
                    .map_err(db_err)?;
                if added == 0 {
                    retitle.execute(params![v.title, v.id]).map_err(db_err)?;
                } else {
                    inserted += added;
                }
            }
        }
        tx.commit().map_err(db_err)?;
        Ok(inserted)
    }

    pub fn list_videos(&self, state: &str, limit: i64) -> R<Vec<Video>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT v.id, v.channel_id, c.title, v.title, v.published, v.thumb, v.state, c.category
                 FROM videos v JOIN channels c ON c.id = v.channel_id
                 WHERE v.state = ?1
                 ORDER BY v.published DESC
                 LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![state, limit], |r| {
                Ok(Video {
                    id: r.get(0)?,
                    channel_id: r.get(1)?,
                    channel_title: r.get(2)?,
                    title: r.get(3)?,
                    published: r.get(4)?,
                    thumb: r.get(5)?,
                    state: r.get(6)?,
                    category: r.get(7)?,
                })
            })
            .map_err(db_err)?;
        let videos = rows.collect::<Result<Vec<_>, _>>().map_err(db_err)?;
        Ok(videos)
    }

    /// La vidéo la plus récente de chaque chaîne (hors vidéos ignorées), les plus fraîches d'abord.
    pub fn latest_videos(&self, limit: usize) -> R<Vec<Video>> {
        let conn = self.lock();
        let mut stmt = conn
            .prepare(
                "SELECT v.id, v.channel_id, c.title, v.title, v.published, v.thumb, v.state, c.category
                 FROM videos v JOIN channels c ON c.id = v.channel_id
                 WHERE v.state != 'ignored'
                 ORDER BY v.published DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Video {
                    id: r.get(0)?,
                    channel_id: r.get(1)?,
                    channel_title: r.get(2)?,
                    title: r.get(3)?,
                    published: r.get(4)?,
                    thumb: r.get(5)?,
                    state: r.get(6)?,
                    category: r.get(7)?,
                })
            })
            .map_err(db_err)?;
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for video in rows {
            let video = video.map_err(db_err)?;
            if seen.insert(video.channel_id.clone()) {
                out.push(video);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    pub fn set_state(&self, id: &str, state: &str) -> R<()> {
        if !STATES.contains(&state) {
            return Err(format!("État inconnu : {state}"));
        }
        self.lock()
            .execute("UPDATE videos SET state = ?1 WHERE id = ?2", params![state, id])
            .map_err(db_err)?;
        Ok(())
    }

    /// Range toutes les vidéos « à voir » comme vues. Retourne le nombre de vidéos concernées.
    pub fn mark_all_seen(&self) -> R<usize> {
        self.lock()
            .execute("UPDATE videos SET state = 'seen' WHERE state = 'new'", [])
            .map_err(db_err)
    }

    // ---------- réglages ----------

    pub fn get_setting(&self, key: &str) -> R<Option<String>> {
        self.lock()
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(db_err)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> R<()> {
        self.lock()
            .execute(
                "INSERT INTO settings(key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn exclude_shorts(&self) -> bool {
        !matches!(self.get_setting("exclude_shorts"), Ok(Some(v)) if v == "0")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 86_400;

    fn video(id: &str, age_days: i64) -> ParsedVideo {
        ParsedVideo {
            id: id.into(),
            title: format!("Titre {id}"),
            published: NOW - age_days * DAY,
            thumb: None,
        }
    }

    fn db_with_channel() -> Db {
        let db = Db::open_in_memory().unwrap();
        assert!(db.add_channel("UC1", "Ma chaîne", NOW).unwrap());
        db
    }

    #[test]
    fn ajout_unique_et_mise_a_jour_du_titre() {
        let db = db_with_channel();
        assert!(!db.add_channel("UC1", "Nouveau nom", NOW).unwrap());
        assert_eq!(db.list_channels().unwrap()[0].title, "Nouveau nom");
    }

    #[test]
    fn premier_import_range_les_archives_comme_vues() {
        let db = db_with_channel();
        let videos = [video("recent00001", 1), video("ancienne001", 30)];
        assert_eq!(db.upsert_videos("UC1", &videos, true, NOW).unwrap(), 2);

        let nouvelles = db.list_videos("new", 50).unwrap();
        assert_eq!(nouvelles.len(), 1);
        assert_eq!(nouvelles[0].id, "recent00001");
        assert_eq!(db.list_videos("seen", 50).unwrap().len(), 1);
        assert_eq!(db.list_channels().unwrap()[0].new_count, 1);
    }

    #[test]
    fn actualisation_n_ajoute_que_les_nouveautes() {
        let db = db_with_channel();
        db.upsert_videos("UC1", &[video("aaaaaaaaaaa", 1)], true, NOW).unwrap();
        let again = [video("aaaaaaaaaaa", 1), video("bbbbbbbbbbb", 0)];
        assert_eq!(db.upsert_videos("UC1", &again, false, NOW).unwrap(), 1);
        let nouvelles = db.list_videos("new", 50).unwrap();
        assert_eq!(nouvelles.len(), 2);
        assert_eq!(nouvelles[0].id, "bbbbbbbbbbb", "tri du plus récent au plus ancien");
    }

    #[test]
    fn derniere_video_de_chaque_chaine() {
        let db = db_with_channel();
        assert!(db.add_channel("UC2", "Autre chaîne", NOW).unwrap());
        db.upsert_videos("UC1", &[video("aaaaaaaaaaa", 5), video("bbbbbbbbbbb", 2)], true, NOW).unwrap();
        db.upsert_videos("UC2", &[video("ccccccccccc", 3), video("ddddddddddd", 1)], true, NOW).unwrap();
        db.set_state("ddddddddddd", "ignored").unwrap();

        let dernieres = db.latest_videos(10).unwrap();
        let ids: Vec<_> = dernieres.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, ["bbbbbbbbbbb", "ccccccccccc"], "une par chaîne, ignorées exclues, tri récent d'abord");
        assert_eq!(db.latest_videos(1).unwrap().len(), 1);
    }

    #[test]
    fn ancienne_base_sans_colonne_avatar() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE channels (id TEXT PRIMARY KEY, title TEXT NOT NULL, added_at INTEGER NOT NULL);
             INSERT INTO channels VALUES ('UC1', 'Ancienne', 1);",
        )
        .unwrap();
        let db = Db::init(conn).unwrap();
        let chaines = db.list_channels().unwrap();
        assert_eq!(chaines.len(), 1);
        assert_eq!(chaines[0].avatar, None);
    }

    #[test]
    fn dossiers_des_chaines() {
        let db = db_with_channel();
        // La catégorie YouTube sert de dossier par défaut…
        db.set_profile("UC1", None, "", Some("Éducation")).unwrap();
        assert_eq!(db.list_channels().unwrap()[0].category.as_deref(), Some("Éducation"));
        // …mais n'écrase pas un choix de l'utilisateur.
        db.set_category("UC1", "  Tech   perso ").unwrap();
        db.set_profile("UC1", None, "", Some("Éducation")).unwrap();
        assert_eq!(db.list_channels().unwrap()[0].category.as_deref(), Some("Tech perso"));
        // Les vidéos portent le dossier de leur chaîne.
        db.upsert_videos("UC1", &[video("aaaaaaaaaaa", 1)], false, NOW).unwrap();
        assert_eq!(db.list_videos("new", 10).unwrap()[0].category.as_deref(), Some("Tech perso"));
        assert_eq!(db.latest_videos(10).unwrap()[0].category.as_deref(), Some("Tech perso"));
        // Un nom vide retire la chaîne de son dossier.
        db.set_category("UC1", "   ").unwrap();
        assert_eq!(db.list_channels().unwrap()[0].category, None);
    }

    #[test]
    fn avatar_enregistre_et_liste() {
        let db = db_with_channel();
        assert_eq!(db.list_channels().unwrap()[0].avatar, None);
        assert_eq!(db.list_channels().unwrap()[0].description, None);
        db.set_profile("UC1", Some("https://yt3.googleusercontent.com/abc=s96"), "Un descriptif", None).unwrap();
        let c = &db.list_channels().unwrap()[0];
        assert_eq!(c.avatar.as_deref(), Some("https://yt3.googleusercontent.com/abc=s96"));
        assert_eq!(c.description.as_deref(), Some("Un descriptif"));
        // Une page sans avatar ne retire pas celui qu'on avait.
        db.set_profile("UC1", None, "", None).unwrap();
        assert!(db.list_channels().unwrap()[0].avatar.is_some());
    }

    #[test]
    fn titre_modifie_par_le_createur() {
        let db = db_with_channel();
        db.upsert_videos("UC1", &[video("aaaaaaaaaaa", 1)], false, NOW).unwrap();
        let mut modifiee = video("aaaaaaaaaaa", 1);
        modifiee.title = "Titre corrigé".into();
        assert_eq!(db.upsert_videos("UC1", &[modifiee], false, NOW).unwrap(), 0);
        assert_eq!(db.list_videos("new", 50).unwrap()[0].title, "Titre corrigé");
    }

    #[test]
    fn etats_et_tout_marquer_comme_vu() {
        let db = db_with_channel();
        let videos = [video("aaaaaaaaaaa", 1), video("bbbbbbbbbbb", 2), video("ccccccccccc", 3)];
        db.upsert_videos("UC1", &videos, false, NOW).unwrap();

        db.set_state("aaaaaaaaaaa", "later").unwrap();
        db.set_state("bbbbbbbbbbb", "ignored").unwrap();
        assert!(db.set_state("ccccccccccc", "nimporte").is_err());

        assert_eq!(db.list_videos("later", 50).unwrap().len(), 1);
        assert_eq!(db.mark_all_seen().unwrap(), 1);
        assert!(db.list_videos("new", 50).unwrap().is_empty());
    }

    #[test]
    fn suppression_d_une_chaine_supprime_ses_videos() {
        let db = db_with_channel();
        db.upsert_videos("UC1", &[video("aaaaaaaaaaa", 1)], false, NOW).unwrap();
        db.remove_channel("UC1").unwrap();
        assert!(db.list_channels().unwrap().is_empty());
        assert!(db.list_videos("new", 50).unwrap().is_empty());
    }

    #[test]
    fn reglages() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.get_setting("player").unwrap(), None);
        assert!(db.exclude_shorts());
        db.set_setting("player", "mpv").unwrap();
        db.set_setting("player", "browser").unwrap();
        assert_eq!(db.get_setting("player").unwrap().as_deref(), Some("browser"));
        db.set_setting("exclude_shorts", "0").unwrap();
        assert!(!db.exclude_shorts());
    }
}
