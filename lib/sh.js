// Exécution de commandes sous Linux. Pendant de lib/ps.js (PowerShell).
//
// Règle : on appelle les programmes directement (execFile, sans shell). Quand
// un script bash est nécessaire (droits administrateur), son texte vient
// toujours du serveur ; les valeurs venues de la page passent en arguments
// positionnels ($1, $2…), jamais collées dans le script.

const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

// Environnement neutre : sorties en anglais (plus faciles à lire) sauf
// quand on veut le texte de l'utilisateur.
const C_ENV = { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" };

function exec(cmd, args = [], { timeout = 120000, input = null, env = C_ENV, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8", env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      if (err && !okCodes.includes(code)) {
        const e = new Error(cleanError(stderr) || err.message);
        e.code = code; e.stdout = stdout;
        return reject(e);
      }
      resolve(stdout);
    });
    if (input != null) { p.stdin.end(input); }
  });
}

// Comme exec, mais ne lève jamais : renvoie "" en cas d'échec.
const tryExec = (cmd, args, opts) => exec(cmd, args, opts).catch(() => "");

const json = async (cmd, args, opts) => JSON.parse((await exec(cmd, args, opts)) || "null");

// Le programme existe-t-il dans le PATH ?
const whichCache = new Map();
function which(cmd) {
  if (whichCache.has(cmd)) return whichCache.get(cmd);
  let found = null;
  for (const dir of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":").concat(["/usr/sbin", "/sbin"])) {
    const f = path.join(dir, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); found = f; break; } catch {}
  }
  whichCache.set(cmd, found);
  return found;
}

// Script bash avec les droits administrateur. pkexec affiche la fenêtre
// d'authentification de GNOME : c'est l'utilisateur qui accepte ou refuse.
// `args` devient $1, $2… dans le script.
async function runElevated(script, args = [], { timeout = 30 * 60000 } = {}) {
  if (!which("pkexec")) throw new Error("pkexec est introuvable : installe le paquet « pkexec » (sudo apt install pkexec).");
  const body = "set -o pipefail\n" + script;
  try {
    return await exec("pkexec", ["/bin/bash", "-c", body, "sonde", ...args.map(String)], { timeout });
  } catch (e) {
    // 126 : fenêtre fermée ou mot de passe refusé ; 127 : non autorisé.
    if (e.code === 126 || e.code === 127) throw new Error("Autorisation administrateur refusée.");
    throw e;
  }
}

// Comme runElevated, mais chaque ligne de sortie est transmise au fur et à
// mesure (mises à jour : on montre ce qu'apt est en train de faire).
// Renvoie le code de sortie. Une fois autorisé, le processus tourne en
// root : il ne peut plus être interrompu depuis Sonde.
function streamElevated(script, args = [], onLine) {
  if (!which("pkexec")) return Promise.reject(new Error("pkexec est introuvable : installe le paquet « pkexec »."));
  return new Promise((resolve) => {
    const p = spawn("pkexec", ["/bin/bash", "-c", "set -o pipefail\n" + script, "sonde", ...args.map(String)], { env: C_ENV });
    let buf = "";
    const feed = (d) => {
      buf += String(d).replace(/\r/g, "\n");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
    };
    p.stdout.on("data", feed);
    p.stderr.on("data", feed);
    p.on("close", (code) => { if (buf.trim()) onLine(buf.trim()); resolve(code); });
    p.on("error", () => resolve(-1));
  });
}

// Montre un fichier dans le gestionnaire de fichiers (Fichiers de GNOME,
// Dolphin…) via l'interface standard FileManager1 ; sinon ouvre le dossier.
async function reveal(p) {
  // dbus-send sépare les tableaux sur les virgules : on les encode.
  const uri = pathToFileURL(p).href.replace(/,/g, "%2C");
  try {
    await exec("dbus-send", ["--session", "--dest=org.freedesktop.FileManager1", "--type=method_call",
      "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems", `array:string:${uri}`, "string:"], { timeout: 5000 });
  } catch {
    const dir = fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p);
    open(dir);
  }
}

// Ouvre un fichier, un dossier ou une adresse avec l'application par défaut.
function open(target) {
  spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
}

// Lance un programme graphique détaché (Paramètres de GNOME, Moniteur système…).
function launch(cmd, args = []) {
  if (!which(cmd)) throw new Error(`${cmd} n'est pas installé.`);
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// Notification du bureau.
async function notify(title, text) {
  try { return await sendNotification(title, text); }
  catch (e) {
    if (/ServiceUnknown|not provided|Cannot autolaunch|DBUS_SESSION/i.test(e.message)) throw new Error("Aucun service de notification : le bureau n'est pas ouvert, ou il n'affiche pas de notifications.");
    throw e;
  }
}

async function sendNotification(title, text) {
  if (which("notify-send")) return exec("notify-send", ["--app-name=Sonde", "--icon=sonde", title, text], { timeout: 10000 });
  // Repli : directement par D-Bus. gdbus lit des valeurs GVariant : les
  // chaînes sont donc écrites entre guillemets (JSON en est un sous-ensemble).
  const q = (t) => JSON.stringify(String(t));
  return exec("gdbus", ["call", "--session", "--dest=org.freedesktop.Notifications", "--object-path=/org/freedesktop/Notifications",
    "--method=org.freedesktop.Notifications.Notify", q("Sonde"), "0", q("sonde"), q(title), q(text), "[]", "{}", "8000"], { timeout: 10000 });
}

function cleanError(s) {
  if (!s) return "";
  const line = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  return (line || s).trim().slice(0, 400);
}

module.exports = { exec, tryExec, json, which, runElevated, streamElevated, reveal, open, launch, notify, C_ENV };
