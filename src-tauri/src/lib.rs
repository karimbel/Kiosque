mod db;
mod feed;
mod providers;
mod resolve;

use db::{Channel, Db, Video};
use providers::Platform;
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

struct AppState {
    db: Db,
    http: reqwest::Client,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Serialize)]
struct RefreshReport {
    new_videos: usize,
    errors: Vec<String>,
}

// ---------- chaînes ----------

#[tauri::command]
async fn add_channel(state: State<'_, AppState>, input: String) -> Result<Channel, String> {
    // Une autre plateforme que YouTube ? Elle doit avoir été activée dans les réglages.
    if let Some(found) = providers::detect(&input)? {
        let active = providers::enabled_platforms(&state.db.get_setting("platforms")?.unwrap_or_default());
        if !active.contains(&found.platform) {
            let name = found.platform.label();
            return Err(format!(
                "Cette adresse est une chaîne {name}. Active {name} dans Chaînes → Plateformes pour la suivre."
            ));
        }
        let id = match found.kind {
            providers::Kind::Channel(id) => id,
            providers::Kind::PeerTubeVideo { host, uuid } => {
                providers::peertube_channel_of_video(&state.http, &host, &uuid)
                    .await
                    .map_err(|err| format!("Vidéo PeerTube introuvable ({err})."))?
            }
        };
        return add_other_channel(&state, id).await;
    }
    let id = resolve::resolve_channel_id(&state.http, &input).await?;
    let meta = feed::fetch_channel_feed(&state.http, &id)
        .await
        .map_err(|err| format!("Le flux de cette chaîne est inaccessible ({err}). Vérifie l'adresse."))?;
    let title = if meta.title.trim().is_empty() {
        id.clone()
    } else {
        meta.title.clone()
    };

    if state.db.add_channel(&id, &title, now())? {
        let exclude_shorts = state.db.exclude_shorts();
        let videos = match feed::fetch_videos(&state.http, &id, exclude_shorts).await {
            Ok(f) => f.videos,
            Err(_) => meta.videos,
        };
        state.db.upsert_videos(&id, &videos, true, now())?;
        // Avatar et descriptif : facultatifs, un échec n'empêche pas d'ajouter la chaîne.
        if let Some(p) = resolve::fetch_profile(&state.http, &id).await {
            state.db.set_profile(&id, p.avatar.as_deref(), &p.description, p.genre.as_deref())?;
        }
    }

    state
        .db
        .list_channels()?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "La chaîne est introuvable après son ajout.".to_string())
}

/// Ajoute une chaîne PeerTube, Odysee, Vimeo ou Dailymotion.
async fn add_other_channel(state: &AppState, id: String) -> Result<Channel, String> {
    let fetched = providers::fetch(&state.http, &id)
        .await
        .map_err(|err| format!("Cette chaîne est inaccessible ({err}). Vérifie l'adresse."))?;
    if state.db.add_channel(&id, &fetched.title, now())? {
        state.db.upsert_videos(&id, &fetched.videos, true, now())?;
        state.db.set_profile(
            &id,
            fetched.avatar.as_deref(),
            fetched.description.as_deref().unwrap_or(""),
            None,
        )?;
    }
    state
        .db
        .list_channels()?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| "La chaîne est introuvable après son ajout.".to_string())
}

#[tauri::command]
fn list_channels(state: State<'_, AppState>) -> Result<Vec<Channel>, String> {
    state.db.list_channels()
}

#[tauri::command]
fn set_channel_category(state: State<'_, AppState>, id: String, category: String) -> Result<(), String> {
    state.db.set_category(&id, &category)
}

#[tauri::command]
fn remove_channel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.remove_channel(&id)
}

// ---------- vidéos ----------

#[tauri::command]
async fn refresh(state: State<'_, AppState>) -> Result<RefreshReport, String> {
    let channels = state.db.list_channels()?;
    let exclude_shorts = state.db.exclude_shorts();
    let http = state.http.clone();

    let results: Vec<_> = futures::stream::iter(channels.into_iter().map(|channel| {
        let http = http.clone();
        async move {
            let result = if providers::platform_of(&channel.id) == Platform::YouTube {
                feed::fetch_videos(&http, &channel.id, exclude_shorts)
                    .await
                    .map(|f| f.videos)
            } else {
                providers::fetch(&http, &channel.id).await.map(|f| f.videos)
            };
            (channel, result)
        }
    }))
    .buffer_unordered(6)
    .collect()
    .await;

    // Chaînes sans profil enregistré (suivies avant les avatars, ou page injoignable) : on le récupère.
    let missing: Vec<String> = state
        .db
        .list_channels()?
        .into_iter()
        .filter(|c| c.description.is_none() && c.platform == "youtube")
        .map(|c| c.id)
        .collect();
    let avatars: Vec<_> = futures::stream::iter(missing.into_iter().map(|id| {
        let http = http.clone();
        async move { (id.clone(), resolve::fetch_profile(&http, &id).await) }
    }))
    .buffer_unordered(4)
    .collect()
    .await;
    for (id, profile) in avatars {
        if let Some(p) = profile {
            let _ = state.db.set_profile(&id, p.avatar.as_deref(), &p.description, p.genre.as_deref());
        }
    }

    let mut report = RefreshReport {
        new_videos: 0,
        errors: Vec::new(),
    };
    let t = now();
    for (channel, result) in results {
        match result {
            Ok(videos) => match state.db.upsert_videos(&channel.id, &videos, false, t) {
                Ok(n) => report.new_videos += n,
                Err(err) => report.errors.push(format!("{} : {err}", channel.title)),
            },
            Err(err) => report.errors.push(format!("{} : {err}", channel.title)),
        }
    }
    Ok(report)
}

#[tauri::command]
fn list_videos(state: State<'_, AppState>, status: String) -> Result<Vec<Video>, String> {
    state.db.list_videos(&status, 300)
}

/// La dernière vidéo de chaque chaîne, vue ou non : sert quand « À voir » est vide.
#[tauri::command]
fn latest_videos(state: State<'_, AppState>) -> Result<Vec<Video>, String> {
    state.db.latest_videos(24)
}

#[tauri::command]
fn set_status(state: State<'_, AppState>, id: String, status: String) -> Result<(), String> {
    state.db.set_state(&id, &status)
}

#[tauri::command]
fn mark_all_seen(state: State<'_, AppState>) -> Result<usize, String> {
    state.db.mark_all_seen()
}

/// Ouvre la vidéo dans le navigateur et la range comme « vue ».
/// Le lecteur intégré est géré par l'interface : cette commande ne sert qu'au bouton
/// « Ouvrir dans le navigateur » et au réglage « Navigateur ».
#[tauri::command]
fn open_video(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if providers::platform_of(&id) == Platform::YouTube && !feed::is_video_id(&id) {
        return Err("Identifiant de vidéo invalide.".into());
    }
    let url = state.db.video_page(&id)?;
    if !url.starts_with("https://") {
        return Err("Adresse de la vidéo introuvable.".into());
    }
    open::that(&url).map_err(|err| format!("Impossible d'ouvrir le navigateur : {err}"))?;
    state.db.set_state(&id, "seen")
}

// ---------- réglages ----------

const SETTINGS: [(&str, &str); 3] = [("player", "inapp"), ("exclude_shorts", "1"), ("platforms", "")];

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    for (key, default) in SETTINGS {
        let value = state.db.get_setting(key)?.unwrap_or_else(|| default.to_string());
        out.insert(key.to_string(), value);
    }
    Ok(out)
}

#[tauri::command]
fn set_setting(state: State<'_, AppState>, key: String, value: String) -> Result<(), String> {
    if !SETTINGS.iter().any(|(k, _)| *k == key) {
        return Err(format!("Réglage inconnu : {key}"));
    }
    if key == "player" && !["inapp", "browser"].contains(&value.trim()) {
        return Err(format!("Lecteur inconnu : {value}"));
    }
    if key == "platforms" {
        return state.db.set_setting(&key, &providers::normalize_platforms(&value));
    }
    state.db.set_setting(&key, value.trim())
}

// ---------- lancement au démarrage de l'ordinateur ----------

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|err| err.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let launcher = app.autolaunch();
    if enabled {
        launcher.enable().map_err(|err| err.to_string())?;
    } else {
        launcher.disable().map_err(|err| err.to_string())?;
    }
    launcher.is_enabled().map_err(|err| err.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
            let db = Db::open(&dir.join("kiosque.sqlite3"))?;
            app.manage(AppState {
                db,
                http: feed::client(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_channel,
            list_channels,
            remove_channel,
            set_channel_category,
            refresh,
            list_videos,
            latest_videos,
            set_status,
            mark_all_seen,
            open_video,
            get_settings,
            set_setting,
            get_autostart,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Kiosque");
}
