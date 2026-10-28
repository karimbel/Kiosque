mod db;
mod feed;
mod i18n;
mod providers;
mod resolve;

use db::{Channel, Db, Video};
use providers::Platform;
use futures::StreamExt;
use serde::Serialize;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;

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
            return Err(tr!(
                "Cette adresse est une chaîne {name}. Active {name} dans Chaînes → Plateformes pour la suivre.",
                "This address is a {name} channel. Turn {name} on in Channels → Platforms to follow it."
            ));
        }
        let id = providers::channel_of_video(&state.http, &found.kind)
            .await
            .map_err(|err| tr!("Impossible de retrouver la chaîne de cette vidéo ({err}).", "Could not find this video's channel ({err})."))?;
        return add_other_channel(&state, id).await;
    }
    let id = resolve::resolve_channel_id(&state.http, &input).await?;
    let meta = feed::fetch_channel_feed(&state.http, &id)
        .await
        .map_err(|err| tr!("Le flux de cette chaîne est inaccessible ({err}). Vérifie l'adresse.", "This channel's feed is unreachable ({err}). Check the address."))?;
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
        .ok_or_else(|| tr!("La chaîne est introuvable après son ajout.", "The channel could not be found after adding it."))
}

/// Ajoute une chaîne PeerTube, Odysee, Vimeo ou Dailymotion.
async fn add_other_channel(state: &AppState, id: String) -> Result<Channel, String> {
    let fetched = providers::fetch(&state.http, &id)
        .await
        .map_err(|err| tr!("Cette chaîne est inaccessible ({err}). Vérifie l'adresse.", "This channel is unreachable ({err}). Check the address."))?;
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
        .ok_or_else(|| tr!("La chaîne est introuvable après son ajout.", "The channel could not be found after adding it."))
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
        return Err(tr!("Identifiant de vidéo invalide.", "Invalid video ID."));
    }
    let url = state.db.video_page(&id)?;
    if !url.starts_with("https://") {
        return Err(tr!("Adresse de la vidéo introuvable.", "Video address not found."));
    }
    open::that(&url).map_err(|err| tr!("Impossible d'ouvrir le navigateur : {err}", "Could not open the browser: {err}"))?;
    state.db.set_state(&id, "seen")
}

// ---------- réglages ----------

const SETTINGS: [(&str, &str); 5] = [
    ("player", "inapp"),
    ("exclude_shorts", "1"),
    ("platforms", ""),
    ("auto_update", "0"),
    ("language", ""), // vide = langue du système
];

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
        return Err(tr!("Réglage inconnu : {key}", "Unknown setting: {key}"));
    }
    if key == "player" && !["inapp", "browser"].contains(&value.trim()) {
        return Err(tr!("Lecteur inconnu : {value}", "Unknown player: {value}"));
    }
    if key == "language" && !["", "fr", "en"].contains(&value.trim()) {
        return Err(tr!("Langue inconnue : {value}", "Unknown language: {value}"));
    }
    if key == "platforms" {
        return state.db.set_setting(&key, &providers::normalize_platforms(&value));
    }
    state.db.set_setting(&key, value.trim())
}

// ---------- nouvelle version ----------

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    url: String,
}

const RELEASES_API: &str = "https://api.github.com/repos/karimbel/kiosque/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/karimbel/kiosque/releases/latest";

/// Les trois nombres d'une version (« v0.1.5 » ou « 0.1.5 »).
fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let mut parts = text.trim().trim_start_matches('v').split('.');
    let a = parts.next()?.parse().ok()?;
    let b = parts.next()?.parse().ok()?;
    let c = parts.next()?.split(|ch: char| !ch.is_ascii_digit()).next()?.parse().ok()?;
    Some((a, b, c))
}

struct Release {
    version: (u32, u32, u32),
    assets: Vec<(String, String)>, // (nom du fichier, adresse de téléchargement)
}

async fn latest_release(http: &reqwest::Client) -> Result<Option<Release>, String> {
    let text = http
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|err| err.to_string())?
        .text()
        .await
        .map_err(|err| err.to_string())?;
    let body: serde_json::Value = serde_json::from_str(&text).map_err(|err| err.to_string())?;
    let Some(version) = body["tag_name"].as_str().and_then(parse_version) else {
        return Ok(None);
    };
    let assets = body["assets"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|a| Some((a["name"].as_str()?.to_string(), a["browser_download_url"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(Some(Release { version, assets }))
}

/// Compare la version installée à la dernière release GitHub. Silencieux en cas d'échec.
#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<Option<UpdateInfo>, String> {
    let Some(current) = parse_version(env!("CARGO_PKG_VERSION")) else {
        return Ok(None);
    };
    match latest_release(&state.http).await? {
        Some(r) if r.version > current => {
            let version = format!("{}.{}.{}", r.version.0, r.version.1, r.version.2);
            // Notification système, une seule fois par version, et seulement si l'installation n'est pas automatique.
            let automatic = state.db.get_setting("auto_update").ok().flatten().as_deref() == Some("1");
            let already = state.db.get_setting("notified_update").ok().flatten().as_deref() == Some(version.as_str());
            if !automatic && !already {
                let _ = app
                    .notification()
                    .builder()
                    .title("Kiosque")
                    .body(tr!(
                        "La version {version} est disponible.",
                        "Version {version} is available."
                    ))
                    .show();
                let _ = state.db.set_setting("notified_update", &version);
            }
            Ok(Some(UpdateInfo { version, url: RELEASES_PAGE.to_string() }))
        }
        _ => Ok(None),
    }
}

/// Le fichier de la release qui correspond à cette installation, sur GitHub uniquement.
fn pick_asset(assets: &[(String, String)], portable: bool) -> Option<&str> {
    let suffix = if portable { "_portable.exe" } else { "_x64-setup.exe" };
    assets
        .iter()
        .find(|(name, url)| {
            name.ends_with(suffix)
                && url.to_ascii_lowercase().starts_with("https://github.com/karimbel/kiosque/releases/download/")
        })
        .map(|(_, url)| url.as_str())
}

/// Version installée par l'installeur : un `uninstall.exe` se trouve à côté du programme.
fn is_portable(exe: &std::path::Path) -> bool {
    !exe.parent().map(|dir| dir.join("uninstall.exe").exists()).unwrap_or(false)
}

/// Journal de la mise à jour (`update.log` dans le dossier des données de Kiosque) : une ligne par étape.
fn log_update(app: &AppHandle, message: &str) {
    use std::io::Write;
    let Ok(dir) = app.path().app_data_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("update.log")) {
        let _ = writeln!(file, "[{}] {message}", now());
    }
}

/// Télécharge la dernière version, la met en place et relance Kiosque.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    log_update(&app, &format!("début, version installée {}", env!("CARGO_PKG_VERSION")));
    let result = install_update_inner(&app, &state).await;
    match &result {
        Ok(()) => log_update(&app, "terminé, fermeture de Kiosque"),
        Err(err) => log_update(&app, &format!("ÉCHEC : {err}")),
    }
    result
}

async fn install_update_inner(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let current = parse_version(env!("CARGO_PKG_VERSION")).ok_or_else(|| tr!("Version inconnue.", "Unknown version."))?;
    let release = latest_release(&state.http).await?.ok_or_else(|| tr!("Aucune version trouvée.", "No version found."))?;
    if release.version <= current {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|err| err.to_string())?;
    let portable = is_portable(&exe);
    log_update(app, &format!("programme : {} ({})", exe.display(), if portable { "portable" } else { "installé" }));
    let url = pick_asset(&release.assets, portable)
        .ok_or_else(|| tr!("Le fichier de cette version est introuvable sur GitHub.", "This version's file was not found on GitHub."))?
        .to_string();

    let http = reqwest::Client::builder()
        .user_agent("Kiosque")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|err| err.to_string())?;
    log_update(app, &format!("téléchargement : {url}"));
    let mut response = http
        .get(&url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|err| tr!("Téléchargement impossible ({err}).", "Download failed ({err})."))?;
    let total = response.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut last = 101u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| tr!("Téléchargement interrompu ({err}).", "Download interrupted ({err})."))?
    {
        bytes.extend_from_slice(&chunk);
        if total > 0 {
            let percent = (bytes.len() as u64 * 100 / total).min(100);
            if percent != last {
                last = percent;
                let _ = app.emit("update-progress", percent);
            }
        }
    }
    if bytes.len() < 1_000_000 || &bytes[..2] != b"MZ" {
        return Err(tr!("Le fichier téléchargé n'est pas valide.", "The downloaded file is not valid."));
    }

    log_update(app, &format!("{} octets reçus", bytes.len()));
    if portable {
        // Windows laisse renommer un programme en cours d'exécution : l'ancien est mis de côté,
        // le nouveau prend sa place, puis l'ancien est supprimé au lancement suivant.
        let old = exe.with_extension("old");
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old).map_err(|err| tr!("Remplacement impossible ({err}).", "Replacement failed ({err})."))?;
        if let Err(err) = std::fs::write(&exe, &bytes) {
            let _ = std::fs::remove_file(&exe);
            let _ = std::fs::rename(&old, &exe);
            return Err(tr!("Écriture impossible ({err}).", "Write failed ({err})."));
        }
        log_update(app, "ancien programme mis de côté, nouveau programme écrit");
        std::process::Command::new(&exe)
            .spawn()
            .map_err(|err| tr!("Relance impossible ({err}).", "Restart failed ({err})."))?;
        log_update(app, "nouveau programme lancé");
    } else {
        let setup = std::env::temp_dir().join("Kiosque-mise-a-jour-setup.exe");
        std::fs::write(&setup, &bytes).map_err(|err| tr!("Écriture impossible ({err}).", "Write failed ({err})."))?;
        std::process::Command::new(&setup)
            .args(["/P", "/R", "/UPDATE"])
            .spawn()
            .map_err(|err| tr!("Installation impossible ({err}).", "Installation failed ({err})."))?;
        log_update(app, &format!("installeur lancé : {}", setup.display()));
    }
    app.exit(0);
    Ok(())
}

/// Version de Kiosque en cours d'utilisation.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Ouvre la page de la dernière release dans le navigateur.
#[tauri::command]
fn open_release() -> Result<(), String> {
    open::that(RELEASES_PAGE).map_err(|err| tr!("Impossible d'ouvrir le navigateur : {err}", "Could not open the browser: {err}"))
}

/// Ouvre le dépôt GitHub du projet dans le navigateur.
#[tauri::command]
fn open_repo() -> Result<(), String> {
    open::that("https://github.com/karimbel/Kiosque").map_err(|err| tr!("Impossible d'ouvrir le navigateur : {err}", "Could not open the browser: {err}"))
}

/// Langue des messages du programme : l'interface l'envoie au démarrage et à chaque changement.
#[tauri::command]
fn set_language(code: String) {
    i18n::set_language(&code);
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
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Reste d'une mise à jour de la version portable.
            if let Ok(exe) = std::env::current_exe() {
                let _ = std::fs::remove_file(exe.with_extension("old"));
            }
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
            app_version,
            check_update,
            set_language,
            install_update,
            open_release,
            open_repo,
            get_autostart,
            set_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Kiosque");
}

#[cfg(test)]
mod tests {
    use super::{parse_version, pick_asset};

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.1.5"), Some((0, 1, 5)));
        assert_eq!(parse_version("0.2.10"), Some((0, 2, 10)));
        assert_eq!(parse_version("v1.0.0-beta"), Some((1, 0, 0)));
        assert_eq!(parse_version("n'importe quoi"), None);
        assert!(parse_version("v0.1.10") > parse_version("v0.1.9"));
    }

    #[test]
    fn choix_du_fichier() {
        let base = "https://github.com/karimbel/kiosque/releases/download/v0.1.6/";
        let assets = vec![
            ("Kiosque_0.1.6_x64-setup.exe".to_string(), format!("{base}Kiosque_0.1.6_x64-setup.exe")),
            ("Kiosque_0.1.6_portable.exe".to_string(), format!("{base}Kiosque_0.1.6_portable.exe")),
            ("Kiosque_0.1.6_evil_portable.exe".to_string(), "https://exemple.com/x_portable.exe".to_string()),
        ];
        assert!(pick_asset(&assets, false).unwrap().ends_with("_x64-setup.exe"));
        assert!(pick_asset(&assets, true).unwrap().ends_with("0.1.6_portable.exe"));
        assert_eq!(pick_asset(&assets[2..], true), None);
        // GitHub renvoie le nom du dépôt avec sa casse d'origine (« Kiosque »).
        let real = vec![("Kiosque_0.1.9_portable.exe".to_string(), "https://github.com/karimbel/Kiosque/releases/download/v0.1.9/Kiosque_0.1.9_portable.exe".to_string())];
        assert!(pick_asset(&real, true).is_some());
    }
}
