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
