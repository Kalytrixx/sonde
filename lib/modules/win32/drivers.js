// Pilotes : périphériques en erreur, pilotes importants et leur âge, mises
// à jour de pilotes proposées par Windows Update.

const ps = require("../../ps");

// Codes d'erreur du Gestionnaire de périphériques, expliqués simplement.
const CODES = {
  1: "mal configuré", 10: "ne peut pas démarrer", 12: "pas assez de ressources libres",
  14: "redémarrage nécessaire", 18: "pilote à réinstaller", 19: "configuration du registre abîmée",
  21: "en cours de suppression", 22: "désactivé", 24: "absent ou mal installé",
  28: "aucun pilote installé", 31: "pilote qui ne fonctionne pas", 32: "service du pilote désactivé",
  37: "le pilote a échoué", 39: "pilote corrompu ou manquant", 43: "arrêté après un problème signalé",
  45: "débranché", 52: "signature du pilote invalide",
};

// Classes de périphériques qui comptent pour les performances.
const KEY_CLASSES = { DISPLAY: "Carte graphique", NET: "Réseau", MEDIA: "Son", BLUETOOTH: "Bluetooth",
  HDC: "Contrôleur de stockage", SCSIADAPTER: "Contrôleur de stockage", USB: "USB", SYSTEM: "Système" };

// Codes d'écran bleu les plus fréquents, expliqués simplement.
const BUGCHECK = {
  0x0a: ["IRQL_NOT_LESS_OR_EQUAL", "un pilote a accédé à la mémoire au mauvais moment"],
  0x1a: ["MEMORY_MANAGEMENT", "erreur de gestion de la mémoire : RAM instable (profil EXPO/XMP, overclocking) ou pilote"],
  0x1e: ["KMODE_EXCEPTION_NOT_HANDLED", "un pilote a provoqué une erreur qu'il n'a pas gérée"],
  0x19: ["BAD_POOL_HEADER", "mémoire du noyau abîmée, souvent par un pilote"],
  0x24: ["NTFS_FILE_SYSTEM", "problème du système de fichiers ou du disque"],
  0x3b: ["SYSTEM_SERVICE_EXCEPTION", "un pilote ou un service système a planté"],
  0x50: ["PAGE_FAULT_IN_NONPAGED_AREA", "accès à une mémoire qui n'existe pas : pilote, antivirus ou RAM"],
  0x7a: ["KERNEL_DATA_INPAGE_ERROR", "lecture impossible depuis le disque : disque ou câble à vérifier"],
  0x7b: ["INACCESSIBLE_BOOT_DEVICE", "Windows ne trouve plus son disque au démarrage"],
  0x7e: ["SYSTEM_THREAD_EXCEPTION_NOT_HANDLED", "un pilote a planté"],
  0x7f: ["UNEXPECTED_KERNEL_MODE_TRAP", "erreur matérielle ou de pilote, parfois une surchauffe"],
  0x9f: ["DRIVER_POWER_STATE_FAILURE", "un pilote n'a pas su passer en veille ou en sortir"],
  0xbe: ["ATTEMPTED_WRITE_TO_READONLY_MEMORY", "un pilote a écrit là où il n'avait pas le droit"],
  0xd1: ["DRIVER_IRQL_NOT_LESS_OR_EQUAL", "un pilote (souvent réseau, Wi-Fi ou carte graphique) a accédé à la mémoire au mauvais moment"],
  0xef: ["CRITICAL_PROCESS_DIED", "un processus indispensable de Windows s'est arrêté"],
  0x101: ["CLOCK_WATCHDOG_TIMEOUT", "un cœur du processeur a cessé de répondre : souvent un overclocking, une tension trop basse ou un BIOS à mettre à jour"],
  0x116: ["VIDEO_TDR_FAILURE", "la carte graphique a cessé de répondre : pilote graphique, surchauffe ou overclocking de la carte"],
  0x124: ["WHEA_UNCORRECTABLE_ERROR", "erreur matérielle signalée par le processeur : overclocking, tension, température ou matériel défaillant"],
  0x133: ["DPC_WATCHDOG_VIOLATION", "un pilote a bloqué le système trop longtemps (souvent stockage ou carte graphique)"],
  0x139: ["KERNEL_SECURITY_CHECK_FAILURE", "Windows a détecté une corruption, souvent par un pilote ou la RAM"],
};

// Écrans bleus (1001) et arrêts brutaux (Kernel-Power 41) des 6 derniers mois,
// et pilotes installés sur la même période : de quoi comprendre une cause probable.
const CRASHES = `
$since = (Get-Date).AddDays(-180)
$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 1001; StartTime = $since } -ErrorAction SilentlyContinue | Where-Object {
  $_.Id -eq 41 -or $_.ProviderName -eq 'Microsoft-Windows-WER-SystemErrorReporting' } | ForEach-Object {
  $code = $null
  if ($_.Id -eq 41) { $code = [int64]$_.Properties[0].Value }
  elseif ($_.Message -match '0x([0-9a-fA-F]{8})') { $code = [Convert]::ToInt64($Matches[1], 16) }
  @{ at = $_.TimeCreated.ToString('o'); id = $_.Id; code = $code } })
$drv = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-UserPnp'; Id = 20001; StartTime = $since } -ErrorAction SilentlyContinue |
  Select-Object -First 30 | ForEach-Object { @{ at = $_.TimeCreated.ToString('o'); text = ($_.Message -split [char]10)[0].Trim() } })
@{ events = $ev; drivers = $drv }`;

// Santé des disques : état donné par Windows (sans droits), détails SMART
// (température, usure, heures) avec les droits administrateur.
const DISKS = `
@(Get-PhysicalDisk -ErrorAction SilentlyContinue | ForEach-Object {
  @{ id = "$($_.DeviceId)"; model = "$($_.FriendlyName)"; media = "$($_.MediaType)"; bus = "$($_.BusType)"; size = [int64]$_.Size; health = "$($_.HealthStatus)" } })`;
const DISK_DETAILS = `
@(Get-PhysicalDisk | ForEach-Object {
  $r = $_ | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue
  @{ id = "$($_.DeviceId)"; temp = $r.Temperature; wear = $r.Wear; hours = $r.PowerOnHours; errors = [int64]$r.ReadErrorsUncorrected + [int64]$r.WriteErrorsUncorrected } })`;
// Batterie (portables) : capacité actuelle par rapport à neuve, cycles.
const BATTERY = `
$full = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryFullChargedCapacity -ErrorAction SilentlyContinue)
if (-not $full.Count) { return $null }
$design = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue)
$cycles = @(Get-CimInstance -Namespace root\\wmi -ClassName BatteryCycleCount -ErrorAction SilentlyContinue)
$b = @(Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue)
@(for ($i = 0; $i -lt $full.Count; $i++) {
  @{ name = "$($design[$i].DeviceName)".Trim(); full = [int64]$full[$i].FullChargedCapacity; design = [int64]$design[$i].DesignedCapacity
     cycles = $cycles[$i].CycleCount; level = $b[$i].EstimatedChargeRemaining } })`;

const diskOut = (list, details) => list.map((d) => {
  const x = details?.find((y) => y.id === d.id) || {};
  const kind = d.bus === "NVMe" ? "SSD NVMe" : d.media === "SSD" ? "SSD" : d.media === "HDD" ? "Disque dur" : d.bus;
  const notes = [];
  if (x.errors) notes.push(`${x.errors} erreur(s) de lecture ou d'écriture non corrigées`);
  if (x.wear >= 90) notes.push("usure presque atteinte");
  const state = d.health === "Unhealthy" ? "bad" : d.health === "Warning" || x.errors || x.wear >= 90 ? "warn" : d.health === "Healthy" ? "good" : "unknown";
  return { model: d.model, kind, size: d.size, state, temp: x.temp || null, hours: x.hours || null, wear: x.wear ?? null, notes };
});

module.exports = (ctx) => {
  let updates = null;   // cache de la recherche Windows Update (lente)
  let diskDetails = null;   // détails SMART lus avec les droits administrateur

  return {
    "GET /api/drivers": async () => {
      const r = await ps.run(`
        $err = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.Present -and $_.Status -ne 'OK' -and $_.Status -ne 'Unknown' } |
          ForEach-Object { @{ name = $_.FriendlyName; cls = "$($_.Class)"; status = "$($_.Status)"; code = [int]$_.ConfigManagerErrorCode; id = $_.InstanceId } }
        $drv = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceName -and $_.DeviceClass -in @(${Object.keys(KEY_CLASSES).map((c) => `'${c}'`).join(",")}) } |
          ForEach-Object { @{ name = $_.DeviceName; cls = $_.DeviceClass; version = $_.DriverVersion; maker = $_.Manufacturer
            date = if ($_.DriverDate) { $_.DriverDate.ToString('yyyy-MM-dd') } else { $null }; inf = $_.InfName } }
        @{ errors = @($err); drivers = @($drv) }`, { timeout: 60000 });
      // Les pilotes intégrés à Windows portent tous la date factice du 21/06/2006 :
      // leur âge ne veut rien dire, on ne les signale pas.
      const seen = new Set();
      const drivers = (r.drivers || []).filter((d) => {
        const k = d.name + d.version;
        if (seen.has(k)) return false;
        seen.add(k);
        return !/^Microsoft/i.test(d.maker || "") && d.date !== "2006-06-21" && !/WAN Miniport|Virtual|Hyper-V|Kernel Debug/i.test(d.name);
      }).map((d) => {
        const age = d.date ? (Date.now() - Date.parse(d.date)) / (365 * 864e5) : null;
        return { ...d, family: KEY_CLASSES[d.cls] || d.cls, ageYears: age, old: age != null && age > 2 };
      }).sort((a, b) => (b.ageYears || 0) - (a.ageYears || 0));
      const errors = (r.errors || []).map((e) => ({ ...e, meaning: CODES[e.code] || `code ${e.code}` }));
      // Écrans bleus, santé des disques, batterie.
      const [cr, dk, bt] = await Promise.all([ps.run(CRASHES, { timeout: 60000 }).catch(() => null), ps.run(DISKS).catch(() => []), ps.run(BATTERY).catch(() => null)]);
      const crashes = cr ? [].concat(cr.events || []).map((e) => {
        const k = BUGCHECK[e.code];
        return { at: e.at, kind: e.id === 1001 || e.code ? "bugcheck" : "power", code: e.code ? "0x" + e.code.toString(16).toUpperCase().padStart(8, "0") : null,
          name: k?.[0] || null, meaning: k?.[1] || (e.code ? "code peu courant" : null) };
      }) : null;
      // Un écran bleu donne deux événements (41 puis 1001) : on n'en garde qu'un.
      const crashList = crashes && crashes.filter((c, i) => !(c.kind === "bugcheck" && crashes.some((o, j) => j !== i && o.code === c.code && Math.abs(Date.parse(o.at) - Date.parse(c.at)) < 120000 && j < i)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const battery = bt ? [].concat(bt).map((b) => ({ name: b.name || "Batterie", health: b.full && b.design ? Math.round((b.full / b.design) * 100) : null, cycles: b.cycles || null, level: b.level ?? null })) : null;
      return { errors, drivers, updates, crashes: crashList, recentDrivers: cr ? [].concat(cr.drivers || []) : [],
        disks: diskOut([].concat(dk || []), diskDetails), disksAdmin: !diskDetails, battery, power: null };
    },

    // Détails SMART des disques (température, usure) : droits administrateur.
    "POST /api/drivers/diskdetails": async () => {
      diskDetails = [].concat(await ps.runElevated(DISK_DETAILS, { noHook: true }) || []);
      return { disks: diskOut([].concat(await ps.run(DISKS) || []), diskDetails) };
    },

    // Recherche des mises à jour de pilotes proposées par Windows Update.
    "POST /api/drivers/updates": async (req) => {
      const { force } = await ctx.body(req);
      if (updates && !force && Date.now() - updates.at < 3600000) return updates;
      const r = await ps.run(`
        $s = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher()
        $res = $s.Search("IsInstalled=0 and Type='Driver'")
        @(foreach ($u in $res.Updates) { @{ title = $u.Title; size = [int64]$u.MaxDownloadSize
          date = if ($u.LastDeploymentChangeTime) { $u.LastDeploymentChangeTime.ToString('yyyy-MM-dd') } else { $null }
          model = $u.DriverModel; maker = $u.DriverManufacturer } })`, { timeout: 180000 });
      updates = { at: Date.now(), items: [].concat(r || []) };
      return updates;
    },
  };
};
