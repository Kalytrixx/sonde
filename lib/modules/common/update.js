// Mise à jour de Sonde : vérifier, télécharger, installer. Vérification
// automatique au démarrage puis une fois par jour (désactivable).

const updater = require("../../updater");

const DAY = 864e5;

module.exports = (ctx) => {
  updater.init();
  const auto = () => ctx.settings.autoUpdate !== false;
  if (updater.state.supported) {
    // Une minute après le démarrage, pour ne pas ralentir l'ouverture.
    setTimeout(() => { if (auto()) updater.check().catch(() => {}); }, 60000).unref();
    setInterval(() => { if (auto()) updater.check().catch(() => {}); }, DAY).unref();
  }
  ctx.updateState = () => ({ version: updater.version, available: updater.state.status === "available" || updater.state.status === "ready" ? updater.state.available?.version : null });

  return {
    "GET /api/update": async () => ({ ...updater.state, auto: auto(), platform: process.platform }),
    "POST /api/update/check": async () => updater.check(),
    "POST /api/update/download": async () => updater.download(),
    "POST /api/update/install": async () => {
      ctx.journal.add({ kind: "system", title: `Mise à jour de Sonde vers la version ${updater.state.available?.version}` });
      return updater.install();
    },
    "POST /api/update/auto": async (req) => {
      const { on } = await ctx.body(req);
      ctx.settings.autoUpdate = !!on;
      ctx.saveSettings();
      return { auto: auto() };
    },
  };
};
