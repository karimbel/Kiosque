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
  settings: { player: 'inapp', mpv_path: 'mpv', exclude_shorts: '1' },
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

const playerEl = document.querySelector('#player');
let playing = null;

function openPlayer(video) {
  playing = video;
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}`
    + '?autoplay=1&rel=0&modestbranding=1&playsinline=1&iv_load_policy=3';
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
    <div class="player-stage">
      <iframe src="${esc(src)}" title="${esc(video.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
    </div>`;
  playerEl.hidden = false;
  playerEl.querySelector('[data-player="close"]').focus();
}

function closePlayer() {
  if (playerEl.hidden) return;
  playerEl.hidden = true;
  playerEl.innerHTML = ''; // retirer le lecteur arrête la lecture
  playing = null;
}

playerEl.addEventListener('click', async (event) => {
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

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePlayer();
});

// ---------- données ----------

const loadChannels = async () => { app.channels = await invoke('list_channels'); };
const loadVideos = async () => { app.videos = await invoke('list_videos', { status: app.tab }); };
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
    return `<div class="empty"><img src="logo.svg" alt=""><h2>C’est tout pour aujourd’hui</h2>
      <p>Rien de nouveau parmi tes ${n} ${plural(n, 'chaîne', 'chaînes')}. Reviens quand tu veux.</p></div>`;
  }
  if (app.tab === 'later') {
    return '<div class="empty"><h2>Rien en attente</h2><p>Les vidéos que tu mets de côté apparaissent ici.</p></div>';
  }
  return '<div class="empty"><h2>Aucune vidéo vue</h2><p>Les vidéos que tu ouvres sont rangées ici.</p></div>';
}

function actionsFor(tab) {
  const watch = '<button type="button" class="primary" data-act="watch">Regarder</button>';
  if (tab === 'new') {
    return `${watch}<button type="button" class="quiet" data-act="later">Plus tard</button><button type="button" class="quiet" data-act="ignore">Ignorer</button>`;
  }
  if (tab === 'later') {
    return `${watch}<button type="button" class="quiet" data-act="ignore">Ignorer</button>`;
  }
  return `${watch}<button type="button" class="quiet" data-act="unsee">Remettre à voir</button>`;
}

function videoRow(v, thumbs) {
  // Miniature fournie par le flux, sinon celle que YouTube publie pour chaque vidéo.
  const src = v.thumb || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`;
  return `<li class="item${thumbs ? ' has-thumb' : ''}" data-id="${esc(v.id)}">
    ${thumbs ? `<button type="button" class="thumb-btn" data-act="watch" tabindex="-1" aria-hidden="true"><img class="thumb" src="${esc(src)}" alt="" loading="lazy" onerror="this.closest('.thumb-btn').remove()"></button>` : ''}
    <div>
      <button type="button" class="title" data-act="watch" title="${esc(v.title)}">${esc(calmTitle(v.title))}</button>
      <p class="meta"><span class="who">${esc(v.channel_title)}</span><span>${esc(when(v.published))}</span></p>
      <div class="actions">${actionsFor(app.tab)}</div>
    </div>
  </li>`;
}

function renderVideos() {
  if (!app.videos.length) {
    view.innerHTML = emptyState();
    return;
  }
  const thumbs = showThumbs();
  const bar = app.tab === 'new'
    ? '<div class="bar"><button type="button" class="quiet" data-act="all-seen">Tout marquer comme vu</button></div>'
    : '';
  view.innerHTML = `${bar}<ul class="feed${thumbs ? ' cards' : ''}">${app.videos.map((v) => videoRow(v, thumbs)).join('')}</ul>`;
}

function renderChannels() {
  const s = app.settings;
  const list = app.channels.length
    ? `<ul class="channels">${app.channels.map((c) => `<li data-id="${esc(c.id)}">
        <span class="name">${esc(c.title)}${c.new_count ? `<span class="pending">${c.new_count} à voir</span>` : ''}</span>
        <button type="button" class="quiet" data-act="remove-channel">Retirer</button></li>`).join('')}</ul>`
    : '<div class="empty"><h2>Aucune chaîne</h2><p>Colle l’adresse d’une chaîne, son @pseudo ou un identifiant commençant par UC.</p></div>';

  view.innerHTML = `
    <form id="add" class="add">
      <label class="sr" for="channel-input">Chaîne à suivre</label>
      <input id="channel-input" type="text" placeholder="@pseudo, adresse de la chaîne ou identifiant UC…" autocomplete="off" spellcheck="false">
      <button type="submit" class="primary">Suivre</button>
    </form>
    ${list}
    <section class="settings">
      <h2>Lecture</h2>
      <p class="hint">Le lecteur intégré est celui de YouTube : il peut afficher des publicités. mpv lit sans publicité ni compte, à condition que mpv et yt-dlp soient installés.</p>
      <div class="field"><input type="radio" id="p-inapp" name="player" value="inapp" data-setting="player" ${s.player !== 'mpv' && s.player !== 'browser' ? 'checked' : ''}><label for="p-inapp">Dans Kiosque (lecteur intégré)</label></div>
      <div class="field"><input type="radio" id="p-browser" name="player" value="browser" data-setting="player" ${s.player === 'browser' ? 'checked' : ''}><label for="p-browser">Dans le navigateur</label></div>
      <div class="field"><input type="radio" id="p-mpv" name="player" value="mpv" data-setting="player" ${s.player === 'mpv' ? 'checked' : ''}><label for="p-mpv">Dans mpv</label></div>
      ${s.player === 'mpv' ? `<div class="field path"><label class="sr" for="mpv-path">Chemin de mpv</label><input id="mpv-path" type="text" value="${esc(s.mpv_path)}" data-setting="mpv_path" spellcheck="false"></div>` : ''}
      <h2 style="margin-top:24px">Affichage</h2>
      <div class="field"><input type="checkbox" id="shorts" data-setting="exclude_shorts" ${s.exclude_shorts !== '0' ? 'checked' : ''}><label for="shorts">Masquer les Shorts</label></div>
      <div class="field"><input type="checkbox" id="thumbs" data-local="thumbs" ${showThumbs() ? 'checked' : ''}><label for="thumbs">Afficher les miniatures</label></div>
    </section>`;
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
      case 'watch': {
        if (app.settings.player === 'inapp') {
          const id = li.dataset.id;
          const video = app.videos.find((v) => v.id === id) ?? { id, title: '', channel_title: '' };
          await invoke('set_status', { id, status: 'seen' });
          setStatus('');
          openPlayer(video);
          if (app.tab === 'seen') return;
          return dismissRow(li);
        }
        const used = await invoke('open_video', { id: li.dataset.id });
        if (used === 'browser-fallback') {
          setStatus('mpv est introuvable : la vidéo s’est ouverte dans le navigateur. Vérifie le chemin dans Chaînes.', 'error');
        } else {
          setStatus('');
        }
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
        if (!confirmClick(button, 'Confirmer ?')) return;
        await invoke('remove_channel', { id: li.dataset.id });
        await loadChannels();
        return render();
      }
    }
  } catch (err) {
    setStatus(String(err), 'error');
  }
});

view.addEventListener('submit', async (event) => {
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

view.addEventListener('change', async (event) => {
  const el = event.target;
  try {
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
    await loadChannels();
    await loadVideos();
    render();
    if (app.channels.length) refresh();
  } catch (err) {
    setStatus(String(err), 'error');
    render();
  }
})();
