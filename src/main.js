'use strict';

const view = document.querySelector('#view');
const statusEl = document.querySelector('#status');
const refreshBtn = document.querySelector('#refresh');
const tabButtons = [...document.querySelectorAll('.tabs [data-tab]')];

// ---------- barre de navigation rétractable ----------

const navToggle = document.querySelector('#nav-toggle');

function setNav(collapsed, save = true) {
  document.documentElement.dataset.nav = collapsed ? 'collapsed' : 'expanded';
  const label = collapsed ? 'Agrandir la barre de navigation' : 'Réduire la barre de navigation';
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
  view.innerHTML = '<div class="empty"><h2>Ouvre Kiosque depuis l’application</h2><p>Cette page a besoin de la fenêtre Tauri pour fonctionner.</p></div>';
  throw new Error('Tauri indisponible');
}
const { invoke } = window.__TAURI__.core;

const app = {
  tab: 'new',
  channels: [],
  videos: [],
  settings: { player: 'inapp', exclude_shorts: '1' },
  autostart: false,
  folder: (() => { try { return localStorage.getItem('folder') || ''; } catch { return ''; } })(),
  busy: false,
};

// ---------- utilitaires ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const plural = (n, one, many) => (n > 1 ? many : one);
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
      t = title.toLocaleLowerCase('fr');
      t = t.charAt(0).toLocaleUpperCase('fr') + t.slice(1);
    }
  }
  return t.replace(/([!?])\1+/g, '$1');
}

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function when(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 3600) return rtf.format(-Math.max(1, Math.round(diff / 60)), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 7 * 86400) return rtf.format(-Math.round(diff / 86400), 'day');
  const date = new Date(ts * 1000);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
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
    toggle.setAttribute('aria-label', isPlaying ? 'Pause' : 'Lecture');
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
    mute.setAttribute('aria-label', muted ? 'Activer le son' : 'Couper le son');
  }
  const volume = q('[data-ctl="volume"]');
  if (volume && !volume.dataset.drag) {
    const level = muted ? 0 : (yt.getVolume?.() ?? 100);
    volume.value = String(level);
    volume.style.setProperty('--pct', `${level}%`);
  }
}

async function openPlayer(video) {
  closePlayer();
  playing = video;
  playerEl.innerHTML = `
    <div class="player-bar">
      <button type="button" class="quiet back" data-player="close">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12.5 5l-5 5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Retour
      </button>
      <div class="player-info">
        <p class="player-title" title="${esc(video.title)}">${esc(calmTitle(video.title))}</p>
        <p class="player-channel">${esc(video.channel_title)}</p>
      </div>
      <button type="button" data-player="external">Ouvrir dans le navigateur</button>
    </div>
    <div class="player-stage" id="player-stage">
      <div class="video-area">
        <div id="yt-host"></div>
        <div class="player-msg" hidden role="alert">
          <p></p>
          <button type="button" class="primary" data-player="external">Ouvrir dans le navigateur</button>
        </div>
      </div>
      <div class="controls">
        <button type="button" class="ctl" data-ctl="toggle" aria-label="Lecture">${icon('play')}</button>
        <input class="range seek" type="range" min="0" max="1000" step="1" value="0" data-ctl="seek" aria-label="Position dans la vidéo">
        <span class="time">0:00 / 0:00</span>
        <button type="button" class="ctl" data-ctl="mute" aria-label="Couper le son">${icon('volume')}</button>
        <input class="range volume" type="range" min="0" max="100" step="1" value="100" data-ctl="volume" aria-label="Volume">
        <button type="button" class="ctl" data-ctl="full" aria-label="Plein écran">${icon('full')}</button>
      </div>
    </div>`;
  playerEl.hidden = false;
  q('[data-player="close"]').focus();

  try {
    await loadYouTubeApi();
  } catch {
    if (playing === video) showPlayerMessage('Impossible de joindre YouTube. Vérifie ta connexion internet.');
    return;
  }
  if (playing !== video) return; // fermé pendant le chargement

  yt = new window.YT.Player('yt-host', {
    host: 'https://www.youtube-nocookie.com',
    videoId: video.id,
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3,
      modestbranding: 1, playsinline: 1, cc_load_policy: 0,
    },
    events: {
      onReady: () => { syncControls(); },
      onStateChange: syncControls,
      onError: (e) => {
        const code = e?.data;
        showPlayerMessage(
          code === 101 || code === 150 || code === 153
            ? 'L’auteur de cette vidéo interdit sa lecture hors de YouTube.'
            : code === 100
              ? 'Cette vidéo est privée ou a été supprimée.'
              : 'Cette vidéo ne peut pas être lue ici.',
        );
      },
    },
  });
  ytTimer = setInterval(syncControls, 250);
}

function closePlayer() {
  clearInterval(ytTimer);
  ytTimer = null;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  try { yt?.destroy?.(); } catch { /* déjà détruit */ }
  yt = null;
  playing = null;
  if (!playerEl.hidden) playerEl.hidden = true;
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
      case 'full': return toggleFullscreen();
    }
    return;
  }
  const button = event.target.closest('[data-player]');
  if (!button) return;
  if (button.dataset.player === 'close') return closePlayer();
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
  full.setAttribute('aria-label', on ? 'Quitter le plein écran' : 'Plein écran');
});

document.addEventListener('keydown', (event) => {
  if (playerEl.hidden) return;
  const tag = event.target.tagName;
  if (event.key === 'Escape') {
    if (!document.fullscreenElement) closePlayer();
    return;
  }
  if (event.target.type === 'range' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
  if (event.key === ' ' && tag !== 'BUTTON') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); }
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
      button.innerHTML = `À voir${n ? `<span class="count">${n}</span>` : ''}`;
    }
  }
}

function emptyState() {
  const n = app.channels.length;
  if (app.tab === 'new') {
    if (n === 0) {
      return `<div class="empty"><img src="logo.svg" alt=""><h2>Aucune chaîne suivie</h2>
        <p>Ajoute les chaînes qui t’intéressent. Elles seront les seules à apparaître ici.</p>
        <button type="button" class="primary" data-act="go-channels">Ajouter une chaîne</button></div>`;
    }
    return `<div class="empty compact"><img src="logo.svg" alt=""><h2>C’est tout pour aujourd’hui</h2>
      <p>Rien de nouveau parmi tes ${n} ${plural(n, 'chaîne', 'chaînes')}.</p></div>`;
  }
  if (app.tab === 'later') {
    return '<div class="empty"><h2>Rien en attente</h2><p>Les vidéos que tu mets de côté apparaissent ici.</p></div>';
  }
  return '<div class="empty"><h2>Aucune vidéo vue</h2><p>Les vidéos que tu ouvres sont rangées ici.</p></div>';
}

function actionsFor(tab) {
  const watch = '<button type="button" class="primary" data-act="watch">Regarder</button>';
  if (tab === 'new') {
    return `${watch}<button type="button" class="quiet" data-act="later">Voir plus tard</button><button type="button" class="quiet" data-act="ignore">Ignorer</button>`;
  }
  if (tab === 'later') {
    return `${watch}<button type="button" class="quiet" data-act="ignore">Ignorer</button>`;
  }
  return `${watch}<button type="button" class="quiet" data-act="later">Voir plus tard</button>`;
}

function videoRow(v, thumbs, latest = false) {
  // Miniature fournie par le flux, sinon celle que YouTube publie pour chaque vidéo.
  const src = v.thumb || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  return `<li class="item${thumbs ? ' has-thumb' : ''}" data-id="${esc(v.id)}"${latest ? ' data-latest="1"' : ''}>
    ${thumbs ? `<button type="button" class="thumb-btn" data-act="watch" tabindex="-1" aria-hidden="true"><img class="thumb" src="${esc(src)}" alt="" loading="lazy" onerror="this.closest('.thumb-btn').remove()"></button>` : ''}
    <div>
      <h3 class="title" title="${esc(v.title)}">${esc(shortTitle(v.title))}</h3>
      <p class="meta"><span class="who">${esc(v.channel_title)}</span><span>${esc(when(v.published))}</span></p>
      <div class="actions">${latest ? '<button type="button" class="primary" data-act="watch">Regarder</button>' : actionsFor(app.tab)}</div>
    </div>
  </li>`;
}

// ---------- dossiers ----------

const folderNames = () =>
  [...new Set(app.channels.map((c) => c.category).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'fr'));

function currentFolder() {
  if (app.folder && !folderNames().includes(app.folder)) setFolder('');
  return app.folder;
}

function setFolder(name) {
  app.folder = name;
  try { localStorage.setItem('folder', name); } catch { /* sans mémoire, le filtre repart de « Tous » */ }
}

function folderBar(items) {
  const names = folderNames();
  if (!names.length) return '';
  const active = currentFolder();
  const chip = (name, label, count) =>
    `<button type="button" class="chip" data-act="folder" data-folder="${esc(name)}" aria-pressed="${active === name}">${esc(label)}<span class="chip-count">${count}</span></button>`;
  return `<div class="folders" role="group" aria-label="Dossiers">${chip('', 'Tous', items.length)}${names
    .map((n) => chip(n, n, items.filter((v) => v.category === n).length))
    .join('')}</div>`;
}

const inFolder = (v) => !currentFolder() || v.category === currentFolder();

function renderVideos() {
  const thumbs = showThumbs();
  if (!app.videos.length) {
    const latestAll = app.latest ?? [];
    const latest = latestAll.length
      ? `<section class="latest" aria-labelledby="latest-title">
          <h2 id="latest-title">Dernières vidéos de tes chaînes</h2>
          ${folderBar(latestAll)}
          <ul class="feed${thumbs ? ' cards' : ''}">${latestAll.filter(inFolder).map((v) => videoRow(v, thumbs, true)).join('')}</ul>
        </section>`
      : '';
    view.innerHTML = emptyState() + latest;
    return;
  }
  const shown = app.videos.filter(inFolder);
  // « Tout marquer comme vu » concerne toute la boîte : on le masque quand un dossier filtre la liste.
  const bar = app.tab === 'new' && shown.length && !currentFolder()
    ? '<div class="bar"><button type="button" class="quiet" data-act="all-seen">Tout marquer comme vu</button></div>'
    : '';
  const body = shown.length
    ? `<ul class="feed${thumbs ? ' cards' : ''}">${shown.map((v) => videoRow(v, thumbs)).join('')}</ul>`
    : `<div class="empty compact"><h2>Rien ici dans « ${esc(currentFolder())} »</h2>
        <p>Les autres dossiers ont encore des vidéos.</p>
        <button type="button" class="primary" data-act="folder" data-folder="">Voir tous les dossiers</button></div>`;
  view.innerHTML = `${folderBar(app.videos)}${bar}${body}`;
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

const PLAYER_HINTS = {
  inapp: 'Lecteur de YouTube dans la fenêtre. Des publicités peuvent s’afficher.',
  browser: 'La vidéo s’ouvre dans ton navigateur habituel.',
};

function renderChannels() {
  const s = app.settings;
  const player = s.player === 'browser' ? 'browser' : 'inapp';
  const n = app.channels.length;

  const card = (c) => `<li data-id="${esc(c.id)}">
        ${avatar(c)}
        <div class="info">
          <span class="line"><span class="name">${esc(c.title)}</span>${c.new_count ? `<span class="pill">${c.new_count} à voir</span>` : ''}</span>
          ${c.description ? `<span class="desc">${esc(c.description)}</span>` : ''}
          <span class="folder-slot"><button type="button" class="folder-chip${c.category ? ' set' : ''}" data-act="edit-folder" title="Choisir le dossier de cette chaîne">${c.category ? esc(c.category) : '+ Dossier'}</button></span>
        </div>
        <button type="button" class="remove" data-act="remove-channel" aria-label="Retirer ${esc(c.title)}" title="Retirer cette chaîne">
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false"><path d="M2.5 2.5l7 7m0-7l-7 7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </li>`;
  const names = folderNames();
  const groups = names.length
    ? [...names.map((name) => [name, app.channels.filter((c) => c.category === name)]),
       ['', app.channels.filter((c) => !c.category)]].filter(([, list]) => list.length)
    : [['', app.channels]];
  const list = n
    ? groups.map(([name, items]) => `${names.length ? `<h3 class="group">${name ? esc(name) : 'Sans dossier'}<span class="note">${items.length}</span></h3>` : ''}
        <ul class="channels">${items.map(card).join('')}</ul>`).join('')
    : '<div class="empty-small"><img src="logo.svg" alt="" width="72" height="72"><h3>Aucune chaîne pour l’instant</h3><p>Colle l’adresse d’une chaîne, son @pseudo ou un identifiant commençant par UC, puis clique sur « Suivre ».</p></div>';

  const segment = (value, label) =>
    `<label class="seg"><input type="radio" name="player" value="${value}" data-setting="player" ${player === value ? 'checked' : ''}><span>${label}</span></label>`;
  const toggle = (id, label, help, attrs, on) =>
    `<label class="switch-row" for="${id}"><span class="switch-text"><span class="switch-label">${label}</span><span class="switch-help">${help}</span></span>
      <input type="checkbox" id="${id}" class="switch" ${attrs} ${on ? 'checked' : ''}></label>`;

  view.innerHTML = `
    <div class="manage">
      <section class="mine" aria-labelledby="mine-title">
        <div class="section-head">
          <h2 id="mine-title">Mes chaînes</h2>
          <span class="note">${n ? `${n} ${plural(n, 'chaîne suivie', 'chaînes suivies')}` : ''}</span>
        </div>
        <form id="add" class="add">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <label class="sr" for="channel-input">Chaîne à suivre</label>
          <input id="channel-input" type="text" placeholder="Ajouter : @pseudo, adresse ou identifiant UC…" autocomplete="off" spellcheck="false">
          <button type="submit" class="primary">Suivre</button>
        </form>
        ${list}
      </section>

      <aside class="prefs" aria-label="Réglages">
        <section class="card">
          <h2>Lecture</h2>
          <div class="segmented" role="radiogroup" aria-label="Lecteur vidéo">
            ${segment('inapp', 'Dans Kiosque')}${segment('browser', 'Navigateur')}
          </div>
          <p class="hint">${PLAYER_HINTS[player]}</p>
        </section>
        <section class="card">
          <h2>Affichage</h2>
          ${toggle('thumbs', 'Miniatures', 'Une image pour chaque vidéo.', 'data-local="thumbs"', showThumbs())}
          ${toggle('shorts', 'Masquer les Shorts', 'Pris en compte à la prochaine actualisation.', 'data-setting="exclude_shorts"', s.exclude_shorts !== '0')}
        </section>
        <section class="card">
          <h2>Système</h2>
          ${toggle('autostart', 'Lancer au démarrage', 'Kiosque s’ouvre en même temps que ton ordinateur.', 'data-local="autostart"', app.autostart)}
        </section>
      </aside>
    </div>`;
}

function render() {
  renderTabs();
  if (app.tab === 'channels') renderChannels();
  else renderVideos();
}

async function switchTab(tab) {
  closePlayer();
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
  setStatus('Actualisation…');
  try {
    const report = await invoke('refresh');
    await loadChannels();
    if (app.tab !== 'channels') await loadVideos();
    render();
    if (report.errors.length) {
      const n = report.errors.length;
      setStatus(`${n} ${plural(n, 'chaîne n’a pas répondu', 'chaînes n’ont pas répondu')} : ${report.errors[0]}`, 'error');
    } else if (report.new_videos) {
      const n = report.new_videos;
      setStatus(`${n} ${plural(n, 'nouvelle vidéo', 'nouvelles vidéos')}`);
    } else {
      setStatus('À jour');
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
      case 'edit-folder': {
        const channel = app.channels.find((c) => c.id === li.dataset.id);
        const slot = li.querySelector('.folder-slot');
        slot.innerHTML = `<form class="folder-edit" data-id="${esc(channel.id)}">
          <input type="text" list="folder-list" maxlength="40" autocomplete="off" spellcheck="false"
                 value="${esc(channel.category ?? '')}" placeholder="Nom du dossier" aria-label="Dossier de ${esc(channel.title)}">
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
        if (!confirmClick(button, 'Confirmer ?')) return;
        const n = await invoke('mark_all_seen');
        setStatus(`${n} ${plural(n, 'vidéo rangée', 'vidéos rangées')} comme ${plural(n, 'vue', 'vues')}`);
        await loadChannels();
        await loadVideos();
        return render();
      }
      case 'remove-channel': {
        // Confirmation dans la carte : on retire la chaîne seulement après un second clic explicite.
        const name = li.querySelector('.name')?.textContent ?? 'cette chaîne';
        const box = document.createElement('div');
        box.className = 'confirm';
        box.setAttribute('role', 'alertdialog');
        box.innerHTML = `<span>Retirer « ${esc(name)} » ?</span>
          <button type="button" class="danger" data-act="remove-confirm">Retirer</button>
          <button type="button" class="quiet" data-act="remove-cancel">Annuler</button>`;
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
  setStatus('Recherche de la chaîne…');
  try {
    const channel = await invoke('add_channel', { input: value });
    setStatus(`« ${channel.title} » est suivie`);
    await loadChannels();
    render();
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
        setStatus(app.autostart ? 'Kiosque se lancera au démarrage' : 'Lancement au démarrage désactivé');
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
    const key = el.dataset.setting;
    if (!key) return;
    const value = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
    await invoke('set_setting', { key, value });
    app.settings[key] = value;
    if (key === 'player') renderChannels();
    if (key === 'exclude_shorts') setStatus('Appliqué à la prochaine actualisation');
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

for (const button of tabButtons) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}
refreshBtn.addEventListener('click', refresh);

// ---------- démarrage ----------

(async function init() {
  try {
    app.settings = await invoke('get_settings');
    if (app.settings.player !== 'browser') app.settings.player = 'inapp'; // anciens réglages (mpv) : lecteur intégré
    app.autostart = await invoke('get_autostart').catch(() => false);
    await loadChannels();
    await loadVideos();
    render();
    if (app.channels.length) refresh();
  } catch (err) {
    setStatus(String(err), 'error');
    render();
  }
})();
