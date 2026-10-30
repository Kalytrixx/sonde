// Ce qui change d'un système à l'autre pour le cœur de Sonde : séparateur
// de chemins, casse des noms, liste des disques. Les modules système, eux,
// ont une version par plateforme (lib/modules/win32, lib/modules/linux).

const fs = require("fs");
const path = require("path");

const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const SEP = path.sep;
const ID = IS_WIN ? "win32" : "linux";

// Clé d'index d'un chemin : Windows ignore la casse, Linux non.
const key = IS_WIN ? (p) => String(p).toLowerCase() : (p) => String(p);

// « dossier » + « nom », sans doubler le séparateur (racine C:\ ou /).
const join = (dir, name) => (dir.endsWith(SEP) ? dir + name : dir + SEP + name);

// p est-il dans dir (ou dir lui-même) ?
function inside(p, dir) {
  const a = key(p), b = key(dir);
  return a === b || a.startsWith(b.endsWith(SEP) ? b : b + SEP);
}

// ----------------------------------------------------------------- Linux ---
// Systèmes de fichiers qui contiennent des données de l'utilisateur. Les
// autres (proc, tmpfs, overlay, 9p de WSL, squashfs des snaps…) sont ignorés.
const REAL_FS = new Set(["ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "jfs", "reiserfs", "zfs", "bcachefs",
  "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "hfsplus"]);
// Montages réels mais sans intérêt pour un nettoyage.
const SKIP_MOUNT = /^\/(boot(\/efi)?|efi|snap\/.*|var\/lib\/(docker|containers)\/.*)$/;

// Montages du système : [{ mount, fstype, dev }], décodés depuis mountinfo.
function mounts() {
  let txt = "";
  try { txt = fs.readFileSync("/proc/self/mountinfo", "utf8"); } catch { return []; }
  const unesc = (s) => s.replace(/\\(\d{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line) continue;
    const [a, b] = line.split(" - ");
    const f = a.split(" "), g = (b || "").split(" ");
    out.push({ mount: unesc(f[4]), fstype: g[0], dev: g[1], root: unesc(f[3]) });
  }
  return out;
}

// Tous les points de montage, réels ou non : le scan ne les traverse pas
// (sinon /proc, /sys ou un autre disque seraient comptés dans « / »).
function allMountPoints() {
  return new Set(mounts().map((m) => m.mount));
}

// Les « disques » proposés au scan : un par point de montage réel. Un même
// périphérique monté deux fois (sous-volume btrfs, bind) n'est gardé qu'une fois.
function linuxDrives() {
  const seen = new Set();
  const out = [];
  for (const m of mounts()) {
    if (!REAL_FS.has(m.fstype) || SKIP_MOUNT.test(m.mount)) continue;
    const id = m.dev + "|" + m.root;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(m.mount);
  }
  // « / » d'abord, puis par ordre alphabétique.
  return out.sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
}

function winDrives() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = String.fromCharCode(c) + ":\\";
    try { fs.accessSync(d); out.push(d); } catch {}
  }
  return out;
}

const drives = IS_WIN ? winDrives : linuxDrives;

// Racine de disque entier (« C:\ » ou un point de montage).
const isDriveRoot = IS_WIN ? (p) => /^[A-Z]:\\$/i.test(p) : (p) => linuxDrives().includes(p);

// Nom court d'un disque pour l'affichage : « C: » ou « / », « /home ».
const driveName = IS_WIN ? (r) => r.slice(0, 2).toUpperCase() : (r) => r;

// Le disque (racine) qui contient p, pour statfs et la corbeille.
function driveOf(p) {
  if (IS_WIN) return p.slice(0, 3);
  let best = "/";
  for (const m of mounts()) if (inside(p, m.mount) && m.mount.length > best.length) best = m.mount;
  return best;
}

const HOME = process.env.HOME || process.env.USERPROFILE || "";

module.exports = { IS_WIN, IS_LINUX, ID, SEP, key, join, inside, drives, isDriveRoot, driveName, driveOf,
  allMountPoints, mounts, HOME };
