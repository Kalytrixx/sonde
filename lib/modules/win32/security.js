// Sécurité : état de Defender, du pare-feu et de l'UAC, menaces détectées,
// analyses Defender, et audit de tout ce qui se lance automatiquement.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const ps = require("../../ps");

const MPCMD = ["C:\\Program Files\\Windows Defender\\MpCmdRun.exe"];

const AUTORUNS = `
function Exe($cmd) {
  if (-not $cmd) { return $null }
  $c = [Environment]::ExpandEnvironmentVariables("$cmd".Trim())
  if ($c.StartsWith('"')) { return $c.Substring(1, [Math]::Max(0, $c.IndexOf('"', 1) - 1)) }
  $m = [regex]::Match($c, '^(.*?\\.(exe|com|bat|cmd|lnk|ps1|vbs|js))', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return ($c -split ' ')[0]
}
$items = New-Object System.Collections.ArrayList
$runs = @(
  @{ p = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; s = 'Registre (utilisateur)' },
  @{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'; s = 'Registre (machine)' },
  @{ p = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; s = 'Registre (machine 32 bits)' })
foreach ($k in $runs) {
  $props = Get-ItemProperty $k.p -ErrorAction SilentlyContinue
  if ($props) { foreach ($n in $props.PSObject.Properties) { if ($n.Name -notlike 'PS*') {
    [void]$items.Add(@{ kind = 'run'; source = $k.s; name = $n.Name; command = "$($n.Value)"; exe = (Exe $n.Value) }) } } }
}
$sh = New-Object -ComObject WScript.Shell
foreach ($d in @([Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'))) {
  Get-ChildItem -LiteralPath $d -File -ErrorAction SilentlyContinue | Where-Object Name -ne 'desktop.ini' | ForEach-Object {
    $t = $_.FullName
    if ($_.Extension -eq '.lnk') { $t = $sh.CreateShortcut($_.FullName).TargetPath }
    [void]$items.Add(@{ kind = 'folder'; source = 'Dossier Démarrage'; name = $_.BaseName; command = $_.FullName; exe = $t })
  }
}
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' -and $_.State -ne 'Disabled' } | ForEach-Object {
  $a = $_.Actions | Select-Object -First 1
  if ($a.Execute) { [void]$items.Add(@{ kind = 'task'; source = 'Tâche planifiée'; name = $_.TaskName; command = "$($a.Execute) $($a.Arguments)"; exe = (Exe $a.Execute) }) }
}
Get-CimInstance Win32_Service | Where-Object { $_.StartMode -eq 'Auto' -and $_.PathName -and $_.PathName -notmatch '\\\\Windows\\\\' } | ForEach-Object {
  [void]$items.Add(@{ kind = 'service'; source = 'Service'; name = $_.DisplayName; command = $_.PathName; exe = (Exe $_.PathName) })
}
$cache = @{}
foreach ($i in $items) {
  $e = $i.exe
  if ($e -and (Test-Path -LiteralPath $e -PathType Leaf)) {
    if (-not $cache.ContainsKey($e)) {
      $s = Get-AuthenticodeSignature -LiteralPath $e
      $cache[$e] = @{ status = "$($s.Status)"; signer = if ($s.SignerCertificate) { $s.SignerCertificate.GetNameInfo('SimpleName', $false) } else { $null } }
    }
    $i.sig = $cache[$e]; $i.exists = $true
  } else { $i.exists = $false }
}
$items`;

// Pourquoi un élément de démarrage mérite un coup d'œil. Rien de tout ça
// n'est une preuve : c'est ce qu'un technicien regarderait en premier.
function flags(i) {
  const f = [];
  const exe = String(i.exe || "");
  if (!String(i.command || "").trim()) f.push("commande vide : entrée orpheline");
  else if (!i.exists) f.push("programme introuvable : sans doute désinstallé, entrée orpheline");
  else if (i.sig?.status !== "Valid") f.push(i.sig?.status === "NotSigned" ? "non signé" : "signature invalide");
  if (/\\(Temp|Downloads|Téléchargements|Public)\\/i.test(exe)) f.push("lancé depuis un dossier inhabituel");
  if (/\\(wscript|cscript|mshta|rundll32|regsvr32|powershell|cmd)\.exe$/i.test(exe) && /(http|base64|-enc|\.vbs|\.js|\.hta)/i.test(i.command))
    f.push("script lancé par un interpréteur");
  return f;
}

// Zones d'une analyse. MpCmdRun ne dit pas quel fichier il lit : Sonde
// découpe donc l'analyse en dossiers et les confie un par un à Defender
// (analyse personnalisée), ce qui donne un aperçu réel et une progression.
// Analyse complète : les dossiers des disques scannés ; un dossier qui pèse
// plus de 10 % du total est découpé en sous-dossiers (jusqu'à 5 niveaux).
// Rien ne doit passer entre les mailles : les fichiers posés directement
// dans un dossier découpé (ou à la racine du disque) forment leur propre
// étape, et un dossier qui en contient trop n'est pas découpé du tout.
const MAX_LOOSE = 300;
const SKIP_ROOT = /^(pagefile|hiberfil|swapfile)\.sys$|^DumpStack\.log/i;

// Fichiers posés directement dans un dossier, avec leur taille totale réelle.
function looseFiles(dir) {
  const files = [];
  let size = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || SKIP_ROOT.test(e.name)) continue;
      const f = path.join(dir, e.name);
      files.push(f);
      try { size += fs.statSync(f).size; } catch {}
    }
  } catch {}
  return { files, size };
}

function fullZones(scan) {
  const roots = scan ? scan.tree.path === "::pc" ? scan.tree.children : [scan.tree] : [];
  if (!roots.length) return [{ label: "C:\\", path: "C:\\", size: 1 }];
  const total = roots.reduce((a, d) => a + d.size, 0) || 1;
  const out = [];
  const visit = (d, depth) => {
    const loose = d.children.length && d.size > total * 0.1 && depth < 5 ? looseFiles(d.path) : null;
    if (!loose || loose.files.length > MAX_LOOSE) {
      out.push({ label: d.path, path: d.path, size: d.size });
      return;
    }
    if (loose.files.length) out.push({ label: `${d.path} (fichiers du dossier)`, files: loose.files, size: loose.size || 1 });
    for (const c of d.children) if (c.size > 0) visit(c, depth + 1);
  };
  for (const r of roots) {
    const root = r.path.length === 2 ? r.path + "\\" : r.path;
    const loose = looseFiles(root);
    if (loose.files.length) out.push({ label: `${root} (fichiers à la racine)`, files: loose.files, size: loose.size || 1 });
    for (const c of r.children) if (c.size > 0) visit(c, 1);
  }
  return out.sort((x, y) => x.label.localeCompare(y.label, "fr"));
}

function quickZones(scan) {
  const home = process.env.USERPROFILE || "";
  const appdata = process.env.APPDATA || "";
  const z = [
    ["Téléchargements", path.join(home, "Downloads")],
    ["Bureau", path.join(home, "Desktop")],
    ["Fichiers temporaires", process.env.TEMP || path.join(home, "AppData", "Local", "Temp")],
    ["Programmes au démarrage (utilisateur)", path.join(appdata, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")],
    ["Programmes au démarrage (tous)", path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs", "StartUp")],
  ];
  // Poids de chaque zone : sa taille d'après le dernier scan (sinon 100 Mo).
  return z.filter(([, p]) => p && fs.existsSync(p)).map(([label, p]) => ({ label, path: p, size: scan?.get(p)?.size || 100 * 1024 ** 2 }));
}

module.exports = (ctx) => {
  let job = null;         // analyse Defender en cours
  let autorunsCache = null;

  // Lance MpCmdRun et renvoie son code de sortie ; la sortie va dans le job.
  function mp(args, j) {
    const exe = MPCMD.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("MpCmdRun.exe introuvable : Defender est-il installé ?");
    return new Promise((resolve) => {
      const p = spawn(exe, args, { windowsHide: true });
      j.proc = p;
      let out = "";
      const add = (d) => { out += d; j.output = (j.output + d).slice(-4000); };
      p.stdout.on("data", add);
      p.stderr.on("data", add);
      p.on("close", (code) => { j.proc = null; resolve({ code, out }); });
      p.on("error", (e) => { j.proc = null; resolve({ code: -1, out: e.message }); });
    });
  }

  // Analyse par étapes : chaque zone passe de « en attente » à « en cours »
  // puis « saine », « menace » ou « erreur ».
  async function runZones(j) {
    const total = j.steps.reduce((a, z) => a + (z.size || 1), 0) || 1;
    let done = 0;
    for (const z of j.steps) {
      if (j.cancelled) { z.state = "skip"; continue; }
      z.state = "run";
      z.started = Date.now();
      j.current = z.label;
      let r;
      if (z.files) {
        r = { code: 0, out: "" };
        for (const f of z.files) {
          if (j.cancelled) break;
          j.currentFile = f;
          const x = await mp(["-Scan", "-ScanType", "3", "-File", f], j);
          r.out += x.out;
          if (x.code !== 0) r.code = x.code === 2 || r.code === 2 ? 2 : x.code;
        }
        j.currentFile = null;
      } else r = await mp(z.quick ? ["-Scan", "-ScanType", "1"] : ["-Scan", "-ScanType", "3", "-File", z.path], j);
      z.secs = Math.round((Date.now() - z.started) / 1000);
      const found = [...r.out.matchAll(/found (\d+) threats?/gi)].reduce((n, m) => n + Number(m[1]), 0);
      z.found = found;
      z.state = j.cancelled ? "skip" : found || r.code === 2 ? "threat" : r.code === 0 ? "ok" : "error";
      if (z.state === "error") z.error = (r.out.trim().split(/\r?\n/).pop() || `code ${r.code}`).slice(0, 200);
      done += z.size || 1;
      j.percent = Math.round((done / total) * 100);
    }
    j.current = null;
    j.done = true;
    j.ended = Date.now();
    j.threats = j.steps.reduce((a, z) => a + (z.found || 0), 0);
    j.code = j.cancelled ? -2 : j.steps.some((z) => z.state === "error") ? 1 : 0;
  }

  function runMp(args, label) {
    const exe = MPCMD.find((p) => fs.existsSync(p));
    if (!exe) throw new Error("MpCmdRun.exe introuvable : Defender est-il installé ?");
    const j = { label, started: Date.now(), output: "", code: null, done: false };
    const p = spawn(exe, args, { windowsHide: true });
    p.stdout.on("data", (d) => { j.output = (j.output + d).slice(-4000); });
    p.stderr.on("data", (d) => { j.output = (j.output + d).slice(-4000); });
    p.on("close", (code) => { j.code = code; j.done = true; j.ended = Date.now(); });
    p.on("error", (e) => { j.output += e.message; j.done = true; j.code = -1; });
    return j;
  }

  const pub = (j) => (j ? { ...j, proc: undefined, steps: j.steps?.map(({ files, ...z }) => ({ ...z, count: files?.length })) } : null);

  return {
    "GET /api/security": async () => {
      const r = await ps.run(`
        $mp = Get-MpComputerStatus -ErrorAction SilentlyContinue
        $iso = { param($d) if ($d -and $d.Year -gt 2000) { $d.ToString('o') } else { $null } }
        @{
          defender = if ($mp) { @{ enabled = $mp.AntivirusEnabled; realtime = $mp.RealTimeProtectionEnabled; tamper = $mp.IsTamperProtected
            sigAge = $mp.AntivirusSignatureAge; sigVersion = $mp.AntivirusSignatureVersion; sigUpdated = (& $iso $mp.AntivirusSignatureLastUpdated)
            quickEnd = (& $iso $mp.QuickScanEndTime); fullEnd = (& $iso $mp.FullScanEndTime); mode = "$($mp.AMRunningMode)" } } else { $null }
          firewall = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | ForEach-Object { @{ name = "$($_.Name)"; enabled = [bool]$_.Enabled } })
          uac = [int](Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue).EnableLUA
          av = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue | ForEach-Object { $_.displayName })
          threats = @(Get-MpThreatDetection -ErrorAction SilentlyContinue | ForEach-Object {
            $t = Get-MpThreat -ThreatID $_.ThreatID -ErrorAction SilentlyContinue
            @{ id = $_.ThreatID; name = $t.ThreatName; severity = $t.SeverityID; at = (& $iso $_.InitialDetectionTime)
               ok = $_.ActionSuccess; resources = @($_.Resources | Select-Object -First 3) } })
        }`, { timeout: 60000 });
      return { ...r, job: pub(job) };
    },

    // Lance une analyse Defender (rapide ou complète) en arrière-plan.
    "POST /api/security/scan": async (req) => {
      const { type } = await ctx.body(req);
      if (job && !job.done) throw new Error("Une analyse est déjà en cours.");
      const full = type === "full";
      // Toujours la vérification rapide de Defender d'abord : mémoire, programmes
      // au démarrage, registre (ce qu'une analyse de dossiers ne couvre pas).
      const steps = [{ label: "Mémoire, démarrage et registre", quick: true, size: 0 },
        ...(full ? fullZones(ctx.getScan()) : quickZones(ctx.getScan()))];
      // Poids de l'étape rapide : environ 5 % de l'analyse.
      const rest = steps.slice(1).reduce((a, z) => a + (z.size || 1), 0) || 1;
      steps[0].size = Math.max(1, Math.round(rest * (full ? 0.03 : 0.3)));
      job = { kind: "zones", label: full ? "Analyse complète" : "Analyse rapide", started: Date.now(), output: "", code: null, done: false,
        percent: 0, current: null, steps: steps.map((z) => ({ ...z, state: "wait" })), threats: 0 };
      runZones(job).catch((e) => { job.done = true; job.code = -1; job.output += e.message; });
      ctx.journal.add({ kind: "system", title: `Defender : ${job.label} lancée` });
      return { job: pub(job) };
    },

    // Arrête l'analyse : la zone en cours est interrompue, les suivantes sautées.
    "POST /api/security/cancel": async () => {
      if (!job || job.done) return { ok: true };
      job.cancelled = true;
      const exe = MPCMD.find((p) => fs.existsSync(p));
      if (exe) spawn(exe, ["-Cancel"], { windowsHide: true });
      job.proc?.kill();
      return { ok: true };
    },

    "GET /api/security/job": async () => ({ job: pub(job) }),

    "POST /api/security/update": async () => {
      if (job && !job.done) throw new Error("Une opération Defender est déjà en cours.");
      job = runMp(["-SignatureUpdate"], "Mise à jour des signatures");
      return { job: pub(job) };
    },

    "GET /api/security/autoruns": async (req, res, url) => {
      if (!autorunsCache || url.searchParams.get("refresh") === "1" || Date.now() - autorunsCache.at > 300000) {
        const items = [].concat(await ps.run(AUTORUNS, { timeout: 120000 }) || []);
        autorunsCache = { at: Date.now(), items: items.map((i) => ({ ...i, flags: flags(i) })) };
      }
      return autorunsCache;
    },
  };
};
