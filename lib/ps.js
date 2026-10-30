// Exécution de PowerShell. Les scripts passent par un fichier temporaire :
// pas de problème de guillemets, et l'encodage UTF-8 est garanti.
//
// Règle : le texte d'un script vient toujours du serveur. Les valeurs
// venues de la page (nom de service, chemin…) sont validées puis passées
// via un fichier JSON d'arguments, jamais collées dans le script.

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

let seq = 0;
const tmp = (ext) => path.join(os.tmpdir(), `sonde-${process.pid}-${Date.now()}-${seq++}${ext}`);

const PRELUDE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
`;

// Lance `script` ; `args` est accessible dans le script sous $A.
// Le script doit écrire son résultat sur la sortie ; on le convertit en JSON.
function run(script, { args = null, timeout = 120000 } = {}) {
  const file = tmp(".ps1");
  const argFile = args ? tmp(".json") : null;
  if (argFile) fs.writeFileSync(argFile, JSON.stringify(args), "utf8");
  const body = PRELUDE +
    (argFile ? `$A = Get-Content -LiteralPath '${argFile}' -Raw -Encoding UTF8 | ConvertFrom-Json\n` : "") +
    `$__r = & {\n${script}\n}\n` +
    `if ($null -eq $__r) { 'null' } else { ConvertTo-Json -InputObject $__r -Depth 6 -Compress }\n`;
  // BOM : Windows PowerShell 5.1 lit sinon le fichier en ANSI.
  fs.writeFileSync(file, "﻿" + body, "utf8");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        fs.rmSync(file, { force: true });
        if (argFile) fs.rmSync(argFile, { force: true });
        if (err) return reject(new Error(cleanError(stderr) || err.message));
        try { resolve(JSON.parse(stdout.trim() || "null")); }
        catch { reject(new Error("Réponse illisible de PowerShell : " + stdout.slice(0, 300))); }
      });
  });
}

// Script ajouté avant chaque action administrateur (point de restauration,
// voir lib/modules/win32/restore.js). Renvoie "" pour ne rien ajouter.
const hooks = { beforeElevated: () => "", afterElevated: () => {} };

// Même chose, mais avec les droits administrateur : Windows affiche la
// fenêtre UAC et c'est l'utilisateur qui accepte ou refuse.
// `onLog` : le script peut écrire des lignes de progression avec `L "texte"` ;
// elles sont transmises au fur et à mesure (l'action tourne dans un autre processus).
async function runElevated(script, { args = null, timeout = 30 * 60000, onLog = null, noHook = false } = {}) {
  const inner = tmp(".ps1");
  const out = tmp(".json");
  const log = tmp(".log");
  const argFile = args ? tmp(".json") : null;
  if (argFile) fs.writeFileSync(argFile, JSON.stringify(args), "utf8");
  const before = noHook ? "" : hooks.beforeElevated() || "";
  const body = PRELUDE +
    (argFile ? `$A = Get-Content -LiteralPath '${argFile}' -Raw -Encoding UTF8 | ConvertFrom-Json\n` : "") +
    `function L([string]$m) { Add-Content -LiteralPath '${log}' -Value $m -Encoding UTF8 }\n` +
    `try {\n${before}\n  $__r = & {\n${script}\n  }\n  ConvertTo-Json -InputObject @{ ok = $true; result = $__r } -Depth 6 -Compress | Set-Content -LiteralPath '${out}' -Encoding UTF8\n` +
    `} catch {\n  ConvertTo-Json -InputObject @{ ok = $false; error = "$_" } -Compress | Set-Content -LiteralPath '${out}' -Encoding UTF8\n}\n`;
  fs.writeFileSync(inner, "﻿" + body, "utf8");
  // Lecture du journal de progression pendant l'action.
  let pos = 0, timer = null;
  const pump = () => {
    try {
      const buf = fs.readFileSync(log);
      if (buf.length > pos) {
        const txt = buf.slice(pos).toString("utf8").replace(/^﻿/, "");
        pos = buf.length;
        for (const l of txt.split(/\r?\n/)) if (l.trim()) onLog(l.trim());
      }
    } catch {}
  };
  if (onLog) timer = setInterval(pump, 500);
  try {
    await run(`
      try {
        Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${inner}"'
      } catch {
        throw "Autorisation administrateur refusée."
      }
      $true`, { timeout });
    if (onLog) pump();
    if (!fs.existsSync(out)) throw new Error("L'action administrateur n'a rien renvoyé.");
    const res = JSON.parse(fs.readFileSync(out, "utf8").replace(/^﻿/, ""));
    if (!res.ok) throw new Error(res.error);
    if (before) hooks.afterElevated();
    return res.result;
  } finally {
    clearInterval(timer);
    for (const f of [inner, out, log, argFile]) if (f) fs.rmSync(f, { force: true });
  }
}

function cleanError(s) {
  if (!s) return "";
  // Garde la première ligne utile du message d'erreur PowerShell.
  const line = s.split(/\r?\n/).find((l) => l.trim() && !/^(Au caractère|At line|\+|    \+)/.test(l.trim()));
  return (line || s).trim().slice(0, 400);
}

module.exports = { run, runElevated, hooks };
