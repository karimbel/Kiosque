'use strict';

// Traductions : le texte français sert de clé. Une phrase absente d'ici s'affiche telle quelle.
// {nom} est remplacé par la valeur donnée à t('…', { nom: … }).
const EN = {
  // navigation
  'Ton actualité vidéo, à portée de clics': 'Your video news, a few clicks away',
  'À voir': 'To watch',
  'Plus tard': 'Later',
  'Vues': 'Watched',
  'Chaînes': 'Channels',
  'Actualiser': 'Refresh',
  'Sections': 'Sections',
  'Agrandir la barre de navigation': 'Expand the navigation bar',
  'Réduire la barre de navigation': 'Collapse the navigation bar',
  'Ouvre Kiosque depuis l’application': 'Open Kiosque from the app',
  'Cette page a besoin de la fenêtre Tauri pour fonctionner.': 'This page needs the Tauri window to work.',
  'Lecteur vidéo': 'Video player',
  // mise à jour
  'Mettre à jour': 'Update',
  'Fermer': 'Close',
  'Kiosque {v} est disponible.': 'Kiosque {v} is available.',
  'Mise à jour vers Kiosque {v} en cours…': 'Updating to Kiosque {v}…',
  'Mise à jour impossible : {err}': 'Update failed: {err}',
  // lecteur
  'Retour': 'Back',
  'Réduire': 'Minimize',
  'Continuer à regarder en petit pendant que tu navigues': 'Keep watching in a small window while you browse',
  'Ouvrir dans le navigateur': 'Open in browser',
  'Agrandir': 'Expand',
  'Arrêter la vidéo': 'Stop the video',
  'Position dans la vidéo': 'Position in the video',
  'Volume': 'Volume',
  'Lecture': 'Playback',
  'Lire': 'Play',
  'Pause': 'Pause',
  'Couper le son': 'Mute',
  'Activer le son': 'Unmute',
  'Vitesse de lecture': 'Playback speed',
  'Sous-titres': 'Subtitles',
  'Sous-titres (si la vidéo en propose)': 'Subtitles (if the video has any)',
  'Sous-titres activés (si la vidéo en propose)': 'Subtitles on (if the video has any)',
  'Sous-titres coupés': 'Subtitles off',
  'Plein écran': 'Fullscreen',
  'Quitter le plein écran': 'Exit fullscreen',
  'L’auteur de cette vidéo interdit sa lecture hors de YouTube.': 'The author of this video does not allow playback outside YouTube.',
  'Cette vidéo est privée ou a été supprimée.': 'This video is private or has been deleted.',
  'Cette vidéo ne peut pas être lue ici.': 'This video cannot be played here.',
  'Cette vidéo ne peut pas être lue dans Kiosque.': 'This video cannot be played in Kiosque.',
  'Impossible de joindre YouTube. Vérifie ta connexion internet.': 'Cannot reach YouTube. Check your internet connection.',
  // listes
  'Aucune chaîne suivie': 'No channels followed',
  'Ajoute les chaînes qui t’intéressent. Elles seront les seules à apparaître ici.': 'Add the channels you care about. They will be the only ones showing up here.',
  'Ajouter une chaîne': 'Add a channel',
  'C’est tout pour aujourd’hui': 'That’s all for today',
  'Rien de nouveau parmi ta chaîne.': 'Nothing new from your channel.',
  'Rien de nouveau parmi tes {n} chaînes.': 'Nothing new from your {n} channels.',
  'Rien en attente': 'Nothing waiting',
  'Les vidéos que tu mets de côté apparaissent ici.': 'Videos you set aside show up here.',
  'Aucune vidéo vue': 'No watched videos',
  'Les vidéos que tu ouvres sont rangées ici.': 'Videos you open are filed here.',
  'Regarder': 'Watch',
  'Voir plus tard': 'Watch later',
  'Ignorer': 'Ignore',
  'Dernières vidéos de tes chaînes': 'Latest videos from your channels',
  'Tout marquer comme vu': 'Mark all as watched',
  'Confirmer ?': 'Confirm?',
  'Rien ici avec ce filtre': 'Nothing here with this filter',
  'Les autres dossiers et plateformes ont encore des vidéos.': 'Other folders and platforms still have videos.',
  'Tout afficher': 'Show all',
  'Tout': 'All',
  'Téléchargement de Kiosque {v} : {p} %': 'Downloading Kiosque {v}: {p}%',
  'Ouvrir le dépôt GitHub': 'Open the GitHub repository',
  'Filtres': 'Filters',
  'Tous': 'All',
  'Toutes': 'All',
  'Dossiers': 'Folders',
  'Plateformes': 'Platforms',
  '{n} vidéo rangée comme vue': '{n} video filed as watched',
  '{n} vidéos rangées comme vues': '{n} videos filed as watched',
  '{n} nouvelle vidéo': '{n} new video',
  '{n} nouvelles vidéos': '{n} new videos',
  '{n} chaîne n’a pas répondu : {err}': '{n} channel didn’t respond: {err}',
  '{n} chaînes n’ont pas répondu : {err}': '{n} channels didn’t respond: {err}',
  'Actualisation…': 'Refreshing…',
  'À jour': 'Up to date',
  // chaînes
  'Mes chaînes': 'My channels',
  '{n} chaîne suivie': '{n} channel followed',
  '{n} chaînes suivies': '{n} channels followed',
  '@pseudo, adresse d’une chaîne ou d’une vidéo…': '@handle, channel or video address…',
  'Suivre': 'Follow',
  'Recherche de la chaîne…': 'Looking up the channel…',
  '« {title} » est suivie': '“{title}” is followed',
  '{n} à voir': '{n} to watch',
  'Choisir le dossier de cette chaîne': 'Choose this channel’s folder',
  '+ Dossier': '+ Folder',
  'Retirer {name}': 'Remove {name}',
  'Retirer cette chaîne': 'Remove this channel',
  'Retirer « {name} » ?': 'Remove “{name}”?',
  'Retirer': 'Remove',
  'Annuler': 'Cancel',
  'cette chaîne': 'this channel',
  'Sans dossier': 'No folder',
  'Nom du dossier': 'Folder name',
  'Dossier de {title}': 'Folder of {title}',
  'Aucune chaîne pour l’instant': 'No channels yet',
  'Colle l’adresse d’une chaîne, son @pseudo ou un identifiant commençant par UC, puis clique sur « Suivre ».': 'Paste a channel address, its @handle or an ID starting with UC, then click “Follow”.',
  // réglages
  'Réglages': 'Settings',
  'Système': 'System',
  'Toujours actif (par défaut).': 'Always on (default).',
  'Vidéos libres, hébergées sur de nombreux sites.': 'Free videos, hosted on many sites.',
  'Chaînes Odysee (@Nom:c).': 'Odysee channels (@Name:c).',
  'Chaînes et comptes Vimeo.': 'Vimeo channels and accounts.',
  'Chaînes Dailymotion.': 'Dailymotion channels.',
  'Colle ensuite l’adresse d’une chaîne ou d’une vidéo de la plateforme dans « Suivre ».': 'Then paste a channel or video address from the platform into “Follow”.',
  'Dans Kiosque': 'In Kiosque',
  'Navigateur': 'Browser',
  'Lecteur de YouTube dans la fenêtre. Des publicités peuvent s’afficher.': 'YouTube player inside the window. Ads may be shown.',
  'La vidéo s’ouvre dans ton navigateur habituel.': 'The video opens in your usual browser.',
  'Miniatures': 'Thumbnails',
  'Une image pour chaque vidéo.': 'A picture for each video.',
  'Masquer les Shorts': 'Hide Shorts',
  'Pris en compte à la prochaine actualisation.': 'Applied on the next refresh.',
  'Appliqué à la prochaine actualisation': 'Applied on the next refresh',
  'Mise à jour automatique': 'Automatic updates',
  'Télécharge et installe les nouvelles versions au démarrage, puis relance Kiosque.': 'Downloads and installs new versions at startup, then restarts Kiosque.',
  'Lancer au démarrage': 'Launch at startup',
  'Kiosque s’ouvre en même temps que ton ordinateur.': 'Kiosque opens when your computer starts.',
  'Kiosque se lancera au démarrage': 'Kiosque will launch at startup',
  'Lancement au démarrage désactivé': 'Launch at startup turned off',
  'Langue': 'Language',
  'Choisis la langue de l’interface.': 'Choose the interface language.',
  'Automatique': 'Automatic',
  '{label} activé': '{label} on',
  '{label} désactivé': '{label} off',
};

const AVAILABLE_LANGUAGES = ['fr', 'en'];
let lang = 'fr';

/** Langue effective : le choix de l'utilisateur, sinon celle du système (français, ou anglais pour le reste). */
function resolveLanguage(choice) {
  if (AVAILABLE_LANGUAGES.includes(choice)) return choice;
  const system = (navigator.language || 'fr').toLowerCase();
  return system.startsWith('fr') ? 'fr' : 'en';
}

function setLanguage(choice) {
  lang = resolveLanguage(choice);
  document.documentElement.lang = lang;
  return lang;
}

/** Texte dans la langue courante ; {nom} est remplacé par vars.nom. */
function t(text, vars) {
  let out = lang === 'en' ? (EN[text] ?? text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Choisit le singulier ou le pluriel selon la langue (en français, 0 et 1 sont au singulier). */
function tn(n, one, many, vars = {}) {
  const isMany = lang === 'en' ? n !== 1 : n > 1;
  return t(isMany ? many : one, { n, ...vars });
}

setLanguage('');
