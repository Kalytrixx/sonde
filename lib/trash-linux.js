// Corbeille sous Linux, au format freedesktop.org (celui de GNOME, KDE,
// Xfce) : jamais de suppression définitive, et tout ce que Sonde envoie se
// retrouve dans la Corbeille de Fichiers, restaurable par l'utilisateur.
//
// - Disque du dossier personnel : ~/.local/share/Trash/{files,info}
// - Autres disques : <montage>/.Trash/<uid> (si l'administrateur l'a prévu)
//   ou <montage>/.Trash-<uid>
// Chaque élément = le fichier déplacé dans files/ + un « .trashinfo » dans
// info/ qui retient le chemin d'origine et la date.
//
// Pas de taille maximale comme sous Windows. Seul piège : GNOME peut vider
// la corbeille tout seul après N jours (Confidentialité > Historique) ; on le
// signale avant l'envoi.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const P = require("./platform");
const { isProtected } = require("./rules");

const UID = process.getuid ? process.getuid() : 0;
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(P.HOME, ".local", "share");
const HOME_TRASH = path.join(DATA_HOME, "Trash");

// ------------------------------------------------------- choix de la corbeille
function ensureDir(d, mode = 0o700) {
  fs.mkdirSync(d, { recursive: true, mode });
  return d;
}

function homeTrash() {
  ensureDir(path.join(HOME_TRASH, "files"));
  ensureDir(path.join(HOME_TRASH, "info"));
  return { dir: HOME_TRASH, top: null };
}

// La corbeille qui convient à p, ou null si aucune n'est possible sur son disque.
function trashFor(p) {
  const home = homeTrash();
  const dev = fs.lstatSync(p).dev;
  if (fs.statSync(home.dir).dev === dev) return home;
  const top = P.driveOf(p);
  // 1. <montage>/.Trash/<uid>, seulement si .Trash est un vrai dossier « sticky ».
  try {
    const shared = path.join(top, ".Trash");
    const st = fs.lstatSync(shared);
    if (st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o1000)) {
      const d = ensureDir(path.join(shared, String(UID)));
      ensureDir(path.join(d, "files")); ensureDir(path.join(d, "info"));
      if (fs.statSync(d).dev === dev) return { dir: d, top };
    }
  } catch {}
  // 2. <montage>/.Trash-<uid>
  try {
    const d = path.join(top, `.Trash-${UID}`);
    ensureDir(path.join(d, "files")); ensureDir(path.join(d, "info"));
    if (fs.statSync(d).dev === dev) return { dir: d, top };
  } catch {}
  return null;
}

// Toutes les corbeilles de l'utilisateur sur les disques montés.
function allTrashDirs() {
  const out = [HOME_TRASH];
  for (const m of P.drives()) {
    for (const d of [path.join(m, ".Trash", String(UID)), path.join(m, `.Trash-${UID}`)]) {
      try { if (fs.statSync(path.join(d, "info")).isDirectory() && !out.includes(d)) out.push(d); } catch {}
    }
  }
  return out;
}

// ------------------------------------------------------------ .trashinfo ---
// Chemin encodé comme une URL, « / » gardé tel quel.
const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
const decodePath = (p) => { try { return decodeURIComponent(p); } catch { return p; } };

// Date locale sans fuseau, comme l'exige la norme : AAAA-MM-JJTHH:MM:SS.
function localStamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}

// Réserve un nom libre dans info/ (création exclusive : deux envois
// simultanés ne peuvent pas prendre le même), puis déplace le fichier.
function trashOne(p) {
  const t = trashFor(p);
  if (!t) throw new Error("Aucune corbeille possible sur ce disque.");
  const orig = t.top ? path.relative(t.top, p) : p;
  const base = path.basename(p);
  const ext = path.extname(base);
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base;
  for (let n = 1; n < 10000; n++) {
    const name = n === 1 ? base : `${stem}.${n}${ext}`;
    const info = path.join(t.dir, "info", name + ".trashinfo");
    let fd;
    try { fd = fs.openSync(info, "wx", 0o600); } catch (e) { if (e.code === "EEXIST") continue; throw e; }
    try {
      fs.writeSync(fd, `[Trash Info]\nPath=${encodePath(orig)}\nDeletionDate=${localStamp()}\n`);
    } finally { fs.closeSync(fd); }
    if (fs.existsSync(path.join(t.dir, "files", name))) { fs.rmSync(info, { force: true }); continue; }
    try {
      fs.renameSync(p, path.join(t.dir, "files", name));
    } catch (e) {
      fs.rmSync(info, { force: true });
      throw e;
    }
    return { trash: t.dir, name };
  }
  throw new Error("Trop d'éléments du même nom dans la corbeille.");
}

// ------------------------------------------------------------ vérification -
// Un élément qu'on ne peut pas déplacer (fichier du système, dossier d'un
// autre utilisateur) est refusé d'avance plutôt que d'échouer à moitié.
function movable(p) {
  try {
    const parent = path.dirname(p);
    fs.accessSync(parent, fs.constants.W_OK);
    const st = fs.statSync(parent);
    // Dossier « sticky » (/tmp, /var/tmp) : seul le propriétaire peut déplacer.
    if ((st.mode & 0o1000) && fs.lstatSync(p).uid !== UID) return false;
    return true;
  } catch { return false; }
}

// GNOME vide-t-il la corbeille automatiquement ? (Confidentialité > Historique)
function autoPurge() {
  try {
    const env = { ...process.env, LC_ALL: "C" };
    const on = execFileSync("gsettings", ["get", "org.gnome.desktop.privacy", "remove-old-trash-files"], { encoding: "utf8", env, timeout: 3000 }).trim();
    if (on !== "true") return null;
    const days = execFileSync("gsettings", ["get", "org.gnome.desktop.privacy", "old-files-age"], { encoding: "utf8", env, timeout: 3000 }).trim().replace(/^uint32 /, "");
    return Number(days) || 30;
  } catch { return null; }
}

async function check(items) {
  const refused = [];
  const ok = [];
  for (const it of items) {
    if (!it.path || isProtected(it.path)) refused.push({ ...it, reason: "Chemin protégé (système ou dossier personnel)." });
    else if (!fs.existsSync(it.path)) refused.push({ ...it, reason: "N'existe plus." });
    // Vider un dossier : il faut pouvoir écrire dedans ; supprimer : dans son parent.
    else if (it.contenu ? !canWrite(it.path) : !movable(it.path))
      refused.push({ ...it, reason: "Appartient au système : passe par « Nettoyage système », qui demande le mot de passe administrateur." });
    else ok.push(it);
  }
  const bins = {};
  const purge = autoPurge();
  for (const it of ok) {
    let t;
    try { t = trashFor(it.path); } catch { t = null; }
    const k = t ? (t.top ? `Corbeille de ${t.top}` : "Corbeille") : P.driveOf(it.path);
    const b = (bins[k] ||= { need: 0, capacity: null, free: null, used: null });
    b.need += it.size || 0;
    if (!t) b.problem = `Pas de corbeille possible sur ${P.driveOf(it.path)} (disque en lecture seule ou sans droits). Rien ne sera envoyé.`;
    else if (purge) b.warning = `GNOME vide automatiquement la corbeille après ${purge} jours (Paramètres > Confidentialité > Historique de fichiers et corbeille).`;
  }
  return { ok, refused, bins, blocked: Object.values(bins).some((b) => b.problem) };
}

function canWrite(d) {
  try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; }
}

// ------------------------------------------------------------------ envoi ---
// En vidant un dossier (cache…), on épargne ce qui a bougé depuis 24 h :
// un programme est peut-être encore en train de s'en servir.
const DAY = 864e5;
function recent(p, cutoff, budget = { n: 200000 }) {
  let st;
  try { st = fs.lstatSync(p); } catch { return false; }
  if (st.mtimeMs > cutoff) return true;
  if (!st.isDirectory()) return false;
  let names;
  try { names = fs.readdirSync(p); } catch { return true; }
  for (const n of names) {
    if (--budget.n < 0) return true;   // trop gros pour vérifier : prudence
    if (recent(path.join(p, n), cutoff, budget)) return true;
  }
  return false;
}

async function send(items, onProgress = () => {}, shouldStop = () => false) {
  const out = [];
  const cutoff = Date.now() - DAY;
  const total = items.length;
  let n = 0;
  for (const it of items) {
    let done = 0, failed = 0;
    let targets = [it.path];
    if (it.contenu) {
      targets = [];
      let names = [];
      try { names = fs.readdirSync(it.path); } catch { failed++; }
      for (const n of names) {
        const full = path.join(it.path, n);
        if (recent(full, cutoff)) failed++;
        else targets.push(full);
      }
    }
    for (const t of targets) {
      if (shouldStop()) { failed++; continue; }
      try { trashOne(t); done++; } catch { failed++; }
    }
    out.push({ path: it.path, done, failed });
    onProgress({ done: ++n, total, path: it.path, bytes: 0 });
  }
  return out;
}

// --------------------------------------------------------------- contenu ---
function duSize(p, budget = { n: 100000 }) {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try { names = fs.readdirSync(p); } catch { return 0; }
  for (const n of names) {
    if (--budget.n < 0) break;
    total += duSize(path.join(p, n), budget);
  }
  return total;
}

// Tout ce que contiennent les corbeilles, du plus récent au plus ancien.
// `id` : nom dans files/ ; `bin` : dossier de la corbeille.
function binItems() {
  const items = [];
  for (const dir of allTrashDirs()) {
    let names;
    try { names = fs.readdirSync(path.join(dir, "info")); } catch { continue; }
    const top = dir === HOME_TRASH ? null : dir.replace(/\/\.Trash(-\d+|\/\d+)$/, "");
    for (const n of names) {
      if (!n.endsWith(".trashinfo")) continue;
      const id = n.slice(0, -10);
      try {
        const txt = fs.readFileSync(path.join(dir, "info", n), "utf8");
        const p = /^Path=(.*)$/m.exec(txt)?.[1];
        const date = /^DeletionDate=(.*)$/m.exec(txt)?.[1];
        if (!p) continue;
        const f = path.join(dir, "files", id);
        const st = fs.lstatSync(f);
        let original = decodePath(p);
        if (!original.startsWith("/")) original = path.join(top || "/", original);
        items.push({ id, bin: dir, original, name: path.basename(original), deleted: date ? Date.parse(date) : st.ctimeMs,
          size: st.isDirectory() ? duSize(f) : st.size, isDir: st.isDirectory() });
      } catch {}
    }
  }
  return items.sort((a, b) => b.deleted - a.deleted);
}

async function binStatus() {
  const items = binItems();
  return { capacity: null, used: items.reduce((a, i) => a + i.size, 0), nuke: false, free: null, autoPurgeDays: autoPurge() };
}

// Remet un élément à son emplacement d'origine.
function restoreOne(item) {
  const f = path.join(item.bin, "files", item.id);
  const info = path.join(item.bin, "info", item.id + ".trashinfo");
  if (fs.existsSync(item.original)) return { ok: false, reason: "Un élément du même nom existe déjà à cet endroit." };
  try {
    fs.mkdirSync(path.dirname(item.original), { recursive: true });
    fs.renameSync(f, item.original);
  } catch (e) {
    return { ok: false, reason: e.code === "EXDEV" ? "Autre disque : restaure-le depuis la Corbeille de Fichiers." : e.message };
  }
  fs.rmSync(info, { force: true });
  return { ok: true };
}

// Restaure les éléments d'une entrée du journal : les chemins supprimés, ou
// pour un dossier vidé, tout ce qui venait de l'intérieur de ce dossier.
function restoreEntry(entry) {
  const items = binItems();
  const results = [];
  for (const it of entry.items || []) {
    const matches = items.filter((b) => {
      if (b.deleted < entry.at - 60000) return false;   // supprimé avant cette action
      return it.contenu ? b.original.startsWith(it.path + "/") : b.original === it.path;
    });
    if (!matches.length) { results.push({ path: it.path, ok: false, reason: "Introuvable dans la corbeille (vidée ?)." }); continue; }
    // Un même chemin peut être plusieurs fois dans la corbeille : pour un
    // élément isolé, seule la suppression la plus récente est la nôtre.
    for (const m of it.contenu ? matches : matches.slice(0, 1)) results.push({ path: m.original, ...restoreOne(m) });
  }
  return results;
}

module.exports = { check, send, binStatus, binItems, restoreOne, restoreEntry, HOME_TRASH, allTrashDirs };
