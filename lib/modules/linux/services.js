// Services et vie privée sous Debian : services systemd (mémoire, mode de
// démarrage), fiche explicative pour ceux qui reviennent souvent, envoi de
// statistiques à Debian (popularity-contest), réglages de confidentialité GNOME.
//
// Les modes reprennent ceux de Windows pour l'interface :
//   Automatic = enabled (démarre avec le PC)   Manual = disabled (démarre à la demande)
//   Disabled  = masked (ne peut plus démarrer) System = static/indirect (on n'y touche pas)

const fs = require("fs");
const sh = require("../../sh");

const KB = {
  kerneloops: { cat: "telemetrie", reco: "Disabled", risk: "faible", what: "Envoie les rapports de plantage du noyau Linux au site kerneloops.org.", lose: "Rien d'utile au quotidien." },
  "cups-browsed": { cat: "securite", reco: "Disabled", risk: "faible", what: "Ajoute automatiquement les imprimantes annoncées sur le réseau. Une faille grave l'a touché en 2024.", lose: "L'ajout automatique des imprimantes réseau ; on peut toujours les ajouter à la main dans Paramètres > Imprimantes." },
  "avahi-daemon": { cat: "vieprivee", reco: "Manual", risk: "moyen", what: "Découverte automatique sur le réseau local (mDNS/Bonjour) : imprimantes, partages, noms en .local. Annonce aussi ton PC aux autres.", lose: "La détection automatique des imprimantes et partages du réseau local." },
  ModemManager: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Gère les modems 3G/4G/5G (clés USB, cartes intégrées).", lose: "Les connexions par modem mobile, si tu en as un." },
  ssh: { cat: "securite", reco: "Manual", risk: "moyen", what: "Serveur SSH : permet de se connecter à ce PC à distance.", lose: "L'accès à distance par SSH. Inutile si tu ne t'en sers pas, et plus sûr fermé." },
  "NetworkManager-wait-online": { cat: "performance", reco: "Manual", risk: "faible", what: "Retarde la fin du démarrage jusqu'à ce que le réseau soit connecté.", lose: "Rien sur un PC personnel ; seuls des dossiers réseau montés au démarrage en ont besoin." },
  exim4: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Serveur de courrier local : livre les messages du système (cron, alertes) au compte root.", lose: "Ces messages internes, que presque personne ne lit sur un PC de bureau." },
  "spice-vdagentd": { cat: "optionnel", reco: "Manual", risk: "faible", what: "Agent pour machines virtuelles SPICE (copier-coller, taille d'écran).", lose: "Rien sur un vrai PC ; utile seulement dans une machine virtuelle." },
  "qemu-guest-agent": { cat: "optionnel", reco: "Manual", risk: "faible", what: "Agent pour machines virtuelles QEMU/KVM.", lose: "Rien sur un vrai PC." },
  "open-vm-tools": { cat: "optionnel", reco: "Manual", risk: "faible", what: "Outils pour machines virtuelles VMware.", lose: "Rien sur un vrai PC." },
  rsync: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Serveur rsync : partage de fichiers pour d'autres machines.", lose: "Rien si tu n'as pas configuré de partage rsync." },
  saned: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Partage des scanners sur le réseau.", lose: "Le partage de ton scanner avec d'autres PC." },
  docker: { cat: "performance", reco: "Manual", risk: "moyen", what: "Moteur de conteneurs Docker : occupe de la mémoire même sans conteneur lancé.", lose: "Docker démarre alors à la première commande docker (si docker.socket reste actif)." },
  containerd: { cat: "performance", reco: "Manual", risk: "moyen", what: "Moteur d'exécution des conteneurs (utilisé par Docker).", lose: "Il démarre avec Docker quand on en a besoin." },
  cups: { cat: "optionnel", reco: "Automatic", risk: "moyen", what: "Système d'impression.", lose: "L'impression, y compris « Imprimer dans un fichier PDF »." },
  bluetooth: { cat: "optionnel", reco: "Automatic", risk: "moyen", what: "Bluetooth : casques, manettes, souris.", lose: "Tous les appareils Bluetooth." },
  "unattended-upgrades": { cat: "securite", reco: "Automatic", risk: "élevé", what: "Installe automatiquement les mises à jour de sécurité de Debian.", lose: "Les failles corrigées par Debian restent ouvertes jusqu'à ta prochaine mise à jour manuelle." },
  apparmor: { cat: "securite", reco: "Automatic", risk: "élevé", what: "Confinement de sécurité des programmes (AppArmor).", lose: "Une couche de protection importante du système." },
  smartmontools: { cat: "performance", reco: "Automatic", risk: "moyen", what: "Surveille la santé des disques (SMART) et prévient avant une panne.", lose: "Les alertes de disque qui faiblit." },
  ollama: { cat: "performance", reco: "Automatic", risk: "élevé", what: "Fait tourner les modèles d'IA locaux, dont GPT-OSS pour Sonde.", lose: "L'IA de Sonde ne répond plus." },
};

// Services qu'on ne laisse pas modifier depuis Sonde, quel que soit leur mode.
const LOCKED = /^(systemd-.*|dbus.*|polkit|gdm3?|display-manager|NetworkManager|wpa_supplicant|udisks2|upower|accounts-daemon|rtkit-daemon|getty@.*|user@.*|ollama|apt-daily.*|e2scrub.*|fstrim|cron|anacron|rsyslog|ssh-agent)$/;

const MODES = { enabled: "Automatic", "enabled-runtime": "Automatic", alias: "Automatic", disabled: "Manual",
  masked: "Disabled", "masked-runtime": "Disabled" };   // le reste : static, indirect, generated… -> System
const NAME_RE = /^[A-Za-z0-9_.:\\-]{1,120}$/;

// Réglages de confidentialité de GNOME (sans droits administrateur).
const PRIVACY = [
  { id: "problems", label: "Signaler les problèmes techniques", desc: "Envoie des rapports quand une application plante.", schema: "org.gnome.desktop.privacy", key: "report-technical-problems" },
  { id: "usage", label: "Statistiques d'utilisation des logiciels", desc: "Envoie des statistiques anonymes sur les logiciels utilisés.", schema: "org.gnome.desktop.privacy", key: "send-software-usage-stats" },
  { id: "recent", label: "Historique des fichiers récents", desc: "GNOME retient les fichiers que tu ouvres (visibles dans « Récents »).", schema: "org.gnome.desktop.privacy", key: "remember-recent-files" },
  { id: "appusage", label: "Historique d'utilisation des applications", desc: "GNOME retient les applications que tu lances pour les suggérer.", schema: "org.gnome.desktop.privacy", key: "remember-app-usage" },
  { id: "location", label: "Services de localisation", desc: "Les applications peuvent connaître la position du PC (Wi-Fi, adresse IP).", schema: "org.gnome.system.location", key: "enabled" },
  { id: "lockscreen", label: "Notifications sur l'écran de verrouillage", desc: "Le contenu des notifications est visible sans déverrouiller.", schema: "org.gnome.desktop.notifications", key: "show-in-lock-screen" },
];

const POPCON = "/etc/popularity-contest.conf";

function parseShow(txt) {
  const out = [];
  for (const block of txt.split(/\n\n+/)) {
    const o = {};
    for (const l of block.split("\n")) { const i = l.indexOf("="); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
    if (o.Id) out.push(o);
  }
  return out;
}

module.exports = (ctx) => {
  let last = null;

  // Une seule demande de mot de passe pour tous les changements.
  const setServices = (changes) => sh.runElevated(`
    while [ $# -gt 0 ]; do
      n="$1.service"; m="$2"; run="$3"; shift 3
      case "$m" in
        Automatic) systemctl unmask "$n"; systemctl enable "$n" ;;
        Manual) systemctl unmask "$n"; systemctl disable "$n" ;;
        Disabled) systemctl disable --now "$n"; systemctl mask "$n" ;;
      esac
      [ "$run" = "1" ] && systemctl start "$n" || true
    done`, changes.flatMap((c) => [c.name, c.mode, c.running ? "1" : "0"]));

  // Participation à popularity-contest (fichier de configuration, droits administrateur).
  const setPopcon = (enable) => sh.runElevated(`
    f=${POPCON}
    [ -f "$f" ] || exit 0
    if grep -q '^PARTICIPATE=' "$f"; then sed -i "s/^PARTICIPATE=.*/PARTICIPATE=\\"$1\\"/" "$f"; else echo "PARTICIPATE=\\"$1\\"" >> "$f"; fi`,
    [enable ? "yes" : "no"]);

  const setPrivacy = async (items) => {
    for (const i of items) await sh.exec("gsettings", ["set", i.schema, i.key, i.value ? "true" : "false"], { timeout: 5000 });
  };

  ctx.reverters.service = ({ changes }) => setServices(changes);
  ctx.reverters.tasks = ({ tasks }) => setPopcon(!!tasks?.[0]?.enable);
  ctx.reverters.privacy = ({ items }) => setPrivacy(items);

  return {
    "GET /api/services": async () => {
      const files = await sh.exec("systemctl", ["list-unit-files", "--type=service", "--no-legend", "--no-pager"], { timeout: 30000 });
      const names = files.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c[0] && !c[0].includes("@.") && c[0].endsWith(".service"))
        .map((c) => c[0]);
      const props = "Id,Description,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,FragmentPath,LoadState";
      const shown = [];
      for (let i = 0; i < names.length; i += 120) {
        shown.push(...parseShow(await sh.exec("systemctl", ["show", "-p", props, ...names.slice(i, i + 120)], { timeout: 60000 })));
      }
      // Services chargés sans fichier listé (générés au démarrage) : déjà actifs.
      // Un alias (udev.service -> systemd-udevd.service) renvoie le même service : une fois suffit.
      const ids = new Set();
      const services = shown.filter((s) => s.LoadState === "loaded" && s.Id.endsWith(".service") && !ids.has(s.Id) && ids.add(s.Id)).map((s) => {
        const name = s.Id.replace(/\.service$/, "");
        const mode = MODES[s.UnitFileState] || "System";
        const kb = KB[name] || null;
        const mem = /^\d+$/.test(s.MemoryCurrent || "") && s.MemoryCurrent !== "18446744073709551615" ? Number(s.MemoryCurrent) : 0;
        const fromDebian = /^\/(usr\/)?lib\/systemd\//.test(s.FragmentPath || "");
        return {
          name, display: s.Description || name, desc: s.Description || "", state: s.ActiveState === "active" ? "Running" : "Stopped",
          mode: LOCKED.test(name) ? "System" : mode, pid: Number(s.MainPID) || 0, mem, shared: 0, conn: 0,
          windows: fromDebian, kb,
          advice: kb && mode !== "System" && kb.reco !== mode && !(kb.reco === "Manual" && mode === "Disabled") && !LOCKED.test(name) ? kb.reco : null,
        };
      }).sort((a, b) => b.mem - a.mem);
      last = services;

      // popularity-contest : la « tâche planifiée » de Debian qui envoie des statistiques.
      const tasks = [];
      const pc = fs.existsSync(POPCON) ? fs.readFileSync(POPCON, "utf8") : null;
      if (pc != null) tasks.push({ path: POPCON, name: "popularity-contest", what: "Envoie chaque semaine à Debian la liste des paquets installés et leur usage (statistiques anonymes)",
        state: /^PARTICIPATE="?yes"?/m.test(pc) ? "Ready" : "Disabled" });

      const privacy = [];
      for (const p of PRIVACY) {
        const v = (await sh.tryExec("gsettings", ["get", p.schema, p.key], { timeout: 3000 })).trim();
        if (v === "true" || v === "false") privacy.push({ id: p.id, label: p.label, desc: p.desc, on: v === "true" });
      }
      return { services, tasks, privacy, telemetryPolicy: null, platform: "linux" };
    },

    // Change le mode de démarrage de services (mot de passe administrateur).
    "POST /api/services/set": async (req) => {
      const { changes } = await ctx.body(req);
      if (!last) throw new Error("Actualise d'abord la liste des services.");
      const valid = [], revert = [];
      for (const c of changes || []) {
        const s = last.find((x) => x.name === c.name);
        if (!s || !NAME_RE.test(c.name) || !["Automatic", "Manual", "Disabled"].includes(c.mode)) throw new Error(`Changement refusé : ${c.name}`);
        if (s.mode === "System" || LOCKED.test(s.name)) throw new Error(`${s.display} fait partie du système : on n'y touche pas.`);
        valid.push({ name: s.name, mode: c.mode, running: false });
        revert.push({ name: s.name, mode: s.mode, running: s.state === "Running" });
      }
      if (!valid.length) throw new Error("Aucun changement.");
      await setServices(valid);
      ctx.journal.add({ kind: "system", title: valid.length === 1
        ? `Service ${last.find((x) => x.name === valid[0].name).display} : ${valid[0].mode}` : `${valid.length} services modifiés`,
        detail: valid.map((v) => `${v.name} → ${v.mode}`).join(", "), revert: { type: "service", args: { changes: revert } } });
      return { ok: true };
    },

    "POST /api/tasks/set": async (req) => {
      const { names, enable } = await ctx.body(req);
      if (!(names || []).includes("popularity-contest")) throw new Error("Aucune tâche connue.");
      await setPopcon(!!enable);
      ctx.journal.add({ kind: "system", title: `Statistiques Debian (popularity-contest) ${enable ? "réactivées" : "désactivées"}`,
        revert: { type: "tasks", args: { tasks: [{ name: "popularity-contest", enable: !enable }] } } });
      return { ok: true };
    },

    "POST /api/privacy/set": async (req) => {
      const { ids, on } = await ctx.body(req);
      const items = PRIVACY.filter((p) => (ids || []).includes(p.id));
      if (!items.length) throw new Error("Réglage inconnu.");
      await setPrivacy(items.map((p) => ({ schema: p.schema, key: p.key, value: !!on })));
      ctx.journal.add({ kind: "system", title: `Confidentialité : ${items.map((p) => p.label).join(", ")} ${on ? "activé" : "désactivé"}`,
        revert: { type: "privacy", args: { items: items.map((p) => ({ schema: p.schema, key: p.key, value: !on })) } } });
      return { ok: true };
    },
  };
};
