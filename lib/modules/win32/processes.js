// Logiciels actifs : processus regroupés par programme (mémoire, processeur,
// connexions réseau) et programmes lancés au démarrage.

const ps = require("../../ps");

const PROCS = `
$n = [Environment]::ProcessorCount
$t0 = @{}
foreach ($p in Get-Process) { try { $t0[$p.Id] = $p.TotalProcessorTime.TotalMilliseconds } catch {} }
Start-Sleep -Milliseconds 1000
$conn = @{}
Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object { $conn[[int]$_.OwningProcess] = 1 + [int]$conn[[int]$_.OwningProcess] }
$svc = @{}
Get-CimInstance Win32_Service -Filter "State='Running'" | ForEach-Object { if ($_.ProcessId) { $svc[[int]$_.ProcessId] = @($svc[[int]$_.ProcessId]) + $_.Name } }
foreach ($p in Get-Process) {
  $cpu = 0
  try { if ($t0.ContainsKey($p.Id)) { $cpu = ($p.TotalProcessorTime.TotalMilliseconds - $t0[$p.Id]) / 10 / $n } } catch {}
  @{ pid = $p.Id; name = $p.ProcessName; mem = [int64]$p.WorkingSet64; cpu = [math]::Round($cpu, 1)
     path = $p.Path; company = $p.Company; product = $p.Product; desc = $p.Description
     conn = [int]$conn[$p.Id]; services = @($svc[$p.Id] | Where-Object { $_ }); session = $p.SessionId }
}`;

// Processus qu'on ne ferme jamais, même s'ils ne sont pas dans C:\Windows.
const CRITICAL = new Set(["system", "idle", "registry", "memory compression", "smss", "csrss", "wininit", "winlogon",
  "services", "lsass", "svchost", "dwm", "explorer", "fontdrvhost", "sihost", "ctfmon", "node", "powershell", "conhost",
  "ollama", "ollama app", "llama-server", "ollama_llama_server", "claude"]);   // Ollama fait tourner GPT-OSS pour Sonde

// Démarrage : entrées + état dans StartupApproved (même mécanisme que le
// Gestionnaire des tâches). Octet 0 pair = activé, impair = désactivé.
const STARTUP = `
function Approved($hive, $sub, $name) {
  $v = (Get-ItemProperty "$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\$sub" -Name $name -ErrorAction SilentlyContinue).$name
  if ($v -and ($v[0] % 2) -eq 1) { $false } else { $true }
}
$out = @()
$runs = @(
  @{ hive = 'HKCU:'; key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; sub = 'Run'; scope = 'utilisateur' },
  @{ hive = 'HKLM:'; key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run'; sub = 'Run'; scope = 'machine' },
  @{ hive = 'HKLM:'; key = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run'; sub = 'Run32'; scope = 'machine' })
foreach ($r in $runs) {
  $props = Get-ItemProperty $r.key -ErrorAction SilentlyContinue
  if ($props) { foreach ($p in $props.PSObject.Properties) { if ($p.Name -notlike 'PS*') {
    $out += @{ id = "$($r.hive)|$($r.sub)|$($p.Name)"; name = $p.Name; command = "$($p.Value)"; scope = $r.scope; enabled = (Approved $r.hive $r.sub $p.Name) } } } }
}
foreach ($f in @(@{ d = [Environment]::GetFolderPath('Startup'); hive = 'HKCU:'; scope = 'utilisateur' }, @{ d = [Environment]::GetFolderPath('CommonStartup'); hive = 'HKLM:'; scope = 'machine' })) {
  Get-ChildItem -LiteralPath $f.d -File -ErrorAction SilentlyContinue | Where-Object Name -ne 'desktop.ini' | ForEach-Object {
    $out += @{ id = "$($f.hive)|StartupFolder|$($_.Name)"; name = $_.BaseName; command = $_.FullName; scope = $f.scope; enabled = (Approved $f.hive 'StartupFolder' $_.Name) }
  }
}
$out`;

const SET_STARTUP = `
$hive, $sub, $name = $A.id -split '\\|', 3
$key = "$hive\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\$sub"
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
$bytes = New-Object byte[] 12
if ($A.enable) { $bytes[0] = 2 } else { $bytes[0] = 3; [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTimeUtc()).CopyTo($bytes, 4) }
Set-ItemProperty -Path $key -Name $name -Value $bytes -Type Binary
$true`;

function classify(p) {
  const path = p.path || "";
  if (!path) return "windows";   // inaccessible : processus système ou protégé
  if (/^[A-Z]:\\Windows\\/i.test(path)) return "windows";
  if (/Microsoft/i.test(p.company || "")) return "microsoft";
  return "tiers";
}

module.exports = (ctx) => {
  let last = null;
  let startupCache = null;

  async function startupList() {
    startupCache = [].concat(await ps.run(STARTUP) || []);
    return startupCache;
  }

  async function setStartup(id, enable) {
    const item = (startupCache || await startupList()).find((s) => s.id === id);
    if (!item) throw new Error("Entrée de démarrage inconnue.");
    // Les entrées « machine » demandent les droits administrateur.
    if (id.startsWith("HKLM:")) await ps.runElevated(SET_STARTUP, { args: { id, enable } });
    else await ps.run(SET_STARTUP, { args: { id, enable } });
    return item;
  }

  ctx.reverters.startup = ({ id, enable }) => setStartup(id, enable);

  return {
    "GET /api/processes": async () => {
      const raw = [].concat(await ps.run(PROCS, { timeout: 60000 }) || []);
      const groups = new Map();
      // Certaines ressources de version contiennent des entités XML (&apos;…).
      const clean = (s) => String(s || "").replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
      for (const p of raw) {
        p.product = clean(p.product); p.desc = clean(p.desc); p.company = clean(p.company);
        const key = p.name.toLowerCase();
        if (!groups.has(key)) groups.set(key, { name: p.name, product: p.product || p.desc || "", company: p.company || "",
          path: p.path || "", cls: classify(p), count: 0, mem: 0, cpu: 0, conn: 0, pids: [], services: [] });
        const g = groups.get(key);
        g.count++; g.mem += p.mem; g.cpu += p.cpu; g.conn += p.conn; g.pids.push(p.pid);
        g.services.push(...(p.services || []));
        if (!g.path && p.path) { g.path = p.path; g.cls = classify(p); }
      }
      const list = [...groups.values()].map((g) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10,
        canStop: g.cls !== "windows" && !CRITICAL.has(g.name.toLowerCase()) && !g.pids.includes(process.pid) }))
        .sort((a, b) => b.mem - a.mem);
      last = { at: Date.now(), list };
      const sum = (cls) => list.filter((g) => g.cls === cls).reduce((a, g) => a + g.mem, 0);
      return { list, totals: { windows: sum("windows"), microsoft: sum("microsoft"), tiers: sum("tiers") }, count: raw.length };
    },

    // Ferme un programme (tous ses processus). Jamais un processus de Windows.
    "POST /api/processes/stop": async (req) => {
      const { name } = await ctx.body(req);
      const g = last?.list.find((x) => x.name === name);
      if (!g) throw new Error("Programme introuvable : actualise la liste.");
      if (!g.canStop) throw new Error("Ce processus fait partie de Windows ou de Sonde : il ne peut pas être fermé ici.");
      await ps.run("Stop-Process -Id $A.pids -ErrorAction SilentlyContinue; $true", { args: { pids: g.pids } });
      ctx.journal.add({ kind: "system", title: `Programme fermé : ${g.product || g.name}` });
      return { ok: true };
    },

    "GET /api/startup": async () => startupList(),

    "POST /api/startup/set": async (req) => {
      const { id, enable } = await ctx.body(req);
      const item = await setStartup(String(id), !!enable);
      ctx.journal.add({ kind: "system", title: `Démarrage ${enable ? "activé" : "désactivé"} : ${item.name}`,
        revert: { type: "startup", args: { id: item.id, enable: !enable } } });
      return { ok: true };
    },
  };
};
