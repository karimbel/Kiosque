'use strict';

const view = document.querySelector('#view');
const toastBox = document.querySelector('#toasts');
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
  kid: { active: false, session_name: '', has_pin: false }, // mode protection
  sessions: [],
  sessionEdit: null, // session en cours de modification : { id, name, channels:Set }
  pinForm: false,
  missing: [], // chaînes des sessions importées pas encore suivies : { id, title, platform }
};

// ---------- utilitaires ----------

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const plural = (n, one, many) => t(lang === 'en' ? (n !== 1 ? many : one) : (n > 1 ? many : one));
// Miniatures affichées par défaut ; se désactivent dans Chaînes.
const showThumbs = () => { try { return localStorage.getItem('thumbs') !== '0'; } catch { return true; } };

/**
 * Notification éphémère en bas à gauche. `kind` : '' (info), 'error' (reste plus longtemps)
 * ou 'busy' (opération en cours : reste affichée jusqu'à la notification suivante).
 * Un message vide ne fait rien.
 */
function setStatus(message, kind = '') {
  if (!message) return;
  for (const old of toastBox.querySelectorAll('.toast[data-kind="busy"]')) dismissToast(old);
  const same = [...toastBox.children].find((el) => el.dataset.text === message && el.dataset.kind === kind);
  if (same) same.remove();
  while (toastBox.children.length >= 4) toastBox.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.kind = kind;
  el.dataset.text = message;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', t('Fermer'));
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(el));
  el.append(icon, text, close);
  toastBox.append(el);

  if (kind === 'busy') return;
  let left = kind === 'error' ? 9000 : 4500;
  let started = Date.now();
  let timer = setTimeout(() => dismissToast(el), left);
  // Le survol met la notification en pause pour avoir le temps de la lire.
  el.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - started; });
  el.addEventListener('mouseleave', () => { started = Date.now(); timer = setTimeout(() => dismissToast(el), Math.max(left, 1500)); });
}

function dismissToast(el) {
  if (!el.isConnected || el.classList.contains('out')) return;
  el.classList.add('out');
  setTimeout(() => el.remove(), 220);
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
// Lecteur YouTube standard (API « IFrame »), avec ses propres commandes, en lecture automatique.

const playerEl = document.querySelector('#player');
let playing = null;      // vidéo en cours
let yt = null;           // lecteur YouTube
let ytLoading = null;    // chargement unique du script YouTube

const ICONS = {
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
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

const q = (sel) => playerEl.querySelector(sel);

function showPlayerMessage(text) {
  const box = q('.player-msg');
  if (!box) return;
  box.querySelector('p').textContent = text;
  box.hidden = false;
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
    playerVars: { autoplay: 1, playsinline: 1, rel: 0, hl: lang, start: Math.floor(startAt) },
    events: {
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
}

/** Réduit le lecteur dans le coin bas droit : la vidéo continue pendant la navigation. */
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
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  try { yt?.destroy?.(); } catch { /* déjà détruit */ }
  yt = null;
  playing = null;
  if (!playerEl.hidden) playerEl.hidden = true;
  playerEl.classList.remove('mini');
  playerEl.innerHTML = '';
}

playerEl.addEventListener('click', async (event) => {
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

document.addEventListener('keydown', (event) => {
  if (playerEl.hidden || playerEl.classList.contains('mini')) return;
  if (event.key === 'Escape' && !document.fullscreenElement) minimizePlayer();
});

// ---------- données ----------

const loadChannels = async () => {
  app.channels = await invoke('list_channels');
  if (!app.kid.active) app.sessions = await invoke('sessions_list').catch(() => []);
};
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
  if (app.kid.active && n === 0) {
    return `<div class="empty"><img src="logo.svg" alt=""><h2>${t('Aucune chaîne dans cette session')}</h2>
      <p>${t('Quitte le mode protection pour ajouter des chaînes à cette session.')}</p></div>`;
  }
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
      <p class="meta"><span class="who">${esc(v.channel_title)}</span><span class="when">${esc(when(v.published))}</span></p>
      ${platformLabel(v.platform) || v.category ? `<p class="vtags">${platformLabel(v.platform) ? `<span class="pf">${esc(platformLabel(v.platform))}</span>` : ''}${v.category ? `<span class="fo">${esc(v.category)}</span>` : ''}</p>` : ''}
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
// Plateformes mises de côté : le code reste en place, mais l'option est désactivée et ne peut pas être cochée.
// Dailymotion : le lecteur refuse d'être intégré à Kiosque pour la plupart des vidéos.
const UNAVAILABLE = ['dailymotion'];
const activePlatforms = () => (app.settings.platforms || '').split(',').filter((k) => k && !UNAVAILABLE.includes(k));

const PLAYER_HINTS = {
  inapp: 'Lecteur de YouTube dans la fenêtre. Des publicités peuvent s’afficher.',
  browser: 'La vidéo s’ouvre dans ton navigateur habituel.',
}; // traduits à l'affichage

// ---------- sessions et mode protection ----------

function sessionsPanel() {
  return `<div class="sessions-panel">${sessionsPanelBody()}</div>`;
}

function sessionsPanelBody() {
  const ed = app.sessionEdit;
  if (ed) {
    const rows = app.channels.map((c) => `<label class="pick"><input type="checkbox" data-pick="${esc(c.id)}" ${ed.channels.has(c.id) ? 'checked' : ''}>
        <span class="pick-name">${esc(c.title)}</span>${platformLabel(c.platform) ? `<span class="pf">${esc(platformLabel(c.platform))}</span>` : ''}</label>`).join('');
    return `<div class="field"><label class="switch-label" for="session-name">${t('Nom de la session')}</label>
        <input id="session-name" class="text" type="text" maxlength="40" autocomplete="off" value="${esc(ed.name)}" placeholder="${esc(t('Ex. : Les enfants'))}"></div>
      <div class="field"><span class="switch-label">${t('Chaînes de la session')}</span>
        <div class="picklist">${rows || `<p class="hint">${t('Ajoute d’abord des chaînes dans « Mes chaînes ».')}</p>`}</div></div>
      <div class="row-actions"><button type="button" class="primary" data-act="session-save">${t('Enregistrer')}</button>
        <button type="button" class="quiet" data-act="session-cancel">${t('Annuler')}</button></div>`;
  }
  const list = app.sessions.length
    ? `<ul class="sessions">${app.sessions.map((s) => `<li data-session="${esc(s.id)}">
        <span class="sname">${esc(s.name)}<span class="note">${tn(s.channels.length, '{n} chaîne', '{n} chaînes')}</span></span>
        <span class="sact">${app.kid.has_pin ? `<button type="button" class="primary small" data-act="session-launch">${t('Lancer')}</button>` : ''}
          <button type="button" class="quiet" data-act="session-edit">${t('Modifier')}</button>
          <button type="button" class="quiet" data-act="session-delete" aria-label="${esc(t('Supprimer {name}', { name: s.name }))}" title="${esc(t('Supprimer cette session'))}">×</button></span></li>`).join('')}</ul>`
    : `<p class="hint">${t('Aucune session pour l’instant.')}</p>`;
  // Assistant : pas de session = pas de code. Dès la première session, on choisit le code (vide = 0000).
  // Ensuite la zone du code reste repliée derrière « Changer le code ».
  const hasPin = app.kid.has_pin;
  const hasSessions = app.sessions.length > 0;
  const codeForm = !hasPin || app.pinForm;
  let codeZone = '';
  if (hasSessions || hasPin) {
    codeZone = codeForm
      ? `<div class="field pin"><span class="switch-label">${t('Code de protection')}</span>
          <p class="hint">${hasPin ? t('Ce code est unique : il est valable pour toutes les sessions.') : t('Valable pour toutes les sessions. Laisse vide pour utiliser 0000.')}</p>
          ${hasPin ? `<input id="pin-current" class="text" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${esc(t('Code actuel'))}" aria-label="${esc(t('Code actuel'))}">` : ''}
          <input id="pin-new" class="text" type="password" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="${esc(t('Nouveau code (4 chiffres)'))}" aria-label="${esc(t('Nouveau code (4 chiffres)'))}">
          <div class="row-actions"><button type="button" class="primary" data-act="pin-save">${t('Enregistrer')}</button>
            ${hasPin ? `<button type="button" class="quiet" data-act="pin-cancel">${t('Annuler')}</button>` : ''}</div></div>`
      : `<div class="field pin"><button type="button" data-act="pin-open">${t('Changer le code')}</button></div>`;
  }
  return `<p class="hint">${t('Une session est une liste de chaînes. Le mode protection la verrouille : seules ces chaînes sont visibles, sans ajout, sans réglages ni liens externes.')}</p>
    <div class="sp-head"><span class="switch-label">${t('Mes sessions')}</span>${!hasPin && hasSessions ? '' : `<button type="button" data-act="session-new">${t('Nouvelle session')}</button>`}</div>
    ${list}
    ${codeZone}`;
}

/** Sauvegarde et transfert des sessions (réglages Système). */
function sessionsBackup() {
  return `<div class="field backup"><span class="switch-label">${t('Sauvegarde des sessions')}</span>
      <p class="hint">${t('Gère tes sessions dans un fichier pour les exporter ou les importer sur un autre ordinateur. Le code de protection s’il existe n’y est pas inclus. Il faut en recréer un nouveau.')}</p>
      <div class="row-actions"><button type="button" data-act="sessions-export"${app.sessions.length ? '' : ' disabled'}>${t('Exporter')}</button>
        <button type="button" data-act="sessions-import">${t('Importer')}</button>
        <input id="session-file" type="file" accept=".json,application/json" hidden></div>
      ${missingPanel()}</div>`;
}

/** Chaînes des sessions importées que cet ordinateur ne suit pas encore. */
function missingPanel() {
  if (!app.missing.length) return '';
  const names = app.missing.map((c) => esc(c.title)).join(', ');
  return `<div class="missing"><p class="hint">${tn(app.missing.length, '{n} chaîne de ces sessions n’est pas encore suivie ici :', '{n} chaînes de ces sessions ne sont pas encore suivies ici :')} ${names}.</p>
    <div class="row-actions"><button type="button" class="primary" data-act="follow-missing">${t('Suivre les chaînes manquantes')}</button>
      <button type="button" class="quiet" data-act="missing-dismiss">${t('Ignorer')}</button></div></div>`;
}

/** Recharge tout après l'entrée ou la sortie du mode protection. */
async function reloadAfterKidChange() {
  app.kid = await invoke('kid_status');
  // À l'entrée du mode protection, une vidéo hors session ne doit pas continuer ; à la sortie, la lecture continue.
  if (app.kid.active) closePlayer();
  app.sessionEdit = null;
  app.pinForm = false;
  setPlatform('');
  setFolder('');
  applyKid();
  await loadChannels();
  if (app.tab !== 'channels') await loadVideos();
  render();
}

function applyKid() {
  const on = !!app.kid.active;
  document.body.classList.toggle('kid', on);
  const button = document.querySelector('#kid-exit');
  button.hidden = !on;
  if (on) {
    button.querySelector('.kid-name').textContent = t('Mode protection');
    button.title = t('Session : {name} — quitter le mode protection (code de protection)', { name: app.kid.session_name });
    document.querySelector('#update').hidden = true;
    if (app.tab === 'channels') app.tab = 'new';
  }
}

/** Demande le code de protection dans une fenêtre ; `action(code)` doit lever une erreur si le code est refusé. */
function askPin(title, hint, action) {
  const modal = document.querySelector('#pin-modal');
  const input = document.querySelector('#pin-input');
  const error = document.querySelector('#pin-error');
  document.querySelector('#pin-title').textContent = title;
  document.querySelector('#pin-hint').textContent = hint;
  error.hidden = true;
  input.value = '';
  modal.hidden = false;
  input.focus();
  return new Promise((resolve) => {
    const form = document.querySelector('#pin-form');
    const finish = (result) => {
      modal.hidden = true;
      form.removeEventListener('submit', onSubmit);
      document.removeEventListener('keydown', onKey, true);
      document.querySelector('#pin-cancel').removeEventListener('click', onCancel);
      resolve(result);
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      try {
        await action(input.value);
        finish(true);
      } catch (err) {
        error.textContent = String(err);
        error.hidden = false;
        input.value = '';
        input.focus();
      }
    };
    const onCancel = () => finish(false);
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); finish(false); } };
    form.addEventListener('submit', onSubmit);
    document.querySelector('#pin-cancel').addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
  });
}

document.querySelector('#kid-exit').addEventListener('click', async () => {
  const done = await askPin(t('Code de protection'), t('Saisis le code pour quitter le mode protection.'), (pin) => invoke('kid_stop', { pin }));
  if (!done) return;
  await reloadAfterKidChange();
  setStatus(t('Mode protection désactivé'));
});

view.addEventListener('input', (event) => {
  if (event.target.id === 'session-name' && app.sessionEdit) app.sessionEdit.name = event.target.value;
});
view.addEventListener('change', async (event) => {
  if (event.target.id !== 'session-file') return;
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const report = await invoke('sessions_import', { json: await file.text() });
    app.sessions = await invoke('sessions_list');
    app.missing = report.missing;
    renderChannels();
    setStatus(tn(report.imported, '{n} session importée', '{n} sessions importées'));
    // Le fichier ne contient jamais le code : sans code sur cet ordinateur, on propose d'en créer un (vide = 0000).
    if (!app.kid.has_pin) {
      let byDefault = false;
      const done = await askPin(
        t('Code de protection'),
        t('Choisis un code à 4 chiffres pour cet ordinateur. Laisse vide pour utiliser 0000.'),
        (pin) => {
          byDefault = pin.trim() === '';
          return invoke('kid_set_pin', { pin: byDefault ? '0000' : pin, current: null });
        },
      );
      app.kid = await invoke('kid_status');
      if (done) setStatus(byDefault ? t('Code 0000 défini : à changer.') : t('Code de protection enregistré'));
      renderChannels();
    }
  } catch (err) {
    setStatus(String(err), 'error');
  }
});
view.addEventListener('change', (event) => {
  const id = event.target.dataset?.pick;
  if (!id || !app.sessionEdit) return;
  if (event.target.checked) app.sessionEdit.channels.add(id); else app.sessionEdit.channels.delete(id);
});

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

  const SUBS = [['platforms', t('Plateformes')], ['playback', t('Lecture')], ['sessions', t('Sessions')], ['system', t('Système')]];
  if (!SUBS.some(([k]) => k === app.sub)) app.sub = 'playback';

  const panels = {
    platforms: `
      ${toggle('pf-youtube', 'YouTube', t('Toujours actif (par défaut).'), 'disabled', true)}
      ${PLATFORMS.map(([key, label, help]) => UNAVAILABLE.includes(key)
        ? toggle('pf-' + key, label, t('Bientôt disponible.'), 'disabled', false)
        : toggle('pf-' + key, label, t(help), `data-platform="${key}"`, activePlatforms().includes(key))).join('')}
      <p class="hint">${t('Colle ensuite l’adresse d’une chaîne ou d’une vidéo de la plateforme dans « Suivre ».')}</p>`,
    playback: `
      <div class="segmented" role="radiogroup" aria-label="${t('Lecteur vidéo')}">
        ${segment('inapp', t('Dans Kiosque'))}${segment('browser', t('Navigateur'))}
      </div>
      <p class="hint">${t(PLAYER_HINTS[player])}</p>
      ${toggle('thumbs', t('Miniatures'), t('Une image pour chaque vidéo.'), 'data-local="thumbs"', showThumbs())}
      ${toggle('shorts', t('Masquer les Shorts'), t('Pris en compte à la prochaine actualisation.'), 'data-setting="exclude_shorts"', s.exclude_shorts !== '0')}`,
    sessions: sessionsPanel(),
    system: `
      <div class="field"><span class="switch-label">${t('Langue')}</span>
        <div class="segmented three" role="radiogroup" aria-label="${t('Langue')}">
          ${[['', t('Automatique')], ['fr', 'Français'], ['en', 'English']].map(([v, label]) => `<label class="seg"><input type="radio" name="language" value="${v}" data-setting="language" ${(s.language || '') === v ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
      </div>
      ${toggle('autoupdate', t('Mise à jour automatique'), t('Télécharge et installe les nouvelles versions au démarrage, puis relance Kiosque.'), 'data-setting="auto_update"', s.auto_update === '1')}
      ${toggle('autostart', t('Lancer au démarrage'), t('Kiosque s’ouvre en même temps que ton ordinateur.'), 'data-local="autostart"', app.autostart)}
      ${sessionsBackup()}`,
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
  if (app.kid.active && tab === 'channels') return; // verrouillé : pas de gestion des chaînes
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

async function refresh(quiet = false) {
  if (app.busy) return;
  app.busy = true;
  refreshBtn.disabled = true;
  if (!quiet) setStatus(t('Actualisation…'), 'busy');
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
    } else if (!quiet) {
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
        minimizePlayer();
        setFolder(button.dataset.folder);
        return renderVideos();
      case 'platform':
        minimizePlayer();
        setPlatform(button.dataset.platform);
        return renderVideos();
      case 'open-repo':
        event.preventDefault();
        return await invoke('open_repo');
      case 'session-new':
        app.sessionEdit = { id: '', name: '', channels: new Set() };
        return renderChannels();
      case 'session-edit': {
        const session = app.sessions.find((s) => s.id === button.closest('[data-session]').dataset.session);
        if (!session) return;
        app.sessionEdit = { id: session.id, name: session.name, channels: new Set(session.channels) };
        return renderChannels();
      }
      case 'session-cancel':
        app.sessionEdit = null;
        return renderChannels();
      case 'session-save': {
        const ed = app.sessionEdit;
        await invoke('session_save', { id: ed.id, name: ed.name, channels: [...ed.channels] });
        app.sessions = await invoke('sessions_list');
        app.sessionEdit = null;
        renderChannels();
        return setStatus(t('Session enregistrée'));
      }
      case 'session-delete': {
        if (!confirmClick(button, t('Confirmer ?'))) return;
        await invoke('session_delete', { id: button.closest('[data-session]').dataset.session });
        app.sessions = await invoke('sessions_list');
        renderChannels();
        return setStatus(t('Session supprimée'));
      }
      case 'session-launch': {
        if (!app.kid.has_pin) {
          app.pinForm = true;
          renderChannels();
          return setStatus(t('Choisis d’abord un code de protection.'), 'error');
        }
        await invoke('kid_start', { sessionId: button.closest('[data-session]').dataset.session });
        await reloadAfterKidChange();
        return setStatus(t('Mode protection activé'));
      }
      case 'sessions-export': {
        const path = await invoke('sessions_export');
        return setStatus(t('Exporté : {path}', { path }));
      }
      case 'sessions-import':
        return document.querySelector('#session-file').click();
      case 'missing-dismiss':
        app.missing = [];
        return renderChannels();
      case 'follow-missing': {
        setStatus(t('Ajout des chaînes…'), 'busy');
        const report = await invoke('follow_channels', { ids: app.missing.map((c) => c.id) });
        await loadChannels();
        const left = app.missing.filter((c) => !app.channels.some((x) => x.id === c.id));
        app.missing = left;
        renderChannels();
        if (report.failed.length) {
          return setStatus(t('{n} chaîne(s) non ajoutée(s) : {detail}', { n: report.failed.length, detail: report.failed[0] }), 'error');
        }
        return setStatus(tn(report.followed, '{n} chaîne ajoutée', '{n} chaînes ajoutées'));
      }
      case 'pin-open':
        app.pinForm = true;
        return renderChannels();
      case 'pin-cancel':
        app.pinForm = false;
        return renderChannels();
      case 'pin-save': {
        const current = document.querySelector('#pin-current')?.value ?? null;
        let pin = document.querySelector('#pin-new').value;
        const byDefault = !app.kid.has_pin && pin.trim() === '';
        if (byDefault) pin = '0000';
        await invoke('kid_set_pin', { pin, current });
        app.kid = await invoke('kid_status');
        app.pinForm = false;
        renderChannels();
        return setStatus(byDefault ? t('Code 0000 défini : à changer.') : t('Code enregistré'));
      }
      case 'reset-filters':
        minimizePlayer();
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

        // Réglage « Navigateur » : la vidéo s'ouvre hors de Kiosque. Dailymotion : si l'auteur interdit
        // l'intégration (le lecteur afficherait « Forbidden »), la vidéo s'ouvre aussi dans le navigateur.
        let external = app.settings.player === 'browser' && !app.kid.active;
        if (!external && !app.kid.active && video.platform === 'dailymotion' && !(await invoke('can_embed', { id }))) {
          external = true;
          setStatus(t('L’auteur de cette vidéo Dailymotion interdit sa lecture hors de Dailymotion : ouverture dans le navigateur.'));
        }
        if (external) {
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
  setStatus(t('Recherche de la chaîne…'), 'busy');
  try {
    const channel = await invoke('add_channel', { input: value });
    const already = app.channels.some((c) => c.id === channel.id);
    setStatus(already
      ? t('« {title} » est déjà dans tes chaînes', { title: channel.title })
      : t('« {title} » est suivie', { title: channel.title }));
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
  for (const el of document.querySelectorAll('[data-t-title]')) el.title = t(el.dataset.tTitle);
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
  if (app.kid.active) return;
  try {
    const info = await invoke('check_update');
    if (!info) return;
    const box = document.querySelector('#update');
    const text = document.querySelector('#update-text');
    box.dataset.version = info.version;
    app.selfUpdate = await invoke('can_self_update').catch(() => true);
    if (app.settings.auto_update === '1' && app.selfUpdate) {
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
    if (app.selfUpdate === false) {
      // macOS et Linux : pas encore d'installation dans Kiosque, on ouvre la page de la release.
      try { await invoke('open_release'); } catch (err) { setStatus(String(err), 'error'); }
      return;
    }
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
    app.kid = await invoke('kid_status').catch(() => app.kid);
    applyKid();
    await loadChannels();
    await loadVideos();
    render();
    if (app.channels.length) refresh(true);
    checkUpdate();
  } catch (err) {
    setStatus(String(err), 'error');
    render();
  }
})();
