// Mise à jour de Sonde depuis l'application (electron-updater).
//
// Source des mises à jour, par ordre de priorité :
//   1. variable SONDE_UPDATE_URL : dossier web contenant latest.yml et les paquets
//   2. champ « updates » de package.json : Releases d'un dépôt GitHub
// Windows : l'installateur .exe ; Debian : le paquet .deb (installé avec
// pkexec). Chaque fichier téléchargé est vérifié (empreinte SHA-512 publiée
// avec la version) avant installation. Rien ne s'installe sans un clic.

const path = require("path");
const pkg = require("../package.json");

const state = {
  supported: false, reason: null, current: pkg.version,
  status: "idle",        // idle | checking | none | available | downloading | ready | error
  available: null,       // { version, date, notes }
  progress: null,        // { percent, transferred, total, speed }
  error: null, checkedAt: null,
};

let au = null;

function feed() {
  if (process.env.SONDE_UPDATE_URL) return { provider: "generic", url: process.env.SONDE_UPDATE_URL };
  const u = pkg.updates || {};
  if (u.provider === "github" && u.owner && u.repo) return { provider: "github", owner: u.owner, repo: u.repo };
  if (u.provider === "generic" && u.url) return { provider: "generic", url: u.url };
  return null;
}

// Notes de version : texte brut (GitHub les renvoie parfois en HTML).
function notesText(n) {
  const raw = Array.isArray(n) ? n.map((x) => `${x.version}\n${x.note || ""}`).join("\n\n") : String(n || "");
  return raw.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h\d)>/gi, "\n").replace(/<li>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 4000);
}

function init() {
  if (!process.versions.electron) { state.reason = "Sonde tourne depuis les sources : mets-le à jour avec « git pull », puis « npm install »."; return; }
  const { app } = require("electron");
  if (!app.isPackaged && !process.env.SONDE_UPDATE_URL) { state.reason = "Version de développement : pas de mise à jour automatique."; return; }
  const f = feed();
  if (!f) { state.reason = "Les mises à jour ne sont pas encore branchées : le dépôt de publication de Sonde reste à indiquer."; return; }
  try {
    ({ autoUpdater: au } = require("electron-updater"));
  } catch (e) {
    state.reason = `Module de mise à jour indisponible (${e.message}).`;
    return;
  }
  au.autoDownload = false;            // l'utilisateur décide
  au.autoInstallOnAppQuit = false;
  au.allowDowngrade = false;
  au.logger = null;
  au.setFeedURL(f);
  au.on("checking-for-update", () => { state.status = "checking"; state.error = null; });
  au.on("update-not-available", () => { state.status = "none"; state.available = null; state.checkedAt = Date.now(); });
  au.on("update-available", (i) => {
    state.status = "available"; state.checkedAt = Date.now();
    state.available = { version: i.version, date: i.releaseDate || null, notes: notesText(i.releaseNotes) };
  });
  au.on("download-progress", (p) => {
    state.status = "downloading";
    state.progress = { percent: Math.round(p.percent), transferred: p.transferred, total: p.total, speed: p.bytesPerSecond };
  });
  au.on("update-downloaded", () => { state.status = "ready"; state.progress = null; });
  au.on("error", (e) => { state.status = "error"; state.error = friendly(e); state.progress = null; });
  state.supported = true;
}

function friendly(e) {
  const m = String(e?.message || e || "");
  if (/404|Cannot find|No published versions|latest(-linux)?\.yml/i.test(m)) return "Aucune version publiée pour l'instant à l'adresse des mises à jour.";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(m)) return "Pas de connexion au serveur des mises à jour.";
  if (/sha512|checksum/i.test(m)) return "Le fichier téléchargé ne correspond pas à l'empreinte publiée : installation refusée.";
  return m.split("\n")[0].slice(0, 300);
}

async function check() {
  if (!state.supported) throw new Error(state.reason);
  if (["checking", "downloading"].includes(state.status)) return state;
  try { await au.checkForUpdates(); }
  catch (e) { state.status = "error"; state.error = friendly(e); }
  return state;
}

function download() {
  if (!state.supported || state.status !== "available") throw new Error("Aucune mise à jour à télécharger.");
  state.status = "downloading";
  state.progress = { percent: 0, transferred: 0, total: 0, speed: 0 };
  au.downloadUpdate().catch((e) => { state.status = "error"; state.error = friendly(e); });
  return state;
}

// Ferme Sonde, installe, relance. Debian : pkexec demande le mot de passe.
function install() {
  if (!state.supported || state.status !== "ready") throw new Error("La mise à jour n'est pas encore téléchargée.");
  // Windows : installateur en silencieux (le clic sur « Redémarrer et
  // installer » vaut accord), puis relance. Debian : dpkg via pkexec.
  setTimeout(() => au.quitAndInstall(process.platform === "win32", true), 400);
  return { ok: true };
}

module.exports = { init, check, download, install, state, get version() { return pkg.version; } };
