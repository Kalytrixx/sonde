// Sécurité sous Debian : pare-feu, mises à jour (et mises à jour
// automatiques), redémarrage en attente, démarrage sécurisé, chiffrement,
// services ouverts sur le réseau, antivirus ClamAV s'il est installé, et
// audit de tout ce qui se lance automatiquement.
//
// L'interface reçoit des « indicateurs » tout prêts (état, libellé, valeur,
// détail, phrase à dire s'il cloche) et des corrections applicables.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sh = require("../../sh");
const P = require("../../platform");
const { owners, upgradable } = require("../../debian");

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return null; } };
const days = (ms) => (ms ? Math.floor((Date.now() - ms) / 864e5) : null);
const active = async (unit) => (await sh.tryExec("systemctl", ["is-active", unit])).trim() === "active";

async function firewall() {
  if (sh.which("ufw") || fs.existsSync("/usr/sbin/ufw")) {
    const on = /^ENABLED=yes/m.test(read("/etc/ufw/ufw.conf") || "") && (await active("ufw"));
    return { name: "ufw", on, installed: true };
  }
  if (await active("firewalld")) return { name: "firewalld", on: true, installed: true };
  if (await active("nftables")) {
    // Le service nftables de Debian est actif même avec une table vide.
    const conf = read("/etc/nftables.conf") || "";
    return { name: "nftables", on: /\bpolicy\s+drop\b|\bdrop\b/.test(conf), installed: true };
  }
  return { name: null, on: false, installed: false };
}

// Ports ouverts à d'autres machines (pas seulement à ce PC).
async function exposed() {
  const txt = await sh.tryExec("ss", ["-tulnpH"]);
  const out = [];
  for (const l of txt.split("\n")) {
    const c = l.trim().split(/\s+/);
    if (c.length < 5) continue;
    const local = c[4];
    if (/^(127\.|\[::1\]|::1|\[::ffff:127\.)/.test(local) || /%lo:/.test(local)) continue;
    const port = Number(/:(\d+)$/.exec(local)?.[1]);
    if (!port) continue;
    const proc = /users:\(\("([^"]+)"/.exec(l)?.[1] || null;
    // Découverte locale (mDNS, DHCP…) : normal sur un PC de bureau.
    if ([5353, 68, 546, 1900, 5355].includes(port) && c[0] === "udp") continue;
    if (!out.some((o) => o.port === port && o.proto === c[0])) out.push({ proto: c[0], port, proc });
  }
  return out;
}

function secureBoot() {
  try {
    const f = fs.readdirSync("/sys/firmware/efi/efivars").find((n) => n.startsWith("SecureBoot-"));
    if (!f) return { efi: true, on: null };
    const b = fs.readFileSync(path.join("/sys/firmware/efi/efivars", f));
    return { efi: true, on: b[b.length - 1] === 1 };
  } catch { return { efi: fs.existsSync("/sys/firmware/efi"), on: null }; }
}

async function encrypted() {
  const out = await sh.tryExec("lsblk", ["-rno", "TYPE,MOUNTPOINTS"]);
  return out.split("\n").some((l) => /^crypt/.test(l));
}

function rebootNeeded() {
  if (fs.existsSync("/run/reboot-required")) return true;
  // Le noyau en cours n'est plus le plus récent installé.
  const running = require("os").release();
  try {
    const mods = fs.readdirSync("/lib/modules").filter((d) => fs.existsSync(`/boot/vmlinuz-${d}`));
    const newest = mods.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).pop();
    return !!newest && newest !== running && mods.includes(running);
  } catch { return false; }
}

function autoUpdates() {
  const conf = ["/etc/apt/apt.conf.d/20auto-upgrades", "/etc/apt/apt.conf.d/10periodic"].map(read).join("\n");
  const installed = fs.existsSync("/usr/bin/unattended-upgrade");
  return { installed, on: installed && /APT::Periodic::Unattended-Upgrade\s+"1"/.test(conf) };
}

function clamav() {
  const bin = sh.which("clamscan");
  if (!bin) return null;
  const db = ["daily.cld", "daily.cvd"].map((f) => mtime(path.join("/var/lib/clamav", f))).find(Boolean);
  return { bin, sigAge: days(db), sigUpdated: db ? new Date(db).toISOString() : null };
}

// ------------------------------------------------------------- autoruns ---
const CONFIG = process.env.XDG_CONFIG_HOME || path.join(P.HOME, ".config");

function execOf(cmd) {
  const c = String(cmd || "").trim();
  const m = /^"([^"]+)"|^(\S+)/.exec(c);
  let e = m ? m[1] || m[2] : "";
  if (/^(env|sh|bash|\/bin\/sh|\/bin\/bash|\/usr\/bin\/env)$/.test(e)) {
    const rest = c.slice(e.length).trim().replace(/^(-c\s+)?["']?/, "").replace(/^\w+=\S+\s+/g, "");
    e = (/^(\S+)/.exec(rest) || [])[1] || e;
  }
  if (!e) return null;
  return e.startsWith("/") ? e : sh.which(e) || e;
}

async function autoruns() {
  const items = [];
  // Ouverture de session (autostart). Une copie dans ~/.config/autostart
  // remplace celle du système portant le même nom de fichier.
  const auto = new Map();
  for (const [dir, scope] of [["/etc/xdg/autostart", "système"], [path.join(CONFIG, "autostart"), "utilisateur"]]) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith(".desktop")); } catch { continue; }
    for (const n of names) auto.set(n, { txt: read(path.join(dir, n)) || "", scope: auto.has(n) ? auto.get(n).scope : scope });
  }
  for (const [n, { txt, scope }] of auto) {
    if (/^Hidden=true/m.test(txt) || /^X-GNOME-Autostart-enabled=false/m.test(txt)) continue;
    const exec = /^Exec=(.*)$/m.exec(txt)?.[1] || "";
    items.push({ kind: "folder", source: `Ouverture de session (${scope})`, name: /^Name\[fr\]=(.*)$/m.exec(txt)?.[1] || /^Name=(.*)$/m.exec(txt)?.[1] || n, command: exec, exe: execOf(exec) });
  }
  // Services de l'utilisateur et services du système ajoutés à la main
  const userUnits = await sh.tryExec("systemctl", ["--user", "list-unit-files", "--type=service", "--state=enabled", "--no-legend"]);
  const sysUnits = await sh.tryExec("systemctl", ["list-unit-files", "--type=service", "--state=enabled", "--no-legend"]);
  const units = [
    ...userUnits.split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean).map((u) => ({ u, user: true })),
    ...sysUnits.split("\n").map((l) => l.split(/\s+/)[0]).filter(Boolean).map((u) => ({ u, user: false })),
  ];
  for (const { u, user } of units) {
    // Unité modèle (getty@.service) : ses instances sont déjà couvertes.
    if (u.endsWith("@.service")) continue;
    const out = await sh.tryExec("systemctl", [...(user ? ["--user"] : []), "show", "-p", "ExecStart,FragmentPath", u]);
    const frag = /^FragmentPath=(.*)$/m.exec(out)?.[1] || "";
    // Services livrés par les paquets (/usr/lib/systemd) : on ne liste que ceux
    // installés à la main ou par un programme (/etc, ~/.config).
    if (/^\/(usr\/)?lib\/systemd\//.test(frag)) continue;
    const exe = /path=([^ ;]+)/.exec(out)?.[1] || null;
    const argv = /argv\[\]=([^;]+)/.exec(out)?.[1]?.trim() || exe || "";
    items.push({ kind: "service", source: user ? "Service utilisateur" : "Service système", name: u.replace(/\.service$/, ""), command: argv, exe, unitFile: frag });
  }
  // Tâches cron
  const cron = await sh.tryExec("crontab", ["-l"]);
  for (const l of cron.split("\n")) {
    if (!l.trim() || l.trim().startsWith("#") || /^\w+=/.test(l.trim())) continue;
    const cmd = l.trim().split(/\s+/).slice(l.trim().startsWith("@") ? 1 : 5).join(" ");
    items.push({ kind: "task", source: "Tâche cron (utilisateur)", name: cmd.slice(0, 60), command: cmd, exe: execOf(cmd) });
  }
  let cronD = [];
  try { cronD = fs.readdirSync("/etc/cron.d").filter((n) => !n.startsWith(".") && n !== "README"); } catch {}
  const cronOwn = await owners(cronD.map((n) => path.join("/etc/cron.d", n)));
  for (const n of cronD) {
    const f = path.join("/etc/cron.d", n);
    if (cronOwn.has(f)) continue;   // fourni par un paquet Debian
    const txt = read(f) || "";
    for (const l of txt.split("\n")) {
      const t = l.trim();
      if (!t || t.startsWith("#") || /^\w+=/.test(t)) continue;
      const cmd = t.split(/\s+/).slice(t.startsWith("@") ? 2 : 6).join(" ");
      items.push({ kind: "task", source: "Tâche cron (système)", name: n, command: cmd, exe: execOf(cmd) });
    }
  }
  // Provenance : paquet Debian, Flatpak, Snap, ou rien (installé à la main).
  const own = await owners(items.map((i) => i.exe).filter(Boolean));
  for (const i of items) {
    i.exists = !!i.exe && fs.existsSync(i.exe);
    const pkg = i.exe && own.get(i.exe);
    const via = pkg ? `paquet ${pkg}` : /flatpak/.test(i.command) ? "Flatpak" : /^\/snap\//.test(i.exe || "") ? "Snap" : null;
    i.sig = { status: via ? "Valid" : "NotSigned", signer: via };
  }
  return items;
}

function flags(i) {
  const f = [];
  const exe = String(i.exe || ""), cmd = String(i.command || "");
  if (!cmd.trim()) f.push("commande vide : entrée orpheline");
  else if (!i.exists) f.push("programme introuvable : sans doute désinstallé, entrée orpheline");
  else if (i.sig?.status !== "Valid") f.push("hors paquet Debian (installé à la main ou par un script)");
  if (/^\/(tmp|dev\/shm|var\/tmp)\/|\/(Downloads|Téléchargements)\//.test(exe) || /\/\.[^/]+\/[^/]+$/.test(exe) && !/\/\.local\/bin\//.test(exe)) f.push("lancé depuis un dossier inhabituel");
  if (/(curl|wget)\b.*\|\s*(ba)?sh|base64\s+(-d|--decode)|\bnc\s+-e|python3?\s+-c|bash\s+-i\s+>&/.test(cmd)) f.push("script qui télécharge ou exécute du code");
  return f;
}

module.exports = (ctx) => {
  let job = null;          // analyse ClamAV en cours
  let lastThreats = [];
  let autorunsCache = null;

  function runJob(cmd, args, label, { elevated = false } = {}) {
    const j = { label, started: Date.now(), output: "", code: null, done: false };
    const p = elevated ? spawn("pkexec", [cmd, ...args]) : spawn(cmd, args, { env: sh.C_ENV });
    const add = (d) => {
      j.output = (j.output + d).slice(-6000);
      for (const m of String(d).matchAll(/^(.+?): (.+) FOUND$/gm)) {
        lastThreats.unshift({ id: m[1], name: m[2], severity: 5, at: new Date().toISOString(), ok: false, resources: [m[1]] });
      }
    };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    // clamscan : 0 = rien trouvé, 1 = menace trouvée, 2 = erreurs (fichiers illisibles…).
    p.on("close", (code) => { j.code = code === 1 && label.startsWith("Analyse") ? 0 : code === 2 && label.startsWith("Analyse") ? 0 : code; j.found = code === 1; j.done = true; j.ended = Date.now(); });
    p.on("error", (e) => { j.output += e.message; j.done = true; j.code = -1; });
    return j;
  }

  // Corrections proposées sur la page, chacune avec son script fixe.
  const FIXES = {
    firewall: { label: "Activer le pare-feu (ufw)", why: "Bloque les connexions entrantes non demandées. Ne gêne pas la navigation, les jeux ni les téléchargements.",
      script: `export DEBIAN_FRONTEND=noninteractive
        command -v ufw >/dev/null || apt-get install -y -q ufw
        ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
        ufw --force enable`,
      revert: "ufw-off" },
    autoupdates: { label: "Activer les mises à jour de sécurité automatiques", why: "Debian installe tout seul les correctifs de sécurité, chaque jour, en arrière-plan.",
      script: `export DEBIAN_FRONTEND=noninteractive
        [ -x /usr/bin/unattended-upgrade ] || apt-get install -y -q unattended-upgrades
        printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "1";\\n' > /etc/apt/apt.conf.d/20auto-upgrades`,
      revert: "autoupdates-off" },
    clamav: { label: "Installer l'antivirus ClamAV", why: "Facultatif sous Linux. Utile surtout pour vérifier des fichiers venus de Windows (clés USB, téléchargements, pièces jointes).",
      script: "DEBIAN_FRONTEND=noninteractive apt-get install -y -q clamav clamav-freshclam" },
  };
  ctx.reverters["ufw-off"] = () => sh.runElevated("ufw --force disable");
  ctx.reverters["autoupdates-off"] = () => sh.runElevated(`printf 'APT::Periodic::Update-Package-Lists "1";\\nAPT::Periodic::Unattended-Upgrade "0";\\n' > /etc/apt/apt.conf.d/20auto-upgrades`);

  return {
    "GET /api/security": async () => {
      const [fw, ports, upd, enc] = await Promise.all([firewall(), exposed(), upgradable(), encrypted()]);
      const sb = secureBoot(), au = autoUpdates(), av = clamav(), reboot = rebootNeeded();
      const listsAge = days(Math.max(...["/var/lib/apt/periodic/update-success-stamp", "/var/cache/apt/pkgcache.bin"].map((f) => mtime(f) || 0)) || null);
      const sec = upd.filter((u) => u.security).length;
      const indicators = [
        [fw.on ? "good" : ports.length ? "bad" : "warn", "Pare-feu", fw.on ? `Actif (${fw.name})` : "Aucun", fw.on ? "connexions entrantes filtrées" : ports.length ? `${ports.length} port(s) ouvert(s) sur le réseau` : "aucun port ouvert pour l'instant",
          ports.length ? "aucun pare-feu ne protège les ports ouverts" : "aucun pare-feu n'est actif"],
        [sec ? "bad" : upd.length > 20 ? "warn" : "good", "Mises à jour", upd.length ? `${upd.length} en attente` : "À jour", sec ? `dont ${sec} de sécurité` : listsAge != null ? `vérifié il y a ${listsAge} j` : "",
          sec ? `${sec} mise(s) à jour de sécurité attendent` : "beaucoup de mises à jour attendent"],
        [au.on ? "good" : "warn", "Mises à jour auto.", au.on ? "Actives" : "Désactivées", "correctifs de sécurité quotidiens", "les mises à jour de sécurité automatiques sont désactivées"],
        [reboot ? "warn" : "good", "Redémarrage", reboot ? "Nécessaire" : "Inutile", reboot ? "un nouveau noyau attend" : "", "un redémarrage est nécessaire pour appliquer une mise à jour"],
        [enc ? "good" : "warn", "Chiffrement du disque", enc ? "Actif (LUKS)" : "Non chiffré", enc ? "" : "en cas de vol, les fichiers sont lisibles", "le disque n'est pas chiffré"],
        [sb.on ? "good" : "info", "Démarrage sécurisé", sb.on == null ? (sb.efi ? "Inconnu" : "BIOS hérité") : sb.on ? "Actif" : "Désactivé", "Secure Boot", "le démarrage sécurisé est désactivé"],
        [ports.length > 3 ? "warn" : "good", "Ports ouverts", ports.length ? String(ports.length) : "Aucun", ports.slice(0, 4).map((p) => `${p.port}${p.proc ? " " + p.proc : ""}`).join(", "), "plusieurs services écoutent sur le réseau"],
        av ? [av.sigAge != null && av.sigAge <= 2 ? "good" : "warn", "Antivirus", "ClamAV", av.sigAge != null ? `signatures : ${av.sigAge === 0 ? "aujourd'hui" : `il y a ${av.sigAge} j`}` : "signatures absentes", "les signatures de ClamAV ne sont pas à jour"]
          : ["info", "Antivirus", "Aucun", "facultatif sous Linux", ""],
      ].map(([state, label, value, detail, issue]) => ({ state, label, value, detail, issue }));
      const fixes = [];
      if (!fw.on && (!fw.name || fw.name === "ufw")) fixes.push("firewall");
      if (!au.on) fixes.push("autoupdates");
      if (!av) fixes.push("clamav");
      return {
        platform: "linux", indicators, ports,
        status: fw.on ? `Pare-feu ${fw.name} actif` : "Aucun pare-feu actif",
        fixes: fixes.map((id) => ({ id, label: FIXES[id].label, why: FIXES[id].why })),
        av: av ? { name: "ClamAV", ...av } : null,
        threats: lastThreats, job,
        updates: upd.slice(0, 50),
      };
    },

    "POST /api/security/fix": async (req) => {
      const { id } = await ctx.body(req);
      const f = FIXES[id];
      if (!f) throw new Error("Correction inconnue.");
      await sh.runElevated(f.script);
      ctx.journal.add({ kind: "system", title: f.label, revert: f.revert ? { type: f.revert, args: {} } : undefined });
      return { ok: true };
    },

    // Analyse ClamAV : rapide = dossier personnel, complète = tout le disque.
    "POST /api/security/scan": async (req) => {
      const { type } = await ctx.body(req);
      if (job && !job.done) throw new Error("Une analyse est déjà en cours.");
      if (!sh.which("clamscan")) throw new Error("ClamAV n'est pas installé.");
      const full = type === "full";
      const args = ["-r", "-i", "--max-filesize=200M", "--max-scansize=400M"];
      if (full) args.push("--exclude-dir=^/(proc|sys|dev|run|snap)", "--cross-fs=no", "/");
      else args.push(P.HOME);
      job = runJob("clamscan", args, full ? "Analyse complète" : "Analyse rapide (dossier personnel)");
      ctx.journal.add({ kind: "system", title: `ClamAV : ${job.label} lancée` });
      return { job };
    },

    "GET /api/security/job": async () => ({ job }),

    "POST /api/security/update": async () => {
      if (job && !job.done) throw new Error("Une opération est déjà en cours.");
      if (!sh.which("freshclam")) throw new Error("ClamAV n'est pas installé.");
      // Le service clamav-freshclam tient normalement les signatures à jour ;
      // sinon freshclam se lance avec les droits administrateur.
      if (await active("clamav-freshclam")) throw new Error("Les signatures se mettent déjà à jour toutes seules (service clamav-freshclam).");
      job = runJob("freshclam", [], "Mise à jour des signatures", { elevated: true });
      return { job };
    },

    "GET /api/security/autoruns": async (req, res, url) => {
      if (!autorunsCache || url.searchParams.get("refresh") === "1" || Date.now() - autorunsCache.at > 300000) {
        const items = await autoruns();
        autorunsCache = { at: Date.now(), items: items.map((i) => ({ ...i, flags: flags(i) })) };
      }
      return autorunsCache;
    },
  };
};
