//! Lecture des flux Atom publics de YouTube (aucun compte, aucune clé d'API).

use feed_rs::parser;
use std::time::Duration;

const FEED_URL: &str = "https://www.youtube.com/feeds/videos.xml";

#[derive(Debug, Clone)]
pub struct ParsedVideo {
    pub id: String,
    pub title: String,
    /// Date de publication, en secondes Unix.
    pub published: i64,
    pub thumb: Option<String>,
    /// Adresse de la page de la vidéo (autres plateformes que YouTube ; vide pour YouTube).
    pub url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ParsedFeed {
    pub title: String,
    pub videos: Vec<ParsedVideo>,
}

/// Client HTTP partagé (TLS en Rust pur, délai maximal de 20 s).
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")
        .timeout(Duration::from_secs(20))
        .build()
        .expect("impossible de créer le client HTTP")
}

/// Un identifiant de vidéo YouTube : 11 caractères `[A-Za-z0-9_-]`.
pub fn is_video_id(s: &str) -> bool {
    s.len() == 11 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn video_id(entry_id: &str, link: Option<&str>) -> Option<String> {
    if let Some(rest) = entry_id.strip_prefix("yt:video:") {
        if is_video_id(rest) {
            return Some(rest.to_string());
        }
    }
    let link = link?;
    let start = link.find("v=")? + 2;
    let id: String = link[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    is_video_id(&id).then_some(id)
}

pub fn parse_feed(bytes: &[u8]) -> Result<ParsedFeed, String> {
    let feed = parser::parse(bytes).map_err(|err| crate::tr!("flux illisible ({err})", "unreadable feed ({err})"))?;
    let title = feed.title.map(|t| t.content).unwrap_or_default();

    let mut videos = Vec::new();
    for entry in feed.entries {
        let link = entry.links.first().map(|l| l.href.clone());
        let Some(id) = video_id(&entry.id, link.as_deref()) else {
            continue;
        };
        let video_title = entry.title.map(|t| t.content).unwrap_or_default();
        let published = entry
            .published
            .or(entry.updated)
            .map(|d| d.timestamp())
            .unwrap_or(0);
        let thumb = entry
            .media
            .iter()
            .flat_map(|m| m.thumbnails.iter())
            .next()
            .map(|t| t.image.uri.clone());
        videos.push(ParsedVideo {
            id,
            title: video_title,
            published,
            thumb,
            url: None,
        });
    }
    Ok(ParsedFeed { title, videos })
}

async fn get_feed(http: &reqwest::Client, query: &str) -> Result<ParsedFeed, String> {
    let url = format!("{FEED_URL}?{query}");
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|err| crate::tr!("connexion impossible ({err})", "connection failed ({err})"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|err| crate::tr!("lecture interrompue ({err})", "read interrupted ({err})"))?;
    parse_feed(&bytes)
}

/// Flux officiel de la chaîne (contient aussi les Shorts). Sert à lire le nom de la chaîne.
pub async fn fetch_channel_feed(http: &reqwest::Client, channel_id: &str) -> Result<ParsedFeed, String> {
    get_feed(http, &format!("channel_id={channel_id}")).await
}

/// Vidéos d'une chaîne. Avec `exclude_shorts`, on lit d'abord la playlist « vidéos longues »
/// (`UULF` + identifiant sans le préfixe `UC`) et l'on retombe sur le flux classique si elle
/// est absente ou vide.
pub async fn fetch_videos(
    http: &reqwest::Client,
    channel_id: &str,
    exclude_shorts: bool,
) -> Result<ParsedFeed, String> {
    if exclude_shorts && channel_id.len() == 24 && channel_id.starts_with("UC") {
        let query = format!("playlist_id=UULF{}", &channel_id[2..]);
        if let Ok(feed) = get_feed(http, &query).await {
            if !feed.videos.is_empty() {
                return Ok(feed);
            }
        }
    }
    fetch_channel_feed(http, channel_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
 <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv"/>
 <id>yt:channel:abcdefghijklmnopqrstuv</id>
 <yt:channelId>abcdefghijklmnopqrstuv</yt:channelId>
 <title>Ma Chaîne</title>
 <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <author><name>Ma Chaîne</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
 <published>2015-01-01T00:00:00+00:00</published>
 <entry>
  <id>yt:video:dQw4w9WgXcQ</id>
  <yt:videoId>dQw4w9WgXcQ</yt:videoId>
  <yt:channelId>abcdefghijklmnopqrstuv</yt:channelId>
  <title>Première vidéo</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
  <author><name>Ma Chaîne</name><uri>https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv</uri></author>
  <published>2026-10-27T10:00:00+00:00</published>
  <updated>2026-10-27T12:00:00+00:00</updated>
  <media:group>
   <media:title>Première vidéo</media:title>
   <media:content url="https://www.youtube.com/v/dQw4w9WgXcQ?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
   <media:thumbnail url="https://i2.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" width="480" height="360"/>
   <media:description>Une description</media:description>
  </media:group>
 </entry>
 <entry>
  <id>yt:video:9bZkp7q19f0</id>
  <yt:videoId>9bZkp7q19f0</yt:videoId>
  <title>Deuxième vidéo</title>
  <link rel="alternate" href="https://www.youtube.com/watch?v=9bZkp7q19f0"/>
  <published>2026-10-20T08:30:00+00:00</published>
  <updated>2026-10-20T08:30:00+00:00</updated>
 </entry>
</feed>"#;

    #[test]
    fn parse_un_flux_youtube() {
        let feed = parse_feed(SAMPLE.as_bytes()).expect("le flux doit être lisible");
        assert_eq!(feed.title, "Ma Chaîne");
        assert_eq!(feed.videos.len(), 2);
        let v = &feed.videos[0];
        assert_eq!(v.id, "dQw4w9WgXcQ");
        assert_eq!(v.title, "Première vidéo");
        assert!(v.published > 1_700_000_000);
        assert_eq!(
            v.thumb.as_deref(),
            Some("https://i2.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
        );
        assert_eq!(feed.videos[1].id, "9bZkp7q19f0");
        assert!(feed.videos[1].thumb.is_none());
    }

    #[test]
    fn flux_invalide() {
        assert!(parse_feed(b"pas du xml").is_err());
    }

    #[test]
    fn identifiants_de_video() {
        assert!(is_video_id("dQw4w9WgXcQ"));
        assert!(!is_video_id("trop-court"));
        assert!(!is_video_id("dQw4w9WgXc;"));
        assert_eq!(
            video_id("autre", Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1")),
            Some("dQw4w9WgXcQ".to_string())
        );
    }
}
