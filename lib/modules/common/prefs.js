// Page Paramètres : lancement à l'ouverture de session, données de Sonde
// (emplacement, taille, effacement des notes de l'IA et de l'historique).

const fs = require("fs");
const path = require("path");

function dirSize(d) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
  } catch {}
  return total;
}
const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

// Lancement avec la session : géré par Electron sous Windows (clé Run de
// l'utilisateur). Indisponible depuis les sources ou sous Linux pour l'instant.
function loginItem() {
  try {
    if (!process.versions.electron || process.platform !== "win32") return null;
    const { app } = require("electron");
    if (!app.isPackaged) return null;
    return app;
  } catch { return null; }
}

module.exports = (ctx) => ({
  "GET /api/prefs": async () => {
    const app = loginItem();
    let journal = 0;
    try { journal = ctx.journal.list().length; } catch {}
    return {
      platform: process.platform,
      version: require("../../../package.json").version,
      packaged: !!(process.versions.electron && require("electron").app?.isPackaged),
      openAtLogin: app ? app.getLoginItemSettings().openAtLogin : null,
      alertFreeGB: ctx.settings.alertFreeGB,
      autoUpdate: ctx.settings.autoUpdate !== false,
      data: { dir: ctx.DATA, size: dirSize(ctx.DATA), notes: ctx.notes.count, history: ctx.history.list().length, journal,
        analyse: fs.existsSync(path.join(ctx.DATA, "analyse.json")),
        // Poids de chaque type de données, pour la page Paramètres.
        sizes: { notes: fileSize(ctx.notes.file), history: dirSize(ctx.history.dir), analyse: fileSize(path.join(ctx.DATA, "analyse.json")) } },
    };
  },

  "POST /api/prefs": async (req) => {
    const b = await ctx.body(req);
    if (typeof b.openAtLogin === "boolean") {
      const app = loginItem();
      if (!app) throw new Error("Disponible seulement dans l'application installée sous Windows.");
      app.setLoginItemSettings({ openAtLogin: b.openAtLogin });
    }
    return { ok: true };
  },

  // Ouvre le dossier des données dans l'Explorateur (ou Fichiers).
  "POST /api/data/open": async () => {
    if (process.platform === "win32") require("child_process").spawn("explorer.exe", [ctx.DATA], { detached: true, stdio: "ignore" }).unref();
    else require("../../sh").open(ctx.DATA);
    return { ok: true };
  },

  // Efface des données de Sonde lui-même (jamais tes fichiers).
  "POST /api/data/clear": async (req) => {
    const { what } = await ctx.body(req);
    if (what === "notes") ctx.notes.clear();
    else if (what === "history") ctx.history.clear();
    else if (what === "analyse") fs.rmSync(path.join(ctx.DATA, "analyse.json"), { force: true });
    else throw new Error("Donnée inconnue.");
    return { ok: true };
  },
});
