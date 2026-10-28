# Kiosque

Un lecteur de chaînes YouTube qui se termine. Tu choisis les chaînes, Kiosque affiche leurs nouvelles vidéos dans une boîte de réception, et quand elle est vide, c'est fini : pas de recommandations, pas de fil sans fin, pas d'autoplay.

Application de bureau en Rust avec [Tauri 2](https://v2.tauri.app/). Aucun compte Google, aucune clé d'API : Kiosque lit les flux RSS publics des chaînes.

![Aperçu de Kiosque, thème clair](docs/apercu-clair.png)

<details>
<summary>Thème sombre</summary>

![Aperçu de Kiosque, thème sombre](docs/apercu-sombre.png)

</details>

Les aperçus montrent des chaînes d'exemple, dont les miniatures sont des dégradés de remplacement. L'interface suit le thème de ton système, et la barre du haut se réduit avec la flèche à droite.

## Obtenir l'application (GitHub)

Un workflow GitHub (`.github/workflows/release.yml`) construit l'installeur Windows sur les serveurs de GitHub : rien à installer ni à compiler chez toi, et aucun Go de plus sur ton disque.

1. Crée un dépôt vide sur github.com (sans README), puis, dans PowerShell, dans le dossier du projet :
   ```
   git init
   git add .
   git commit -m "Kiosque"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/kiosque.git
   git push -u origin main
   ```
2. Lance la construction : onglet **Actions → Construire Kiosque → Run workflow**. Compte une dizaine de minutes la première fois, moins ensuite.
3. Va dans **Releases** : un brouillon contient `Kiosque_0.1.0_x64-setup.exe` (installeur) et `Kiosque_0.1.0_portable.exe` (aucune installation : tu le lances directement). Télécharge celui que tu préfères. « Publish release » est facultatif.

Pour une nouvelle version, change `version` dans `src-tauri/tauri.conf.json`, envoie les changements (`git add . && git commit -m "…" && git push`), puis relance le workflow, ou pousse une étiquette : `git tag v0.2.0 && git push --tags`.

L'installeur n'est pas signé : Windows (SmartScreen) affiche un avertissement au premier lancement. Clique sur « Informations complémentaires », puis « Exécuter quand même ».

Le workflow ne construit que Windows. macOS et Linux se rajoutent facilement, mais sur un dépôt privé, les minutes macOS sont comptées dix fois plus vite que celles de Windows.

## Lancer le projet sur ta machine

Seulement si tu veux modifier le code. Prérequis : [Rust](https://rustup.rs), [Node.js](https://nodejs.org) et les dépendances système de Tauri pour ton OS ([guide officiel](https://v2.tauri.app/start/prerequisites/)).

```bash
npm install
npm run dev      # fenêtre de développement
```

Sous Windows, `construire.bat` fabrique l'installeur avec ton Rust local (`src-tauri\target` pèse alors quelques Go : supprime-le après coup).

## Utilisation

- **Chaînes** : colle une adresse de chaîne, un `@pseudo` ou un identifiant `UC…`, puis « Suivre ». Coller l'adresse d'une vidéo fonctionne aussi : Kiosque suit sa chaîne.
- **À voir** : les nouvelles vidéos, de la plus récente à la plus ancienne. Pour chacune : Regarder, Plus tard ou Ignorer. « Tout marquer comme vu » vide la boîte d'un coup.
- **Plus tard / Vues** : les vidéos mises de côté et l'historique de ce que tu as ouvert.
- **Lecture** : dans la fenêtre de Kiosque (lecteur YouTube intégré, publicités possibles), dans le navigateur, ou dans [mpv](https://mpv.io) (sans publicité ni compte, nécessite aussi [yt-dlp](https://github.com/yt-dlp/yt-dlp)). Si mpv est introuvable, Kiosque bascule sur le navigateur et te le dit. Une vidéo qui interdit l'intégration s'ouvre avec « Ouvrir dans le navigateur ».

À l'ajout d'une chaîne, ses vidéos de plus de 7 jours sont directement rangées dans « Vues » pour que la boîte de réception ne démarre pas pleine d'archives.

Les titres entièrement en majuscules sont remis en minuscules (le titre d'origine s'affiche au survol) et les miniatures sont masquées par défaut (case à cocher dans Chaînes).

## Où sont les données

Dans un fichier SQLite local, `kiosque.sqlite3`, dans le dossier de données de l'application :

- Windows : `%APPDATA%\fr.kiosque.reader\`
- macOS : `~/Library/Application Support/fr.kiosque.reader/`
- Linux : `~/.local/share/fr.kiosque.reader/`

Aucune télémétrie. Kiosque ne contacte que `youtube.com` (flux RSS, et la page de la chaîne au moment de l'ajout).

## Architecture

```
src/            interface (HTML, CSS, JS sans bundler)
src-tauri/src/
  feed.rs       lecture des flux Atom YouTube (feed-rs)
  resolve.rs    adresse / @pseudo / UC… → identifiant de chaîne
  db.rs         SQLite : chaînes, vidéos, états, réglages
  lib.rs        commandes Tauri exposées à l'interface
```

Les tests couvrent le parsing des flux, la résolution des adresses et la base de données : `cd src-tauri && cargo test`.

## Limites à connaître

- Un flux RSS ne contient que les **15 dernières vidéos** d'une chaîne. Suffisant pour un fil d'actualité, pas pour parcourir un catalogue.
- Les **Shorts** sont masqués en lisant la playlist « vidéos longues » (`UULF…`). C'est une astuce non documentée par YouTube : si elle cesse de fonctionner, Kiosque retombe sur le flux classique (Shorts inclus), et tu peux désactiver l'option dans Chaînes.
- La durée des vidéos n'est pas dans le flux, donc pas de filtre par durée pour l'instant.
- Les flux RSS sont stables depuis des années, mais ce n'est pas une API officielle garantie.
- Si YouTube affiche une page de consentement au moment d'ajouter une chaîne par `@pseudo`, colle plutôt l'adresse `youtube.com/channel/UC…` ou l'identifiant `UC…`.

## Pistes pour la suite

Règles par chaîne (digest hebdomadaire, durée minimale), filtres de mots-clés, budget de temps quotidien, import de tes abonnements (OPML ou export Google Takeout), connexion OAuth pour les likes et commentaires (optionnelle).
