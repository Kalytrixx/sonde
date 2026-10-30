// Envoi à la corbeille Windows, jamais de suppression définitive.
//
// Piège : la corbeille a une taille maximale par disque. Si on dépasse,
// Windows efface DÉFINITIVEMENT les éléments les plus anciens, voire l'élément
// envoyé lui-même, sans prévenir. On vérifie donc la place avant d'envoyer.

const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { isProtected } = require("./rules");

function ps(script, timeout = 600000) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

// Chaîne PowerShell entre apostrophes simples : seule l'apostrophe s'échappe.
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Capacité et occupation de la corbeille du lecteur `drive` (ex. "C:").
async function binStatus(drive) {
  const letter = drive.slice(0, 1).toUpperCase();
  const out = await ps(`
    $ErrorActionPreference = 'SilentlyContinue'
    $vol = (mountvol ${letter}:\\ /L).Trim()
    $guid = [regex]::Match($vol, '\\{[0-9a-fA-F-]+\\}').Value
    $key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume\\$guid"
    $p = Get-ItemProperty $key
    $sid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    $used = (Get-ChildItem "${letter}:\\\`$Recycle.Bin\\$sid" -Recurse -File -Force | Measure-Object Length -Sum).Sum
    [pscustomobject]@{ capacity = [int64]$p.MaxCapacity * 1MB; nuke = [int]$p.NukeOnDelete; used = [int64]$used } | ConvertTo-Json -Compress
  `, 120000);
  const s = JSON.parse(out.trim() || "{}");
  // Sans réglage lu, on suppose la valeur par défaut la plus prudente.
  if (!s.capacity) s.capacity = 0;
  return { capacity: s.capacity, used: s.used || 0, nuke: !!s.nuke, free: Math.max(0, s.capacity - (s.used || 0)) };
}

// items : [{ path, size, contenu }] — `contenu` vide le dossier sans le supprimer.
async function check(items) {
  const refused = [];
  const ok = [];
  for (const it of items) {
    if (!it.path || isProtected(it.path)) refused.push({ ...it, reason: "Chemin protégé (système ou dossier personnel)." });
    else if (!fs.existsSync(it.path)) refused.push({ ...it, reason: "N'existe plus." });
    else ok.push(it);
  }
  const byDrive = {};
  for (const it of ok) (byDrive[it.path.slice(0, 2).toUpperCase()] ||= []).push(it);
  const bins = {};
  for (const [drive, list] of Object.entries(byDrive)) {
    const b = await binStatus(drive);
    const need = list.reduce((s, it) => s + (it.size || 0), 0);
    const biggest = Math.max(0, ...list.map((it) => it.size || 0));
    bins[drive] = { ...b, need };
    if (b.nuke) bins[drive].problem = "La corbeille de ce disque est réglée pour supprimer définitivement. Rien ne sera envoyé.";
    else if (!b.capacity) bins[drive].problem = "Impossible de lire la taille maximale de la corbeille.";
    else if (biggest > b.capacity) bins[drive].problem = `Un élément (${gb(biggest)}) dépasse la taille maximale de la corbeille (${gb(b.capacity)}) : Windows le supprimerait définitivement.`;
    else if (need > b.free) bins[drive].problem = `Il faut ${gb(need)} de place dans la corbeille, il en reste ${gb(b.free)}. Au-delà, Windows efface définitivement les éléments les plus anciens. Procède par lots (en vidant la corbeille entre deux), ou agrandis-la : clic droit sur la Corbeille > Propriétés > Taille personnalisée.`;
  }
  return { ok, refused, bins, blocked: Object.values(bins).some((b) => b.problem) };
}

// --------------------------------------------------------------- envoi ---
// Un seul PowerShell reste ouvert pendant tout l'envoi : il reçoit les
// chemins un par un (en base64, pour les accents) et les met à la corbeille
// avec SHFileOperation : corbeille (FOF_ALLOWUNDO), sans confirmation ni
// fenêtre d'erreur (un fichier verrouillé échoue simplement). FOF_WANTNUKEWARNING :
// si Windows devait supprimer définitivement au lieu de recycler, il demande
// quand même (normalement impossible : la place est vérifiée avant).
const WORKER = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SondeBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEOPSTRUCT {
    public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo;
    public ushort fFlags; public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHFileOperation(ref SHFILEOPSTRUCT op);
  public static int Recycle(string path) {
    var op = new SHFILEOPSTRUCT();
    op.wFunc = 3;                     // FO_DELETE
    op.pFrom = path + "\\0\\0";
    // FOF_ALLOWUNDO 0x40 | FOF_NOCONFIRMATION 0x10 | FOF_SILENT 0x4 | FOF_NOERRORUI 0x400 | FOF_WANTNUKEWARNING 0x4000
    op.fFlags = (ushort)(0x40 | 0x10 | 0x4 | 0x400 | 0x4000);
    int r = SHFileOperation(ref op);
    if (r == 0 && op.fAnyOperationsAborted) return -1;
    return r;
  }
}
'@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
'READY'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
  $r = 1
  try { $r = [SondeBin]::Recycle($p) } catch { $r = 2 }
  if ($r -eq 0 -and (Test-Path -LiteralPath $p)) { $r = 3 }
  "$r"
}`;

function startWorker() {
  // Le script passe par un fichier (avec BOM : PowerShell 5.1 le lirait sinon
  // en ANSI) ; l'entrée standard ne sert qu'aux chemins.
  const script = path.join(os.tmpdir(), `sonde-bin-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(script, "﻿" + WORKER, "utf8");
  const p = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  p.on("close", () => fs.rmSync(script, { force: true }));
  let buf = "";
  const waiters = [];
  let ready;
  const readyP = new Promise((r) => (ready = r));
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === "READY") ready();
      else if (/^-?\d+$/.test(line)) waiters.shift()?.(Number(line));
    }
  });
  p.on("close", () => { ready(); while (waiters.length) waiters.shift()(99); });
  return {
    ready: readyP,
    recycle: (file) => new Promise((resolve) => { waiters.push(resolve); p.stdin.write(Buffer.from(file, "utf8").toString("base64") + "\r\n"); }),
    close: () => { try { p.stdin.end(); } catch {} setTimeout(() => p.kill(), 2000).unref(); },
  };
}

// En vidant un dossier (Temp…), on épargne ce qui a bougé depuis 24 h : un
// programme s'en sert peut-être encore. On s'arrête au premier fichier récent.
// Renvoie aussi la taille, pour la progression.
const DAY = 864e5;
function inspect(p, cutoff, budget = { n: 200000 }) {
  let st;
  try { st = fs.lstatSync(p); } catch { return { recent: false, size: 0 }; }
  if (st.mtimeMs > cutoff) return { recent: true, size: st.size };
  if (!st.isDirectory()) return { recent: false, size: st.size };
  let size = 0, names;
  try { names = fs.readdirSync(p); } catch { return { recent: true, size: 0 }; }
  for (const n of names) {
    if (--budget.n < 0) return { recent: true, size };   // trop gros pour vérifier : prudence
    const r = inspect(path.join(p, n), cutoff, budget);
    size += r.size;
    if (r.recent) return { recent: true, size };
  }
  return { recent: false, size };
}

// items : [{ path, size, contenu }]. onProgress({ done, total, path, bytes }).
// shouldStop() : l'utilisateur a demandé l'arrêt (le reste n'est pas envoyé).
async function send(items, onProgress = () => {}, shouldStop = () => false) {
  const cutoff = Date.now() - DAY;
  // 1. Ce qui part vraiment : pour un dossier à vider, ses éléments pas récents.
  const plan = [];
  for (const it of items) {
    const e = { path: it.path, done: 0, failed: 0, targets: [] };
    if (it.contenu) {
      let names = [];
      try { names = fs.readdirSync(it.path); } catch { e.failed++; }
      for (const n of names) {
        const full = path.join(it.path, n);
        const r = inspect(full, cutoff);
        if (r.recent) e.failed++;
        else e.targets.push({ file: full, size: r.size });
      }
    } else e.targets.push({ file: it.path, size: it.size || 0 });
    plan.push(e);
  }
  const total = plan.reduce((a, e) => a + e.targets.length, 0);
  let done = 0, bytes = 0;
  onProgress({ done, total, path: null, bytes });
  // 2. L'envoi, élément par élément.
  const w = startWorker();
  try {
    await w.ready;
    for (const e of plan) {
      for (const t of e.targets) {
        if (shouldStop()) { e.failed += 1; continue; }
        const code = await w.recycle(t.file);
        if (code === 0) { e.done++; bytes += t.size; } else e.failed++;
        done++;
        onProgress({ done, total, path: t.file, bytes });
      }
    }
  } finally {
    w.close();
  }
  return plan.map(({ path: p, done: d, failed }) => ({ path: p, done: d, failed }));
}

function gb(n) {
  return (n / 1024 ** 3).toFixed(1).replace(".", ",") + " Go";
}

// Restauration : chaque élément supprimé devient une paire de fichiers dans
// X:$Recycle.Bin<SID> : « $Ixxxxxx » (en-tête : chemin d'origine, taille,
// date) et « $Rxxxxxx » (le contenu). Restaurer = remettre $R à sa place et
// effacer $I. On lit le format directement : ça marche quelle que soit la
// langue de Windows, sans dépendre des verbes du menu contextuel.

let SID = null;
function sid() {
  if (SID) return SID;
  // Chemin complet : un autre « whoami » (Git Bash…) peut passer avant dans le PATH.
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  const out = execFileSync(exe, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
  SID = out.trim().split(",").pop().replace(/"/g, "");
  return SID;
}

// ------------------------------------------------------------ corbeille ---
function parseI(buf) {
  const version = Number(buf.readBigInt64LE(0));
  const size = Number(buf.readBigInt64LE(8));
  const ft = buf.readBigInt64LE(16);
  const deleted = Number(ft / 10000n - 11644473600000n);   // FILETIME -> ms Unix
  let original;
  if (version >= 2) {
    const len = buf.readInt32LE(24);
    original = buf.toString("utf16le", 28, 28 + (len - 1) * 2);
  } else {
    original = buf.toString("utf16le", 24, 24 + 520).replace(/\0.*$/s, "");
  }
  return { size, deleted, original };
}

function binDirs() {
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const d = `${String.fromCharCode(c)}:\\$Recycle.Bin\\${sid()}`;
    try { fs.accessSync(d); out.push(d); } catch {}
  }
  return out;
}

// Tout ce que contient la corbeille, du plus récent au plus ancien.
function binItems() {
  const items = [];
  for (const dir of binDirs()) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.startsWith("$I")) continue;
      try {
        const info = parseI(fs.readFileSync(path.join(dir, n)));
        const r = path.join(dir, "$R" + n.slice(2));
        if (!fs.existsSync(r)) continue;
        items.push({ id: n.slice(2), bin: dir, ...info, name: path.basename(info.original),
          isDir: fs.statSync(r).isDirectory() });
      } catch {}
    }
  }
  return items.sort((a, b) => b.deleted - a.deleted);
}

// Remet un élément de la corbeille à son emplacement d'origine.
function restoreOne(item) {
  const iFile = path.join(item.bin, "$I" + item.id);
  const rFile = path.join(item.bin, "$R" + item.id);
  if (fs.existsSync(item.original)) return { ok: false, reason: "Un élément du même nom existe déjà à cet endroit." };
  fs.mkdirSync(path.dirname(item.original), { recursive: true });
  try {
    fs.renameSync(rFile, item.original);
  } catch (e) {
    return { ok: false, reason: e.code === "EXDEV" ? "Autre disque : restaure-le depuis la Corbeille Windows." : e.message };
  }
  fs.rmSync(iFile, { force: true });
  return { ok: true };
}

// Restaure les éléments d'une entrée du journal : les chemins supprimés, ou
// pour un dossier vidé, tout ce qui venait de l'intérieur de ce dossier.
function restoreEntry(entry) {
  const items = binItems();
  const results = [];
  for (const it of entry.items || []) {
    const p = it.path.toLowerCase();
    const matches = items.filter((b) => {
      const o = b.original.toLowerCase();
      if (b.deleted < entry.at - 60000) return false;   // supprimé avant cette action
      return it.contenu ? o.startsWith(p + "\\") : o === p;
    });
    if (!matches.length) { results.push({ path: it.path, ok: false, reason: "Introuvable dans la corbeille (vidée ?)." }); continue; }
    // Un même chemin peut être plusieurs fois dans la corbeille : pour un
    // élément isolé, seule la suppression la plus récente est la nôtre.
    for (const m of it.contenu ? matches : matches.slice(0, 1)) results.push({ path: m.original, ...restoreOne(m) });
  }
  return results;
}

module.exports = { check, send, binStatus, binItems, restoreOne, restoreEntry };
