// Ouverture d'outils Windows (Paramètres, Gestionnaire de périphériques…) et
// explication d'un élément système par GPT-OSS.

const ps = require("../../ps");

// Liste fermée : la page ne peut ouvrir que ces outils-là.
const TOOLS = {
  devmgmt: "devmgmt.msc",
  services: "services.msc",
  taskmgr: "taskmgr.exe",
  windowsupdate: "ms-settings:windowsupdate",
  driverupdates: "ms-settings:windowsupdate-optionalupdates",
  defender: "windowsdefender:",
  startup: "ms-settings:startupapps",
  apps: "ms-settings:appsfeatures",
  storage: "ms-settings:storagesense",
  network: "ms-settings:network-status",
  privacy: "ms-settings:privacy-general",
  recyclebin: "shell:RecycleBinFolder",
  amd: "https://www.amd.com/fr/support/download/drivers.html",
  nvidia: "https://www.nvidia.com/fr-fr/drivers/",
  coreisolation: "windowsdefender://coreisolation",
  gaming: "ms-settings:gaming-gamemode",
  display: "ms-settings:display-advanced",
};

const PROMPTS = {
  app: "Tu expliques à quoi sert un programme installé sur Windows, s'il est utile au quotidien, et s'il peut être désinstallé sans risque. 4 phrases maximum.",
  process: "Tu expliques ce qu'est un processus Windows en cours d'exécution : quel logiciel, pourquoi il tourne, s'il est normal, et s'il peut être fermé ou retiré du démarrage. 4 phrases maximum.",
  service: "Tu expliques ce que fait un service Windows, ce qui arrive si on le désactive, et si c'est conseillé pour un PC de jeu et d'IA personnel. Si une « fiche_sonde » est fournie, elle est vérifiée : appuie-toi dessus sans la citer, et ne la contredis pas. Faits à respecter : la télémétrie (DiagTrack, dmwappushservice…) n'a aucun lien avec Windows Update ni avec les mises à jour de sécurité. N'invente pas de conséquence dont tu n'es pas sûr. 4 phrases maximum.",
  driver: "Tu expliques ce qu'est ce pilote ou ce périphérique, ce que signifie son état, et comment régler le problème s'il y en a un. 4 phrases maximum.",
  startup: "Tu expliques ce qu'est ce programme lancé au démarrage de Windows, s'il est utile qu'il démarre automatiquement, et s'il est légitime ou suspect. Une entrée orpheline (commande vide ou programme introuvable) est presque toujours un reste de désinstallation, pas une menace : dis-le simplement, et qu'on peut la désactiver. N'alarme pas sans indice concret. 4 phrases maximum.",
  network: "Tu es un expert réseau. Tu analyses ce diagnostic de connexion Internet et tu expliques simplement ce qui va bien, ce qui ne va pas, et les réglages qui aideraient vraiment. Pas de conseils placebo. 8 phrases maximum, en puces.",
  security: "Tu es un expert en sécurité Windows. Tu analyses la liste des programmes lancés automatiquement et signales ceux qui méritent vérification (non signés, emplacements inhabituels, noms trompeurs). N'alarme pas pour rien : un logiciel connu et signé est normal. 8 puces maximum.",
  services: "Tu analyses la liste des services Windows qui consomment de la mémoire ou du réseau et tu dis lesquels peuvent être désactivés sans gêne pour un PC personnel de jeu et d'IA. 8 puces maximum.",
};

module.exports = (ctx) => ({
  "POST /api/tool/open": async (req) => {
    const { tool } = await ctx.body(req);
    const target = TOOLS[tool];
    if (!target) throw new Error("Outil inconnu.");
    await ps.run("Start-Process $A.t; $true", { args: { t: target } });
    return { ok: true };
  },

  // Explication d'un élément système. L'élément est réduit à du texte court.
  "POST /api/ai/item": ctx.aiRoute(async ({ input, emit, signal }) => {
    const system = PROMPTS[input.kind];
    if (!system) throw new Error("Type inconnu.");
    const data = JSON.stringify(input.item ?? {}, null, 1).slice(0, 12000);
    return ctx.ai.ask({ system: system + " Écris en markdown simple.", user: data, emit, signal });
  }),
});
