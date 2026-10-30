// Points de restauration (Windows) : état de la protection du système, création
// d'un point avant les changements faits par Sonde (dans la même fenêtre UAC,
// au plus un toutes les 12 heures), création à la demande.

const ps = require("../../ps");

const KEY = "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore";
const EVERY = 12 * 3600 * 1000;

// Crée un point « Sonde : … ». Windows en refuse un par 24 h par défaut : la
// limite est levée le temps de la création, puis remise comme avant.
// Un échec ne bloque jamais l'action qui suit.
const POINT = (why) => `
try {
  $__k = '${KEY}'
  $__f = (Get-ItemProperty $__k -Name SystemRestorePointCreationFrequency -ErrorAction SilentlyContinue).SystemRestorePointCreationFrequency
  Set-ItemProperty $__k -Name SystemRestorePointCreationFrequency -Value 0 -Type DWord
  Checkpoint-Computer -Description ${JSON.stringify(`Sonde : ${why}`).replace(/"/g, "'")} -RestorePointType MODIFY_SETTINGS -ErrorAction Stop
  if ($null -eq $__f) { Remove-ItemProperty $__k -Name SystemRestorePointCreationFrequency -ErrorAction SilentlyContinue } else { Set-ItemProperty $__k -Name SystemRestorePointCreationFrequency -Value $__f -Type DWord }
} catch {}`;

module.exports = (ctx) => {
  // La protection du système est-elle active sur le disque de Windows ?
  const status = async () => {
    const r = await ps.run(`
      $v = (Get-ItemProperty '${KEY}' -ErrorAction SilentlyContinue)
      @{ interval = $v.RPSessionInterval; disabled = $v.DisableSR }`).catch(() => ({}));
    return { protection: r.interval === 1 && r.disabled !== 1, auto: ctx.settings.restoreBefore !== false, last: ctx.settings.lastRestorePoint || null };
  };
  let protectionOn = null;
  status().then((s) => { protectionOn = s.protection; });

  // Avant chaque action administrateur : un point de restauration si le réglage
  // est actif, la protection aussi, et le dernier point date de plus de 12 h.
  ps.hooks.beforeElevated = () => {
    if (ctx.settings.restoreBefore === false || !protectionOn) return "";
    if (Date.now() - (ctx.settings.lastRestorePoint || 0) < EVERY) return "";
    return POINT("avant un changement du système");
  };
  ps.hooks.afterElevated = () => { ctx.settings.lastRestorePoint = Date.now(); ctx.saveSettings(); };

  ctx.reverters["restore-off"] = () => ps.runElevated("Disable-ComputerRestore -Drive \"$env:SystemDrive\\\"; $true", { noHook: true });

  return {
    "GET /api/restore": async () => { const s = await status(); protectionOn = s.protection; return s; },

    "POST /api/restore": async (req) => {
      const { action, on } = await ctx.body(req);
      if (action === "auto") {
        ctx.settings.restoreBefore = !!on;
        ctx.saveSettings();
      } else if (action === "enable") {
        // Active la protection du disque de Windows (comme « Configurer… » dans Protection du système).
        await ps.runElevated("Enable-ComputerRestore -Drive \"$env:SystemDrive\\\"; $true", { noHook: true });
        protectionOn = true;
        ctx.journal.add({ kind: "system", title: "Protection du système activée sur le disque de Windows", revert: { type: "restore-off", args: {} } });
      } else if (action === "create") {
        await ps.runElevated(POINT("point créé à la main").replace("} catch {}", "} catch { throw \"Windows a refusé de créer le point : $_\" }") + "\n$true", { noHook: true });
        ctx.settings.lastRestorePoint = Date.now();
        ctx.saveSettings();
        ctx.journal.add({ kind: "system", title: "Point de restauration créé", detail: "Pour revenir en arrière : Paramètres › Points de restauration › Ouvrir la restauration du système." });
      } else throw new Error("Action inconnue.");
      return status();
    },
  };
};
