// Logiciels actifs sous Linux : processus regroupés par programme (mémoire,
// processeur, connexions réseau) lus dans /proc, et programmes lancés à
// l'ouverture de la session (autostart du bureau, norme freedesktop).

const fs = require("fs");
const os = require("os");
const path = require("path");
const sh = require("../../sh");
const P = require("../../platform");

const UID = process.getuid();
const HZ = 100;   // tics d'horloge par seconde (USER_HZ, toujours 100 sous Linux x86/ARM)
const PAGE = 4096;

// Processus de la session de bureau (équivalent des « applis Microsoft »).
const DESKTOP = /^(gnome-|gsd-|gvfs|evolution-|tracker|localsearch|xdg-|at-spi|ibus|pipewire|wireplumber|pulseaudio|Xwayland|Xorg|mutter|nautilus|gjs|goa-|dconf|dbus|kwin|plasmashell|kded|ksmserver|baloo|xfce|xfwm|mate-|cinnamon)/;
// Jamais fermés depuis Sonde, même s'ils appartiennent à l'utilisateur.
const CRITICAL = new Set(["systemd", "dbus-daemon", "dbus-broker", "gnome-shell", "gnome-session-binary", "gnome-session-c", "gdm-wayland-session",
  "Xwayland", "Xorg", "pipewire", "wireplumber", "pipewire-pulse", "gsd-xsettings", "at-spi-bus-launcher", "ollama", "node", "sonde", "electron", "claude"]);

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

// Un instantané de tous les processus visibles.
function snapshot() {
  const out = new Map();
  for (const n of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(n)) continue;
    const stat = read(`/proc/${n}/stat`);
    if (!stat) continue;
    // Le nom (entre parenthèses) peut contenir des espaces : on coupe après la dernière « ) ».
    const close = stat.lastIndexOf(")");
    const comm = stat.slice(stat.indexOf("(") + 1, close);
    const f = stat.slice(close + 2).split(" ");
    const ppid = Number(f[1]);
    const ticks = Number(f[11]) + Number(f[12]);
    const rss = Number(f[21]) * PAGE;
    out.set(Number(n), { pid: Number(n), comm, ppid, ticks, rss, kthread: ppid === 2 || Number(n) === 2 });
  }
  return out;
}

// Nombre de connexions TCP établies par processus : sockets de /proc/net/tcp*
// (état 01) reliés aux processus par /proc/<pid>/fd. Seuls les processus de
// l'utilisateur sont lisibles : les autres restent à 0.
function connections(pids) {
  const est = new Set();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const txt = read(f) || "";
    for (const l of txt.split("\n").slice(1)) {
      const c = l.trim().split(/\s+/);
      if (c[3] !== "01") continue;
      const remote = c[2] || "";
      // 127.0.0.1 et ::1 : connexions locales, pas Internet.
      if (/^0100007F:|^00000000000000000000000001000000:/.test(remote)) continue;
      est.add(c[9]);
    }
  }
  const count = new Map();
  if (!est.size) return count;
  for (const pid of pids) {
    let fds;
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    let n = 0;
    for (const fd of fds) {
      let l;
      try { l = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(l);
      if (m && est.has(m[1])) n++;
    }
    if (n) count.set(pid, n);
  }
  return count;
}

// Service systemd d'un processus, d'après son groupe de contrôle.
function unitOf(pid) {
  const cg = read(`/proc/${pid}/cgroup`) || "";
  const m = /\/system\.slice\/(?:[^/]*\.slice\/)*([^/\n]+\.service)/.exec(cg);
  return m ? m[1].replace(/\.service$/, "") : null;
}

function info(pid) {
  let exe = null, uid = null, cmd = "";
  try { exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ""); } catch {}
  const st = read(`/proc/${pid}/status`) || "";
  const u = /^Uid:\s+(\d+)/m.exec(st);
  if (u) uid = Number(u[1]);
  cmd = (read(`/proc/${pid}/cmdline`) || "").split("\0").filter(Boolean).join(" ").slice(0, 300);
  return { exe, uid, cmd };
}

function classify(p) {
  if (p.kthread || p.uid !== UID) return "windows";   // noyau, root, comptes système
  if (DESKTOP.test(p.name) || /^\/usr\/(lib|libexec)\/(gnome|gvfs|evolution|tracker|at-spi|xdg)/.test(p.exe || "")) return "microsoft";
  return "tiers";
}

// Nom lisible d'un programme : le lanceur .desktop qui le démarre, sinon son nom.
function prettyNames() {
  const map = new Map();
  const dirs = ["/usr/share/applications", path.join(P.HOME, ".local/share/applications"), "/var/lib/flatpak/exports/share/applications"];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith(".desktop")); } catch { continue; }
    for (const n of names) {
      const txt = read(path.join(d, n)) || "";
      const name = /^Name\[fr\]=(.*)$/m.exec(txt)?.[1] || /^Name=(.*)$/m.exec(txt)?.[1];
      const exec = /^Exec=(\S+)/m.exec(txt)?.[1];
      if (name && exec) map.set(path.basename(exec.replace(/^"|"$/g, "")), name);
      const wm = /^StartupWMClass=(.*)$/m.exec(txt)?.[1];
      if (name && wm) map.set(wm.toLowerCase(), name);
    }
  }
  return map;
}

// ------------------------------------------------------------ démarrage ---
const CONFIG = process.env.XDG_CONFIG_HOME || path.join(P.HOME, ".config");
const USER_AUTOSTART = path.join(CONFIG, "autostart");
const SYS_AUTOSTART = ["/etc/xdg/autostart", "/usr/share/gnome/autostart"];

function parseAutostart(file) {
  const txt = read(file);
  if (txt == null) return null;
  const sec = /\[Desktop Entry\]([\s\S]*?)(?:\n\[|$)/.exec(txt)?.[1] || "";
  const v = {};
  for (const line of sec.split("\n")) {
    const m = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/.exec(line.trim());
    if (m && !(m[1] in v)) v[m[1]] = m[2];
  }
  return v;
}

// Entrées qui concernent ce bureau, avec leur état réel : une copie dans
// ~/.config/autostart remplace celle du système (c'est ainsi que GNOME
// désactive une entrée pour un seul utilisateur).
function startupList() {
  const desk = (process.env.XDG_CURRENT_DESKTOP || "GNOME").split(":");
  const entries = new Map();
  for (const dir of [...SYS_AUTOSTART, USER_AUTOSTART]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".desktop")); } catch { continue; }
    for (const n of names) {
      const v = parseAutostart(path.join(dir, n));
      if (!v) continue;
      const user = dir === USER_AUTOSTART;
      const prev = entries.get(n);
      entries.set(n, { file: n, v, user, system: prev?.system || !user });
    }
  }
  const out = [];
  for (const e of entries.values()) {
    const v = e.v;
    if (v.OnlyShowIn && !v.OnlyShowIn.split(";").some((d) => desk.includes(d))) continue;
    if (v.NotShowIn && v.NotShowIn.split(";").some((d) => desk.includes(d))) continue;
    // Composants du bureau lui-même (gnome-settings-daemon…) : pas des programmes de l'utilisateur.
    if (v["X-GNOME-AutoRestart"] === "true" || /^org\.gnome\.SettingsDaemon/.test(e.file)) continue;
    const enabled = v.Hidden !== "true" && v["X-GNOME-Autostart-enabled"] !== "false";
    out.push({ id: e.file, name: v["Name[fr]"] || v.Name || e.file.replace(/\.desktop$/, ""), command: v.Exec || "",
      scope: e.system ? "machine" : "utilisateur", enabled });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// Active ou désactive une entrée pour l'utilisateur seulement : jamais de
// droits administrateur, jamais de modification des fichiers du système.
function setStartup(id, enable) {
  if (!/^[\w.@+-]+\.desktop$/.test(id)) throw new Error("Entrée de démarrage inconnue.");
  const item = startupList().find((s) => s.id === id);
  if (!item) throw new Error("Entrée de démarrage inconnue.");
  fs.mkdirSync(USER_AUTOSTART, { recursive: true });
  const mine = path.join(USER_AUTOSTART, id);
  const sys = SYS_AUTOSTART.map((d) => path.join(d, id)).find((f) => fs.existsSync(f));
  let txt = read(mine) ?? (sys ? read(sys) : null);
  if (txt == null) throw new Error("Fichier de démarrage introuvable.");
  // On retire nos deux clés puis on écrit l'état voulu dans la section principale.
  txt = txt.replace(/^(Hidden|X-GNOME-Autostart-enabled)=.*\n?/gm, "");
  txt = txt.replace(/\[Desktop Entry\]\n?/, `[Desktop Entry]\nX-GNOME-Autostart-enabled=${enable ? "true" : "false"}\n${enable ? "" : "Hidden=true\n"}`);
  fs.writeFileSync(mine, txt);
  return item;
}

module.exports = (ctx) => {
  let last = null;

  ctx.reverters.startup = ({ id, enable }) => setStartup(id, enable);

  return {
    "GET /api/processes": async () => {
      const a = snapshot();
      await new Promise((r) => setTimeout(r, 1000));
      const b = snapshot();
      const ncpu = os.cpus().length || 1;
      const pretty = prettyNames();
      const procs = [];
      for (const p of b.values()) {
        if (p.kthread) continue;   // fils du noyau : ni mémoire ni intérêt ici
        const before = a.get(p.pid);
        const cpu = before ? ((p.ticks - before.ticks) / HZ) * 100 / ncpu : 0;
        const i = info(p.pid);
        const name = p.comm;
        procs.push({ ...p, ...i, name, cpu: Math.max(0, Math.round(cpu * 10) / 10), unit: unitOf(p.pid) });
      }
      const conn = connections(procs.filter((p) => p.uid === UID).map((p) => p.pid));
      const groups = new Map();
      for (const p of procs) {
        const k = p.name.toLowerCase();
        if (!groups.has(k)) groups.set(k, { name: p.name, product: pretty.get(path.basename(p.exe || "")) || pretty.get(k) || "",
          company: "", path: p.exe || "", cls: classify(p), count: 0, mem: 0, cpu: 0, conn: 0, pids: [], services: [], uids: new Set() });
        const g = groups.get(k);
        g.count++; g.mem += p.rss; g.cpu += p.cpu; g.conn += conn.get(p.pid) || 0; g.pids.push(p.pid); g.uids.add(p.uid);
        if (p.unit && !g.services.includes(p.unit)) g.services.push(p.unit);
        if (!g.path && p.exe) g.path = p.exe;
      }
      const list = [...groups.values()].map(({ uids, ...g }) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10,
        // Seuls les programmes de l'utilisateur peuvent être fermés (pas root).
        canStop: g.cls !== "windows" && [...uids].every((u) => u === UID) && !CRITICAL.has(g.name) && !g.pids.includes(process.pid) && !g.pids.includes(process.ppid) }))
        .sort((x, y) => y.mem - x.mem);
      last = { at: Date.now(), list };
      const sum = (cls) => list.filter((g) => g.cls === cls).reduce((s, g) => s + g.mem, 0);
      return { list, totals: { windows: sum("windows"), microsoft: sum("microsoft"), tiers: sum("tiers") }, count: procs.length };
    },

    // Ferme un programme (SIGTERM : il peut enregistrer avant de quitter).
    "POST /api/processes/stop": async (req) => {
      const { name } = await ctx.body(req);
      const g = last?.list.find((x) => x.name === name);
      if (!g) throw new Error("Programme introuvable : actualise la liste.");
      if (!g.canStop) throw new Error("Ce processus fait partie du système ou de Sonde : il ne peut pas être fermé ici.");
      for (const pid of g.pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
      ctx.journal.add({ kind: "system", title: `Programme fermé : ${g.product || g.name}` });
      return { ok: true };
    },

    "GET /api/startup": async () => startupList(),

    "POST /api/startup/set": async (req) => {
      const { id, enable } = await ctx.body(req);
      const item = setStartup(String(id), !!enable);
      ctx.journal.add({ kind: "system", title: `Démarrage ${enable ? "activé" : "désactivé"} : ${item.name}`,
        revert: { type: "startup", args: { id: item.id, enable: !enable } } });
      return { ok: true };
    },
  };
};
