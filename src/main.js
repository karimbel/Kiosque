'use strict';

const view = document.querySelector('#view');
const statusEl = document.querySelector('#status');
const refreshBtn = document.querySelector('#refresh');
const tabButtons = [...document.querySelectorAll('.tabs [data-tab]')];

// ---------- barre de navigation rétractable ----------

const navToggle = document.querySelector('#nav-toggle');

function setNav(collapsed, save = true) {
  document.documentElement.dataset.nav = collapsed ? 'collapsed' : 'expanded';
  const label = t(collapsed ? 'Agrandir la barre de navigation' : 'Réduire la barre de navigation');
  navToggle.setAttribute('aria-expanded', String(!collapsed));
  navToggle.setAttribute('aria-label', label);
  navToggle.title = label;
  if (save) {
    try { localStorage.setItem('nav', collapsed ? 'collapsed' : 'expanded'); } catch { /* préférence non conservée */ }
  }
}

setNav(document.documentElement.dataset.nav === 'collapsed', false);
navToggle.addEventListener('click', () => setNav(document.documentElement.dataset.nav !== 'collapsed'));

if (!window.__TAURI__) {
  view.innerHTML = `<div class="empty"><h2>${t('Ouvre Kiosque depuis l’application')}</h2><p>${t('Cette page a besoin de la fenêtre Tauri pour fonctionner.')}</p></div>`;
  throw new Error('Tauri indisponible');
}
const { invoke } = window.__TAURI__.core;

const app = {
  tab: 'new',
  channels: [],
  videos: [],
  settings: { player: 'inapp', exclude_shorts: '1', platforms: '', auto_update: '0', language: '' },
  autostart: false,
  platform: (() => { try { return localStorage.getItem('platform') || ''; } catch { return ''; } })(),
  folder: (() => { try { return localStorage.getItem('folder') || ''; } catch { return ''; } })(),
  sub: (() => { try { return localStorage.getItem('sub') || 'platforms'; } catch { return 'mine'; } })(),
  version: '',
  busy: false,
};

// ---------- utilitaires ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const plural = (n, one, many) => t(lang === 'en' ? (n !== 1 ? many : one) : (n > 1 ? many : one));
// Miniatures affichées par défaut ; se désactivent dans Chaînes.
const showThumbs = () => { try { return localStorage.getItem('thumbs') !== '0'; } catch { return true; } };

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
}

/** Remet en minuscules les titres criés en majuscules et réduit « !!! » à « ! ». Le titre d'origine reste en infobulle. */
// Titre de liste : on s'arrête au premier point suivi d'une phrase, pour garder des rangées régulières.
// Le titre complet reste visible au survol et dans le lecteur.
function shortTitle(title) {
  const t = calmTitle(title);
  const cut = t.search(/[.…]\s+\S/u);
  return cut >= 12 ? t.slice(0, cut + 1) : t;
}

function calmTitle(title) {
  const letters = title.replace(/[^\p{L}]/gu, '');
  let t = title;
  if (letters.length >= 8) {
    const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
    if (upper / letters.length > 0.7) {
      t = title.toLocaleLowerCase(lang);
      t = t.charAt(0).toLocaleUpperCase(lang) + t.slice(1);
    }
  }
  return t.replace(/([!?])\1+/g, '$1');
}

function when(ts) {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return rtf.format(-Math.max(1, Math.round(diff / 60)), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 7 * 86400) return rtf.format(-Math.round(diff / 86400), 'day');
  const date = new Date(ts * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(lang === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Confirmation en deux clics : le premier arme le bouton, le second valide. */
function confirmClick(button, label, ms = 3000) {
  if (button.dataset.armed) return true;
  button.dataset.armed = '1';
  button.dataset.label = button.textContent;
  button.textContent = label;
  setTimeout(() => {
    if (button.isConnected) {
      delete button.dataset.armed;
      button.textContent = button.dataset.label;
    }
  }, ms);
  return false;
}

// ---------- lecteur intégré ----------
// Le flux vient de YouTube (API « IFrame ») mais l'interface de lecture est celle de Kiosque :
// YouTube n'affiche que l'image, les commandes ci-dessous pilotent la vidéo.

const playerEl = document.querySelector('#player');
let captionsOn = (() => { try { return localStorage.getItem('cc') === '1'; } catch { return false; } })();
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];
let speed = (() => { try { const s = Number(localStorage.getItem('speed')); return SPEEDS.includes(s) ? s : 1; } catch { return 1; } })();
const speedLabel = (s) => `${String(s).replace('.', lang === 'en' ? '.' : ',')}×`;
let playing = null;      // vidéo en cours
let yt = null;           // lecteur YouTube
let ytTimer = null;      // rafraîchissement de la barre de progression
let ytLoading = null;    // chargement unique du script YouTube

const ICONS = {
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/>',
  volume: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15 9a4.5 4.5 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  muted: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z" fill="currentColor"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  cc: '<rect x="3" y="5.5" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10.5 10.3a2.3 2.3 0 1 0 0 3.4M17 10.3a2.3 2.3 0 1 0 0 3.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  exit: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytLoading) {
    ytLoading = new Promise((resolve, reject) => {
      window.onYouTubeIframeAPIReady = resolve;
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { ytLoading = null; script.remove(); reject(new Error('offline')); };
      document.head.appendChild(script);
    });
  }
  return ytLoading;
}

const clock = (sec) => {
  const t = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

const q = (sel) => playerEl.querySelector(sel);

function showPlayerMessage(text) {
  const box = q('.player-msg');
  if (!box) return;
  box.querySelector('p').textContent = text;
  box.hidden = false;
}

function syncControls() {
  if (!yt || typeof yt.getPlayerState !== 'function') return;
  const state = yt.getPlayerState();
  const isPlaying = state === 1 || state === 3; // lecture ou mise en mémoire
  const toggle = q('[data-ctl="toggle"]');
  if (toggle) {
    toggle.innerHTML = icon(isPlaying ? 'pause' : 'play');
    toggle.setAttribute('aria-label', t(isPlaying ? 'Pause' : 'Lire'));
  }
  const duration = yt.getDuration?.() || 0;
  const current = yt.getCurrentTime?.() || 0;
  const seek = q('[data-ctl="seek"]');
  if (seek && !seek.dataset.drag) {
    seek.value = duration ? String(Math.round((current / duration) * 1000)) : '0';
    seek.style.setProperty('--pct', `${duration ? (current / duration) * 100 : 0}%`);
  }
  const time = q('.time');
  if (time) time.textContent = `${clock(current)} / ${clock(duration)}`;
  const muted = yt.isMuted?.();
  const mute = q('[data-ctl="mute"]');
  if (mute) {
    mute.innerHTML = icon(muted ? 'muted' : 'volume');
    mute.setAttribute('aria-label', t(muted ? 'Activer le son' : 'Couper le son'));
  }
  const volume = q('[data-ctl="volume"]');
  if (volume && !volume.dataset.drag) {
    const level = muted ? 0 : (yt.getVolume?.() ?? 100);
    volume.value = String(level);
    volume.style.setProperty('--pct', `${level}%`);
  }
}

/** Seules les adresses de lecteurs intégrés sont acceptées, jamais une page de site. */
function isPlayerUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return (u.hostname === 'player.vimeo.com' && u.pathname.startsWith('/video/'))
      || (u.hostname === 'www.dailymotion.com' && u.pathname.startsWith('/embed/video/'))
      || (u.hostname === 'odysee.com' && u.pathname.startsWith('/$/embed/'))
      || u.pathname.startsWith('/videos/embed/'); // PeerTube
  } catch {
    return false;
  }
}

function createYtPlayer(video, startAt) {
  yt = new window.YT.Player('yt-host', {
    host: 'https://www.youtube-nocookie.com',
    videoId: video.id,
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3,
      modestbranding: 1, playsinline: 1, hl: lang,
      cc_load_policy: captionsOn ? 1 : 0, start: Math.floor(startAt),
    },
    events: {
      onReady: () => { try { yt.setPlaybackRate(speed); } catch { /* facultatif */ } syncControls(); },
      onStateChange: syncControls,
      onError: (e) => {
        const code = e?.data;
        showPlayerMessage(
          code === 101 || code === 150 || code === 153
            ? t('L’auteur de cette vidéo interdit sa lecture hors de YouTube.')
            : code === 100
              ? t('Cette vidéo est privée ou a été supprimée.')
              : t('Cette vidéo ne peut pas être lue ici.'),
        );
      },
    },
  });
}

async function openPlayer(video) {
  closePlayer();
  playing = video;
  playerEl.innerHTML = `
    <div class="player-bar">
      <button type="button" class="quiet back full-only" data-player="close">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12.5 5l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${t('Retour')}
      </button>
      <div class="player-info">
        <p class="player-title" title="${esc(video.title)}">${esc(calmTitle(video.title))}</p>
        <p class="player-channel">${esc(video.channel_title)}</p>
      </div>
      <button type="button" class="full-only" data-player="minimize" title="${t('Continuer à regarder en petit pendant que tu navigues')}">${t('Réduire')}</button>
      <button type="button" class="full-only" data-player="external">${t('Ouvrir dans le navigateur')}</button>
      <button type="button" class="mini-only" data-player="expand" aria-label="${t('Agrandir')}" title="${t('Agrandir')}">${icon('full')}</button>
      <button type="button" class="mini-only close-mini" data-player="close" aria-label="${t('Arrêter la vidéo')}" title="${t('Arrêter la vidéo')}">×</button>
    </div>
    <div class="player-stage" id="player-stage">
      <div class="video-area">
        <div id="yt-host"></div>
        <div class="player-msg" hidden role="alert">
          <p></p>
          <button type="button" class="primary" data-player="external">${t('Ouvrir dans le navigateur')}</button>
        </div>
      </div>
      <div class="controls">
        <button type="button" class="ctl" data-ctl="toggle" aria-label="${t('Lire')}">${icon('play')}</button>
        <input class="range seek" type="range" min="0" max="1000" step="1" value="0" data-ctl="seek" aria-label="${t('Position dans la vidéo')}">
        <span class="time">0:00 / 0:00</span>
        <button type="button" class="ctl" data-ctl="mute" aria-label="${t('Couper le son')}">${icon('volume')}</button>
        <input class="range volume" type="range" min="0" max="100" step="1" value="100" data-ctl="volume" aria-label="${t('Volume')}">
        <button type="button" class="ctl speed" data-ctl="speed" aria-label="${t('Vitesse de lecture')}" title="${t('Vitesse de lecture')}">${speedLabel(speed)}</button>
        <button type="button" class="ctl cc" data-ctl="cc" aria-label="${t('Sous-titres')}" aria-pressed="${captionsOn}" title="${t('Sous-titres (si la vidéo en propose)')}">${icon('cc')}</button>
        <button type="button" class="ctl" data-ctl="full" aria-label="${t('Plein écran')}">${icon('full')}</button>
      </div>
    </div>`;
  playerEl.hidden = false;
  q('[data-player="close"]').focus();

  // Autres plateformes : uniquement le lecteur de la vidéo, jamais une page de site.
  if (video.embed) {
    if (!isPlayerUrl(video.embed)) {
      showPlayerMessage(t('Cette vidéo ne peut pas être lue dans Kiosque.'));
      return;
    }
    q('#player-stage').classList.add('native');
    q('#yt-host').innerHTML = `<iframe src="${esc(video.embed)}" title="${esc(video.title)}"
      sandbox="allow-scripts allow-same-origin allow-presentation"
      allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    return;
  }

  try {
    await loadYouTubeApi();
  } catch {
    if (playing === video) showPlayerMessage(t('Impossible de joindre YouTube. Vérifie ta connexion internet.'));
    return;
  }
  if (playing !== video) return; // fermé pendant le chargement

  createYtPlayer(video, 0);
  ytTimer = setInterval(syncControls, 250);
}

/** Réduit le lecteur dans le coin bas gauche : la vidéo continue pendant la navigation. */
function minimizePlayer() {
  if (!playing || playerEl.hidden) return;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  playerEl.classList.add('mini');
}

function expandPlayer() {
  playerEl.classList.remove('mini');
  q('[data-player="minimize"]')?.focus();
}

function closePlayer() {
  clearInterval(ytTimer);
  ytTimer = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  try { yt?.destroy?.(); } catch { /* déjà détruit */ }
  yt = null;
  playing = null;
  if (!playerEl.hidden) playerEl.hidden = true;
  playerEl.classList.remove('mini');
  playerEl.innerHTML = '';
}

function togglePlay() {
  if (!yt?.getPlayerState) return;
  const state = yt.getPlayerState();
  if (state === 1 || state === 3) yt.pauseVideo(); else yt.playVideo();
  setTimeout(syncControls, 50);
}

function toggleMute() {
  if (!yt?.isMuted) return;
  if (yt.isMuted()) { yt.unMute(); if (!yt.getVolume()) yt.setVolume(60); } else yt.mute();
  setTimeout(syncControls, 50);
}

/** Passe à la vitesse suivante (0,75× → 1× → 1,25× → 1,5× → 2× → 0,75×). */
function cycleSpeed() {
  if (!yt?.setPlaybackRate) return;
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  try { localStorage.setItem('speed', String(speed)); } catch { /* facultatif */ }
  yt.setPlaybackRate(speed);
  const button = q('[data-ctl="speed"]');
  if (button) button.textContent = speedLabel(speed);
}

/** Active ou coupe les sous-titres : le lecteur est relancé à l'endroit où tu en étais. */
function toggleCaptions() {
  if (!yt?.getCurrentTime || !playing) return;
  captionsOn = !captionsOn;
  try { localStorage.setItem('cc', captionsOn ? '1' : '0'); } catch { /* facultatif */ }
  const at = yt.getCurrentTime() || 0;
  const wasPaused = yt.getPlayerState?.() === 2;
  const video = playing;
  try { yt.destroy(); } catch { /* déjà détruit */ }
  yt = null;
  const area = q('.video-area');
  area.insertAdjacentHTML('afterbegin', '<div id="yt-host"></div>');
  const button = q('[data-ctl="cc"]');
  if (button) button.setAttribute('aria-pressed', String(captionsOn));
  createYtPlayer(video, at);
  if (wasPaused) {
    const t = setInterval(() => {
      if (yt?.getPlayerState?.() === 1) { yt.pauseVideo(); clearInterval(t); }
    }, 100);
    setTimeout(() => clearInterval(t), 5000);
  }
  setStatus(t(captionsOn ? 'Sous-titres activés (si la vidéo en propose)' : 'Sous-titres coupés'));
}

function toggleFullscreen() {
  const stage = document.querySelector('#player-stage');
  if (!stage) return;
  if (document.fullscreenElement) document.exitFullscreen?.();
  else stage.requestFullscreen?.().catch(() => {});
}

function seekBy(seconds) {
  if (!yt?.getCurrentTime) return;
  yt.seekTo(Math.max(0, yt.getCurrentTime() + seconds), true);
  setTimeout(syncControls, 50);
}

playerEl.addEventListener('click', async (event) => {
  const ctl = event.target.closest('[data-ctl]');
  if (ctl) {
    switch (ctl.dataset.ctl) {
      case 'toggle': return togglePlay();
      case 'mute': return toggleMute();
      case 'speed': return cycleSpeed();
      case 'cc': return toggleCaptions();
      case 'full': return toggleFullscreen();
    }
    return;
  }
  const button = event.target.closest('[data-player]');
  if (!button) return;
  if (button.dataset.player === 'close') return closePlayer();
  if (button.dataset.player === 'minimize') return minimizePlayer();
  if (button.dataset.player === 'expand') return expandPlayer();
  if (button.dataset.player === 'external' && playing) {
    try {
      await invoke('open_video', { id: playing.id, player: 'browser' });
      closePlayer();
    } catch (err) {
      setStatus(String(err), 'error');
    }
  }
});

// Curseurs : la position et le volume suivent le doigt, la vidéo se déplace au relâchement du curseur.
playerEl.addEventListener('input', (event) => {
  const el = event.target;
  if (!yt || !el.dataset?.ctl) return;
  el.dataset.drag = '1';
  if (el.dataset.ctl === 'seek') {
    const duration = yt.getDuration?.() || 0;
    el.style.setProperty('--pct', `${el.value / 10}%`);
    const time = q('.time');
    if (time) time.textContent = `${clock((el.value / 1000) * duration)} / ${clock(duration)}`;
  } else if (el.dataset.ctl === 'volume') {
    const v = Number(el.value);
    if (v > 0 && yt.isMuted?.()) yt.unMute();
    yt.setVolume(v);
    el.style.setProperty('--pct', `${v}%`);
  }
});
playerEl.addEventListener('change', (event) => {
  const el = event.target;
  if (!yt || !el.dataset?.ctl) return;
  delete el.dataset.drag;
  if (el.dataset.ctl === 'seek') {
    const duration = yt.getDuration?.() || 0;
    yt.seekTo((el.value / 1000) * duration, true);
  }
  setTimeout(syncControls, 50);
});

document.addEventListener('fullscreenchange', () => {
  const full = q('[data-ctl="full"]');
  if (!full) return;
  const on = !!document.fullscreenElement;
  full.innerHTML = icon(on ? 'exit' : 'full');
  full.setAttribute('aria-label', t(on ? 'Quitter le plein écran' : 'Plein écran'));
});

document.addEventListener('keydown', (event) => {
  if (playerEl.hidden || playerEl.classList.contains('mini')) return;
  const tag = event.target.tagName;
  if (event.key === 'Escape') {
    if (!document.fullscreenElement) minimizePlayer();
    return;
  }
  if (event.target.type === 'range' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.key === ' ' && tag !== 'BUTTON') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); }
  else if (event.key === 'c' || event.key === 'C') toggleCaptions();
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else if (event.key === 'm' || event.key === 'M') toggleMute();
});

// ---------- données ----------

const loadChannels = async () => { app.channels = await invoke('list_channels'); };
const loadVideos = async () => {
  app.videos = await invoke('list_videos', { status: app.tab });
  // « À voir » vide : on montre à la place la dernière vidéo de chaque chaîne.
  app.latest = app.tab === 'new' && !app.videos.length ? await invoke('latest_videos') : [];
};
const newCount = () => app.channels.reduce((sum, c) => sum + c.new_count, 0);

// ---------- rendu ----------

function renderTabs() {
  for (const button of tabButtons) {
    const active = button.dataset.tab === app.tab;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
    if (button.dataset.tab === 'new') {
      const n = newCount();
      button.innerHTML = `${t('À voir')}${n ? `<span class="count">${n}</span>` : ''}`;
    }
  }
}

function emptyState() {
  const n = app.channels.length;
  if (app.tab === 'new') {
    if (n === 0) {
      return `<div class="empty"><img src="logo.svg" alt=""><h2>${t('Aucune chaîne suivie')}</h2>
        <p>${t('Ajoute les chaînes qui t’intéressent. Elles seront les seules à apparaître ici.')}</p>
        <button type="button" class="primary" data-act="go-channels">${t('Ajouter une chaîne')}</button></div>`;
    }
    return `<div class="empty compact"><img src="logo.svg" alt=""><h2>${t('C’est tout pour aujourd’hui')}</h2>
      <p>${tn(n, 'Rien de nouveau parmi ta chaîne.', 'Rien de nouveau parmi tes {n} chaînes.')}</p></div>`;
  }
  if (app.tab === 'later') {
    return `<div class="empty"><h2>${t('Rien en attente')}</h2><p>${t('Les vidéos que tu mets de côté apparaissent ici.')}</p></div>`;
  }
  return `<div class="empty"><h2>${t('Aucune vidéo vue')}</h2><p>${t('Les vidéos que tu ouvres sont rangées ici.')}</p></div>`;
}

function actionsFor(tab) {
  const watch = `<button type="button" class="primary" data-act="watch">${t('Regarder')}</button>`;
  const later = `<button type="button" class="quiet" data-act="later">${t('Voir plus tard')}</button>`;
  const ignore = `<button type="button" class="quiet" data-act="ignore">${t('Ignorer')}</button>`;
  if (tab === 'new') return `${watch}${later}${ignore}`;
  if (tab === 'later') return `${watch}${ignore}`;
  return `${watch}${later}`;
}

function videoRow(v, thumbs, latest = false) {
  // Miniature fournie par le flux, sinon celle que YouTube publie pour chaque vidéo.
  const src = v.thumb || (v.platform === 'youtube' ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : '');
  return `<li class="item${thumbs ? ' has-thumb' : ''}" data-id="${esc(v.id)}"${latest ? ' data-latest="1"' : ''}>
    ${thumbs ? `<button type="button" class="thumb-btn" data-act="watch" tabindex="-1" aria-hidden="true"><img class="thumb" src="${esc(src)}" alt="" loading="lazy" onerror="this.closest('.thumb-btn').remove()"></button>` : ''}
    <div>
      <h3 class="title" title="${esc(v.title)}">${esc(shortTitle(v.title))}</h3>
      <p class="meta"><span class="who">${esc(v.channel_title)}</span>${platformLabel(v.platform) ? `<span class="pf">${esc(platformLabel(v.platform))}</span>` : ''}${v.category ? `<span class="fo">${esc(v.category)}</span>` : ''}<span>${esc(when(v.published))}</span></p>
      <div class="actions">${latest ? `<button type="button" class="primary" data-act="watch">${t('Regarder')}</button>` : actionsFor(app.tab)}</div>
    </div>
  </li>`;
}

// ---------- filtres (plateformes et dossiers) ----------

const NO_FOLDER = '\u0000none';
const folderOf = (v) => v.category || '';

const folderNames = () =>
  [...new Set(app.channels.map((c) => c.category).filter(Boolean))].sort((x, y) => x.localeCompare(y, lang));

function currentFolder() {
  if (app.folder && app.folder !== NO_FOLDER && !folderNames().includes(app.folder)) setFolder('');
  return app.folder;
}

function setFolder(name) {
  app.folder = name;
  try { localStorage.setItem('folder', name); } catch { /* sans mémoire, le filtre repart de « Tout » */ }
}

const platformsPresent = () => {
  const keys = new Set(app.channels.map((c) => c.platform).filter(Boolean));
  return ['youtube', ...PLATFORMS.map((p) => p[0])].filter((k) => keys.has(k));
};

function currentPlatform() {
  if (app.platform && !platformsPresent().includes(app.platform)) setPlatform('');
  return app.platform;
}

function setPlatform(key) {
  app.platform = key;
  try { localStorage.setItem('platform', key); } catch { /* sans mémoire, le filtre repart de « Tout » */ }
}

const inFolder = (v) => !currentFolder() || (currentFolder() === NO_FOLDER ? !folderOf(v) : folderOf(v) === currentFolder());
const inPlatform = (v) => !currentPlatform() || v.platform === currentPlatform();
const visible = (v) => inFolder(v) && inPlatform(v);
const filtering = () => !!(currentFolder() || currentPlatform());

/**
 * Sous-navbar de filtres : Tout | plateformes (activées et non vides) | dossiers (non vides).
 * Les deux familles se combinent ; chacune compte ce que l'autre laisse passer.
 */
function filterBars(items) {
  const chip = (cls, act, attr, value, label, count, active) =>
    `<button type="button" class="chip ${cls}" data-act="${act}"${attr ? ` data-${attr}="${esc(value)}"` : ''} aria-pressed="${active}" data-count="${count}">${esc(label)}<span class="chip-count">${count}</span></button>`;
  const enabled = new Set(['youtube', ...activePlatforms()]);
  const pfKeys = ['youtube', ...PLATFORMS.map((p) => p[0])].filter((k) => enabled.has(k) && items.some((v) => v.platform === k));
  const folders = [...new Set(items.map(folderOf))]
    .sort((x, y) => (x === '' ? 1 : y === '' ? -1 : x.localeCompare(y, lang)));
  if (!items.length) return '';
  const pf = currentPlatform();
  const fo = currentFolder();
  const byFolder = items.filter(inFolder);
  const byPlatform = items.filter(inPlatform);
  const parts = [chip('', 'reset-filters', '', '', t('Tout'), items.length, !pf && !fo)];
  if (pfKeys.length) {
    parts.push(...pfKeys
      .map((k) => [k, byFolder.filter((v) => v.platform === k).length])
      .filter(([k, n]) => n > 0 || pf === k)
      .map(([k, n]) => chip('pf-chip', 'platform', 'platform', pf === k ? '' : k, platformLabel(k), n, pf === k)));
  }
  if (folders.length) {
    parts.push(...folders
      .map((n) => [n, n === '' ? NO_FOLDER : n, byPlatform.filter((v) => folderOf(v) === n).length])
      .filter(([, key, count]) => count > 0 || fo === key)
      .map(([n, key, count]) => chip('fo-chip', 'folder', 'folder', fo === key ? '' : key, n || t('Sans dossier'), count, fo === key)));
  }
  return `<div class="filterbar" role="group" aria-label="${t('Filtres')}"><div class="filterbar-in">${parts.join('')}</div></div>`;
}

function renderVideos() {
  const thumbs = showThumbs();
  if (!app.videos.length) {
    const latestAll = app.latest ?? [];
    const latest = latestAll.length
      ? `<section class="latest" aria-labelledby="latest-title">
          <h2 id="latest-title">${t('Dernières vidéos de tes chaînes')}</h2>
          <ul class="feed${thumbs ? ' cards' : ''}">${latestAll.filter(visible).map((v) => videoRow(v, thumbs, true)).join('')}</ul>
        </section>`
      : '';
    view.innerHTML = (latestAll.length ? filterBars(latestAll) : '') + emptyState() + latest;
    return;
  }
  const shown = app.videos.filter(visible);
  // « Tout marquer comme vu » concerne toute la boîte : on le masque quand un filtre est actif.
  const bar = app.tab === 'new' && shown.length && !filtering()
    ? `<div class="bar"><button type="button" class="quiet" data-act="all-seen">${t('Tout marquer comme vu')}</button></div>`
    : '';
  const body = shown.length
    ? `<ul class="feed${thumbs ? ' cards' : ''}">${shown.map((v) => videoRow(v, thumbs)).join('')}</ul>`
    : `<div class="empty compact"><h2>${t('Rien ici avec ce filtre')}</h2>
        <p>${t('Les autres dossiers et plateformes ont encore des vidéos.')}</p>
        <button type="button" class="primary" data-act="reset-filters">${t('Tout afficher')}</button></div>`;
  view.innerHTML = `${filterBars(app.videos)}${bar}${body}`;
}

const AVATAR_COLORS = ['#e4572e', '#0f766e', '#b7791f', '#6d28d9', '#1d4e89', '#4d7c0f', '#be185d'];
function avatar(channel) {
  const title = channel.title;
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const letter = [...title.trim()][0]?.toUpperCase() ?? '?';
  // L'initiale sert de repli : l'image la recouvre, et disparaît si elle ne charge pas.
  const img = channel.avatar
    ? `<img src="${esc(channel.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
    : '';
  return `<span class="avatar" style="background:${AVATAR_COLORS[h % AVATAR_COLORS.length]}" aria-hidden="true">${esc(letter)}${img}</span>`;
}

const PLATFORMS = [
  ['peertube', 'PeerTube', 'Vidéos libres, hébergées sur de nombreux sites.'],
  ['odysee', 'Odysee', 'Chaînes Odysee (@Nom:c).'],
  ['vimeo', 'Vimeo', 'Chaînes et comptes Vimeo.'],
  ['dailymotion', 'Dailymotion', 'Chaînes Dailymotion.'],
];
const platformDesc = (text) => t(text);
const platformLabel = (key) => (key === 'youtube' ? 'YouTube' : PLATFORMS.find((p) => p[0] === key)?.[1] ?? '');
const activePlatforms = () => (app.settings.platforms || '').split(',').filter(Boolean);

const PLAYER_HINTS = {
  inapp: 'Lecteur de YouTube dans la fenêtre. Des publicités peuvent s’afficher.',
  browser: 'La vidéo s’ouvre dans ton navigateur habituel.',
}; // traduits à l'affichage

function renderChannels() {
  const s = app.settings;
  const player = s.player === 'browser' ? 'browser' : 'inapp';
  const n = app.channels.length;

  const card = (c) => `<li data-id="${esc(c.id)}">
        ${avatar(c)}
        <div class="info">
          <span class="line"><span class="name">${esc(c.title)}</span>${c.new_count ? `<span class="pill">${t('{n} à voir', { n: c.new_count })}</span>` : ''}</span>
          ${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}
          <span class="tags">${platformLabel(c.platform) ? `<span class="pf" data-pf="${esc(c.platform)}">${esc(platformLabel(c.platform))}</span>` : ''}<span class="folder-slot"><button type="button" class="folder-chip${c.category ? ' set' : ''}" data-act="edit-folder" title="${t('Choisir le dossier de cette chaîne')}">${c.category ? esc(c.category) : t('+ Dossier')}</button></span></span>
        </div>
        <button type="button" class="remove" data-act="remove-channel" aria-label="${esc(t('Retirer {name}', { name: c.title }))}" title="${t('Retirer cette chaîne')}">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M2.5 2.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </li>`;
  const names = folderNames();
  const groups = names.length
    ? [...names.map((name) => [name, app.channels.filter((c) => c.category === name)]),
       ['', app.channels.filter((c) => !c.category)]].filter(([, list]) => list.length)
    : [['', app.channels]];
  const list = n
    ? groups.map(([name, items]) => `${names.length ? `<h3 class="group">${name ? esc(name) : t('Sans dossier')}<span class="note">${items.length}</span></h3>` : ''}
        <ul class="channels">${items.map(card).join('')}</ul>`).join('')
    : `<div class="empty-small"><img src="logo.svg" alt="" width="72" height="72"><h3>${t('Aucune chaîne pour l’instant')}</h3><p>${t('Colle l’adresse d’une chaîne, son @pseudo ou un identifiant commençant par UC, puis clique sur « Suivre ».')}</p></div>`;

  const segment = (value, label) =>
    `<label class="seg"><input type="radio" name="player" value="${value}" data-setting="player" ${player === value ? 'checked' : ''}><span>${label}</span></label>`;
  const toggle = (id, label, help, attrs, on) =>
    `<label class="switch-row" for="${id}"><span class="switch-text"><span class="switch-label">${label}</span><span class="switch-help">${help}</span></span>
      <input type="checkbox" id="${id}" class="switch" ${attrs} ${on ? 'checked' : ''}></label>`;

  const SUBS = [['platforms', t('Plateformes')], ['playback', t('Lecture')], ['system', t('Système')]];
  if (!SUBS.some(([k]) => k === app.sub)) app.sub = 'playback';

  const panels = {
    platforms: `
      ${toggle('pf-youtube', 'YouTube', t('Toujours actif (par défaut).'), 'disabled', true)}
      ${PLATFORMS.map(([key, label, help]) => toggle('pf-' + key, label, t(help), `data-platform="${key}"`, activePlatforms().includes(key))).join('')}
      <p class="hint">${t('Colle ensuite l’adresse d’une chaîne ou d’une vidéo de la plateforme dans « Suivre ».')}</p>`,
    playback: `
      <div class="segmented" role="radiogroup" aria-label="${t('Lecteur vidéo')}">
        ${segment('inapp', t('Dans Kiosque'))}${segment('browser', t('Navigateur'))}
      </div>
      <p class="hint">${t(PLAYER_HINTS[player])}</p>
      ${toggle('thumbs', t('Miniatures'), t('Une image pour chaque vidéo.'), 'data-local="thumbs"', showThumbs())}
      ${toggle('shorts', t('Masquer les Shorts'), t('Pris en compte à la prochaine actualisation.'), 'data-setting="exclude_shorts"', s.exclude_shorts !== '0')}`,
    system: `
      <div class="field"><span class="switch-label">${t('Langue')}</span>
        <div class="segmented three" role="radiogroup" aria-label="${t('Langue')}">
          ${[['', t('Automatique')], ['fr', 'Français'], ['en', 'English']].map(([v, label]) => `<label class="seg"><input type="radio" name="language" value="${v}" data-setting="language" ${(s.language || '') === v ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
      </div>
      ${toggle('autoupdate', t('Mise à jour automatique'), t('Télécharge et installe les nouvelles versions au démarrage, puis relance Kiosque.'), 'data-setting="auto_update"', s.auto_update === '1')}
      ${toggle('autostart', t('Lancer au démarrage'), t('Kiosque s’ouvre en même temps que ton ordinateur.'), 'data-local="autostart"', app.autostart)}`,
  };

  view.classList.toggle('scrolled', view.scrollTop > 2);
  view.innerHTML = `
    <div class="manage">
      <div class="addbar">
        <h2 class="addbar-title"><label for="channel-input">${t('Ajouter une chaîne')}</label></h2>
        <form id="add" class="add">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <input id="channel-input" type="text" placeholder="${t('@pseudo, adresse d’une chaîne ou d’une vidéo…')}" autocomplete="off" spellcheck="false">
          <button type="submit" class="primary">${t('Suivre')}</button>
        </form>
      </div>

      <div class="cols">
        <section class="mine" aria-labelledby="mine-title">
          <div class="section-head">
            <h2 id="mine-title">${t('Mes chaînes')}</h2>
            <span class="note">${n ? tn(n, '{n} chaîne suivie', '{n} chaînes suivies') : ''}</span>
          </div>
          ${list}
        </section>

        <aside class="prefs card" aria-label="${t('Réglages')}">
          <div class="subtabs" role="tablist" aria-label="${t('Réglages')}">
            ${SUBS.map(([k, label]) => `<button type="button" role="tab" id="sub-${k}" data-sub="${k}" aria-selected="${app.sub === k}" tabindex="${app.sub === k ? 0 : -1}">${label}</button>`).join('')}
          </div>
          <div class="subpanel" role="tabpanel" aria-labelledby="sub-${app.sub}">${panels[app.sub]}</div>
          ${app.version ? `<p class="version"><a href="https://github.com/karimbel/Kiosque" data-act="open-repo" title="${t('Ouvrir le dépôt GitHub')}">Kiosque ${esc(app.version)}</a></p>` : ''}
        </aside>
      </div>
    </div>`;
}

// Ombre sous la barre d'ajout dès que la page défile.
view.addEventListener('scroll', () => view.classList.toggle('scrolled', view.scrollTop > 2), { passive: true });

view.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-sub]');
  if (!tab) return;
  app.sub = tab.dataset.sub;
  try { localStorage.setItem('sub', app.sub); } catch { /* facultatif */ }
  const typed = document.querySelector('#channel-input')?.value ?? '';
  renderChannels();
  const input = document.querySelector('#channel-input');
  if (input) input.value = typed;
  document.querySelector(`#sub-${app.sub}`)?.focus();
});
view.addEventListener('keydown', (event) => {
  const tab = event.target.closest('[data-sub]');
  if (!tab || !['ArrowRight', 'ArrowLeft'].includes(event.key)) return;
  const all = [...view.querySelectorAll('[data-sub]')];
  const next = all[(all.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
  next.click();
});

function render() {
  renderTabs();
  if (app.tab === 'channels') renderChannels();
  else renderVideos();
}

async function switchTab(tab) {
  minimizePlayer();
  app.tab = tab;
  try {
    if (tab !== 'channels') await loadVideos();
    else await loadChannels();
  } catch (err) {
    setStatus(String(err), 'error');
  }
  render();
}

// ---------- actions ----------

async function refresh() {
  if (app.busy) return;
  app.busy = true;
  refreshBtn.disabled = true;
  setStatus(t('Actualisation…'));
  try {
    const report = await invoke('refresh');
    await loadChannels();
    if (app.tab !== 'channels') await loadVideos();
    render();
    if (report.errors.length) {
      const n = report.errors.length;
      setStatus(tn(n, '{n} chaîne n’a pas répondu : {err}', '{n} chaînes n’ont pas répondu : {err}', { err: report.errors[0] }), 'error');
    } else if (report.new_videos) {
      const n = report.new_videos;
      setStatus(tn(n, '{n} nouvelle vidéo', '{n} nouvelles vidéos'));
    } else {
      setStatus(t('À jour'));
    }
  } catch (err) {
    setStatus(String(err), 'error');
  } finally {
    app.busy = false;
    refreshBtn.disabled = false;
  }
}

function dismissRow(li) {
  const done = async () => {
    li.remove();
    try { await loadChannels(); } catch { /* le compteur se mettra à jour à la prochaine action */ }
    renderTabs();
    if (!view.querySelector('.item')) {
      app.videos = [];
      renderVideos();
    }
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  li.classList.add('leaving');
  setTimeout(done, reduce ? 0 : 150);
}

async function setStatusOf(li, status) {
  await invoke('set_status', { id: li.dataset.id, status });
  dismissRow(li);
}

view.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  const li = button.closest('[data-id]');

  try {
    switch (button.dataset.act) {
      case 'go-channels':
        return switchTab('channels');
      case 'folder':
        setFolder(button.dataset.folder);
        return renderVideos();
      case 'platform':
        setPlatform(button.dataset.platform);
        return renderVideos();
      case 'open-repo':
        event.preventDefault();
        return await invoke('open_repo');
      case 'reset-filters':
        setFolder('');
        setPlatform('');
        return renderVideos();
      case 'edit-folder': {
        const channel = app.channels.find((c) => c.id === li.dataset.id);
        const slot = li.querySelector('.folder-slot');
        slot.innerHTML = `<form class="folder-edit" data-id="${esc(channel.id)}">
          <input type="text" list="folder-list" maxlength="40" autocomplete="off" spellcheck="false"
                 value="${esc(channel.category ?? '')}" placeholder="${t('Nom du dossier')}" aria-label="${esc(t('Dossier de {title}', { title: channel.title }))}">
          <datalist id="folder-list">${folderNames().map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        </form>`;
        const input = slot.querySelector('input');
        input.focus();
        input.select();
        return;
      }
      case 'watch': {
        const id = li.dataset.id;
        const isLatest = li.dataset.latest === '1';
        const video = (isLatest ? app.latest : app.videos).find((v) => v.id === id)
          ?? { id, title: '', channel_title: '' };
        setStatus('');

        // Réglage « Navigateur » : la vidéo s'ouvre hors de Kiosque.
        if (app.settings.player === 'browser') {
          await invoke('open_video', { id });
          if (isLatest || app.tab === 'seen') return;
          return dismissRow(li);
        }

        // Lecteur intégré. Une vidéo de « Dernières vidéos » garde son état.
        if (isLatest) return openPlayer(video);
        await invoke('set_status', { id, status: 'seen' });
        openPlayer(video);
        if (app.tab === 'seen') return;
        return dismissRow(li);
      }
      case 'later':
        return await setStatusOf(li, 'later');
      case 'ignore':
        return await setStatusOf(li, 'ignored');
      case 'unsee':
        return await setStatusOf(li, 'new');
      case 'all-seen': {
        if (!confirmClick(button, t('Confirmer ?'))) return;
        const n = await invoke('mark_all_seen');
        setStatus(tn(n, '{n} vidéo rangée comme vue', '{n} vidéos rangées comme vues'));
        await loadChannels();
        await loadVideos();
        return render();
      }
      case 'remove-channel': {
        // Confirmation dans la carte : on retire la chaîne seulement après un second clic explicite.
        const name = li.querySelector('.name')?.textContent ?? t('cette chaîne');
        const box = document.createElement('div');
        box.className = 'confirm';
        box.setAttribute('role', 'alertdialog');
        box.innerHTML = `<span>${esc(t('Retirer « {name} » ?', { name }))}</span>
          <button type="button" class="danger" data-act="remove-confirm">${t('Retirer')}</button>
          <button type="button" class="quiet" data-act="remove-cancel">${t('Annuler')}</button>`;
        li.append(box);
        box.querySelector('.quiet').focus();
        return;
      }
      case 'remove-cancel':
        return li.querySelector('.confirm')?.remove();
      case 'remove-confirm': {
        await invoke('remove_channel', { id: li.dataset.id });
        await loadChannels();
        return render();
      }
    }
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

let folderCancelled = false;
view.addEventListener('submit', async (event) => {
  if (event.target.classList.contains('folder-edit')) {
    event.preventDefault();
    const form = event.target;
    try {
      await invoke('set_channel_category', { id: form.dataset.id, category: form.querySelector('input').value });
      await loadChannels();
    } catch (err) {
      setStatus(String(err), 'error');
    }
    render();
    return;
  }
  if (event.target.id !== 'add') return;
  event.preventDefault();
  const input = document.querySelector('#channel-input');
  const submit = event.target.querySelector('button[type="submit"]');
  const value = input.value.trim();
  if (!value) return;
  submit.disabled = true;
  setStatus(t('Recherche de la chaîne…'));
  try {
    const channel = await invoke('add_channel', { input: value });
    setStatus(t('« {title} » est suivie', { title: channel.title }));
    await loadChannels();
    render();
    // La nouvelle carte est mise en vue et brièvement mise en évidence.
    const card = [...document.querySelectorAll('.channels li')].find((li) => li.dataset.id === channel.id);
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('just-added');
      setTimeout(() => card.classList.remove('just-added'), 2400);
    }
  } catch (err) {
    setStatus(String(err), 'error');
    submit.disabled = false;
  }
});

view.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && event.target.closest?.('.folder-edit')) {
    event.stopPropagation();
    folderCancelled = true;
    render();
  }
});
view.addEventListener('focusout', (event) => {
  const form = event.target.closest?.('.folder-edit');
  if (!form) return;
  if (folderCancelled) { folderCancelled = false; return; }
  if (form.isConnected) form.requestSubmit();
});

view.addEventListener('change', async (event) => {
  const el = event.target;
  try {
    if (el.dataset.local === 'autostart') {
      try {
        app.autostart = await invoke('set_autostart', { enabled: el.checked });
        setStatus(t(app.autostart ? 'Kiosque se lancera au démarrage' : 'Lancement au démarrage désactivé'));
      } catch (err) {
        el.checked = !el.checked;
        setStatus(String(err), 'error');
      }
      return;
    }
    if (el.dataset.local === 'thumbs') {
      localStorage.setItem('thumbs', el.checked ? '1' : '0');
      return;
    }
    if (el.dataset.platform) {
      const set = new Set(activePlatforms());
      if (el.checked) set.add(el.dataset.platform); else set.delete(el.dataset.platform);
      const value = [...set].join(',');
      await invoke('set_setting', { key: 'platforms', value });
      app.settings.platforms = value;
      setStatus(t(el.checked ? '{label} activé' : '{label} désactivé', { label: platformLabel(el.dataset.platform) }));
      return;
    }
    const key = el.dataset.setting;
    if (!key) return;
    const value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    await invoke('set_setting', { key, value });
    app.settings[key] = value;
    if (key === 'player') renderChannels();
    if (key === 'language') return applyLanguage();
    if (key === 'exclude_shorts') setStatus(t('Appliqué à la prochaine actualisation'));
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

for (const button of tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}
refreshBtn.addEventListener('click', refresh);

// ---------- langue ----------

/** Traduit les textes fixes de la page (index.html) et ceux de la barre de navigation. */
function applyStatic() {
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll('[data-t-aria]')) el.setAttribute('aria-label', t(el.dataset.tAria));
  setNav(document.documentElement.dataset.nav === 'collapsed', false);
  const box = document.querySelector('#update');
  if (box && !box.hidden && !box.classList.contains('busy') && box.dataset.version) {
    document.querySelector('#update-text').textContent = t('Kiosque {v} est disponible.', { v: box.dataset.version });
  }
}

/** Applique la langue choisie à toute l'interface et aux messages du programme. */
async function applyLanguage() {
  setLanguage(app.settings.language);
  try { await invoke('set_language', { code: lang }); } catch { /* messages du programme restent dans l'ancienne langue */ }
  applyStatic();
  setStatus('');
  render();
}

// ---------- démarrage ----------

/** Téléchargement, installation et relance dans Kiosque, avec la progression dans la bannière. */
async function runInstall(version) {
  const box = document.querySelector('#update');
  const text = document.querySelector('#update-text');
  const bar = document.querySelector('#update-bar');
  const showing = (percent) => {
    text.textContent = percent == null
      ? t('Téléchargement de Kiosque {v}…', { v: version })
      : t('Téléchargement de Kiosque {v} : {p} %', { v: version, p: percent });
  };
  showing(null);
  bar.value = 0;
  bar.hidden = false;
  box.hidden = false;
  box.classList.add('busy');
  const stops = [];
  try {
    const events = window.__TAURI__.event;
    stops.push(await events.listen('update-progress', (e) => {
      bar.value = e.payload;
      showing(e.payload);
    }));
    stops.push(await events.listen('update-stage', (e) => {
      if (e.payload === 'install') {
        text.textContent = t('Installation de Kiosque {v}…', { v: version });
        bar.removeAttribute('value'); // barre sans pourcentage : l'installation n'a pas de progression
      } else if (e.payload === 'restart') {
        text.textContent = t('Relance de Kiosque…');
      }
    }));
  } catch { /* sans événements, le texte « en cours » reste affiché */ }
  try {
    await invoke('install_update'); // relance Kiosque : on ne revient normalement pas ici
  } catch (err) {
    stops.forEach((off) => off());
    bar.hidden = true;
    bar.value = 0;
    box.classList.remove('busy');
    text.textContent = t('Kiosque {v} est disponible.', { v: version });
    setStatus(t('Mise à jour impossible : {err}', { err }), 'error');
  }
}

async function checkUpdate() {
  try {
    const info = await invoke('check_update');
    if (!info) return;
    const box = document.querySelector('#update');
    const text = document.querySelector('#update-text');
    box.dataset.version = info.version;
    if (app.settings.auto_update === '1') {
      await runInstall(info.version);
      return;
    }
    try { if (localStorage.getItem('update-dismissed') === info.version) return; } catch { /* facultatif */ }
    text.textContent = t('Kiosque {v} est disponible.', { v: info.version });
    box.hidden = false;
  } catch { /* hors ligne ou GitHub injoignable : on ne dit rien */ }
}

document.querySelector('#update').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-update]');
  if (!button) return;
  if (button.dataset.update === 'open') {
    await runInstall(document.querySelector('#update').dataset.version);
    return;
  }
  try { localStorage.setItem('update-dismissed', document.querySelector('#update').dataset.version); } catch { /* facultatif */ }
  document.querySelector('#update').hidden = true;
});

(async function init() {
  try {
    app.settings = await invoke('get_settings');
    if (app.settings.player !== 'browser') app.settings.player = 'inapp'; // anciens réglages (mpv) : lecteur intégré
    setLanguage(app.settings.language);
    invoke('set_language', { code: lang }).catch(() => {});
    applyStatic();
    app.version = await invoke('app_version').catch(() => '');
    app.autostart = await invoke('get_autostart').catch(() => false);
    await loadChannels();
    await loadVideos();
    render();
    if (app.channels.length) refresh();
    checkUpdate();
  } catch (err) {
    setStatus(String(err), 'error');
    render();
  }
})();
