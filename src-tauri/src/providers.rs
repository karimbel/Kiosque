//! Autres plateformes que YouTube : PeerTube, Odysee, Vimeo et Dailymotion.
//! Comme pour YouTube, tout passe par des flux ou des interfaces publiques : aucun compte, aucune clé.
//!
//! Un identifiant de chaîne ou de vidéo porte toujours sa plateforme en préfixe
//! (`pt:`, `od:`, `vi:`, `dm:`). Sans préfixe, c'est YouTube.

use crate::feed::ParsedVideo;
use feed_rs::parser;
use regex::Regex;
use reqwest::Url;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    YouTube,
    PeerTube,
    Odysee,
    Vimeo,
    Dailymotion,
}

/// Plateformes qu'on peut activer dans les réglages (YouTube est toujours active).
pub const OPTIONAL: [Platform; 4] = [
    Platform::PeerTube,
    Platform::Odysee,
    Platform::Vimeo,
    Platform::Dailymotion,
];

impl Platform {
    pub fn key(self) -> &'static str {
        match self {
            Platform::YouTube => "youtube",
            Platform::PeerTube => "peertube",
            Platform::Odysee => "odysee",
            Platform::Vimeo => "vimeo",
            Platform::Dailymotion => "dailymotion",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Platform::YouTube => "YouTube",
            Platform::PeerTube => "PeerTube",
            Platform::Odysee => "Odysee",
            Platform::Vimeo => "Vimeo",
            Platform::Dailymotion => "Dailymotion",
        }
    }

    pub fn from_key(key: &str) -> Option<Platform> {
        [Platform::YouTube]
            .into_iter()
            .chain(OPTIONAL)
            .find(|p| p.key() == key)
    }
}

/// Plateforme d'un identifiant de chaîne ou de vidéo.
pub fn platform_of(id: &str) -> Platform {
    match id.get(..3) {
        Some("pt:") => Platform::PeerTube,
        Some("od:") => Platform::Odysee,
        Some("vi:") => Platform::Vimeo,
        Some("dm:") => Platform::Dailymotion,
        _ => Platform::YouTube,
    }
}

/// Plateformes activées dans les réglages (liste séparée par des virgules). YouTube y est toujours.
pub fn enabled_platforms(setting: &str) -> Vec<Platform> {
    let mut list = vec![Platform::YouTube];
    for key in setting.split(',') {
        if let Some(p) = Platform::from_key(key.trim()) {
            if !list.contains(&p) && !unavailable(p) {
                list.push(p);
            }
        }
    }
    list
}

/// Plateformes mises de côté : le code reste, mais elles ne peuvent pas être activées.
/// Dailymotion : son lecteur refuse l'intégration pour la plupart des vidéos.
pub fn unavailable(platform: Platform) -> bool {
    platform == Platform::Dailymotion
}

/// Nettoie une liste de plateformes reçue de l'interface (clés connues, dédoublonnées).
pub fn normalize_platforms(value: &str) -> String {
    enabled_platforms(value)
        .into_iter()
        .filter(|p| *p != Platform::YouTube)
        .map(|p| p.key())
        .collect::<Vec<_>>()
        .join(",")
}

// ---------- reconnaissance de ce que l'utilisateur colle ----------

#[derive(Debug, PartialEq)]
pub enum Kind {
    /// Identifiant de chaîne complet (avec préfixe).
    Channel(String),
    /// Adresse d'une vidéo PeerTube : la chaîne s'obtient par l'interface de l'instance.
    PeerTubeVideo { host: String, uuid: String },
    DailymotionVideo(String),
    VimeoVideo(String),
}

#[derive(Debug, PartialEq)]
pub struct Detected {
    pub platform: Platform,
    pub kind: Kind,
}

fn decode(segment: &str) -> String {
    percent_decode(segment)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.contains('.')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
}

/// Reconnaît une adresse d'une autre plateforme que YouTube.
/// `Ok(None)` : ce n'en est pas une (le texte est traité comme une adresse YouTube).
pub fn detect(input: &str) -> Result<Option<Detected>, String> {
    let s = input.trim();

    // PeerTube : « nom@instance.tld »
    if let Some((name, host)) = s.split_once('@') {
        if !name.is_empty() && valid_name(name) && valid_host(host) && !host.contains('/') {
            return Ok(Some(Detected {
                platform: Platform::PeerTube,
                kind: Kind::Channel(format!("pt:{name}@{}", host.to_lowercase())),
            }));
        }
    }

    if !s.contains('/') && !s.contains('.') {
        return Ok(None);
    }
    let with_scheme = if s.starts_with("http://") || s.starts_with("https://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let Ok(url) = Url::parse(&with_scheme) else {
        return Ok(None);
    };
    let host = url.host_str().unwrap_or("").to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let segments: Vec<String> = url
        .path_segments()
        .map(|it| it.filter(|p| !p.is_empty()).map(decode).collect())
        .unwrap_or_default();
    let first = segments.first().map(String::as_str).unwrap_or("");

    match host.as_str() {
        "youtube.com" | "m.youtube.com" | "youtu.be" => Ok(None),

        "odysee.com" | "lbry.tv" => {
            if first.starts_with('@') && first.len() > 1 {
                Ok(Some(Detected {
                    platform: Platform::Odysee,
                    kind: Kind::Channel(format!("od:{first}")),
                }))
            } else {
                Err(crate::tr!("Pour Odysee, colle l'adresse de la chaîne (odysee.com/@nom).", "For Odysee, paste the channel address (odysee.com/@name)."))
            }
        }

        "vimeo.com" => {
            if first == "channels" && segments.len() >= 2 && valid_name(&segments[1]) {
                Ok(Some(Detected {
                    platform: Platform::Vimeo,
                    kind: Kind::Channel(format!("vi:channels/{}", segments[1])),
                }))
            } else if first.len() >= 4 && first.chars().all(|c| c.is_ascii_digit()) {
                Ok(Some(Detected { platform: Platform::Vimeo, kind: Kind::VimeoVideo(first.to_string()) }))
            } else if valid_name(first)
                && !first.chars().all(|c| c.is_ascii_digit())
                && !matches!(first, "groups" | "ondemand" | "watch" | "categories" | "search" | "upload" | "features")
            {
                Ok(Some(Detected {
                    platform: Platform::Vimeo,
                    kind: Kind::Channel(format!("vi:{first}")),
                }))
            } else {
                Err(crate::tr!("Pour Vimeo, colle l'adresse du profil ou de la chaîne (vimeo.com/nom).", "For Vimeo, paste the profile or channel address (vimeo.com/name)."))
            }
        }

        "dailymotion.com" => {
            if first == "video" {
                let id = segments.get(1).map(|v| v.split('_').next().unwrap_or("")).unwrap_or("");
                if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Ok(Some(Detected { platform: Platform::Dailymotion, kind: Kind::DailymotionVideo(id.to_string()) }));
                }
            }
            let name = if first == "user" { segments.get(1).map(String::as_str).unwrap_or("") } else { first };
            if valid_name(name) && !matches!(name, "video" | "playlist" | "search" | "embed") {
                Ok(Some(Detected {
                    platform: Platform::Dailymotion,
                    kind: Kind::Channel(format!("dm:{name}")),
                }))
            } else {
                Err(crate::tr!("Pour Dailymotion, colle l'adresse de la chaîne (dailymotion.com/nom).", "For Dailymotion, paste the channel address (dailymotion.com/name)."))
            }
        }

        other => {
            // Toute autre adresse : si elle ressemble à une chaîne ou une vidéo PeerTube, on la prend pour telle.
            if matches!(first, "c" | "video-channels") && segments.len() >= 2 && valid_name(&segments[1]) {
                return Ok(Some(Detected {
                    platform: Platform::PeerTube,
                    kind: Kind::Channel(format!("pt:{}@{other}", segments[1])),
                }));
            }
            if first == "w" && segments.len() >= 2 {
                return Ok(Some(Detected {
                    platform: Platform::PeerTube,
                    kind: Kind::PeerTubeVideo { host: other.to_string(), uuid: segments[1].clone() },
                }));
            }
            if first == "videos" && segments.get(1).map(String::as_str) == Some("watch") && segments.len() >= 3 {
                return Ok(Some(Detected {
                    platform: Platform::PeerTube,
                    kind: Kind::PeerTubeVideo { host: other.to_string(), uuid: segments[2].clone() },
                }));
            }
            Ok(None)
        }
    }
}

// ---------- adresses de lecture ----------

/// Adresse d'intégration du lecteur de la plateforme (`None` pour YouTube, lu par son propre lecteur).
pub fn embed_url(video_id: &str) -> Option<String> {
    let rest = video_id.get(3..).unwrap_or("");
    match platform_of(video_id) {
        Platform::YouTube => None,
        Platform::PeerTube => {
            let (uuid, host) = rest.rsplit_once('@')?;
            Some(format!("https://{host}/videos/embed/{uuid}?autoplay=1&title=0&warningTitle=0"))
        }
        Platform::Vimeo => Some(format!("https://player.vimeo.com/video/{rest}?autoplay=1")),
        Platform::Dailymotion => Some(format!("https://www.dailymotion.com/embed/video/{rest}?autoplay=1")),
        Platform::Odysee => {
            let (slug, short) = rest.rsplit_once(':')?;
            Some(format!("https://odysee.com/$/embed/{slug}/{short}?autoplay=true"))
        }
    }
}

/// Adresse de la page de la vidéo (pour « Ouvrir dans le navigateur »).
pub fn watch_url(video_id: &str, stored: Option<&str>) -> String {
    if let Some(url) = stored.filter(|u| u.starts_with("https://")) {
        return url.to_string();
    }
    match platform_of(video_id) {
        Platform::YouTube => format!("https://www.youtube.com/watch?v={video_id}"),
        Platform::PeerTube => {
            let rest = video_id.get(3..).unwrap_or("");
            match rest.rsplit_once('@') {
                Some((uuid, host)) => format!("https://{host}/videos/watch/{uuid}"),
                None => String::new(),
            }
        }
        Platform::Vimeo => format!("https://vimeo.com/{}", video_id.get(3..).unwrap_or("")),
        Platform::Dailymotion => format!("https://www.dailymotion.com/video/{}", video_id.get(3..).unwrap_or("")),
        Platform::Odysee => "https://odysee.com".to_string(),
    }
}

// ---------- lecture des chaînes ----------

pub struct Fetched {
    pub title: String,
    pub avatar: Option<String>,
    pub description: Option<String>,
    pub videos: Vec<ParsedVideo>,
}

fn timestamp(date: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(date)
        .map(|d| d.timestamp())
        .unwrap_or(0)
}

async fn get_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|err| crate::tr!("connexion impossible ({err})", "connection failed ({err})"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    resp.text().await.map_err(|err| crate::tr!("lecture interrompue ({err})", "read interrupted ({err})"))
}

async fn get_json(http: &reqwest::Client, url: &str) -> Result<Value, String> {
    let text = get_text(http, url).await?;
    serde_json::from_str(&text).map_err(|err| crate::tr!("réponse illisible ({err})", "unreadable response ({err})"))
}

/// Dailymotion : l'auteur peut interdire l'intégration de sa vidéo (le lecteur affiche alors « Forbidden »).
/// En cas de doute (réseau, réponse inattendue), on tente quand même la lecture intégrée.
pub async fn dailymotion_embeddable(http: &reqwest::Client, video_id: &str) -> bool {
    let Some(id) = video_id.strip_prefix("dm:") else { return true };
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return true;
    }
    match get_json(http, &format!("https://api.dailymotion.com/video/{id}?fields=allow_embed")).await {
        Ok(json) => json["allow_embed"].as_bool() != Some(false),
        Err(_) => true,
    }
}

pub fn parse_peertube_videos(json: &Value, host: &str) -> Vec<ParsedVideo> {
    json["data"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| {
                    let uuid = v["uuid"].as_str()?;
                    Some(ParsedVideo {
                        id: format!("pt:{uuid}@{host}"),
                        title: v["name"].as_str().unwrap_or("").to_string(),
                        published: timestamp(v["publishedAt"].as_str().unwrap_or("")),
                        thumb: v["thumbnailPath"].as_str().map(|p| format!("https://{host}{p}")),
                        url: Some(format!("https://{host}/videos/watch/{uuid}")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn peertube_avatar(json: &Value, host: &str) -> Option<String> {
    let path = json["avatars"]
        .as_array()
        .and_then(|a| a.iter().find_map(|x| x["path"].as_str()))
        .or_else(|| json["avatar"]["path"].as_str())?;
    Some(format!("https://{host}{path}"))
}

async fn fetch_peertube(http: &reqwest::Client, id: &str) -> Result<Fetched, String> {
    let (name, host) = id
        .get(3..)
        .and_then(|rest| rest.rsplit_once('@'))
        .ok_or_else(|| crate::tr!("identifiant PeerTube invalide", "invalid PeerTube identifier"))?;
    let channel = get_json(http, &format!("https://{host}/api/v1/video-channels/{name}")).await?;
    let videos = get_json(
        http,
        &format!("https://{host}/api/v1/video-channels/{name}/videos?count=15&sort=-publishedAt"),
    )
    .await?;
    Ok(Fetched {
        title: channel["displayName"].as_str().unwrap_or(name).to_string(),
        avatar: peertube_avatar(&channel, host),
        description: channel["description"].as_str().filter(|d| !d.trim().is_empty()).map(String::from),
        videos: parse_peertube_videos(&videos, host),
    })
}

pub fn parse_dailymotion_videos(json: &Value) -> Vec<ParsedVideo> {
    json["list"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| {
                    let id = v["id"].as_str()?;
                    Some(ParsedVideo {
                        id: format!("dm:{id}"),
                        title: v["title"].as_str().unwrap_or("").to_string(),
                        published: v["created_time"].as_i64().unwrap_or(0),
                        thumb: v["thumbnail_360_url"].as_str().map(String::from),
                        url: Some(format!("https://www.dailymotion.com/video/{id}")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn fetch_dailymotion(http: &reqwest::Client, id: &str) -> Result<Fetched, String> {
    let name = id.get(3..).unwrap_or("");
    let user = get_json(
        http,
        &format!("https://api.dailymotion.com/user/{name}?fields=screenname,avatar_120_url,description"),
    )
    .await?;
    let videos = get_json(
        http,
        &format!("https://api.dailymotion.com/user/{name}/videos?fields=id,title,created_time,thumbnail_360_url&limit=15&sort=recent"),
    )
    .await?;
    Ok(Fetched {
        title: user["screenname"].as_str().unwrap_or(name).to_string(),
        avatar: user["avatar_120_url"].as_str().map(String::from),
        description: user["description"].as_str().filter(|d| !d.trim().is_empty()).map(String::from),
        videos: parse_dailymotion_videos(&videos),
    })
}

/// Lit un flux RSS/Atom et en tire des vidéos : `extract` transforme l'adresse d'une entrée
/// en identifiant de vidéo (ou l'écarte).
fn parse_rss(bytes: &[u8], extract: impl Fn(&str) -> Option<String>) -> Result<Fetched, String> {
    let feed = parser::parse(bytes).map_err(|err| crate::tr!("flux illisible ({err})", "unreadable feed ({err})"))?;
    let mut videos = Vec::new();
    for entry in feed.entries {
        let Some(link) = entry.links.first().map(|l| l.href.clone()) else { continue };
        let Some(id) = extract(&link) else { continue };
        // Une entrée qui annonce un contenu autre que vidéo (article, texte…) n'est pas une vidéo.
        let types: Vec<String> = entry
            .media
            .iter()
            .flat_map(|m| m.content.iter())
            .filter_map(|c| c.content_type.as_ref().map(|t| t.to_string()))
            .collect();
        if !types.is_empty() && !types.iter().any(|t| t.starts_with("video/")) {
            continue;
        }
        videos.push(ParsedVideo {
            id,
            title: entry.title.map(|t| t.content).unwrap_or_default(),
            published: entry.published.or(entry.updated).map(|d| d.timestamp()).unwrap_or(0),
            thumb: entry
                .media
                .iter()
                .flat_map(|m| m.thumbnails.iter())
                .next()
                .map(|t| t.image.uri.clone()),
            url: Some(link),
        });
    }
    Ok(Fetched {
        title: feed.title.map(|t| t.content).unwrap_or_default(),
        avatar: feed.logo.map(|l| l.uri).filter(|u| u.starts_with("https://")),
        description: feed
            .description
            .map(|d| d.content)
            .filter(|d| !d.trim().is_empty()),
        videos,
    })
}

pub fn vimeo_id(link: &str) -> Option<String> {
    let caps = Regex::new(r"vimeo\.com/(?:[^?#]*/)?(\d{4,})").ok()?.captures(link)?;
    Some(format!("vi:{}", &caps[1]))
}

pub fn odysee_id(link: &str) -> Option<String> {
    let caps = Regex::new(r"odysee\.com/(?:@[^/]+/)?([^/:?#]+):([0-9a-fA-F]+)").ok()?.captures(link)?;
    Some(format!("od:{}:{}", &caps[1], &caps[2]))
}

async fn fetch_rss(http: &reqwest::Client, url: &str, extract: fn(&str) -> Option<String>) -> Result<Fetched, String> {
    let resp = http
        .get(url)
        .send()
        .await
        .map_err(|err| format!("connexion impossible ({err})"))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(|err| format!("lecture interrompue ({err})"))?;
    parse_rss(&bytes, extract)
}

/// Titre, avatar, descriptif et dernières vidéos d'une chaîne d'une autre plateforme que YouTube.
pub async fn fetch(http: &reqwest::Client, channel_id: &str) -> Result<Fetched, String> {
    let rest = channel_id.get(3..).unwrap_or("");
    let mut fetched = match platform_of(channel_id) {
        Platform::YouTube => return Err("Chaîne YouTube : utilise la lecture YouTube.".into()),
        Platform::PeerTube => fetch_peertube(http, channel_id).await?,
        Platform::Dailymotion => fetch_dailymotion(http, channel_id).await?,
        Platform::Vimeo => {
            fetch_rss(http, &format!("https://vimeo.com/{rest}/videos/rss"), vimeo_id).await?
        }
        Platform::Odysee => {
            fetch_rss(http, &format!("https://odysee.com/$/rss/{rest}"), odysee_id).await?
        }
    };
    if fetched.title.trim().is_empty() {
        fetched.title = rest.trim_start_matches('@').split(':').next().unwrap_or(rest).to_string();
    }
    Ok(fetched)
}

/// Pour une adresse de vidéo PeerTube : retrouve la chaîne (`nom@instance`).
/// Retrouve la chaîne d'une vidéo (PeerTube, Dailymotion ou Vimeo) à partir de son adresse.
pub async fn channel_of_video(http: &reqwest::Client, kind: &Kind) -> Result<String, String> {
    match kind {
        Kind::Channel(id) => Ok(id.clone()),
        Kind::PeerTubeVideo { host, uuid } => peertube_channel_of_video(http, host, uuid).await,
        Kind::DailymotionVideo(id) => {
            let video = get_json(http, &format!("https://api.dailymotion.com/video/{id}?fields=owner.username")).await?;
            let name = video["owner.username"].as_str().filter(|n| valid_name(n)).ok_or_else(|| crate::tr!("chaîne introuvable", "channel not found"))?;
            Ok(format!("dm:{name}"))
        }
        Kind::VimeoVideo(id) => {
            let video = get_json(http, &format!("https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F{id}")).await?;
            let author = video["author_url"].as_str().unwrap_or("");
            let name = author.trim_end_matches('/').rsplit('/').next().unwrap_or("");
            if valid_name(name) && !name.is_empty() {
                Ok(format!("vi:{name}"))
            } else {
                Err(crate::tr!("chaîne introuvable", "channel not found"))
            }
        }
    }
}

pub async fn peertube_channel_of_video(http: &reqwest::Client, host: &str, uuid: &str) -> Result<String, String> {
    let video = get_json(http, &format!("https://{host}/api/v1/videos/{uuid}")).await?;
    let name = video["channel"]["name"].as_str().ok_or_else(|| crate::tr!("chaîne introuvable", "channel not found"))?;
    let chan_host = video["channel"]["host"].as_str().unwrap_or(host);
    // Une chaîne distante est lue depuis l'instance où elle vit ; sinon depuis celle de l'adresse.
    Ok(format!("pt:{name}@{}", if chan_host.is_empty() { host } else { chan_host }.to_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(input: &str) -> Option<String> {
        match detect(input) {
            Ok(Some(Detected { kind: Kind::Channel(id), .. })) => Some(id),
            _ => None,
        }
    }

    #[test]
    fn reconnait_les_adresses_des_plateformes() {
        assert_eq!(channel("framasoft@framatube.org").as_deref(), Some("pt:framasoft@framatube.org"));
        assert_eq!(channel("https://framatube.org/c/framasoft_channel/videos").as_deref(), Some("pt:framasoft_channel@framatube.org"));
        assert_eq!(channel("https://framatube.org/c/framablog.audio/videos").as_deref(), Some("pt:framablog.audio@framatube.org"));
        assert_eq!(channel("https://peertube.example/video-channels/chat").as_deref(), Some("pt:chat@peertube.example"));
        assert_eq!(channel("https://odysee.com/@Nom:c/une-video:a").as_deref(), Some("od:@Nom:c"));
        assert_eq!(channel("https://odysee.com/@Nom%3Ac").as_deref(), Some("od:@Nom:c"));
        assert_eq!(channel("https://vimeo.com/staff").as_deref(), Some("vi:staff"));
        assert_eq!(channel("vimeo.com/channels/staffpicks").as_deref(), Some("vi:channels/staffpicks"));
        assert_eq!(channel("https://www.dailymotion.com/france24").as_deref(), Some("dm:france24"));
        assert_eq!(channel("https://www.dailymotion.com/user/france24").as_deref(), Some("dm:france24"));
    }

    #[test]
    fn youtube_et_inconnu_ne_sont_pas_pour_nous() {
        assert_eq!(detect("@Fireship"), Ok(None));
        assert_eq!(detect("UCabcdefghijklmnopqrstuv"), Ok(None));
        assert_eq!(detect("https://www.youtube.com/@Fireship"), Ok(None));
        assert_eq!(detect("https://exemple.org/quelque-chose"), Ok(None));
        assert_eq!(detect("Fireship"), Ok(None));
    }

    #[test]
    fn adresses_de_video_ou_incompletes() {
        assert!(detect("https://odysee.com/une-video:abc").is_err());
        assert_eq!(detect("https://vimeo.com/123456789").unwrap().unwrap().kind, Kind::VimeoVideo("123456789".into()));
        assert_eq!(
            detect("https://www.dailymotion.com/video/xbnv85q").unwrap().unwrap().kind,
            Kind::DailymotionVideo("xbnv85q".into())
        );
        assert_eq!(
            detect("https://www.dailymotion.com/video/x8abc_titre-de-la-video").unwrap().unwrap().kind,
            Kind::DailymotionVideo("x8abc".into())
        );
        assert_eq!(
            detect("https://framatube.org/w/p3KkDCa7ZGyKLgLiDnA3dJ").unwrap().unwrap().kind,
            Kind::PeerTubeVideo { host: "framatube.org".into(), uuid: "p3KkDCa7ZGyKLgLiDnA3dJ".into() }
        );
    }

    #[test]
    fn plateforme_d_un_identifiant() {
        assert_eq!(platform_of("UCabcdefghijklmnopqrstuv"), Platform::YouTube);
        assert_eq!(platform_of("dQw4w9WgXcQ"), Platform::YouTube);
        assert_eq!(platform_of("pt:abc@host.tld"), Platform::PeerTube);
        assert_eq!(platform_of("od:video:abc"), Platform::Odysee);
        assert_eq!(platform_of("vi:123"), Platform::Vimeo);
        assert_eq!(platform_of("dm:x8abc"), Platform::Dailymotion);
    }

    #[test]
    fn plateformes_actives() {
        let l = enabled_platforms("vimeo, peertube,inconnue");
        assert_eq!(l, vec![Platform::YouTube, Platform::Vimeo, Platform::PeerTube]);
        assert_eq!(enabled_platforms(""), vec![Platform::YouTube]);
        // Dailymotion est mise de côté : elle ne peut pas être activée.
        assert_eq!(enabled_platforms("dailymotion"), vec![Platform::YouTube]);
        assert_eq!(normalize_platforms("youtube,odysee,odysee,nimporte"), "odysee");
    }

    #[test]
    fn adresses_de_lecture() {
        assert_eq!(embed_url("dQw4w9WgXcQ"), None);
        assert_eq!(
            embed_url("pt:uuid-1@framatube.org").as_deref(),
            Some("https://framatube.org/videos/embed/uuid-1?autoplay=1&title=0&warningTitle=0")
        );
        assert_eq!(embed_url("vi:123456").as_deref(), Some("https://player.vimeo.com/video/123456?autoplay=1"));
        assert_eq!(embed_url("dm:x8abc").as_deref(), Some("https://www.dailymotion.com/embed/video/x8abc?autoplay=1"));
        assert_eq!(embed_url("od:ma-video:a1b2").as_deref(), Some("https://odysee.com/$/embed/ma-video/a1b2?autoplay=true"));
        assert_eq!(watch_url("dQw4w9WgXcQ", None), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(watch_url("vi:1", Some("https://vimeo.com/1")), "https://vimeo.com/1");
    }

    #[test]
    fn videos_peertube() {
        let json: Value = serde_json::from_str(
            r#"{"total":2,"data":[
                {"uuid":"aaa-1","name":"Premier","publishedAt":"2026-10-01T10:00:00.000Z","thumbnailPath":"/lazy-static/thumbnails/aaa.jpg"},
                {"name":"Sans identifiant"}]}"#,
        )
        .unwrap();
        let v = parse_peertube_videos(&json, "framatube.org");
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].id, "pt:aaa-1@framatube.org");
        assert_eq!(v[0].published, 1_790_848_800);
        assert_eq!(v[0].thumb.as_deref(), Some("https://framatube.org/lazy-static/thumbnails/aaa.jpg"));
    }

    #[test]
    fn videos_dailymotion() {
        let json: Value = serde_json::from_str(
            r#"{"list":[{"id":"x8abc","title":"Reportage","created_time":1790000000,"thumbnail_360_url":"https://s1.dmcdn.net/v/a.jpg"}]}"#,
        )
        .unwrap();
        let v = parse_dailymotion_videos(&json);
        assert_eq!(v[0].id, "dm:x8abc");
        assert_eq!(v[0].published, 1_790_000_000);
    }

    #[test]
    fn flux_vimeo_et_odysee() {
        let vimeo = r#"<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
            <title>Staff</title><description>Des films</description>
            <item><title>Court-métrage</title><link>https://vimeo.com/123456789</link><pubDate>Wed, 01 Oct 2026 10:00:00 +0000</pubDate>
            <media:thumbnail url="https://i.vimeocdn.com/video/1.jpg"/></item></channel></rss>"#;
        let f = parse_rss(vimeo.as_bytes(), vimeo_id).unwrap();
        assert_eq!(f.title, "Staff");
        assert_eq!(f.videos[0].id, "vi:123456789");
        assert_eq!(f.videos[0].thumb.as_deref(), Some("https://i.vimeocdn.com/video/1.jpg"));

        let odysee = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Ma chaine</title>
            <item><title>Ma vidéo</title><link>https://odysee.com/@Nom:c/ma-video:a1b2c3</link><pubDate>Wed, 01 Oct 2026 10:00:00 +0000</pubDate></item></channel></rss>"#;
        let f = parse_rss(odysee.as_bytes(), odysee_id).unwrap();
        assert_eq!(f.videos[0].id, "od:ma-video:a1b2c3");
        assert_eq!(f.videos[0].url.as_deref(), Some("https://odysee.com/@Nom:c/ma-video:a1b2c3"));
    }

    #[test]
    fn odysee_ignore_les_articles() {
        let flux = r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Ma chaine</title>
            <item><title>Un article</title><link>https://odysee.com/@Nom:c/un-article:aaa</link><enclosure url="https://odysee.com/a.md" type="text/markdown" length="10"/></item>
            <item><title>Une video</title><link>https://odysee.com/@Nom:c/une-video:bbb</link><enclosure url="https://odysee.com/v.mp4" type="video/mp4" length="10"/></item>
            <item><title>Sans type</title><link>https://odysee.com/@Nom:c/sans-type:ccc</link></item>
            </channel></rss>"#;
        let f = parse_rss(flux.as_bytes(), odysee_id).unwrap();
        let ids: Vec<_> = f.videos.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["od:une-video:bbb", "od:sans-type:ccc"]);
    }
}
