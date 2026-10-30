# Sonde

**Nettoyeur et optimiseur de disque piloté par une IA qui tourne sur ton PC. Pour Windows et Debian.**

Sonde scanne ton disque, et une IA (GPT-OSS ou tout autre modèle via [Ollama](https://ollama.com), sur ton PC ; ou, si tu le choisis, une IA en ligne par API) t'explique ce qu'elle trouve et propose quoi libérer. Avec une IA locale, rien n'est envoyé sur Internet. Rien n'est supprimé sans ton accord, et tout passe par la corbeille.

Dans l'esprit de CleanMyMac, pour Windows 10/11 et Debian 13 (GNOME), en français.

---

## Installation

### Windows

1. Télécharge **`Sonde-Setup-x.y.z.exe`** dans la page [Releases](../../releases) du dépôt.
2. Lance-le. Windows peut afficher « Windows a protégé votre ordinateur », car l'installateur n'est pas signé par un certificat payant : clique sur **Informations complémentaires**, puis **Exécuter quand même**.
3. Au premier lancement, un assistant prépare l'IA :
   - il regarde la mémoire de ton PC et conseille un modèle adapté ;
   - il installe Ollama (installateur officiel, sans droits administrateur) ;
   - il télécharge le modèle, avec une barre de progression. Si la connexion coupe, le téléchargement reprend là où il s'était arrêté.

### Debian 13

1. Télécharge **`sonde_x.y.z_amd64.deb`** dans la page [Releases](../../releases).
2. Installe-le : double-clic (Logiciels), ou dans un terminal :
   ```bash
   sudo apt install ./sonde_1.0.0_amd64.deb
   ```
3. Lance **Sonde** depuis le menu des applications. Au premier lancement, l'assistant installe Ollama avec son script officiel (ton mot de passe administrateur est demandé), puis télécharge le modèle.

Sonde est conçu pour GNOME (le bureau par défaut de Debian) et fonctionne aussi sous d'autres bureaux ; certains raccourcis (Moniteur système, Paramètres) ouvrent alors l'outil équivalent s'il est installé.

Tu peux aussi **continuer sans IA** : le scan, la carte du disque et les outils système fonctionnent sans elle.

### Configuration conseillée

| | Minimum | Conseillé |
|---|---|---|
| Système | Windows 10 ou 11, 64 bits ; Debian 13 64 bits | Windows 11 ; Debian 13 avec GNOME |
| Mémoire pour l'IA | 8 Go (modèle Qwen3 4B ou 8B) | 16 Go de mémoire vidéo ou 32 Go de RAM (GPT-OSS 20B) |
| Espace libre | 5 Go | 15 Go |

### Choisir l'IA

Clique sur l'état de l'IA, en bas à gauche.

- **Sur ce PC (Ollama)** : tous les modèles déjà installés dans Ollama sont proposés (GPT-OSS, Qwen, Mistral, Llama…), avec ce que chacun sait faire. Le bouton **Tester** vérifie qu'il sait vraiment utiliser des outils, ce dont l'analyse et l'assistant ont besoin (certains modèles s'en disent capables mais écrivent l'appel en texte).
- **IA en ligne (API)** : Anthropic (Claude), OpenAI, Mistral AI, OpenRouter, Groq, ou tout serveur compatible OpenAI (LM Studio, llama.cpp, vLLM, Ollama d'un autre PC). La clé d'API est chiffrée par le système (DPAPI sous Windows, trousseau GNOME sous Debian) et n'est jamais affichée. Une IA en ligne demande ton accord explicite : les noms, tailles et dates des dossiers explorés, et les listes de programmes ou de services à expliquer, partent chez le fournisseur ; jamais le contenu des fichiers. Une analyse complète peut consommer plusieurs centaines de milliers de jetons.

---

## Ce que fait Sonde

**Fichiers**
- **Carte du disque** : liste et bulles cliquables, comme le Télescope de CleanMyMac. L'IA note sous chaque gros dossier ce qu'il contient.
- **Analyse IA** : GPT-OSS explore le disque, comprend les gros blocs (modèles d'IA, jeux, projets…) et propose quoi libérer, avec la raison.
- **Recherche en langage naturel** : « les vidéos de plus de 1 Go que je n'ai pas ouvertes cette année ».
- **Gros fichiers, doublons, caches et temporaires.**
- **Évolution** : ce qui a grossi depuis le dernier scan, scan hebdomadaire automatique et alerte quand l'espace devient trop bas.

**Système** (Windows / Debian)
- **Mises à jour** (Debian) : paquets apt (sécurité en tête) et Flatpak, installation suivie en direct ; une mise à jour qui retirerait un paquet n'est jamais installée d'office. Contrôle des dépôts (dépôt de sécurité absent, versions de Debian mélangées, dépôt en erreur), installation de paquets interrompue (réparation d'un clic), paquets bloqués, TRIM des SSD, redémarrage en attente.
- **Programmes installés** : taille et dernière utilisation, recherche des restes. Windows : désinstalleur officiel. Debian : applications apt, Flatpak et gros paquets installés à la main ; avant de désinstaller, Sonde montre tout ce qu'apt retirerait, et refuse si cela casserait le bureau. Une désinstallation s'annule depuis le journal (le paquet est réinstallé).
- **Logiciels actifs** : mémoire, processeur et connexions de chaque programme ; programmes lancés au démarrage (Windows) ou à l'ouverture de la session GNOME (Debian, sans mot de passe). Sous Debian, un onglet **Temps de démarrage** (systemd-analyze) montre les services les plus lents et ce qu'on peut y faire.
- **Services et vie privée** : Windows : services de télémétrie et réglages de confidentialité. Debian : services systemd (kerneloops, cups-browsed, avahi, ssh…), statistiques popularity-contest, confidentialité GNOME.
- **Pilotes** : Windows : périphériques en erreur, mises à jour de Windows Update. Debian : périphériques sans pilote, firmwares manquants (avec le paquet à installer), microcode, mises à jour du noyau, de Mesa et des firmwares (apt et fwupd).
- **Sécurité** : Windows : Microsoft Defender. Debian : pare-feu (ufw), mises à jour de sécurité et mises à jour automatiques, redémarrage en attente, chiffrement, ports ouverts, ClamAV s'il est installé. Partout : audit de tout ce qui se lance automatiquement.
- **Réseau** : ping, comparaison de serveurs DNS, débit ; les optimisations (DNS, économie d'énergie Wi-Fi ou Ethernet…) ne sont proposées que si une mesure les justifie.
- **Nettoyage système** : Windows : Windows Update, temporaires, anciens composants, hibernation. Debian : paquets apt téléchargés, paquets devenus inutiles et anciens noyaux, configurations de paquets désinstallés, journaux, rapports de plantage, runtimes Flatpak inutilisés, cache de construction et images Docker sans nom.

**Et aussi** : un assistant pour poser des questions sur ton disque, un journal de tout ce que Sonde a fait, avec annulation, et la **mise à jour de Sonde depuis l'application** (clic sur la version, en bas à gauche) : recherche automatique chaque jour, téléchargement vérifié, installation au redémarrage.

---

## Confidentialité et sécurité

- **Tout reste sur ton PC**, avec une IA locale (Ollama) : les seules connexions sortantes sont le téléchargement d'Ollama et du modèle, et le test de débit (serveurs Cloudflare), que tu lances toi-même. Si tu choisis une IA en ligne, Sonde te dit exactement ce qui part chez le fournisseur et attend ton accord.
- **Rien n'est supprimé définitivement.** Tout passe par la corbeille. Sous Windows, Sonde vérifie avant l'envoi qu'il y a assez de place : au-delà de sa taille maximale, Windows efface sans prévenir. Sous Debian, Sonde utilise la corbeille standard (celle de Fichiers) et prévient si GNOME est réglé pour la vider tout seul.
- **L'IA propose, les règles décident.** Chaque proposition est revérifiée par le programme. Sont toujours refusés : les fichiers de Windows, l'intérieur des programmes installés, les exécutables, les modèles Ollama, tout morceau d'environnement Python ou Node, et tout ce qui a été modifié dans les 7 derniers jours.
- **Toute modification du système** (services, DNS, nettoyage…) demande une confirmation, puis ton accord : fenêtre UAC sous Windows, mot de passe administrateur (pkexec) sous Debian. Elle est enregistrée dans le journal avec l'état d'avant, pour pouvoir l'annuler.
- Le serveur interne n'écoute que sur `127.0.0.1` et refuse les requêtes venant d'un site web.

---

## Développement

Prérequis : [Node.js](https://nodejs.org) 18 ou plus récent, et Ollama avec un modèle (`ollama pull gpt-oss:20b`).

```bash
npm install
npm start           # application de bureau (Electron)
npm run serve       # ou dans le navigateur : http://127.0.0.1:4777
npm run dist        # Windows : installateur dans release/
npm run dist:linux  # Debian : paquet .deb dans release/ (à lancer sous Linux)
./sonde.sh          # Linux, depuis les sources : dans le navigateur
```

### Publier une nouvelle version

L'application cherche ses mises à jour dans les [Releases GitHub](https://github.com/Kalytrixx/sonde/releases) (champ `updates` de `package.json`). Pour un test, la variable `SONDE_UPDATE_URL` peut pointer vers n'importe quel dossier web.

La construction est automatique ([`.github/workflows/release.yml`](.github/workflows/release.yml)) :

1. Augmente `version` dans `package.json`, puis enregistre le changement (commit).
2. Pousse un tag `v` + la version :
   ```bash
   git tag v1.1.0
   git push origin main v1.1.0
   ```
3. GitHub construit l'installateur Windows et le paquet Debian, puis crée une Release **en brouillon** avec `Sonde-Setup-x.y.z.exe`, `latest.yml`, `sonde_x.y.z_amd64.deb` et `latest-linux.yml`.
4. Relis le brouillon (le texte devient les « Nouveautés » affichées dans Sonde), puis clique sur **Publish release**. C'est seulement à ce moment que les Sonde installées voient la mise à jour.

Les fichiers `latest*.yml` contiennent l'empreinte SHA-512 de chaque paquet : Sonde refuse d'installer un fichier qui ne correspond pas. Si la signature SignPath est configurée (variables du dépôt `SIGNPATH_*`), l'application puis l'installateur sont signés avant la publication, et `build/update-latest-yml.js` remet l'empreinte à jour.

### Architecture

| Chemin | Rôle |
|---|---|
| `electron/main.js` | application de bureau : démarre le serveur et ouvre la fenêtre |
| `server.js` | serveur HTTP local, routes principales, chargement des modules |
| `lib/platform.js` | ce qui change d'un système à l'autre : séparateur, casse, liste des disques (lettres ou points de montage) |
| `lib/scan.js` | parcours du disque (sans traverser les autres montages sous Linux), doublons, « blocs à comprendre » |
| `lib/rules/win32.js`, `lib/rules/linux.js` | caches connus, chemins protégés, familles de fichiers, garde-fous de l'IA |
| `lib/ai.js` | outils de l'IA, garde-fous, analyse en trois phases |
| `lib/llm.js` | fournisseurs d'IA : Ollama (tout modèle, capacités détectées), API compatibles OpenAI, Anthropic ; conversion des messages et des appels d'outils |
| `lib/updater.js` | mise à jour de l'application (electron-updater : installateur Windows, paquet .deb) |
| `lib/secret.js` | chiffrement de la clé d'API par le système (Electron safeStorage) |
| `lib/trash-win32.js`, `lib/trash-linux.js` | corbeille (contrôle de capacité sous Windows, format freedesktop sous Linux) et restauration |
| `lib/ps.js`, `lib/sh.js` | exécution de PowerShell (UAC) ou de commandes Linux (pkexec) |
| `lib/debian.js` | paquet propriétaire d'un fichier, mises à jour en attente |
| `lib/journal.js`, `lib/history.js` | journal des actions, instantanés des scans |
| `lib/modules/common/` | routes communes (journal, recherche) |
| `lib/modules/win32/`, `lib/modules/linux/` | un fichier par fonctionnalité et par système ; mêmes routes, mêmes données pour l'interface |
| `public/` | interface (`app.js`, `system.js`, `setup.js`) |

### Comment l'IA analyse le disque

Un modèle de 20 milliards de paramètres, laissé libre, explore bien mais conclut souvent sans rien proposer, ou propose des choses dangereuses. L'analyse est donc découpée en trois phases imposées :

1. **Exploration.** Le modèle reçoit une vue d'ensemble et explore avec des outils (`lister_dossier`, `infos`, `doublons`…), puis note ce qu'il comprend.
2. **Recommandations.** Sonde lui présente des candidats déjà filtrés : caches, doublons, fichiers pas ouverts depuis 3 mois. Il les juge un par un.
3. **Rapport.** Il le rédige dans un contexte neuf, à partir des seules recommandations acceptées.

La date de **dernier accès** des fichiers sert à juger s'ils servent encore : la date de modification n'est souvent que celle du téléchargement.

### Réglages (variables d'environnement)

| Variable | Rôle |
|---|---|
| `SONDE_MODEL` | modèle Ollama par défaut (sinon, celui choisi dans les réglages de l'IA) |
| `SONDE_CTX` | taille du contexte du modèle (24 576 par défaut) |
| `SONDE_PORT` | port du serveur en mode navigateur (4777 par défaut) |
| `SONDE_DATA` | dossier des données (`%APPDATA%\Sonde\data` ou `~/.config/Sonde/data` pour l'application installée) |
| `OLLAMA_HOST` | adresse d'Ollama (`http://127.0.0.1:11434` par défaut) |

---

## Licence

[MIT](LICENSE)
