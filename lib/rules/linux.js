// Règles pour Debian (et Linux en général) : caches connus, chemins qu'on
// ne touche jamais, familles de fichiers, garde-fous de l'IA.
// Même interface que rules/win32.js.

const fs = require("fs");
const path = require("path");

const SUR = "sur";
const VERIF = "a_verifier";

const HOME = process.env.HOME || "/root";
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const H = rx(HOME);

// Dossiers personnels XDG (« Téléchargements », « Images »… selon la langue).
function xdgDirs() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(HOME, ".config", "user-dirs.dirs"), "utf8");
    for (const m of txt.matchAll(/^XDG_(\w+)_DIR="(.*)"$/gm)) out[m[1]] = m[2].replace(/^\$HOME/, HOME);
  } catch {}
  return out;
}
const XDG = xdgDirs();
const PERSONAL = ["Documents", "Desktop", "Bureau", "Downloads", "Téléchargements", "Pictures", "Images", "Videos", "Vidéos",
  "Music", "Musique", "Templates", "Modèles", "Public"];
const personalDirs = [...new Set([...PERSONAL.map((d) => path.join(HOME, d)), ...Object.values(XDG)])].filter((d) => d !== HOME);

const CLEANABLE = [
  { re: new RegExp(`^${H}/\\.cache/thumbnails$`), label: "Miniatures", niveau: SUR, contenu: true,
    pourquoi: "Aperçus d'images et de vidéos créés par le gestionnaire de fichiers. Recréés quand on rouvre un dossier." },
  { re: /\/\.cache\/(mesa_shader_cache(_db)?|radv_builtin_shaders|nvidia\/GLCache|nv\/GLCache)$/, label: "Cache de shaders GPU", niveau: SUR, contenu: true,
    pourquoi: "Shaders compilés par le pilote graphique. Recréés au lancement des jeux (premier lancement un peu plus lent)." },
  { re: /\/steamapps\/shadercache$/, label: "Cache de shaders Steam", niveau: SUR, contenu: true,
    pourquoi: "Shaders précompilés par Steam. Retéléchargés ou recompilés au prochain lancement des jeux." },
  { re: /\/\.cache\/pip$/, label: "Cache pip", niveau: SUR, contenu: true, pourquoi: "Paquets Python déjà téléchargés. Retéléchargés si besoin." },
  { re: /\/\.cache\/uv$/, label: "Cache uv", niveau: SUR, contenu: true, pourquoi: "Cache du gestionnaire Python uv." },
  { re: /\/\.npm\/_cacache$/, label: "Cache npm", niveau: SUR, contenu: true, pourquoi: "Paquets npm déjà téléchargés. Retéléchargés si besoin." },
  { re: /\/\.cache\/yarn$/, label: "Cache Yarn", niveau: SUR, contenu: true, pourquoi: "Paquets Yarn déjà téléchargés." },
  { re: /\/\.local\/share\/pnpm\/store$/, label: "Magasin pnpm", niveau: VERIF, contenu: true,
    pourquoi: "Paquets partagés par les projets pnpm. Retéléchargés si un projet en a besoin." },
  { re: /\/\.cache\/go-build$/, label: "Cache de compilation Go", niveau: SUR, contenu: true, pourquoi: "Recréé à la prochaine compilation." },
  { re: /\/\.cargo\/registry\/cache$/, label: "Cache Cargo", niveau: SUR, contenu: true, pourquoi: "Archives de crates Rust déjà téléchargées." },
  { re: /\/\.gradle\/caches$/, label: "Cache Gradle", niveau: SUR, contenu: true, pourquoi: "Dépendances Java/Android téléchargées." },
  { re: /\/\.cache\/mozilla\/firefox\/[^/]+\/cache2$/, label: "Cache de Firefox", niveau: SUR, contenu: true,
    pourquoi: "Pages et images mises en cache par Firefox. Fermer Firefox avant." },
  { re: /\/\.(cache|config)\/(google-chrome|chromium|BraveSoftware\/Brave-Browser|microsoft-edge|vivaldi)\/[^/]+\/(Cache|Code Cache|GPUCache|Service Worker\/CacheStorage)$/,
    label: "Cache du navigateur", niveau: SUR, contenu: true, pourquoi: "Pages et images mises en cache par le navigateur. Fermer le navigateur avant." },
  // Applications Electron (Discord, VS Code, Slack…) : même structure de cache.
  { re: new RegExp(`^${H}/\\.config/[^/]+/(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache)$`),
    label: "Cache d'application", niveau: SUR, contenu: true, pourquoi: "Cache d'une application (Electron). Recréé au lancement." },
  { re: new RegExp(`^${H}/\\.var/app/[^/]+/cache$`), label: "Cache d'application Flatpak", niveau: SUR, contenu: true,
    pourquoi: "Cache d'une application Flatpak. Recréé à son prochain lancement." },
  { re: /^\/var\/tmp$/, label: "Temporaires système", niveau: VERIF, contenu: true,
    pourquoi: "Temporaires conservés entre deux redémarrages. Certains demandent les droits administrateur." },
  { re: /^\/var\/cache\/apt\/archives$/, label: "Paquets apt téléchargés", niveau: VERIF, contenu: true,
    pourquoi: "Paquets .deb déjà installés. À vider avec « Nettoyage système » (apt clean), pas avec la corbeille." },
  { re: /^\/var\/lib\/systemd\/coredump$/, label: "Rapports de plantage", niveau: SUR, contenu: true,
    pourquoi: "Copies mémoire de programmes plantés. Utiles seulement pour un développeur." },
  { re: /\/node_modules$/, label: "Dépendances Node", niveau: VERIF, pourquoi: "Réinstallables avec `npm install` si le projet sert encore." },
  { re: /\/__pycache__$/, label: "Cache Python", niveau: SUR, pourquoi: "Bytecode Python, recréé à la prochaine exécution." },
  { re: /\/(\.venv|venv)$/, label: "Environnement Python", niveau: VERIF,
    pourquoi: "Recréable avec pip install -r requirements.txt, si le projet sert encore." },
];

// Jamais dans la corbeille, quoi qu'en dise l'IA ou l'utilisateur.
const PROTECTED = [
  /^\/$/,
  /^\/(bin|boot|dev|etc|lib|lib32|lib64|libx32|proc|run|sbin|sys|usr|snap|lost\+found|efi)(\/|$)/,
  /^\/(home|root|mnt|media|opt|srv|var|tmp)$/,
  /^\/var\/(lib|log|spool|mail|backups|cache|opt|local)(\/|$)/,
  /^\/(swapfile|swap\.img)$/,
  new RegExp(`^${H}$`),
  new RegExp(`^${H}/(\\.config|\\.local|\\.local/share|\\.local/bin|\\.cache|\\.var|\\.var/app)$`),
  new RegExp(`^${H}/(\\.ssh|\\.gnupg|\\.pki|\\.local/share/keyrings|\\.password-store)(/|$)`),
  new RegExp(`^${H}/\\.local/share/Trash(/|$)`),
  /\/\.Trash(-\d+)?(\/|$)/,
  ...personalDirs.map((d) => new RegExp(`^${rx(d)}$`)),
];

// Exceptions dans les dossiers système : ces caches-là peuvent partir.
const SYSTEM_ALLOWED = [
  /^\/var\/tmp\/.+/,
  /^\/var\/lib\/systemd\/coredump\/.+/,
  /^\/var\/crash\/.+/,
];

function isProtected(p) {
  if (SYSTEM_ALLOWED.some((re) => re.test(p))) return false;
  return PROTECTED.some((re) => re.test(p));
}

function matchRule(p) {
  for (const r of CLEANABLE) if (r.re.test(p)) return r;
  return null;
}

// Familles pour la carte. L'ordre compte : la première qui colle gagne.
const SYS_PATH = /^\/(usr|bin|sbin|lib\d*|boot|etc|var|root|snap|swapfile|swap\.img)(\/|$)/;
const CATEGORIES = [
  { id: "cache", label: "Caches et temporaires", test: (p) => !!matchRule(p) || /\/(\.cache|cache|Cache|tmp)(\/|$)/.test(p) },
  { id: "ia", label: "IA et modèles", test: (p) => /\/(\.ollama|ComfyUI[^/]*|\.lmstudio|huggingface|stable-diffusion[^/]*|models)(\/|$)/i.test(p)
      || (/\.(safetensors|gguf|ckpt|pt|pth|onnx|bin)$/i.test(p) && !SYS_PATH.test(p)) },
  { id: "jeux", label: "Jeux", test: (p) => /\/(steamapps|\.steam|Steam|Games|Heroic|lutris|\.wine|com\.valvesoftware\.Steam|itch)(\/|$)/.test(p) && !SYS_PATH.test(p) },
  { id: "dev", label: "Développement", test: (p) => /\/(node_modules|\.venv|venv|\.git|\.cargo|\.rustup|\.gradle|\.m2|\.npm|go\/pkg)(\/|$)/.test(p)
      || /^\/var\/lib\/(docker|containers)(\/|$)/.test(p) || /\/\.local\/share\/containers(\/|$)/.test(p) },
  { id: "apps", label: "Applications", test: (p) => /^\/opt(\/|$)|^\/var\/lib\/(flatpak|snapd)(\/|$)/.test(p)
      || /\/\.local\/share\/flatpak(\/|$)|\/\.var\/app(\/|$)/.test(p) },
  { id: "systeme", label: "Système", test: (p) => SYS_PATH.test(p) },
  { id: "medias", label: "Médias", test: (p) => /\.(mp4|mkv|avi|mov|webm|mp3|flac|wav|m4a|ogg|opus|jpg|jpeg|png|heic|raw|cr2|nef|psd|xcf)$/i.test(p)
      || /\/(Videos|Vidéos|Music|Musique|Pictures|Images)(\/|$)/.test(p) },
  { id: "docs", label: "Documents", test: (p) => /\/(Documents|Desktop|Bureau|Downloads|Téléchargements)(\/|$)/.test(p) },
];

function categorize(p) {
  for (const c of CATEGORIES) if (c.test(p)) return c.id;
  return "autre";
}

const CATEGORY_LABELS = Object.fromEntries([...CATEGORIES.map((c) => [c.id, c.label]), ["autre", "Autres"]]);

// ------------------------------------------------------------------ scan ---
const SCAN = {
  // Copies qui appartiennent au système ou à des programmes installés.
  INTERNAL: /^\/(usr|opt|var\/lib|snap)\/|\/(site|dist)-packages\/|\/\.local\/share\/flatpak\/|\/resources\/app\//,
  // Binaires et données d'applications : un doublon y est presque toujours voulu.
  EXECUTABLE: /\.(so(\.\d+)*|AppImage|deb|run)$|\/\.local\/(bin|share)\/|\/versions\/[^/]+$|\/\.var\/app\//,
  // Conteneurs trop généraux pour être un « bloc à comprendre ».
  GENERIC: new RegExp(`^/(usr|var|opt|home|srv)?$|^${H}(/(\\.local(/share)?|\\.cache|\\.config|\\.var(/app)?|Documents|Downloads|Téléchargements|Desktop|Bureau))?$`),
};

// ------------------------------------------------------- garde-fous de l'IA -
const GUARDS = [
  { re: /^\/(usr|opt|bin|sbin|lib\d*)\/|^\/var\/lib\/(flatpak|snapd|dpkg|apt)\/|\/\.local\/share\/flatpak\//,
    why: "fait partie d'un programme installé (paquet Debian, Flatpak…). Conseille plutôt de le désinstaller depuis Sonde > Programmes installés." },
  { re: /\/\.var\/app\/[^/]+\//, unless: /\/\.var\/app\/[^/]+\/cache(\/|$)/,
    why: "données d'une application Flatpak : conseille plutôt de la désinstaller (avec ses données) depuis Sonde > Programmes installés." },
  { re: /^\/var\/log(\/|$)/,
    why: "journaux du système : ils se nettoient avec « Nettoyage système » (journalctl --vacuum), jamais avec la corbeille." },
  { re: /\.(so(\.\d+)*|AppImage)$/, unless: /\/(Downloads|Téléchargements)\//,
    why: "programme ou bibliothèque : le supprimer casserait le logiciel qui l'utilise. Conseille de désinstaller le logiciel." },
  { re: /\/(node_modules|\.venv|venv)(\/|$)/, also: new RegExp(`^${H}/\\.(local|config)/`),
    why: "environnement d'une application installée : le supprimer la casserait." },
];

// --------------------------------------------------- textes pour l'IA ---
const OS = {
  name: "Debian (Linux)",
  pathKind: "Chemin absolu Linux (commence par /)",
  pathExample: `${HOME}/...`,
  evident: "/usr, /var, /home ou /opt",
  uninstall: "Sonde > Programmes installés (paquet apt ou Flatpak)",
  neverInside: "/usr, /opt, /var/lib, ~/.local/share/flatpak, les dossiers resources/app",
  envUnder: "~/.local ou ~/.config",
  trashNote: "La corbeille (~/.local/share/Trash) : ne la recommande pas, dis dans le résumé qu'il suffit de la vider.",
  downloads: () => XDG.DOWNLOAD || path.join(HOME, "Téléchargements"),
  installers: ".deb .AppImage .run .sh",
  noDelete: "rm, rm -rf, rmdir, shred, find -delete",
};

module.exports = { SUR, VERIF, CLEANABLE, isProtected, matchRule, categorize, CATEGORY_LABELS, SCAN, GUARDS, OS, XDG };
