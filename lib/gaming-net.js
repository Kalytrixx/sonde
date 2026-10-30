// Gaming, partie commune à Windows et Debian : ping des serveurs de jeu,
// latence sous charge (bufferbloat), NAT et UPnP, et petits outils de mesure.
// Les modules lib/modules/{win32,linux}/gaming.js s'en servent.

const fs = require("fs");
const path = require("path");
const net = require("net");
const dgram = require("dgram");
const crypto = require("crypto");
const { execFile } = require("child_process");

function tcpPing(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port, timeout });
    const done = (ok) => { s.destroy(); resolve(ok ? Number(process.hrtime.bigint() - t0) / 1e6 : null); };
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

// Ping ICMP : ping.exe sous Windows (sortie traduite : « temps=12 ms » ou
// « time=12ms »), ping d'iputils sous Linux (« time=12.3 ms »).
function icmpPing(host, count) {
  const win = process.platform === "win32";
  const args = win ? ["-n", String(count), "-w", "1500", host] : ["-n", "-c", String(count), "-i", "0.3", "-W", "2", host];
  return new Promise((resolve) => {
    execFile(win ? "ping.exe" : "ping", args, { windowsHide: true, timeout: 30000 }, (err, out) => {
      resolve([...String(out || "").matchAll(/[=<]([\d.]+)\s*ms/gi)].map((m) => Math.round(Number(m[1]))).slice(0, count));
    });
  });
}

const stats = (times, sent) => {
  const t = times.filter((x) => x != null);
  if (!t.length) return { avg: null, jitter: null, loss: 100 };
  const avg = t.reduce((a, b) => a + b, 0) / t.length;
  let j = 0;
  for (let i = 1; i < t.length; i++) j += Math.abs(t[i] - t[i - 1]);
  return { avg: Math.round(avg), min: Math.round(Math.min(...t)), jitter: t.length > 1 ? Math.round(j / (t.length - 1)) : 0, loss: Math.round(100 * (1 - t.length / sent)) };
};

async function measure(target, n = 8) {
  if (target.icmp) return stats(await icmpPing(target.host, n), n);
  const t = [];
  for (let i = 0; i < n; i++) { t.push(await tcpPing(target.host, target.port)); await new Promise((r) => setTimeout(r, 120)); }
  return stats(t, n);
}

// Vitesse prévue par les barrettes, lue dans la référence quand c'est possible :
// G.Skill F5-6000J…, Corsair …B6000C36, Kingston KF560C36 (= 6000), Crucial …6000…
function ratedFromPart(part) {
  const p = String(part || "");
  const m = /F[45]-(\d{4})/i.exec(p) || /(\d{4})C\d{2}/i.exec(p) || /KF\d(\d{2})C\d{2}/i.exec(p) || /^(\d{4})\s*Series$/i.exec(p.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return v < 100 ? v * 100 : v;
}

// Serveurs de jeu pour le ping. Les relais Steam viennent de la liste publiée
// par Valve (GetSDRConfig) ; les autres sont des adresses publiques connues.
// Un serveur qui ne répond pas est affiché « Non disponible », sans fausse valeur.
const GAME_SERVERS = [
  { id: "riot", name: "Riot Games", where: "EUW · Amsterdam", host: "104.160.141.3", icmp: true },
  { id: "steam", name: "Relais Steam", where: "le plus proche", sdr: ["fra", "par", "ams"] },
  { id: "epic", name: "Epic Games", where: "Fortnite · Europe", host: "ping-eu.ds.on.epicgames.com", icmp: true },
  { id: "blizzard", name: "Blizzard", where: "Battle.net · Europe", host: "eu.actual.battle.net", port: 1119 },
  { id: "valve", name: "Valve CS2", where: "Stockholm", sdr: ["sto"] },
  { id: "google", name: "Google", where: "pour comparaison seulement", host: "8.8.8.8", icmp: true, ref: true },
];
// Référence pour la latence sous charge (bufferbloat).
const BLOAT_REF = { host: "1.1.1.1", port: 443 };

function dirStat(d, depth = 0) {
  let size = 0, count = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 8) { const s = dirStat(f, depth + 1); size += s.size; count += s.count; } }
      else { try { size += fs.statSync(f).size; count++; } catch {} }
    }
  } catch {}
  return { size, count };
}

// UPnP : la box répond-elle à une recherche de passerelle Internet ?
function upnpGateway() {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    let found = null;
    s.on("message", (m, r) => { if (!found) found = { address: r.address, server: (/SERVER:\s*(.*)/i.exec(m.toString()) || [])[1]?.trim() || null }; });
    s.on("error", () => {});
    s.bind(() => {
      const msg = Buffer.from("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n");
      s.send(msg, 1900, "239.255.255.250", () => {});
      setTimeout(() => { try { s.close(); } catch {} resolve(found); }, 2600);
    });
  });
}

// NAT : deux serveurs STUN depuis le même port. Même port public vu des deux
// côtés : NAT « cône » (ouvert ou modéré) ; ports différents : NAT strict.
async function stunMapping() {
  const s = dgram.createSocket("udp4");
  s.on("error", () => {});
  await new Promise((r) => s.bind(r));
  const ask = (host, port) => new Promise((resolve) => {
    const req = Buffer.alloc(20);
    req.writeUInt16BE(1, 0); req.writeUInt32BE(0x2112A442, 4);
    crypto.randomBytes(12).copy(req, 8);
    const t = setTimeout(() => { s.removeListener("message", on); resolve(null); }, 2500);
    const on = (m) => {
      if (m.length < 20 || !m.subarray(8, 20).equals(req.subarray(8, 20))) return;
      clearTimeout(t); s.removeListener("message", on);
      let i = 20;
      while (i + 4 <= m.length) {
        const type = m.readUInt16BE(i), len = m.readUInt16BE(i + 2);
        if (type === 0x0020) return resolve({ ip: [0, 1, 2, 3].map((k) => m[i + 8 + k] ^ [0x21, 0x12, 0xA4, 0x42][k]).join("."), port: m.readUInt16BE(i + 6) ^ 0x2112 });
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      resolve(null);
    };
    s.on("message", on);
    s.send(req, port, host, () => {});
  });
  const a = await ask("stun.l.google.com", 19302);
  const b = await ask("stun.cloudflare.com", 3478);
  try { s.close(); } catch {}
  return { a, b };
}

// Liste des relais Steam, gardée une journée.
let sdrCache = null;
async function sdrPops() {
  if (sdrCache && Date.now() - sdrCache.at < 864e5) return sdrCache.pops;
  const r = await fetch("https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730", { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  sdrCache = { at: Date.now(), pops: j.pops || {} };
  return sdrCache.pops;
}

// Ping d'un serveur de jeu ; les relais Steam : le meilleur des relais candidats.
async function pingServer(sv) {
  if (sv.sdr) {
    const pops = await sdrPops().catch(() => ({}));
    // Les relais candidats sont mesurés en même temps ; on garde le plus rapide.
    const res = await Promise.all(sv.sdr.map(async (k) => {
      const ip = pops[k]?.relays?.[0]?.ipv4;
      if (!ip) return null;
      return { ...(await measure({ host: ip, icmp: true }, 8)), where: String(pops[k].desc || k).replace(/\s*\(.*\)$/, "") };
    }));
    return res.filter((x) => x?.avg != null).sort((a, b) => a.avg - b.avg)[0] || { avg: null, jitter: null, loss: 100 };
  }
  return measure(sv, 8);
}

// NAT (estimé par STUN) et UPnP (la box répond-elle ?).
async function natInfo() {
  const [upnp, stun] = await Promise.all([upnpGateway(), stunMapping().catch(() => ({}))]);
  let nat = null;
  if (stun.a && stun.b) nat = stun.a.port === stun.b.port ? (upnp ? "open" : "moderate") : "strict";
  return { upnp: upnp ? { found: true, server: upnp.server } : { found: false }, nat, publicIp: stun.a?.ip || stun.b?.ip || null };
}

const servers = () => GAME_SERVERS.map(({ id, name, where, ref }) => ({ id, name, where, ref: !!ref }));

// Route en flux : ping des serveurs de jeu, ou latence sous charge.
const testRoute = (ctx) => async (req, res) => {
  const { what } = await ctx.body(req).catch(() => ({}));
  const emit = ctx.stream(res);
  try {
    if (what === "ping") {
      // Tous les serveurs en même temps : chaque résultat arrive dès qu'il est prêt.
      emit({ type: "step", ids: GAME_SERVERS.map((sv) => sv.id) });
      await Promise.all(GAME_SERVERS.map(async (sv) => emit({ type: "ping", id: sv.id, ...(await pingServer(sv)) })));
      emit({ type: "done" });
      return;
    }
    // Latence au repos, puis pendant un gros téléchargement et un envoi.
    emit({ type: "step", phase: "idle", label: "Latence au repos" });
    const idle = await measure(BLOAT_REF, 10);
    emit({ type: "idle", idle });
    const loaded = async (kind) => {
      const stop = Date.now() + 8000;
      let bytes = 0, refused = null;
      const t0 = Date.now();
      const load = Array.from({ length: kind === "down" ? 4 : 2 }, async () => {
        while (Date.now() < stop) {
          try {
            if (kind === "down") {
              const r = await fetch("https://speed.cloudflare.com/__down?bytes=25000000", { signal: AbortSignal.timeout(10000) });
              if (!r.ok) { refused = r.status; throw new Error(`téléchargement refusé (${r.status})`); }
              for await (const c of r.body) { bytes += c.length; if (Date.now() > stop) break; }
            } else {
              const body = Buffer.alloc(4 * 1024 * 1024);
              const r = await fetch("https://speed.cloudflare.com/__up", { method: "POST", body, signal: AbortSignal.timeout(12000) });
              if (!r.ok) { refused = r.status; throw new Error(`envoi refusé (${r.status})`); }
              bytes += body.length;
            }
          } catch { break; }
        }
      });
      await new Promise((r) => setTimeout(r, 1200));   // laisser la charge s'installer
      const t = [];
      while (Date.now() < stop - 300) {
        const v = await tcpPing(BLOAT_REF.host, BLOAT_REF.port);
        t.push(v);
        if (v != null) emit({ type: "live", phase: kind, ms: Math.round(v) });
        await new Promise((r) => setTimeout(r, 200));
      }
      await Promise.all(load);
      return { ...stats(t, t.length), mbps: Math.round((bytes * 8) / ((Date.now() - t0) / 1000) / 1e6),
        // 429 : Cloudflare limite les tests répétés à la suite.
        reason: refused === 429 ? "Cloudflare limite les tests répétés : réessaie dans quelques minutes" : refused ? `serveur de test indisponible (${refused})` : null };
    };
    emit({ type: "step", phase: "down", label: "Latence pendant un téléchargement" });
    const down = await loaded("down");
    emit({ type: "step", phase: "up", label: "Latence pendant un envoi" });
    const up = await loaded("up");
    const valid = [down, up].filter((p) => p.mbps > 5 && p.avg != null);
    down.failed = down.mbps <= 5; up.failed = up.mbps <= 5;
    if (!valid.length) throw new Error(down.reason || up.reason || "Impossible de charger la connexion pour la mesure (serveur de test injoignable).");
    const worst = Math.max(...valid.map((p) => p.avg - (idle.avg ?? 0)));
    const grade = worst < 5 ? "A+" : worst < 30 ? "A" : worst < 60 ? "B" : worst < 200 ? "C" : worst < 400 ? "D" : "F";
    emit({ type: "done", bufferbloat: { idle, down, up, extra: Math.round(worst), grade } });
  } catch (e) {
    emit({ type: "error", error: e.message });
  } finally {
    res.end();
  }
};

module.exports = { stats, tcpPing, icmpPing, measure, ratedFromPart, dirStat, natInfo, servers, testRoute, GAME_SERVERS };
