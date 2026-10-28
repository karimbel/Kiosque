//! Transforme ce que tu colles (adresse, @pseudo, identifiant) en identifiant de chaîne `UC…`.

use regex::Regex;
use reqwest::Url;

#[derive(Debug, PartialEq)]
pub enum Target {
    /// L'identifiant est déjà connu : aucune requête nécessaire.
    ChannelId(String),
    /// Il faut lire cette page pour y trouver l'identifiant.
    Page(String),
}

pub fn is_channel_id(s: &str) -> bool {
    s.len() == 24
        && s.starts_with("UC")
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn handle_page(handle: &str) -> Result<Target, String> {
    let handle = handle.trim().trim_matches('/');
    let valid = !handle.is_empty()
        && handle
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if !valid {
        return Err("Ce pseudo n'est pas valide.".into());
    }
    Ok(Target::Page(format!("https://www.youtube.com/@{handle}")))
}

pub fn classify(input: &str) -> Result<Target, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Colle l'adresse d'une chaîne, un @pseudo ou un identifiant commençant par UC.".into());
    }
    if is_channel_id(s) {
        return Ok(Target::ChannelId(s.to_string()));
    }
    if let Some(handle) = s.strip_prefix('@') {
        return handle_page(handle);
    }
    if !s.contains('/') && !s.contains('.') {
        return handle_page(s);
    }

    let with_scheme = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| "Cette adresse n'est pas valide.".to_string())?;
    let host = url.host_str().unwrap_or("").to_lowercase();
    if !matches!(
        host.as_str(),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be"
    ) {
        return Err("Seules les adresses youtube.com sont acceptées.".into());
    }

    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();
    if segments.first() == Some(&"channel") {
        if let Some(id) = segments.get(1) {
            if is_channel_id(id) {
                return Ok(Target::ChannelId((*id).to_string()));
            }
        }
    }
    Ok(Target::Page(url.to_string()))
}

/// Cherche l'identifiant de la chaîne dans le HTML d'une page de chaîne (ou de vidéo).
pub fn extract_channel_id(html: &str) -> Option<String> {
    const PATTERNS: [&str; 5] = [
        r#"<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[0-9A-Za-z_-]{22})""#,
        r#"<meta itemprop="(?:identifier|channelId)" content="(UC[0-9A-Za-z_-]{22})""#,
        r#""externalId":"(UC[0-9A-Za-z_-]{22})""#,
        r#""externalChannelId":"(UC[0-9A-Za-z_-]{22})""#,
        r#""channelId":"(UC[0-9A-Za-z_-]{22})""#,
    ];
    PATTERNS.iter().find_map(|pattern| {
        Regex::new(pattern)
            .ok()?
            .captures(html)
            .map(|caps| caps[1].to_string())
    })
}

/// Cherche l'image de profil de la chaîne (balise `og:image` de sa page), en 96 px.
/// Seules les images hébergées par Google sont acceptées.
pub fn extract_avatar(html: &str) -> Option<String> {
    let caps = Regex::new(r#"<meta property="og:image" content="(https://[^"]+)""#)
        .ok()?
        .captures(html)?;
    let url = caps[1].replace("&amp;", "&");
    let host = Url::parse(&url).ok()?.host_str()?.to_lowercase();
    let trusted = host == "yt3.googleusercontent.com"
        || host == "yt3.ggpht.com"
        || host.ends_with(".googleusercontent.com");
    if !trusted {
        return None;
    }
    // L'adresse se termine par une taille (=s900-c-k…) : on demande une version légère.
    let sized = Regex::new(r"=s\d+").ok()?.replace(&url, "=s96").into_owned();
    Some(sized)
}

fn decode_entities(text: &str) -> String {
    let named = text
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&");
    Regex::new(r"&#(\d+);")
        .map(|re| {
            re.replace_all(&named, |caps: &regex::Captures| {
                caps[1]
                    .parse::<u32>()
                    .ok()
                    .and_then(char::from_u32)
                    .map(String::from)
                    .unwrap_or_default()
            })
            .into_owned()
        })
        .unwrap_or(named)
}

/// Descriptif court de la chaîne (balise `og:description`), nettoyé et limité à 160 caractères.
pub fn extract_description(html: &str) -> Option<String> {
    let caps = Regex::new(r#"<meta property="og:description" content="([^"]*)""#)
        .ok()?
        .captures(html)?;
    let text = decode_entities(&caps[1]);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    let mut chars = text.chars();
    let short: String = chars.by_ref().take(160).collect();
    Some(if chars.next().is_some() {
        format!("{}…", short.trim_end())
    } else {
        short
    })
}

/// Catégorie YouTube de la chaîne (balise `genre`), traduite en français quand on la connaît.
pub fn extract_genre(html: &str) -> Option<String> {
    let caps = Regex::new(r#"<meta itemprop="genre" content="([^"]+)""#)
        .ok()?
        .captures(html)?;
    let genre = decode_entities(caps[1].trim());
    let french = match genre.as_str() {
        "Film & Animation" => "Cinéma et animation",
        "Autos & Vehicles" => "Auto",
        "Music" => "Musique",
        "Pets & Animals" => "Animaux",
        "Sports" => "Sport",
        "Travel & Events" => "Voyages",
        "Gaming" => "Jeux vidéo",
        "People & Blogs" => "Personnes et blogs",
        "Comedy" => "Humour",
        "Entertainment" => "Divertissement",
        "News & Politics" => "Actualités",
        "Howto & Style" => "Style",
        "Education" => "Éducation",
        "Science & Technology" => "Science et technologie",
        "Nonprofits & Activism" => "Associations",
        other => other,
    };
    if french.is_empty() || french.chars().count() > 40 {
        return None;
    }
    Some(french.to_string())
}

/// Ce que la page publique d'une chaîne apprend : image de profil, descriptif et catégorie.
pub struct Profile {
    pub genre: Option<String>,
    pub avatar: Option<String>,
    /// Vide si la chaîne n'a pas de descriptif (pour ne pas le redemander à chaque fois).
    pub description: String,
}

/// Télécharge la page de la chaîne. Silencieux en cas d'échec : l'interface affiche alors
/// l'initiale de la chaîne et aucun descriptif.
pub async fn fetch_profile(http: &reqwest::Client, channel_id: &str) -> Option<Profile> {
    let resp = http
        .get(format!("https://www.youtube.com/channel/{channel_id}"))
        .header("Cookie", "SOCS=CAI")
        .header("Accept-Language", "fr-FR,fr;q=0.9")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() || resp.url().host_str().is_some_and(|h| h.contains("consent.")) {
        return None;
    }
    let html = resp.text().await.ok()?;
    Some(Profile {
        genre: extract_genre(&html),
        avatar: extract_avatar(&html),
        description: extract_description(&html).unwrap_or_default(),
    })
}

pub async fn resolve_channel_id(http: &reqwest::Client, input: &str) -> Result<String, String> {
    match classify(input)? {
        Target::ChannelId(id) => Ok(id),
        Target::Page(url) => {
            let resp = http
                .get(&url)
                .header("Cookie", "SOCS=CAI")
                .header("Accept-Language", "fr-FR,fr;q=0.9")
                .send()
                .await
                .map_err(|err| format!("Connexion impossible ({err})."))?;
            if resp.url().host_str().is_some_and(|h| h.contains("consent.")) {
                return Err(
                    "YouTube demande un consentement avant d'afficher la page. \
                     Colle plutôt l'adresse en /channel/UC… ou l'identifiant UC… de la chaîne."
                        .into(),
                );
            }
            if !resp.status().is_success() {
                return Err(format!("Chaîne introuvable (HTTP {}).", resp.status().as_u16()));
            }
            let html = resp
                .text()
                .await
                .map_err(|err| format!("Lecture interrompue ({err})."))?;
            extract_channel_id(&html)
                .ok_or_else(|| "Impossible de trouver l'identifiant de cette chaîne.".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "UCabcdefghijklmnopqrstuv";

    #[test]
    fn avatar_de_la_page() {
        let html = r#"<head><meta property="og:image" content="https://yt3.googleusercontent.com/AbC-dEf=s900-c-k-c0x00ffffff-no-rj"><title>x</title>"#;
        assert_eq!(
            extract_avatar(html).as_deref(),
            Some("https://yt3.googleusercontent.com/AbC-dEf=s96-c-k-c0x00ffffff-no-rj")
        );
        let ailleurs = r#"<meta property="og:image" content="https://exemple.com/a.png">"#;
        assert_eq!(extract_avatar(ailleurs), None);
        assert_eq!(extract_avatar("<html></html>"), None);
    }

    #[test]
    fn descriptif_de_la_page() {
        let html = r#"<meta property="og:description" content="Cuisine &amp; pâtisserie : l&#39;essentiel,   sans   bruit.">"#;
        assert_eq!(
            extract_description(html).as_deref(),
            Some("Cuisine & pâtisserie : l'essentiel, sans bruit.")
        );
        assert_eq!(extract_description(r#"<meta property="og:description" content="">"#), None);
        let long = format!(r#"<meta property="og:description" content="{}">"#, "mot ".repeat(80));
        let court = extract_description(&long).unwrap();
        assert!(court.ends_with('…') && court.chars().count() <= 161);
    }

    #[test]
    fn categorie_de_la_page() {
        let en = r#"<meta itemprop="genre" content="Science &amp; Technology">"#;
        assert_eq!(extract_genre(en).as_deref(), Some("Science et technologie"));
        let fr = r#"<meta itemprop="genre" content="Cuisine">"#;
        assert_eq!(extract_genre(fr).as_deref(), Some("Cuisine"));
        assert_eq!(extract_genre("<html></html>"), None);
    }

    #[test]
    fn identifiant_direct() {
        assert_eq!(classify(ID), Ok(Target::ChannelId(ID.into())));
        assert_eq!(
            classify(&format!("https://www.youtube.com/channel/{ID}")),
            Ok(Target::ChannelId(ID.into()))
        );
    }

    #[test]
    fn pseudos_et_adresses() {
        let page = Ok(Target::Page("https://www.youtube.com/@Fireship".into()));
        assert_eq!(classify("@Fireship"), page);
        assert_eq!(classify("Fireship"), page);
        assert_eq!(
            classify("youtube.com/@Fireship"),
            Ok(Target::Page("https://youtube.com/@Fireship".into()))
        );
        assert_eq!(classify("https://m.youtube.com/@Fireship"), Ok(Target::Page("https://m.youtube.com/@Fireship".into())));
    }

    #[test]
    fn entrees_refusees() {
        assert!(classify("").is_err());
        assert!(classify("https://exemple.com/@x").is_err());
        assert!(classify("@a b").is_err());
    }

    #[test]
    fn extraction_depuis_le_html() {
        let canonical = format!(r#"<head><link rel="canonical" href="https://www.youtube.com/channel/{ID}"></head>"#);
        assert_eq!(extract_channel_id(&canonical), Some(ID.into()));
        let json = format!(r#"var x = {{"externalId":"{ID}","title":"t"}};"#);
        assert_eq!(extract_channel_id(&json), Some(ID.into()));
        assert_eq!(extract_channel_id("<html>rien</html>"), None);
    }
}
