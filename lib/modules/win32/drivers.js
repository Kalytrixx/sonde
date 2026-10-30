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

module.exports = (ctx) => {
  let updates = null;   // cache de la recherche Windows Update (lente)

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
      return { errors, drivers, updates };
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
