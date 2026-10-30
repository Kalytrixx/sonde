// Temps de démarrage sous Debian (systemd-analyze) : durée de chaque étape
// et services les plus lents, avec ce qu'on peut y faire.

const sh = require("../../sh");

// Services souvent en tête de « systemd-analyze blame ». `action` : mode
// conseillé (même vocabulaire que la page Services) ; absent = rien à faire.
const KB = {
  "NetworkManager-wait-online": { action: "Manual", why: "Fait attendre la fin du démarrage jusqu'à ce que le réseau soit connecté. Inutile sur un PC personnel, sauf dossiers réseau montés au démarrage." },
  "systemd-networkd-wait-online": { action: "Manual", why: "Même rôle : attendre le réseau. Inutile sur un PC personnel." },
  docker: { action: "Manual", why: "Docker démarre avec le PC. En le passant « à la demande », il démarre à la première commande docker." },
  containerd: { action: "Manual", why: "Moteur des conteneurs, utile seulement avec Docker." },
  ModemManager: { action: "Manual", why: "Gère les modems 3G/4G : inutile sans modem mobile." },
  "cups-browsed": { action: "Disabled", why: "Cherche des imprimantes sur le réseau au démarrage." },
  snapd: { action: "Manual", why: "Service de Snap : inutile si tu n'utilises aucune application Snap." },
  "plymouth-quit-wait": { why: "Mesure la durée de l'écran de démarrage : ce temps n'est pas vraiment perdu, il se superpose au reste." },
  "apt-daily": { why: "Vérifie les mises à jour. Tourne en parallèle, sans retarder l'ouverture de la session." },
  "apt-daily-upgrade": { why: "Installe les mises à jour de sécurité automatiques, en parallèle." },
  "man-db": { why: "Reconstruit l'index des pages de manuel après une mise à jour. Ponctuel." },
  "e2scrub_reap": { why: "Nettoyage de vérifications du système de fichiers. Normal et rapide d'habitude." },
  "systemd-udev-settle": { why: "Ancien mécanisme qui bloque le démarrage jusqu'à la détection de tous les périphériques. Souvent tiré par un vieux paquet (ZFS, mdadm, LVM)." },
  "dev-sda1.device": { why: "Attente d'un disque : normal." },
  fwupd: { why: "Recherche de firmwares. Démarre à la demande d'habitude." },
  "plymouth-start": { why: "Écran de démarrage graphique." },
};

// « 1min 2.345s », « 812ms », « 3.2s » -> millisecondes
function ms(t) {
  let total = 0;
  for (const m of String(t).matchAll(/([\d.]+)\s*(min|ms|s|h)\b/g)) total += Number(m[1]) * { h: 3600000, min: 60000, s: 1000, ms: 1 }[m[2]];
  return Math.round(total);
}

module.exports = (ctx) => ({
  "GET /api/boot": async () => {
    const sum = await sh.tryExec("systemd-analyze", ["--no-pager"], { timeout: 30000 });
    const phases = {};
    for (const m of sum.matchAll(/([\dhmins. ]+?)\s*\((firmware|loader|kernel|initrd|userspace)\)/g)) phases[m[2]] = ms(m[1]);
    // Sans micrologiciel mesuré (machine virtuelle, BIOS hérité), pas de « = total ».
    const total = ms(/=\s*([^\n]+?)\s*$/m.exec(sum)?.[1] || "") || Object.values(phases).reduce((a, b) => a + b, 0);
    const graphical = ms(/reached after ([^\n]+?) in userspace/.exec(sum)?.[1] || "");
    const blame = (await sh.tryExec("systemd-analyze", ["blame", "--no-pager"], { timeout: 30000 })).split("\n")
      .map((l) => /^\s*(.+?)\s+(\S+\.(service|device|mount|timer|socket))\s*$/.exec(l)).filter(Boolean)
      .map((m) => {
        const unit = m[2], name = unit.replace(/\.service$/, "");
        const kb = KB[name] || KB[unit] || null;
        return { unit, name, ms: ms(m[1]), why: kb?.why || null, action: kb?.action || null };
      })
      .sort((a, b) => b.ms - a.ms).slice(0, 15);
    return { platform: "linux", phases, total, graphical, blame, available: !!sum };
  },
});
