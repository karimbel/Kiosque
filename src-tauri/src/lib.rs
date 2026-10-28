mod db;
mod feed;
mod resolve;

use db::{Channel, Db, Video};
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

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
            let result = feed::fetch_videos(&http, &channel.id, exclude_shorts).await;
            (channel, result)
        }
    }))
    .buffer_unordered(6)
    .collect()
    .await;

    let mut report = RefreshReport {
        new_videos: 0,
        errors: Vec::new(),
    };
    let t = now();
    for (channel, result) in results {
        match result {
            Ok(f) => match state.db.upsert_videos(&channel.id, &f.videos, false, t) {
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

/// Ouvre la vidéo hors de la fenêtre (mpv ou navigateur) et la range comme « vue ».
/// Le lecteur intégré est géré par l'interface ; sans choix explicite, le réglage « inapp »
/// retombe ici sur le navigateur.
/// Retourne le lecteur réellement utilisé : "mpv", "browser" ou "mpv-missing" (mpv introuvable,
/// rien n'est ouvert et le réglage repasse sur le lecteur intégré).
#[tauri::command]
fn open_video(
    state: State<'_, AppState>,
    id: String,
    player: Option<String>,
) -> Result<String, String> {
    if !feed::is_video_id(&id) {
        return Err("Identifiant de vidéo invalide.".into());
    }
    let url = format!("https://www.youtube.com/watch?v={id}");
    let player = match player {
        Some(p) => p,
        None => state
            .db
            .get_setting("player")?
            .unwrap_or_else(|| "inapp".into()),
    };

    let used = if player == "mpv" {
        let bin = state
            .db
            .get_setting("mpv_path")?
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "mpv".into());
        let mut cmd = Command::new(bin.trim());
        cmd.arg(&url)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.spawn() {
            Ok(_) => "mpv",
            Err(_) => {
                // mpv n'est pas installé : on revient au lecteur intégré pour la suite,
                // et l'interface lit elle-même la vidéo dans la fenêtre.
                state.db.set_setting("player", "inapp")?;
                return Ok("mpv-missing".to_string());
            }
        }
    } else {
        open::that(&url).map_err(|err| format!("Impossible d'ouvrir le navigateur : {err}"))?;
        "browser"
    };

    state.db.set_state(&id, "seen")?;
    Ok(used.to_string())
}

// ---------- réglages ----------

const SETTINGS: [(&str, &str); 3] = [("player", "inapp"), ("mpv_path", "mpv"), ("exclude_shorts", "1")];

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
    if key == "player" && !["inapp", "browser", "mpv"].contains(&value.trim()) {
        return Err(format!("Lecteur inconnu : {value}"));
    }
    state.db.set_setting(&key, value.trim())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            refresh,
            list_videos,
            latest_videos,
            set_status,
            mark_all_seen,
            open_video,
            get_settings,
            set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Kiosque");
}
