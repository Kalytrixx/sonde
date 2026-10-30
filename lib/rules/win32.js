// Connaissances fixes sur le disque : ce qui est un cache, ce qu'il ne faut
// jamais toucher, et à quelle famille appartient un chemin.
// L'IA propose, mais ces règles ont le dernier mot.

const SUR = "sur";          // se recrée tout seul, aucune perte
const VERIF = "a_verifier"; // récupérable mais demande un coup d'œil

// Dossiers reconnus comme nettoyables. `contenu: true` : on vide le dossier,
// on ne supprime pas le dossier lui-même.
const CLEANABLE = [
  { re: /\\AppData\\Local\\Temp$/i, label: "Fichiers temporaires", niveau: SUR, contenu: true,
    pourquoi: "Fichiers laissés par les installateurs et les programmes. Windows n'en a plus besoin." },
  { re: /^[A-Z]:\\Windows\\Temp$/i, label: "Temporaires système", niveau: VERIF, contenu: true,
    pourquoi: "Temporaires de Windows. Certains demandent les droits administrateur." },
  { re: /\\AppData\\Local\\(AMD|NVIDIA|Intel)\\(DxcCache|DxCache|GLCache|OglCache|VkCache|ShaderCache)$/i,
    label: "Cache de shaders GPU", niveau: SUR, contenu: true,
    pourquoi: "Shaders compilés par le pilote graphique. Recréés au lancement des jeux (premier lancement un peu plus lent)." },
  { re: /\\AppData\\Local\\D3DSCache$/i, label: "Cache DirectX", niveau: SUR, contenu: true,
    pourquoi: "Cache de shaders DirectX, recréé automatiquement." },
  { re: /\\AppData\\Local\\npm-cache$/i, label: "Cache npm", niveau: SUR, contenu: true,
    pourquoi: "Paquets npm déjà téléchargés. Retéléchargés si besoin." },
  { re: /\\AppData\\Local\\pip\\cache$/i, label: "Cache pip", niveau: SUR, contenu: true,
    pourquoi: "Paquets Python déjà téléchargés. Retéléchargés si besoin." },
  { re: /\\AppData\\Local\\uv\\cache$/i, label: "Cache uv", niveau: SUR, contenu: true,
    pourquoi: "Cache du gestionnaire Python uv." },
  { re: /\\AppData\\Local\\Yarn\\Cache$/i, label: "Cache Yarn", niveau: SUR, contenu: true,
    pourquoi: "Paquets Yarn déjà téléchargés." },
  { re: /\\\.gradle\\caches$/i, label: "Cache Gradle", niveau: SUR, contenu: true,
    pourquoi: "Dépendances Java/Android téléchargées." },
  { re: /\\User Data\\[^\\]+\\(Cache|Code Cache|GPUCache|Service Worker\\CacheStorage)$/i,
    label: "Cache du navigateur", niveau: SUR, contenu: true,
    pourquoi: "Pages et images mises en cache par le navigateur. Fermer le navigateur avant." },
  { re: /\\AppData\\Local\\CrashDumps$/i, label: "Rapports de plantage", niveau: SUR, contenu: true,
    pourquoi: "Copies mémoire de programmes plantés. Utiles seulement pour un développeur." },
  { re: /^[A-Z]:\\Windows\\Minidump$/i, label: "Rapports de plantage système", niveau: SUR, contenu: true,
    pourquoi: "Rapports d'écrans bleus." },
  { re: /^[A-Z]:\\Windows\\SoftwareDistribution\\Download$/i, label: "Téléchargements Windows Update",
    niveau: VERIF, contenu: true,
    pourquoi: "Mises à jour déjà installées. Demande les droits administrateur." },
  { re: /\\node_modules$/i, label: "Dépendances Node", niveau: VERIF,
    pourquoi: "Réinstallables avec `npm install` si le projet sert encore." },
  { re: /\\__pycache__$/i, label: "Cache Python", niveau: SUR,
    pourquoi: "Bytecode Python, recréé à la prochaine exécution." },
  { re: /\\(\.venv|venv)$/i, label: "Environnement Python", niveau: VERIF,
    pourquoi: "Recréable avec pip install -r requirements.txt, si le projet sert encore." },
];

// Jamais dans la corbeille, quoi qu'en dise l'IA ou l'utilisateur.
const PROTECTED = [
  /^[A-Z]:\\?$/i,
  /^[A-Z]:\\Windows(\\|$)/i,
  /^[A-Z]:\\Program Files( \(x86\))?$/i,
  /^[A-Z]:\\ProgramData$/i,
  /^[A-Z]:\\Users$/i,
  /^[A-Z]:\\Users\\[^\\]+$/i,
  /^[A-Z]:\\Users\\[^\\]+\\(AppData|AppData\\(Local|Roaming|LocalLow)|Documents|Desktop|Downloads|Pictures|Videos|Music|OneDrive)$/i,
  /^[A-Z]:\\(pagefile|hiberfil|swapfile)\.sys$/i,
  /^[A-Z]:\\(System Volume Information|Recovery|\$WinREAgent|Boot|EFI|Documents and Settings)(\\|$)/i,
  /^[A-Z]:\\\$Recycle\.Bin(\\|$)/i,
];

// Exceptions dans C:\Windows : ces caches-là peuvent partir.
const WINDOWS_ALLOWED = [
  /^[A-Z]:\\Windows\\Temp\\.+/i,
  /^[A-Z]:\\Windows\\Minidump\\.+/i,
  /^[A-Z]:\\Windows\\SoftwareDistribution\\Download\\.+/i,
];

function isProtected(p) {
  if (WINDOWS_ALLOWED.some((re) => re.test(p))) return false;
  return PROTECTED.some((re) => re.test(p));
}

function matchRule(p) {
  for (const r of CLEANABLE) if (r.re.test(p)) return r;
  return null;
}

// Familles pour la carte. L'ordre compte : la première qui colle gagne.
const CATEGORIES = [
  { id: "cache", label: "Caches et temporaires", test: (p) => !!matchRule(p) || /\\(Temp|Cache|Caches|CrashDumps)(\\|$)/i.test(p) },
  { id: "systeme", label: "Système", test: (p) => /^[A-Z]:\\(Windows|\$Recycle\.Bin|System Volume Information|Recovery|ProgramData)(\\|$)/i.test(p) || /^[A-Z]:\\(pagefile|hiberfil|swapfile)\.sys$/i.test(p) },
  { id: "ia", label: "IA et modèles", test: (p) => /\\(\.ollama|ComfyUI[^\\]*|\.lmstudio|huggingface|stable-diffusion[^\\]*|models)(\\|$)/i.test(p) || /\.(safetensors|gguf|ckpt|pt|pth|onnx|bin)$/i.test(p) },
  { id: "jeux", label: "Jeux", test: (p) => /\\(Riot Games|XboxGames|Steam|steamapps|Epic Games|GOG Galaxy|Ubisoft|EA Games|Battle\.net|Rockstar Games|My Games)(\\|$)/i.test(p) },
  { id: "dev", label: "Développement", test: (p) => /\\(node_modules|\.venv|venv|\.git|\.cargo|\.rustup|\.gradle|\.nuget|\.m2|source\\repos)(\\|$)/i.test(p) },
  { id: "apps", label: "Applications", test: (p) => /^[A-Z]:\\Program Files( \(x86\))?(\\|$)/i.test(p) || /\\AppData\\(Local|Roaming)\\Programs(\\|$)/i.test(p) },
  { id: "medias", label: "Médias", test: (p) => /\.(mp4|mkv|avi|mov|webm|mp3|flac|wav|m4a|jpg|jpeg|png|heic|raw|cr2|nef|psd)$/i.test(p) || /\\(Videos|Music|Pictures|Vidéos|Musique|Images)(\\|$)/i.test(p) },
  { id: "docs", label: "Documents", test: (p) => /\\(Documents|Desktop|Downloads|OneDrive)(\\|$)/i.test(p) },
];

function categorize(p) {
  for (const c of CATEGORIES) if (c.test(p)) return c.id;
  return "autre";
}

const CATEGORY_LABELS = Object.fromEntries([...CATEGORIES.map((c) => [c.id, c.label]), ["autre", "Autres"]]);

// ------------------------------------------------------------------ scan ---
const SCAN = {
  // Copies qui appartiennent à des programmes installés (doublons ignorés).
  INTERNAL: /^[A-Z]:\\(Windows|Program Files|Program Files \(x86\)|ProgramData)\\|\\site-packages\\|\\AppData\\Local\\Programs\\|\\resources\\app\\/i,
  // Binaires : un doublon d'exécutable est presque toujours voulu (lanceur + version).
  // Idem pour les applications du Store : Windows y virtualise AppData, et
  // l'application peut lire l'une ou l'autre copie.
  EXECUTABLE: /\.(exe|dll|sys|msi)$|\\\.local\\(bin|share)\\|\\versions\\[^\\]+$|\\AppData\\Local\\Packages\\/i,
  // Conteneurs trop généraux pour être un « bloc à comprendre ».
  GENERIC: /^[A-Z]:\\(Windows|\$Recycle\.Bin)(\\|$)|^[A-Z]:\\Users\\[^\\]+(\\AppData(\\(Local|Roaming|LocalLow))?|\\Documents|\\Downloads|\\Desktop)?$/i,
};

// ------------------------------------------------------- garde-fous de l'IA -
// Testés dans l'ordre ; le premier qui correspond refuse la recommandation.
const GUARDS = [
  { re: /\\AppData\\Local\\Programs(\\|$)|^[A-Z]:\\Program Files|\\resources\\app(\\|$)/i,
    why: "fait partie d'une application installée. Conseille plutôt de la désinstaller via Paramètres > Applications." },
  { re: /\\AppData\\Local\\Packages\\/i,
    why: "données d'une application du Microsoft Store : la réinitialiser ou la désinstaller via Paramètres > Applications." },
  { re: /\.(exe|dll|sys|msi)$/i, unless: /\\(Downloads|Téléchargements)\\/i,
    why: "programme exécutable : le supprimer casserait le logiciel qui l'utilise. Conseille de désinstaller le logiciel." },
  { re: /\\(node_modules|\.venv|venv)(\\|$)/i, also: /\\AppData\\/i,
    why: "environnement d'une application installée : le supprimer la casserait." },
];

// --------------------------------------------------- textes pour l'IA ---
const OS = {
  name: "Windows",
  pathKind: "Chemin absolu Windows",
  pathExample: "C:\\Users\\...",
  evident: "C:\\Windows, C:\\Users ou Program Files",
  uninstall: "Paramètres > Applications",
  neverInside: "Program Files, AppData\\Local\\Programs, dossiers resources\\app",
  envUnder: "AppData",
  trashNote: "La corbeille ($Recycle.Bin) : ne la recommande pas, dis dans le résumé qu'il suffit de la vider.",
  downloads: (home) => `${home}\\Downloads`,
  installers: ".exe .msi",
  noDelete: "del, rm, rmdir, Remove-Item",
};

module.exports = { SUR, VERIF, CLEANABLE, isProtected, matchRule, categorize, CATEGORY_LABELS, SCAN, GUARDS, OS };
