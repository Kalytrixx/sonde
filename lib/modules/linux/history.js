// Suivi dans le temps : évolution de l'espace, ce qui a grossi, scan
// hebdomadaire planifié (minuterie systemd de l'utilisateur) et alerte
// (notification du bureau) quand l'espace libre devient trop bas.

const fs = require("fs");
const path = require("path");
const sh = require("../../sh");
const P = require("../../platform");

const UNIT = "sonde-scan";
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(P.HOME, ".config"), "systemd", "user");
const DAYS = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat", Sunday: "Sun" };

const notify = (title, text) => sh.notify(title, text);

// Valeur systemd entre guillemets (ExecStart, Environment) : on échappe « \ » et « " ».
const q = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

// Microsecondes depuis 1970, ou « n/a ».
const usec = (v) => (/^\d+$/.test(v || "") && v !== "0" ? new Date(Number(v) / 1000).toISOString() : null);

module.exports = (ctx) => ({
  "GET /api/history": async () => ({ snapshots: ctx.history.list(), alertFreeGB: ctx.settings.alertFreeGB }),

  "GET /api/history/diff": async (req, res, url) => {
    const list = ctx.history.list();
    const to = url.searchParams.get("to") || list[0]?.id;
    const from = url.searchParams.get("from") || list[1]?.id;
    if (!from || !to) return { none: true, reason: "Il faut au moins deux scans pour comparer." };
    return ctx.history.diff(from, to) || { none: true, reason: "Instantané introuvable." };
  },

  "GET /api/schedule": async () => {
    if (!fs.existsSync(path.join(UNIT_DIR, UNIT + ".timer"))) return { enabled: false };
    const state = (await sh.tryExec("systemctl", ["--user", "is-active", UNIT + ".timer"])).trim();
    // Les dates en microsecondes : list-timers en JSON (systemd 250 et plus).
    let t = null;
    try { t = JSON.parse(await sh.exec("systemctl", ["--user", "list-timers", "--all", "--output=json"])).find((x) => x.unit === UNIT + ".timer"); } catch {}
    return { enabled: state === "active", state, next: usec(String(t?.next ?? "")), last: usec(String(t?.last ?? "")) };
  },

  // Crée ou supprime la minuterie, au nom de l'utilisateur (sans droits
  // administrateur). Application installée : l'exécutable d'Electron en mode
  // Node (aucune fenêtre, aucun écran nécessaire) ; depuis les sources : node.
  "POST /api/schedule": async (req) => {
    const { enable, day = "Sunday", hour = 12 } = await ctx.body(req);
    if (!DAYS[day] || !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) throw new Error("Jour ou heure invalide.");
    const svc = path.join(UNIT_DIR, UNIT + ".service"), tmr = path.join(UNIT_DIR, UNIT + ".timer");
    if (!enable) {
      await sh.tryExec("systemctl", ["--user", "disable", "--now", UNIT + ".timer"]);
      fs.rmSync(svc, { force: true });
      fs.rmSync(tmr, { force: true });
      await sh.tryExec("systemctl", ["--user", "daemon-reload"]);
      return { ok: true };
    }
    // Les disques du dernier scan : la minuterie scanne les mêmes.
    const roots = (ctx.getScan()?.roots || ["/"]).filter((r) => P.isDriveRoot(r));
    const electron = !!process.versions.electron;
    const server = path.join(ctx.ROOT, "server.js");
    const exec = [electron ? process.execPath : process.execPath, server, "--scan", ...(roots.length ? roots : ["/"])].map(q).join(" ");
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(svc, `[Unit]
Description=Sonde : scan du disque et alerte d'espace libre

[Service]
Type=oneshot
${electron ? "Environment=ELECTRON_RUN_AS_NODE=1\n" : ""}Environment=SONDE_DATA=${q(ctx.DATA)}
ExecStart=${exec}
Nice=10
IOSchedulingClass=idle
`);
    fs.writeFileSync(tmr, `[Unit]
Description=Sonde : scan hebdomadaire

[Timer]
OnCalendar=${DAYS[day]} *-*-* ${String(hour).padStart(2, "0")}:00:00
Persistent=true

[Install]
WantedBy=timers.target
`);
    await sh.exec("systemctl", ["--user", "daemon-reload"]);
    await sh.exec("systemctl", ["--user", "enable", "--now", UNIT + ".timer"]);
    return { ok: true };
  },

  "POST /api/notify/test": async () => {
    await notify("Sonde", "Les notifications fonctionnent.");
    return { ok: true };
  },
});

module.exports.notify = notify;
