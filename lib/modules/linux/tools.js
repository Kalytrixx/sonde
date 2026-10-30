// Ouverture d'outils du bureau (Paramètres de GNOME, Moniteur système,
// Logiciels…) et explication d'un élément système par GPT-OSS.

const sh = require("../../sh");

// Liste fermée : la page ne peut ouvrir que ces outils-là. Chaque outil a
// des remplaçants si le premier n'est pas installé (autre bureau que GNOME).
const TOOLS = {
  taskmgr: [["gnome-system-monitor"], ["plasma-systemmonitor"], ["xfce4-taskmanager"]],
  services: [["gnome-system-monitor"], ["plasma-systemmonitor"]],
  devmgmt: [["gnome-control-center", "system"], ["gnome-control-center", "info-overview"], ["kinfocenter"]],
  windowsupdate: [["gnome-software", "--mode=updates"], ["plasma-discover", "--mode", "update"], ["update-manager"]],
  driverupdates: [["gnome-software", "--mode=updates"], ["plasma-discover", "--mode", "update"]],
  defender: [["gnome-control-center", "privacy"], ["gnome-control-center", "system"]],
  firewall: [["gufw"], ["firewall-config"]],
  startup: [["gnome-tweaks"], ["gnome-session-properties"]],
  apps: [["gnome-control-center", "applications"], ["gnome-software", "--mode=installed"], ["plasma-discover"]],
  storage: [["baobab"], ["filelight"]],
  timeshift: [["timeshift-launcher"], ["pkexec", "timeshift-gtk"]],
  display: [["gnome-control-center", "display"], ["kcmshell6", "kcm_kscreen"], ["xfce4-display-settings"]],
  network: [["gnome-control-center", "network"], ["gnome-control-center", "wifi"], ["nm-connection-editor"]],
  privacy: [["gnome-control-center", "privacy"]],
  recyclebin: [["gio", "open", "trash:///"], ["xdg-open", "trash:///"]],
  amd: [["xdg-open", "https://www.amd.com/fr/support/download/drivers.html"]],
  nvidia: [["xdg-open", "https://wiki.debian.org/fr/NvidiaGraphicsDrivers"]],
};

const PROMPTS = {
  app: "Tu expliques à quoi sert un programme installé sur Debian (paquet apt ou application Flatpak), s'il est utile au quotidien, et s'il peut être désinstallé sans risque. Attention : retirer un paquet du bureau GNOME ou du système peut emporter d'autres paquets ; dis-le si c'est le cas. 4 phrases maximum.",
  process: "Tu expliques ce qu'est un processus Linux en cours d'exécution sous Debian : quel logiciel, pourquoi il tourne, s'il est normal, et s'il peut être fermé ou retiré du démarrage. 4 phrases maximum.",
  service: "Tu expliques ce que fait un service systemd sous Debian, ce qui arrive si on le désactive, et si c'est conseillé pour un PC personnel de bureau (jeu, IA). Si une « fiche_sonde » est fournie, elle est vérifiée : appuie-toi dessus sans la citer, et ne la contredis pas. N'invente pas de conséquence dont tu n'es pas sûr. 4 phrases maximum.",
  driver: "Tu expliques ce qu'est ce périphérique et son pilote sous Debian (module du noyau, firmware, Mesa…), ce que signifie son état, et comment régler le problème s'il y en a un (paquet firmware-*, dépôt non-free-firmware, mise à jour). 4 phrases maximum.",
  startup: "Tu expliques ce qu'est ce programme lancé automatiquement à l'ouverture de la session (GNOME) ou au démarrage du système (systemd, cron), s'il est utile qu'il démarre tout seul, et s'il est légitime ou suspect. Un élément qui ne vient d'aucun paquet Debian n'est pas forcément dangereux (Flatpak, programme installé à la main) : n'alarme pas sans indice concret. 4 phrases maximum.",
  network: "Tu es un expert réseau Linux. Tu analyses ce diagnostic de connexion Internet sous Debian (NetworkManager) et tu expliques simplement ce qui va bien, ce qui ne va pas, et les réglages qui aideraient vraiment. Pas de conseils placebo. 8 phrases maximum, en puces.",
  security: "Tu es un expert en sécurité Linux. Tu analyses la liste de ce qui se lance automatiquement sur ce Debian (autostart GNOME, services systemd, tâches cron) et signales ce qui mérite vérification (hors paquet Debian, emplacement inhabituel comme /tmp, script qui télécharge du code). N'alarme pas pour rien : un paquet Debian ou une application connue est normal. 8 puces maximum.",
  updates: "Tu expliques simplement ce qu'apportent ces mises à jour Debian en attente : regroupe-les (noyau, navigateur, bureau GNOME, bibliothèques…), signale celles de sécurité et s'il faudra redémarrer. N'invente pas le contenu précis d'un correctif que tu ne connais pas. 6 puces maximum.",
  boot: "Tu analyses le temps de démarrage d'un PC sous Debian (systemd-analyze). Dis si c'est normal, ce qui ralentit vraiment (micrologiciel, noyau, ou un service précis), et ce qu'on peut faire sans risque. Les services démarrent en parallèle : un service lent ne retarde pas forcément le bureau. 6 puces maximum.",
  services: "Tu analyses la liste des services systemd de ce Debian qui consomment de la mémoire et tu dis lesquels peuvent être désactivés sans gêne pour un PC personnel de bureau (jeu, IA). Ne propose jamais de toucher à systemd-*, dbus, NetworkManager, gdm, polkit, udisks2 ou aux services de sécurité. 8 puces maximum.",
};

module.exports = (ctx) => ({
  "POST /api/tool/open": async (req) => {
    const { tool } = await ctx.body(req);
    const choices = TOOLS[tool];
    if (!choices) throw new Error("Outil inconnu.");
    const c = choices.find(([cmd]) => sh.which(cmd));
    if (!c) throw new Error(`Aucun outil disponible : installe ${choices[0][0]}.`);
    sh.launch(c[0], c.slice(1));
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
