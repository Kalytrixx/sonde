// Connexion Internet sous Linux (NetworkManager) : diagnostic, mesures
// (ping, DNS, débit) et optimisations proposées seulement quand une mesure
// les justifie. Même interface que la version Windows.

const fs = require("fs");
const dns = require("dns");
const sh = require("../../sh");

const DNS = {
  cloudflare: { label: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
  google: { label: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
  quad9: { label: "Quad9 (bloque les sites malveillants)", servers: ["9.9.9.9", "149.112.112.112"] },
};
const DOMAINS = ["wikipedia.org", "github.com", "reddit.com", "amazon.fr", "lemonde.fr", "twitch.tv", "steamcommunity.com", "youtube.com"];

const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const hasNM = () => !!sh.which("nmcli");

// nmcli -t : champs séparés par « : », les « : » des valeurs sont échappés « \: ».
const nmSplit = (l) => l.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ":"));

async function adapters() {
  const links = await sh.json("ip", ["-j", "addr", "show"]).catch(() => []);
  const out = [];
  for (const l of links) {
    const name = l.ifname;
    // Cartes physiques seulement : celles qui ont un « device » dans sysfs.
    if (!fs.existsSync(`/sys/class/net/${name}/device`) || l.operstate !== "UP") continue;
    const wifi = fs.existsSync(`/sys/class/net/${name}/wireless`) || fs.existsSync(`/sys/class/net/${name}/phy80211`);
    const speed = Number(read(`/sys/class/net/${name}/speed`)) || 0;
    let driver = "";
    try { driver = require("path").basename(fs.readlinkSync(`/sys/class/net/${name}/device/driver`)); } catch {}
    let desc = driver;
    const slot = /PCI_SLOT_NAME=(.+)/.exec(read(`/sys/class/net/${name}/device/uevent`) || "")?.[1];
    if (slot && sh.which("lspci")) {
      const f = (await sh.tryExec("lspci", ["-mm", "-s", slot])).match(/"([^"]*)"/g)?.map((x) => x.slice(1, -1));
      if (f && f[2]) desc = `${f[1]} ${f[2]}`.replace(/\s+Co\.,? Ltd\.?|\s+Corporation/g, "");
    }
    const ip = (l.addr_info || []).find((a) => a.family === "inet")?.local || null;
    out.push({ name, desc, speed: speed > 0 ? speed * 1e6 : 0, media: wifi ? "802.11" : "802.3", ifIndex: l.ifindex, ip, dns: [], dnsStatic: false, eee: [], wifi, conn: null });
  }
  // DNS et connexion NetworkManager de chaque carte.
  if (hasNM()) {
    for (const a of out) {
      const txt = await sh.tryExec("nmcli", ["-t", "-f", "GENERAL.CONNECTION,IP4.DNS", "device", "show", a.name]);
      for (const l of txt.split("\n")) {
        const [k, v] = nmSplit(l);
        if (k === "GENERAL.CONNECTION" && v) a.conn = v;
        if (k && k.startsWith("IP4.DNS") && v) a.dns.push(v);
      }
      if (a.conn) {
        const c = await sh.tryExec("nmcli", ["-t", "-f", "ipv4.ignore-auto-dns,ipv4.dns,802-11-wireless.powersave", "connection", "show", a.conn]);
        const v = Object.fromEntries(c.split("\n").filter(Boolean).map(nmSplit));
        a.dnsStatic = v["ipv4.ignore-auto-dns"] === "yes" && !!v["ipv4.dns"];
        a.manualDns = v["ipv4.dns"] || "";
        if (a.wifi) a.powersave = v["802-11-wireless.powersave"] || "";
      }
    }
  }
  // Repli : resolv.conf (ou le résolveur de systemd-resolved).
  const resolv = (read("/run/systemd/resolve/resolv.conf") || read("/etc/resolv.conf") || "")
    .split("\n").map((l) => /^nameserver\s+(\S+)/.exec(l)?.[1]).filter((x) => x && x !== "127.0.0.53");
  for (const a of out) if (!a.dns.length) a.dns = resolv;
  // Économie d'énergie Ethernet (EEE) : ethtool, si présent.
  if (sh.which("ethtool")) {
    for (const a of out.filter((x) => !x.wifi)) {
      const t = await sh.tryExec("ethtool", ["--show-eee", a.name]);
      const st = /EEE status:\s*(\w+)/i.exec(t)?.[1];
      if (st === "enabled") a.eee.push({ keyword: "eee", label: "Ethernet économe en énergie (EEE)", display: "Activé", value: "1" });
    }
  }
  return out;
}

async function wifiInfo() {
  if (!hasNM()) return null;
  const txt = await sh.tryExec("nmcli", ["-t", "-f", "ACTIVE,SSID,SIGNAL", "device", "wifi", "list", "--rescan", "no"]);
  for (const l of txt.split("\n")) {
    const [active, ssid, signal] = nmSplit(l);
    if (active === "yes") return { ssid, signal: Number(signal) || 0 };
  }
  return null;
}

// Programmes connectés : « ss -tnp » (les processus de l'utilisateur ont un nom).
async function connectedApps() {
  const txt = await sh.tryExec("ss", ["-tnpH", "state", "established"]);
  const byName = new Map();
  for (const l of txt.split("\n")) {
    const c = l.trim().split(/\s+/);
    if (c.length < 4) continue;
    const peer = c[3] || "";
    if (/^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer)) continue;
    const name = /users:\(\("([^"]+)"/.exec(l)?.[1] || "?";
    const pid = /pid=(\d+)/.exec(l)?.[1];
    const host = peer.replace(/:\d+$/, "");
    const g = byName.get(name) || { name, conns: 0, hosts: new Set(), pid };
    g.conns++; g.hosts.add(host);
    byName.set(name, g);
  }
  const list = [...byName.values()].sort((a, b) => b.conns - a.conns).slice(0, 15);
  // « Éditeur » sous Debian : le paquet qui fournit le programme (ou Flatpak).
  const exe = new Map();
  for (const g of list) { try { if (g.pid) exe.set(g, fs.readlinkSync(`/proc/${g.pid}/exe`)); } catch {} }
  const owners = await require("../../debian").owners([...exe.values()]).catch(() => new Map());
  const pubOf = (g) => {
    const f = exe.get(g);
    if (!f) return null;
    if (f.startsWith("/app/") || /\/flatpak\//.test(f)) return "Flatpak";
    return owners.get(f) ? `paquet ${owners.get(f)}` : null;
  };
  return list.map((g) => ({ name: g.name === "?" ? "(processus du système)" : g.name, pub: pubOf(g), conns: g.conns, hosts: g.hosts.size }));
}

async function ping(host, count = 8) {
  const out = await sh.tryExec("ping", ["-n", "-c", String(count), "-i", "0.25", "-W", "2", host], { timeout: 30000 });
  const times = [...out.matchAll(/time[=<]([\d.]+)\s*ms/g)].map((m) => Math.round(Number(m[1])));
  return { host, sent: count, times };
}

function pingStats(p) {
  const t = p.times || [];
  if (!t.length) return { host: p.host, loss: 100, avg: null, jitter: null };
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  let jit = 0;
  for (let i = 1; i < t.length; i++) jit += Math.abs(t[i] - t[i - 1]);
  return { host: p.host, loss: Math.round(100 * (1 - t.length / p.sent)), avg: Math.round(avg * 10) / 10,
    min: Math.min(...t), max: Math.max(...t), jitter: t.length > 1 ? Math.round((jit / (t.length - 1)) * 10) / 10 : 0 };
}

// Résolution DNS directement auprès de chaque serveur (sans cache local).
async function dnsBench(servers) {
  const out = [];
  for (const s of servers) {
    const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    r.setServers([s]);
    const times = [];
    for (const d of DOMAINS) {
      const t0 = performance.now();
      try { await r.resolve4(d); times.push(Math.round(performance.now() - t0)); } catch { times.push(2000); }
    }
    out.push({ server: s, times });
  }
  return out;
}

async function throughput(kind, seconds, emit) {
  const start = Date.now();
  let bytes = 0;
  const deadline = start + seconds * 1000;
  const worker = async () => {
    while (Date.now() < deadline) {
      if (kind === "down") {
        const r = await fetch("https://speed.cloudflare.com/__down?bytes=25000000", { signal: AbortSignal.timeout(seconds * 1000 + 5000) });
        if (!r.ok) throw new Error(`serveur de test indisponible (${r.status})`);
        for await (const chunk of r.body) { bytes += chunk.length; if (Date.now() > deadline) break; }
      } else {
        const body = Buffer.alloc(8 * 1024 * 1024);
        const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body, signal: AbortSignal.timeout(seconds * 1000 + 10000) });
        if (!r.ok) throw new Error(`serveur de test indisponible (${r.status})`);
        bytes += body.length;
      }
      emit && emit({ type: "progress", step: kind, mbps: (bytes * 8) / ((Date.now() - start) / 1000) / 1e6 });
    }
  };
  const res = await Promise.allSettled(Array.from({ length: kind === "down" ? 4 : 2 }, worker));
  if (!bytes) throw res.find((x) => x.status === "rejected")?.reason || new Error("aucune donnée reçue");
  return (bytes * 8) / ((Date.now() - start) / 1000) / 1e6;
}

async function httpLatency() {
  const t = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    const r = await fetch("https://speed.cloudflare.com/__down?bytes=0", { signal: AbortSignal.timeout(5000) });
    await r.arrayBuffer();
    t.push(performance.now() - s);
  }
  return Math.round(median(t.slice(1)));
}

async function gateway() {
  const routes = await sh.json("ip", ["-j", "route", "show", "default"]).catch(() => []);
  return routes.sort((a, b) => (a.metric || 0) - (b.metric || 0))[0]?.gateway || null;
}

module.exports = (ctx) => {
  let info = null;
  let lastTest = null;

  async function getInfo() {
    const [ads, wifi, gw, apps] = await Promise.all([adapters(), wifiInfo(), gateway(), connectedApps()]);
    info = { adapters: ads, wifi, gateway: gw, autotuning: null, doPolicy: null, doUpload: null, apps };
    return info;
  }

  function optimizations(inf, test) {
    const out = [];
    const main = inf.adapters.find((a) => a.ip) || inf.adapters[0];
    if (test?.dns && main?.conn) {
      const cur = test.dns.find((d) => d.current);
      const best = test.dns.filter((d) => !d.current && d.provider).sort((a, b) => a.median - b.median)[0];
      if (cur && best && best.median + 5 < cur.median) {
        out.push({ id: "dns", admin: true, title: `Passer au DNS ${DNS[best.provider].label}`,
          why: `Chez toi, il répond en ${best.median} ms contre ${cur.median} ms pour le DNS actuel (${cur.server}). Chaque nouveau site s'ouvre un peu plus vite.`,
          params: { provider: best.provider, conn: main.conn } });
      }
    }
    for (const a of inf.adapters) {
      // Économie d'énergie Wi-Fi : la carte s'endort entre deux paquets, ce
      // qui ajoute de la latence et des saccades en jeu ou en visio.
      if (a.wifi && a.conn && a.powersave !== "2 (disable)" && a.powersave !== "disable") {
        out.push({ id: "wifips", admin: true, title: `Désactiver l'économie d'énergie Wi-Fi (${a.conn})`,
          why: "La carte Wi-Fi s'endort entre deux paquets pour économiser la batterie : ça ajoute de la latence et des micro-coupures (jeu, visio). Sur un PC branché, le gain d'énergie est négligeable.",
          params: { conn: a.conn, previous: a.powersave } });
      }
      for (const e of a.eee || []) {
        out.push({ id: "eee", admin: true, title: `Désactiver « ${e.label} » sur ${a.name}`,
          why: "L'économie d'énergie Ethernet met la carte en veille entre deux paquets : ça peut ajouter de la latence ou des micro-coupures en jeu. Le gain d'énergie est négligeable sur un PC fixe.",
          params: { adapter: a.name } });
      }
      if (!a.wifi && /2\.5G|2,5G|2500|RTL8125|I225|I226/i.test(a.desc) && a.speed && a.speed < 2.5e9) {
        out.push({ id: "info", title: `Carte 2,5 Gb/s connectée à ${a.speed / 1e9} Gb/s`,
          why: "Ta carte réseau gère 2,5 Gb/s mais le lien négocié est plus lent : c'est la box, le switch ou le câble (catégorie 5e minimum) qui limite. Sans importance si ton abonnement est sous 1 Gb/s." });
      }
    }
    if (inf.wifi && inf.wifi.signal < 60) {
      out.push({ id: "info", title: `Signal Wi-Fi faible (${inf.wifi.signal} %)`,
        why: "Rapproche le PC de la box, ou passe en Ethernet : aucun réglage logiciel ne compense un mauvais signal." });
    }
    if (test?.ping) {
      const gw = test.ping.find((p) => p.host === inf.gateway);
      if (gw && (gw.loss > 0 || (gw.avg ?? 0) > 5)) out.push({ id: "info", title: "Réseau local instable",
        why: `Le ping vers ta box est de ${gw.avg} ms avec ${gw.loss} % de pertes : en Ethernet il devrait être sous 2 ms sans perte. Vérifie le câble ou le port.` });
    }
    return out;
  }

  // NetworkManager : la connexion de l'utilisateur se modifie sans droits
  // administrateur (sinon GNOME demande le mot de passe lui-même).
  async function setDns(conn, servers) {
    const auto = !servers?.length;
    await sh.exec("nmcli", ["connection", "modify", conn, "ipv4.dns", auto ? "" : servers.join(" "), "ipv4.ignore-auto-dns", auto ? "no" : "yes"]);
    await sh.exec("nmcli", ["connection", "up", conn], { timeout: 60000 });
  }
  async function setWifiPs(conn, value) {
    await sh.exec("nmcli", ["connection", "modify", conn, "802-11-wireless.powersave", String(value)]);
    await sh.exec("nmcli", ["connection", "up", conn], { timeout: 60000 });
  }
  const setEee = (adapter, on) => sh.runElevated('ethtool --set-eee "$1" eee "$2"', [adapter, on ? "on" : "off"]);

  ctx.reverters.dns = ({ conn, servers }) => setDns(conn, servers);
  ctx.reverters.wifips = ({ conn, value }) => setWifiPs(conn, value);
  ctx.reverters.eee = ({ adapter }) => setEee(adapter, true);

  return {
    "GET /api/network": async () => {
      const inf = await getInfo();
      return { ...inf, dnsProviders: DNS, test: lastTest, optimizations: optimizations(inf, lastTest), platform: "linux" };
    },

    "POST /api/network/test": async (req, res) => {
      const emit = ctx.stream(res);
      try {
        const inf = await getInfo();
        emit({ type: "step", step: "ping", label: "Ping de la box et d'Internet" });
        const targets = [inf.gateway, "1.1.1.1", "8.8.8.8"].filter(Boolean);
        const pings = (await Promise.all(targets.map((h) => ping(h)))).map(pingStats);
        emit({ type: "ping", ping: pings });

        emit({ type: "step", step: "dns", label: "Comparaison des serveurs DNS" });
        const current = inf.adapters.find((a) => a.ip)?.dns || [];
        const servers = [...new Set([...current.slice(0, 1), ...Object.values(DNS).map((d) => d.servers[0])])];
        const bench = await dnsBench(servers);
        const dnsRes = bench.map((b) => ({ server: b.server, median: median(b.times), fails: b.times.filter((t) => t >= 2000).length,
          current: current.includes(b.server), provider: Object.keys(DNS).find((k) => DNS[k].servers.includes(b.server)) || null }))
          .sort((a, b) => a.median - b.median);
        emit({ type: "dns", dns: dnsRes });

        emit({ type: "step", step: "latency", label: "Latence vers Internet" });
        const http = await httpLatency().catch(() => null);
        emit({ type: "step", step: "down", label: "Débit descendant" });
        const down = await throughput("down", 8, emit).catch(() => null);
        emit({ type: "step", step: "up", label: "Débit montant" });
        const up = await throughput("up", 6, emit).catch(() => null);

        lastTest = { at: Date.now(), ping: pings, dns: dnsRes, http, down: down && Math.round(down), up: up && Math.round(up) };
        emit({ type: "done", test: lastTest, optimizations: optimizations(inf, lastTest) });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally {
        res.end();
      }
    },

    // Cache DNS : seulement si systemd-resolved tourne (sinon Debian n'en a pas).
    "POST /api/network/flushdns": async () => {
      const active = (await sh.tryExec("systemctl", ["is-active", "systemd-resolved"])).trim() === "active";
      if (!active) throw new Error("Pas de cache DNS sur ce système (systemd-resolved n'est pas utilisé) : rien à vider.");
      await sh.exec("resolvectl", ["flush-caches"]);
      ctx.journal.add({ kind: "system", title: "Cache DNS vidé" });
      return { ok: true };
    },

    "POST /api/network/apply": async (req) => {
      const { id, params = {} } = await ctx.body(req);
      const inf = info || await getInfo();
      if (id === "dns") {
        const prov = DNS[params.provider];
        const ad = inf.adapters.find((a) => a.conn && a.conn === params.conn);
        if (!prov || !ad) throw new Error("Paramètres refusés.");
        await setDns(ad.conn, prov.servers);
        ctx.journal.add({ kind: "system", title: `DNS changé pour ${prov.label} (${ad.conn})`,
          revert: { type: "dns", args: { conn: ad.conn, servers: ad.dnsStatic ? ad.manualDns.split(/[\s,]+/).filter(Boolean) : [] } } });
      } else if (id === "wifips") {
        const ad = inf.adapters.find((a) => a.wifi && a.conn === params.conn);
        if (!ad) throw new Error("Paramètres refusés.");
        await setWifiPs(ad.conn, 2);
        const prev = /^(\d)/.exec(ad.powersave || "")?.[1] || "0";
        ctx.journal.add({ kind: "system", title: `Économie d'énergie Wi-Fi désactivée (${ad.conn})`, revert: { type: "wifips", args: { conn: ad.conn, value: prev } } });
      } else if (id === "eee") {
        const ad = inf.adapters.find((a) => a.name === params.adapter && a.eee?.length);
        if (!ad) throw new Error("Paramètres refusés.");
        await setEee(ad.name, false);
        ctx.journal.add({ kind: "system", title: `Économie d'énergie Ethernet désactivée sur ${ad.name}`, detail: "Jusqu'au prochain redémarrage.",
          revert: { type: "eee", args: { adapter: ad.name } } });
      } else {
        throw new Error("Optimisation inconnue.");
      }
      info = null;
      return { ok: true };
    },
  };
};

// Lecture de la carte réseau, réutilisée par la page Gaming (lib/modules/linux/gaming.js).
module.exports.helpers = { adapters, wifiInfo, gateway };
