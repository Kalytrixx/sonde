// Gaming (Windows) : ce qui freine vraiment les jeux, mesuré sur ce PC.
// - Écran : fréquence actuelle, fréquences possibles, câble.
// - RAM : vitesse réelle et vitesse prévue par les barrettes (EXPO/XMP).
// - Carte graphique : pilote, port PCIe, mémoire vidéo.
// - Réglages Windows : mode Jeu, planification GPU, enregistrement en
//   arrière-plan, accélération de la souris, mode d'alimentation, isolation du noyau.
// - Jeux installés, disques, caches de shaders ; launchers et overlays en fond.
// - Réseau : ping des serveurs de jeu, latence sous charge (bufferbloat), NAT et UPnP.
// Chaque changement est confirmé dans la page et journalisé avec de quoi revenir en arrière.

const fs = require("fs");
const path = require("path");
const ps = require("../../ps");

// Affichage : énumération et changement de fréquence (user32, sans droits).
const DISPLAY_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SondeDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
    public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
    public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency;
    public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DISPLAY_DEVICE {
    public int cb;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
    public int StateFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevices(string dev, uint i, ref DISPLAY_DEVICE dd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string dev, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr lp);
  public static List<object[]> List() {
    var res = new List<object[]>();
    for (uint i = 0; ; i++) {
      var dd = new DISPLAY_DEVICE(); dd.cb = Marshal.SizeOf(dd);
      if (!EnumDisplayDevices(null, i, ref dd, 0)) break;
      if ((dd.StateFlags & 1) == 0) continue;            // pas attaché au bureau
      var cur = new DEVMODE(); cur.dmSize = (short)Marshal.SizeOf(cur);
      if (!EnumDisplaySettings(dd.DeviceName, -1, ref cur)) continue;
      var mon = new DISPLAY_DEVICE(); mon.cb = Marshal.SizeOf(mon);
      string monName = EnumDisplayDevices(dd.DeviceName, 0, ref mon, 0) ? mon.DeviceString : "";
      var freqs = new SortedSet<int>();
      var m = new DEVMODE(); m.dmSize = (short)Marshal.SizeOf(m);
      for (int k = 0; EnumDisplaySettings(dd.DeviceName, k, ref m); k++) {
        if (m.dmPelsWidth == cur.dmPelsWidth && m.dmPelsHeight == cur.dmPelsHeight && m.dmBitsPerPel == cur.dmBitsPerPel) freqs.Add(m.dmDisplayFrequency);
      }
      res.Add(new object[] { dd.DeviceName, dd.DeviceString, monName, cur.dmPelsWidth, cur.dmPelsHeight, cur.dmDisplayFrequency, string.Join(",", freqs), (dd.StateFlags & 4) != 0 });
    }
    return res;
  }
  public static int SetFrequency(string dev, int hz) {
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
    if (!EnumDisplaySettings(dev, -1, ref dm)) return -99;
    dm.dmDisplayFrequency = hz; dm.dmFields = 0x400000;  // DM_DISPLAYFREQUENCY
    int t = ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 2, IntPtr.Zero);  // CDS_TEST
    if (t != 0) return t;
    return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 1, IntPtr.Zero);   // CDS_UPDATEREGISTRY
  }
}`;

const INFO = `
Add-Type -TypeDefinition $A.cs
$displays = foreach ($d in [SondeDisplay]::List()) {
  @{ device = $d[0]; adapter = $d[1]; monitor = $d[2]; width = $d[3]; height = $d[4]; hz = $d[5]; modes = @("$($d[6])".Split(',') | Where-Object { $_ } | ForEach-Object { [int]$_ }); primary = $d[7] }
}
# Noms réels des écrans (EDID) et type de câble, dans l'ordre d'énumération
$monNames = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue | ForEach-Object { -join ($_.UserFriendlyName | Where-Object { $_ } | ForEach-Object { [char]$_ }) })
$monConn = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams -ErrorAction SilentlyContinue | ForEach-Object { [int64]$_.VideoOutputTechnology })
$ram = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed; part = "$($_.PartNumber)".Trim(); maker = "$($_.Manufacturer)".Trim(); size = [int64]$_.Capacity; type = [int]$_.SMBIOSMemoryType } })
$gpus = @(Get-CimInstance Win32_VideoController | Where-Object { $_.PNPDeviceID -like 'PCI*' } | ForEach-Object {
  $p = @{}
  foreach ($k in 'DEVPKEY_PciDevice_CurrentLinkWidth','DEVPKEY_PciDevice_MaxLinkWidth','DEVPKEY_PciDevice_CurrentLinkSpeed','DEVPKEY_PciDevice_MaxLinkSpeed','DEVPKEY_Device_Driver') {
    $p[$k] = (Get-PnpDeviceProperty -InstanceId $_.PNPDeviceID -KeyName $k -ErrorAction SilentlyContinue).Data
  }
  $vram = $null
  if ($p['DEVPKEY_Device_Driver']) { $vram = (Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\$($p['DEVPKEY_Device_Driver'])" -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize' }
  @{ name = $_.Name; driver = $_.DriverVersion; date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }; vram = $vram
     width = $p['DEVPKEY_PciDevice_CurrentLinkWidth']; maxWidth = $p['DEVPKEY_PciDevice_MaxLinkWidth']; gen = $p['DEVPKEY_PciDevice_CurrentLinkSpeed']; maxGen = $p['DEVPKEY_PciDevice_MaxLinkSpeed'] }
})
# Version des logiciels de pilote (AMD Software Adrenalin, pilote NVIDIA)
$sw = @(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^(AMD Software|NVIDIA Graphics Driver)' } | ForEach-Object { @{ name = "$($_.DisplayName)"; version = "$($_.DisplayVersion)" } })
function RegV($k, $n) { (Get-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue).$n }
$mouse = @{ speed = RegV 'HKCU:\\Control Panel\\Mouse' 'MouseSpeed'; t1 = RegV 'HKCU:\\Control Panel\\Mouse' 'MouseThreshold1'; t2 = RegV 'HKCU:\\Control Panel\\Mouse' 'MouseThreshold2' }
$plan = (& powercfg.exe /getactivescheme) -join ' '
$aliases = (& powercfg.exe /aliases) -join [char]10
$plans = (& powercfg.exe /list) -join [char]10
$disks = @{}
foreach ($pt in Get-Partition -ErrorAction SilentlyContinue | Where-Object DriveLetter) {
  $pd = Get-PhysicalDisk -ErrorAction SilentlyContinue | Where-Object DeviceId -eq "$($pt.DiskNumber)" | Select-Object -First 1
  $v = Get-Volume -DriveLetter $pt.DriveLetter -ErrorAction SilentlyContinue
  $disks["$($pt.DriveLetter)"] = @{ media = "$($pd.MediaType)"; bus = "$($pd.BusType)"; model = "$($pd.FriendlyName)"; free = [int64]$v.SizeRemaining; size = [int64]$v.Size }
}
$procs = @(Get-Process | ForEach-Object { @{ name = $_.ProcessName; mem = [int64]$_.WorkingSet64 } })
@{
  displays = @($displays); monNames = $monNames; monConn = $monConn; ram = $ram; gpus = $gpus; sw = $sw; disks = $disks; procs = $procs
  plan = $plan; aliases = $aliases; plans = $plans; mouse = $mouse
  gameMode = RegV 'HKCU:\\Software\\Microsoft\\GameBar' 'AutoGameModeEnabled'
  bgRecord = RegV 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR' 'HistoricalCaptureEnabled'
  hags = RegV 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' 'HwSchMode'
  hvci = RegV 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard\\Scenarios\\HypervisorEnforcedCodeIntegrity' 'Enabled'
  wuPause = RegV 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' 'PauseUpdatesExpiryTime'
  steamPath = RegV 'HKCU:\\Software\\Valve\\Steam' 'SteamPath'
}`;

// Réseau pour le jeu : carte active, signal Wi-Fi, passerelle, débit en cours
// sur la carte (deux relevés à 2 s d'intervalle).
const NET_INFO = `
$a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | Sort-Object { "$($_.PhysicalMediaType)" -match '802.11' } | Select-Object -First 1
$w = $null
if ($a -and "$($a.PhysicalMediaType)" -match '802.11') {
  $t = netsh wlan show interfaces | Out-String
  $w = @{ signal = [int][regex]::Match($t, 'Signal\\s*:\\s*(\\d+)').Groups[1].Value; ssid = [regex]::Match($t, '\\n\\s*SSID\\s*:\\s*(.+)').Groups[1].Value.Trim()
          band = [regex]::Match($t, '(?:Bande|Band)\\s*:\\s*(.+)').Groups[1].Value.Trim(); radio = [regex]::Match($t, '(?:Type de radio|Radio type)\\s*:\\s*(.+)').Groups[1].Value.Trim() }
}
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1).NextHop
$rate = $null
if ($a) {
  $s1 = Get-NetAdapterStatistics -Name $a.Name -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 2000
  $s2 = Get-NetAdapterStatistics -Name $a.Name -ErrorAction SilentlyContinue
  if ($s1 -and $s2) { $rate = @{ down = [int64]($s2.ReceivedBytes - $s1.ReceivedBytes) / 2; up = [int64]($s2.SentBytes - $s1.SentBytes) / 2 } }
}
@{ adapter = if ($a) { @{ name = $a.Name; desc = $a.InterfaceDescription; speed = [int64]$a.ReceiveLinkSpeed; wifi = ("$($a.PhysicalMediaType)" -match '802.11') } } else { $null }
   wifi = $w; gateway = $gw; rate = $rate }`;

// Pause de Windows Update pendant 7 jours : les mêmes valeurs que la page
// Paramètres de Windows (« Suspendre pendant 1 semaine »).
const WU_PAUSE = `
$k = 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings'
if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
$now = (Get-Date).ToUniversalTime(); $end = $now.AddDays(7)
$f = 'yyyy-MM-ddTHH:mm:ssZ'
foreach ($n in 'PauseUpdatesStartTime','PauseFeatureUpdatesStartTime','PauseQualityUpdatesStartTime') { Set-ItemProperty -Path $k -Name $n -Value $now.ToString($f) }
foreach ($n in 'PauseUpdatesExpiryTime','PauseFeatureUpdatesEndTime','PauseQualityUpdatesEndTime') { Set-ItemProperty -Path $k -Name $n -Value $end.ToString($f) }
$end.ToString($f)`;
const WU_RESUME = `
$k = 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings'
foreach ($n in 'PauseUpdatesStartTime','PauseFeatureUpdatesStartTime','PauseQualityUpdatesStartTime','PauseUpdatesExpiryTime','PauseFeatureUpdatesEndTime','PauseQualityUpdatesEndTime') { Remove-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue }
$true`;

// Launchers, overlays et synchronisation : utiles, mais inutiles en fond
// quand on ne s'en sert pas. Les logiciels de périphériques (souris, casque)
// sont cités sans être proposés à l'arrêt.
const BACKGROUND = [
  { re: /^steam(webhelper|service)?$/i, name: "Steam", app: /^Steam$/i, kind: "launcher" },
  { re: /^(EpicGamesLauncher|EpicWebHelper)$/i, name: "Epic Games Launcher", app: /Epic Games Launcher/i, kind: "launcher" },
  { re: /^(EADesktop|EABackgroundService|Origin)$/i, name: "EA app", app: /^EA( app)?$/i, kind: "launcher" },
  { re: /^(UbisoftConnect|upc|UplayWebCore)$/i, name: "Ubisoft Connect", app: /Ubisoft Connect/i, kind: "launcher" },
  { re: /^(GalaxyClient|GalaxyClientService|GalaxyCommunication)$/i, name: "GOG Galaxy", app: /GOG GALAXY/i, kind: "launcher" },
  { re: /^(Battle\.net|Agent)$/i, name: "Battle.net", app: /^Battle\.net/i, kind: "launcher" },
  { re: /^(RiotClientServices|RiotClientUx|RiotClientUxRender)$/i, name: "Riot Client", app: /^Riot Client/i, kind: "launcher" },
  { re: /^(RockstarService|SocialClubHelper)$/i, name: "Rockstar Games Launcher", app: /Rockstar Games Launcher/i, kind: "launcher" },
  { re: /^Overwolf/i, name: "Overwolf", app: /^Overwolf/i, kind: "overlay" },
  { re: /^Discord$/i, name: "Discord", kind: "overlay" },
  { re: /^(RadeonSoftware|AMDRSServ|AMDRSSrcExt)$/i, name: "AMD Software (Adrenalin)", kind: "pilote" },
  { re: /^(NVIDIA Share|nvcontainer|NVIDIA Overlay)$/i, name: "NVIDIA App / overlay", kind: "pilote" },
  { re: /^OneDrive$/i, name: "OneDrive", kind: "synchro" },
  { re: /^(lghub|lghub_agent|lghub_system_tray)$/i, name: "Logitech G HUB", kind: "périphérique" },
  { re: /^SteelSeriesGG|SteelSeriesEngine/i, name: "SteelSeries GG", kind: "périphérique" },
  { re: /^(Wand|WeMod)$/i, name: "Wand (WeMod)", kind: "launcher" },
];

// Jeux : dossiers des grands launchers.
const GAME_DIR = /\\steamapps\\common\\([^\\]+)$|\\Epic Games\\([^\\]+)$|\\Riot Games\\([^\\]+)$|\\XboxGames\\([^\\]+)$|\\GOG Games\\([^\\]+)$|\\Ubisoft Game Launcher\\games\\([^\\]+)$|\\EA Games\\([^\\]+)$|\\Rockstar Games\\([^\\]+)$/i;
const NOT_GAME = /^(Steamworks Shared|Launcher|Riot Client|DirectXRedist|Steam Controller Configs|EA Desktop|Social Club|Redistributables?|_CommonRedist|Epic Online Services|EOSOverlay|Metadata|DirectX|Install .*|Riot Vanguard|Vanguard|SteamVR)$/i;
const MIN_GAME = 300 * 1024 ** 2;   // un dossier plus petit est un reste ou un installateur

const G = require("../../gaming-net");


// Mode d'alimentation : les trois modes classiques de Windows, par leur alias.
const PLAN_ALIAS = { saver: "SCHEME_MAX", balanced: "SCHEME_BALANCED", high: "SCHEME_MIN" };
// Type de câble de l'écran (WmiMonitorConnectionParams.VideoOutputTechnology).
const CONN = { 0: "VGA", 4: "DVI", 5: "HDMI", 10: "DisplayPort", 11: "DisplayPort", 12: "USB-C", 13: "USB-C", "-2147483648": "écran intégré" };

// Caches de shaders : se recréent tout seuls (le premier lancement d'un jeu est plus long).
function shaderCaches(steamPath) {
  const L = process.env.LOCALAPPDATA || "";
  const list = [
    { id: "amd-dxc", name: "Cache de shaders AMD (DirectX 12)", path: path.join(L, "AMD", "DxcCache") },
    { id: "amd-dx", name: "Cache de shaders AMD (DirectX 11)", path: path.join(L, "AMD", "DxCache") },
    { id: "amd-vk", name: "Cache de shaders AMD (Vulkan)", path: path.join(L, "AMD", "VkCache") },
    { id: "nv-dx", name: "Cache de shaders NVIDIA", path: path.join(L, "NVIDIA", "DXCache") },
    { id: "nv-gl", name: "Cache de shaders NVIDIA (OpenGL)", path: path.join(L, "NVIDIA", "GLCache") },
    { id: "d3d", name: "Cache de shaders DirectX", path: path.join(L, "D3DSCache") },
  ];
  // Steam : un dossier « shadercache » par bibliothèque de jeux.
  const libs = new Set();
  if (steamPath) {
    libs.add(path.normalize(steamPath));
    try {
      const vdf = fs.readFileSync(path.join(steamPath, "steamapps", "libraryfolders.vdf"), "utf8");
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(path.normalize(m[1].replace(/\\\\/g, "\\")));
    } catch {}
  }
  for (const lib of libs) list.push({ id: `steam-${lib}`, name: libs.size > 1 ? `Cache de shaders Steam (${lib.slice(0, 2)})` : "Cache de shaders Steam", path: path.join(lib, "steamapps", "shadercache") });
  const out = [];
  for (const c of list) {
    const s = G.dirStat(c.path);
    if (s.size > 0) out.push({ ...c, ...s });
  }
  return out;
}

module.exports = (ctx) => {
  const setReg = (key, name, value, admin = false) => {
    const script = value == null
      ? "Remove-ItemProperty -Path $A.k -Name $A.n -ErrorAction SilentlyContinue; $true"
      : "if (-not (Test-Path $A.k)) { New-Item -Path $A.k -Force | Out-Null }; Set-ItemProperty -Path $A.k -Name $A.n -Value $A.v -Type $A.t; $true";
    const args = { k: key, n: name, v: value, t: typeof value === "string" ? "String" : "DWord" };
    return admin ? ps.runElevated(script, { args }) : ps.run(script, { args });
  };
  // Accélération de la souris : valeurs du registre + application immédiate.
  const setMouse = ({ speed, t1, t2 }) => ps.run(`
    Set-ItemProperty 'HKCU:\\Control Panel\\Mouse' MouseSpeed -Value "$($A.s)"
    Set-ItemProperty 'HKCU:\\Control Panel\\Mouse' MouseThreshold1 -Value "$($A.t1)"
    Set-ItemProperty 'HKCU:\\Control Panel\\Mouse' MouseThreshold2 -Value "$($A.t2)"
    Add-Type -Name M -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a, int b, int[] c, int d);'
    [W.M]::SystemParametersInfo(4, 0, [int[]]@([int]$A.t1, [int]$A.t2, [int]$A.s), 3) | Out-Null
    $true`, { args: { s: String(speed ?? 0), t1: String(t1 ?? 0), t2: String(t2 ?? 0) } });
  const setHz = async (device, hz) => {
    const r = await ps.run(`Add-Type -TypeDefinition $A.cs; [SondeDisplay]::SetFrequency($A.d, [int]$A.hz)`, { args: { cs: DISPLAY_CS, d: device, hz } });
    if (r !== 0) throw new Error(`Windows a refusé cette fréquence (code ${r}). Vérifie le câble (DisplayPort ou HDMI 2.0+) et le pilote.`);
  };
  const setPlan = (guid) => ps.run("& powercfg.exe /setactive $A.g; if ($LASTEXITCODE -ne 0) { throw 'powercfg a refusé ce mode.' }; $true", { args: { g: guid } });

  ctx.reverters["gaming-hz"] = ({ device, hz }) => setHz(device, hz);
  ctx.reverters["gaming-reg"] = ({ key, name, value, admin }) => setReg(key, name, value, admin);
  ctx.reverters["gaming-mouse"] = (prev) => setMouse(prev);
  ctx.reverters["gaming-plan"] = ({ guid }) => setPlan(guid);
  ctx.reverters["gaming-wu"] = () => ps.runElevated(WU_RESUME);

  let last = null;

  async function info() {
    const r = await ps.run(INFO, { args: { cs: DISPLAY_CS }, timeout: 90000 });

    // --- Écrans : fréquence actuelle, fréquences possibles, câble
    const displays = [].concat(r.displays || []).map((d, i) => ({ ...d, name: (r.monNames || [])[i] || d.monitor || d.adapter,
      conn: CONN[String((r.monConn || [])[i])] || null, max: Math.max(d.hz, ...(d.modes || [])) }));

    // --- RAM : vitesse réelle et vitesse prévue par les barrettes
    const sticks = [].concat(r.ram || []);
    let ram = null;
    if (sticks.length) {
      const conf = Math.min(...sticks.map((m) => m.configured || m.speed));
      const rated = Math.max(0, ...sticks.map((m) => G.ratedFromPart(m.part) || 0)) || null;
      const ddr = sticks[0].type === 34 ? "DDR5" : sticks[0].type === 26 ? "DDR4" : "";
      const base = ddr === "DDR5" ? 4800 : ddr === "DDR4" ? 2666 : 0;
      const cl = /F[45]-\d{4}[A-Z](\d{2})/i.exec(sticks[0].part)?.[1] || /\d{4}C(\d{2})/i.exec(sticks[0].part)?.[1] || null;
      ram = { conf, rated, ddr, cl, profile: ddr === "DDR4" ? "XMP" : "EXPO", count: sticks.length, stick: sticks[0].size,
        total: sticks.reduce((a, m) => a + m.size, 0), part: sticks[0].part || null,
        slow: rated ? conf < rated - 200 : !!(base && conf <= base) };
    }

    // --- Cartes graphiques
    const sw = [].concat(r.sw || []);
    const gpus = [].concat(r.gpus || []).filter((g) => g.name && !/Basic Display|Microsoft/i.test(g.name)).map((g) => {
      const vendor = /AMD|Radeon/i.test(g.name) ? "amd" : /NVIDIA|GeForce/i.test(g.name) ? "nvidia" : /Intel/i.test(g.name) ? "intel" : "autre";
      const soft = sw.find((s) => (vendor === "amd" && /^AMD Software/i.test(s.name)) || (vendor === "nvidia" && /^NVIDIA Graphics Driver/i.test(s.name)));
      return { name: g.name, vendor, driver: g.driver, date: g.date, age: g.date ? Math.round((Date.now() - Date.parse(g.date)) / 864e5) : null,
        software: soft?.version || null, vram: g.vram || null, width: g.width ?? null, maxWidth: g.maxWidth ?? null, gen: g.gen ?? null, maxGen: g.maxGen ?? null };
    });

    // --- Réglages Windows liés au jeu
    const accel = String(r.mouse?.speed ?? "1") !== "0";
    const guid = (alias) => new RegExp(`([0-9a-f-]{36})\\s+${alias}\\b`, "i").exec(r.aliases || "")?.[1]?.toLowerCase() || null;
    const listed = (r.plans || "").toLowerCase();
    const planIds = Object.fromEntries(Object.entries(PLAN_ALIAS).map(([k, a]) => [k, guid(a)]).filter(([, g]) => g && listed.includes(g)));
    const activeGuid = /([0-9a-f-]{36})/i.exec(r.plan || "")?.[1]?.toLowerCase() || null;
    const win = {
      gameMode: r.gameMode == null || r.gameMode === 1,
      hags: r.hags === 2,
      bgRecord: r.bgRecord === 1,
      mouseAccel: accel,
      hvci: r.hvci === 1,
      plan: { active: Object.keys(planIds).find((k) => planIds[k] === activeGuid) || null, name: /\(([^)]+)\)\s*$/.exec(r.plan || "")?.[1] || null, available: Object.keys(planIds) },
    };

    // --- Jeux et disques
    const disks = r.disks || {};
    const games = new Map();
    const addGame = (name, location, size, lastUsed) => {
      if (!name || NOT_GAME.test(name)) return;
      const k = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      const g = games.get(k);
      if (g) { g.size = Math.max(g.size, size || 0); g.lastUsed = Math.max(g.lastUsed || 0, lastUsed || 0) || null; return; }
      const letter = (location || "").slice(0, 1).toUpperCase();
      const d = disks[letter] || {};
      games.set(k, { name, location, size: size || 0, lastUsed: lastUsed || null, drive: letter ? letter + ":" : "?",
        media: d.bus === "NVMe" ? "SSD NVMe" : d.media === "SSD" ? "SSD" : d.media === "HDD" ? "Disque dur" : "?" });
    };
    const scan = ctx.getScan();
    if (scan) for (const d of scan.index.values()) {
      const m = GAME_DIR.exec(d.path);
      if (m) addGame(m.slice(1).find(Boolean), d.path, d.size, d.atime);
    }
    // Dernière ouverture des launchers, pour repérer ceux qui démarrent avec Windows sans servir.
    const launcherUse = {};
    try {
      for (const a of await ctx.listApps()) {
        if (a.location && GAME_DIR.test(a.location.replace(/\\+$/, ""))) addGame(a.name, a.location, a.size, a.lastUsed);
        else if (/Riot Games|Electronic Arts|Ubisoft|Valve|Epic Games|Rockstar|Bethesda|Blizzard|CD PROJEKT|2K|Bandai|Square Enix|Activision/i.test(a.publisher || "") && a.size > 1024 ** 3 && !/launcher|client|app$/i.test(a.name)) addGame(a.name, a.location, a.size, a.lastUsed);
        const b = BACKGROUND.find((x) => x.kind === "launcher" || x.kind === "overlay" ? x.app?.test(a.name) : false);
        if (b && a.lastUsed) launcherUse[b.name] = Math.max(launcherUse[b.name] || 0, a.lastUsed);
      }
    } catch {}
    const gameList = [...games.values()].filter((g) => g.size >= MIN_GAME).sort((a, b) => b.size - a.size);
    const diskList = Object.entries(disks).filter(([, d]) => d.size).map(([letter, d]) => ({ letter: letter + ":", model: d.model || null,
      media: d.bus === "NVMe" ? "SSD NVMe" : d.media === "SSD" ? "SSD" : d.media === "HDD" ? "Disque dur" : null, free: d.free, size: d.size,
      games: gameList.filter((g) => g.drive === letter + ":").map((g) => g.name) })).sort((a, b) => a.letter.localeCompare(b.letter));

    // --- En fond
    const procs = [].concat(r.procs || []);
    const background = [];
    for (const b of BACKGROUND) {
      const ps_ = procs.filter((p) => b.re.test(p.name));
      if (ps_.length) background.push({ name: b.name, kind: b.kind, mem: ps_.reduce((a, p) => a + p.mem, 0), count: ps_.length });
    }
    const wuPause = r.wuPause && Date.parse(r.wuPause) > Date.now() ? r.wuPause : null;

    // --- Points à regarder (résumé en haut de page)
    const issues = [];
    for (const d of displays) if (d.max > d.hz + 5) issues.push(`${d.name} à ${d.hz} Hz`);
    if (ram?.slow) issues.push("RAM sous sa vitesse prévue");
    if (!win.gameMode) issues.push("mode Jeu désactivé");
    if (win.bgRecord) issues.push("enregistrement en arrière-plan");
    if (win.mouseAccel) issues.push("accélération de la souris");
    if (win.plan.active === "saver") issues.push("mode Économie");
    for (const g of gpus) if (g.age != null && g.age > 180) issues.push(`pilote de ${Math.round(g.age / 30)} mois`);

    // Réglages du système liés au jeu, décrits pour la page (commune à Windows et Debian).
    const PLANS = [["saver", "Économie"], ["balanced", "Équilibré"], ["high", "Performances"]];
    const tweaks = [
      { id: "gamemode", kind: "toggle", title: "Mode Jeu", on: win.gameMode, keepOn: true,
        desc: "Windows donne la priorité au jeu au premier plan et repousse les installations de mises à jour et les notifications. Gain faible, sans contrepartie." },
      { id: "hags", kind: "toggle", title: "Planification GPU accélérée par le matériel", on: win.hags, keepOn: true, admin: true, done: "Fait. Redémarre le PC pour que ce soit pris en compte.",
        desc: "La carte graphique gère elle-même sa file d'images. Réduit un peu la latence, et sert à la génération d'images (AMD Fluid Motion Frames, DLSS Frame Generation). Redémarrage nécessaire." },
      { id: "bgrecord", kind: "toggle", title: "Enregistrement en arrière-plan (Game Bar)", on: win.bgRecord, keepOn: false,
        desc: "Enregistre en continu les dernières secondes de jeu. Coûte quelques pour cent de FPS et une partie de l'encodeur vidéo. L'enregistrement manuel reste possible si tu le coupes." },
      { id: "power", kind: "seg", title: "Mode d'alimentation", value: win.plan.active, ok: win.plan.active !== "saver", tag: win.plan.active === "saver" ? "Conseil : Équilibré" : "Bien réglé",
        options: PLANS.map(([k, label]) => ({ k, label, disabled: !win.plan.available.includes(k) })),
        confirm: "Même réglage que « Options d'alimentation » dans le Panneau de configuration.",
        desc: `Sur un PC fixe récent, Équilibré suffit : le processeur monte en fréquence en quelques millisecondes. Performances évite seulement de rares baisses de fréquence. Économie bride le jeu.${win.plan.active ? "" : ` Mode actuel : ${win.plan.name || "Non disponible"}.`}` },
      { id: "mouse", kind: "toggle", title: "Précision du pointeur", on: win.mouseAccel, keepOn: false,
        desc: "C'est l'accélération de la souris : la distance parcourue dépend de la vitesse du geste. La couper rend la visée constante. Beaucoup de jeux l'ignorent déjà." },
    ];
    // Ce qui tourne en ce moment : overlays, synchronisation, mises à jour.
    const overlays = background.filter((b) => b.kind === "overlay" || b.name === "Steam" || /NVIDIA/.test(b.name));
    const od = background.find((b) => b.name === "OneDrive");
    const wuAction = { id: "wupause", label: "Suspendre 1 semaine", admin: true, title: "Suspendre Windows Update pendant 1 semaine ?",
      body: "Windows ne téléchargera ni n'installera de mise à jour pendant 7 jours, comme avec « Suspendre pendant 1 semaine » dans les Paramètres. Les mises à jour reprennent toutes seules ensuite.",
      done: "Windows Update suspendu pendant 1 semaine. Annulable depuis le journal." };
    const bgNow = [
      { icon: "overlay", name: overlays.length ? `Overlays : ${overlays.map((b) => b.name).join(", ")}` : "Overlays",
        desc: overlays.length ? "Actifs dans tous les jeux. Coût faible, sauf avec certains anti-triche." : "Aucun overlay ne tourne en ce moment." },
      { icon: "cloud", name: "Synchronisation OneDrive", desc: od ? `En cours d'exécution · ${Math.round(od.mem / 1024 ** 2)} Mo de mémoire. La pause se fait depuis son icône, près de l'horloge.` : "OneDrive ne tourne pas." },
      { icon: "update", kind: "updates", name: "Windows Update",
        desc: wuPause ? `En pause jusqu'au ${new Date(wuPause).toLocaleDateString("fr-FR")}` : "Pas en pause. Téléchargement en cours : Non disponible.", short: wuPause ? `En pause jusqu'au ${new Date(wuPause).toLocaleDateString("fr-FR")}` : "Pas en pause",
        action: wuPause ? null : wuAction },
    ];
    // Protection du système vue sous l'angle du jeu.
    const security = { title: "Isolation du noyau", tag: win.hvci ? "Activée · compromis" : "Désactivée", tool: "coreisolation", button: "Ouvrir Sécurité Windows ↗",
      text: win.hvci
        ? "L'intégrité de la mémoire empêche un pilote malveillant de modifier le cœur de Windows. Elle coûte quelques pour cent dans certains jeux, et souvent rien. C'est une vraie protection : Sonde ne la coupe pas et ne te pousse pas à le faire."
        : "L'intégrité de la mémoire est désactivée : un pilote malveillant pourrait modifier le cœur de Windows. Son coût en jeu est faible (quelques pour cent au plus, souvent rien). Sonde ne la change pas : c'est à toi de choisir, dans Sécurité Windows." };

    last = { displays, mouse: r.mouse, planIds, activeGuid };
    return { canSetHz: true, ramSource: "Win32_PhysicalMemory", displays, ram, gpus, win, tweaks, bgNow, security, disks: diskList, games: gameList,
      background: background.sort((a, b) => b.mem - a.mem), launcherUse, wuPause, issues, shaders: shaderCaches(r.steamPath), servers: G.servers() };
  }


  return {
    "GET /api/gaming": async () => info(),

    // Réseau pour le jeu : câble ou Wi-Fi, débit en cours, NAT et UPnP.
    "GET /api/gaming/net": async () => ({ ...(await ps.run(NET_INFO, { timeout: 30000 }).catch(() => ({}))), ...(await G.natInfo()) }),

    "POST /api/gaming/apply": async (req) => {
      const { id, params = {}, on } = await ctx.body(req);
      if (!last) await info();
      if (id === "hz") {
        const d = last.displays.find((x) => x.device === params.device);
        if (!d || !(d.modes || []).includes(params.hz)) throw new Error("Fréquence refusée.");
        await setHz(d.device, params.hz);
        ctx.journal.add({ kind: "system", title: `${d.name} : ${d.hz} Hz → ${params.hz} Hz`, revert: { type: "gaming-hz", args: { device: d.device, hz: d.hz } } });
      } else if (id === "gamemode") {
        const k = "HKCU:\\Software\\Microsoft\\GameBar";
        await setReg(k, "AutoGameModeEnabled", on ? 1 : 0);
        ctx.journal.add({ kind: "system", title: `Mode Jeu ${on ? "activé" : "désactivé"}`, revert: { type: "gaming-reg", args: { key: k, name: "AutoGameModeEnabled", value: on ? 0 : 1 } } });
      } else if (id === "bgrecord") {
        const k = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR";
        await setReg(k, "HistoricalCaptureEnabled", on ? 1 : 0);
        ctx.journal.add({ kind: "system", title: `Enregistrement en arrière-plan de la Game Bar ${on ? "activé" : "désactivé"}`, revert: { type: "gaming-reg", args: { key: k, name: "HistoricalCaptureEnabled", value: on ? 0 : 1 } } });
      } else if (id === "hags") {
        const k = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers";
        await setReg(k, "HwSchMode", on ? 2 : 1, true);
        ctx.journal.add({ kind: "system", title: `Planification GPU accélérée ${on ? "activée" : "désactivée"}`, detail: "Effet après redémarrage.", revert: { type: "gaming-reg", args: { key: k, name: "HwSchMode", value: on ? 1 : 2, admin: true } } });
      } else if (id === "mouse") {
        // on = accélération active (« Améliorer la précision du pointeur »).
        const prev = last.mouse || { speed: "1", t1: "6", t2: "10" };
        await setMouse(on ? { speed: 1, t1: 6, t2: 10 } : { speed: 0, t1: 0, t2: 0 });
        ctx.journal.add({ kind: "system", title: `Accélération de la souris ${on ? "activée" : "désactivée"}`, revert: { type: "gaming-mouse", args: { speed: prev.speed ?? "1", t1: prev.t1 ?? "6", t2: prev.t2 ?? "10" } } });
      } else if (id === "power") {
        const g = last.planIds?.[params.plan];
        if (!g) throw new Error("Ce mode d'alimentation n'existe pas sur ce PC.");
        await setPlan(g);
        const label = { saver: "Économie", balanced: "Équilibré", high: "Performances" }[params.plan];
        ctx.journal.add({ kind: "system", title: `Mode d'alimentation : ${label}`, revert: last.activeGuid ? { type: "gaming-plan", args: { guid: last.activeGuid } } : undefined });
      } else if (id === "wupause") {
        const until = await ps.runElevated(WU_PAUSE);
        ctx.journal.add({ kind: "system", title: "Windows Update suspendu pendant 1 semaine", detail: until ? `Jusqu'au ${new Date(until).toLocaleDateString("fr-FR")}.` : undefined, revert: { type: "gaming-wu", args: {} } });
      } else throw new Error("Réglage inconnu.");
      last = null;
      return { ok: true };
    },

    // En flux : ping des serveurs de jeu, ou latence sous charge (lib/gaming-net.js).
    "POST /api/gaming/test": G.testRoute(ctx),
  };
};
