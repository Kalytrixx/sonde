// Gaming (Debian) : mêmes routes et mêmes données que la version Windows.
// - Écrans : fréquences lues dans GNOME (Mutter), ou xrandr sous X11.
// - RAM : dmidecode, avec le mot de passe administrateur (à la demande).
// - Carte graphique : sysfs (port PCIe, Resizable BAR, mémoire vidéo), Mesa ou pilote NVIDIA.
// - Réglages : profil d'énergie (power-profiles-daemon), accélération de la
//   souris (GNOME), GameMode de Feral.
// - Jeux Steam (manifestes), disques (lsblk), caches de shaders (Mesa, NVIDIA, Steam).
// - Réseau : la partie commune est dans lib/gaming-net.js.
// Chaque changement est confirmé dans la page et journalisé avec de quoi revenir en arrière.

const fs = require("fs");
const os = require("os");
const path = require("path");
const sh = require("../../sh");
const G = require("../../gaming-net");
const netHelpers = () => require("./network").helpers;

const HOME = os.homedir();
const read = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return null; } };
const MIN_GAME = 300 * 1024 ** 2;

// Launchers et overlays sous Linux.
const BACKGROUND = [
  { re: /^(steam|steamwebhelper)$/i, name: "Steam", app: /^steam$/i, kind: "launcher" },
  { re: /^heroic$/i, name: "Heroic Games Launcher", app: /heroic/i, kind: "launcher" },
  { re: /^lutris$/i, name: "Lutris", app: /^lutris$/i, kind: "launcher" },
  { re: /^bottles$/i, name: "Bottles", app: /bottles/i, kind: "launcher" },
  { re: /^itch$/i, name: "itch", app: /^itch$/i, kind: "launcher" },
  { re: /^(Discord|discord)$/, name: "Discord", app: /discord/i, kind: "overlay" },
];
const CONN = (c) => (/^DP|DisplayPort/i.test(c) ? "DisplayPort" : /^HDMI/i.test(c) ? "HDMI" : /^eDP|^LVDS/i.test(c) ? "écran intégré" : /^DVI/i.test(c) ? "DVI" : null);
const PCIE_GEN = { "2.5": 1, "5.0": 2, "8.0": 3, "16.0": 4, "32.0": 5, "64.0": 6 };
const PROFILES = { saver: "power-saver", balanced: "balanced", high: "performance" };
// GameMode et ses dépendances (seuls paquets que Sonde installe ou retire ici).
const GAMEMODE_PKGS = ["gamemode", "gamemode-daemon", "libgamemode0", "libgamemodeauto0"];
async function installedPkgs(names) {
  const out = await sh.exec("dpkg-query", ["-W", "-f=${Package} ${Status}\n", ...names], { okCodes: [0, 1] }).catch(() => "");
  return out.split("\n").filter((l) => / install ok installed$/.test(l)).map((l) => l.split(" ")[0].replace(/:.*$/, ""));
}

// --------------------------------------------------------------- écrans ---
// GNOME (Wayland ou X11) : org.gnome.Mutter.DisplayConfig.GetCurrentState.
async function displaysMutter() {
  const out = await sh.tryExec("gdbus", ["call", "--session", "--dest", "org.gnome.Mutter.DisplayConfig",
    "--object-path", "/org/gnome/Mutter/DisplayConfig", "--method", "org.gnome.Mutter.DisplayConfig.GetCurrentState"], { timeout: 8000 });
  if (!out) return null;
  const primary = new Set([...out.matchAll(/\(-?\d+, -?\d+, [\d.]+, uint32 \d+, true, \[\('([^']+)'/g)].map((m) => m[1]));
  const starts = [...out.matchAll(/\(\('([^']+)', '([^']*)', '([^']*)', '([^']*)'\), \[/g)];
  const res = [];
  starts.forEach((m, i) => {
    const chunk = out.slice(m.index, starts[i + 1]?.index ?? out.length);
    const modes = [...chunk.matchAll(/\('[^']+', (\d+), (\d+), ([\d.]+), [^[]*\[[^\]]*\], \{([^}]*)\}\)/g)]
      .map((x) => ({ w: +x[1], h: +x[2], hz: Math.round(+x[3]), current: /'is-current': <true>/.test(x[4]) }));
    const cur = modes.find((x) => x.current);
    if (!cur) return;   // écran éteint
    const same = [...new Set(modes.filter((x) => x.w === cur.w && x.h === cur.h).map((x) => x.hz))].sort((a, b) => a - b);
    res.push({ device: m[1], name: /'display-name': <'([^']*)'>/.exec(chunk)?.[1] || [m[2], m[3]].filter(Boolean).join(" ") || m[1],
      conn: CONN(m[1]), width: cur.w, height: cur.h, hz: cur.hz, modes: same, max: Math.max(cur.hz, ...same), primary: primary.has(m[1]) });
  });
  return res;
}
// X11 sans GNOME : xrandr.
async function displaysXrandr() {
  const out = await sh.tryExec("xrandr", ["--query"], { timeout: 8000 });
  if (!out) return null;
  const res = [];
  let cur = null;
  for (const l of out.split("\n")) {
    const h = /^(\S+) connected( primary)?(?: (\d+)x(\d+))?/.exec(l);
    if (h) { cur = h[3] ? { device: h[1], name: h[1], conn: CONN(h[1]), width: +h[3], height: +h[4], hz: 0, modes: [], primary: !!h[2] } : null; if (cur) res.push(cur); continue; }
    if (/^\S/.test(l)) { cur = null; continue; }
    const m = /^\s+(\d+)x(\d+)\S*\s+(.*)$/.exec(l);
    if (!cur || !m || +m[1] !== cur.width || +m[2] !== cur.height) continue;
    for (const r of m[3].matchAll(/([\d.]+)(\*)?/g)) {
      const hz = Math.round(+r[1]);
      if (!hz) continue;
      cur.modes.push(hz);
      if (r[2]) cur.hz = hz;
    }
  }
  for (const d of res) { d.modes = [...new Set(d.modes)].sort((a, b) => a - b); d.max = Math.max(d.hz, ...d.modes); }
  return res.filter((d) => d.hz);
}

// ------------------------------------------------------- carte graphique ---
function pciLink(dir) {
  const width = Number(read(path.join(dir, "current_link_width"))) || null;
  const maxWidth = Number(read(path.join(dir, "max_link_width"))) || null;
  const gen = PCIE_GEN[/^([\d.]+)/.exec(read(path.join(dir, "current_link_speed")) || "")?.[1]] || null;
  const maxGen = PCIE_GEN[/^([\d.]+)/.exec(read(path.join(dir, "max_link_speed")) || "")?.[1]] || null;
  return { width, maxWidth, gen, maxGen };
}
async function gpus() {
  const base = "/sys/bus/pci/devices";
  let list = [];
  try { list = fs.readdirSync(base); } catch { return []; }
  const mesa = (await sh.tryExec("dpkg-query", ["-W", "-f=${Version}", "libgl1-mesa-dri"])).trim() || null;
  const out = [];
  for (const slot of list) {
    const dir = path.join(base, slot);
    const cls = read(path.join(dir, "class")) || "";
    if (!/^0x03(00|02|80)/.test(cls)) continue;
    const vid = read(path.join(dir, "vendor"));
    const vendor = vid === "0x1002" ? "amd" : vid === "0x10de" ? "nvidia" : vid === "0x8086" ? "intel" : "autre";
    let name = { amd: "Carte graphique AMD", nvidia: "Carte graphique NVIDIA", intel: "Carte graphique Intel" }[vendor] || "Carte graphique";
    if (sh.which("lspci")) {
      const f = (await sh.tryExec("lspci", ["-mm", "-s", slot])).match(/"([^"]*)"/g)?.map((x) => x.slice(1, -1));
      if (f?.[2]) name = `${f[1].replace(/Advanced Micro Devices, Inc\. \[AMD\/ATI\]/, "AMD").replace(/ Corporation/, "")} ${f[2].replace(/^.*\[(.+)\]$/, "$1")}`;
    }
    let driver = null;
    try { driver = path.basename(fs.readlinkSync(path.join(dir, "driver"))); } catch {}
    // Mémoire vidéo : amdgpu l'expose ; NVIDIA via nvidia-smi.
    let vram = Number(read(path.join(dir, "mem_info_vram_total"))) || null;
    if (!vram && vendor === "nvidia" && sh.which("nvidia-smi")) {
      const mib = Number((await sh.tryExec("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"])).split("\n")[0]);
      if (mib) vram = mib * 1024 ** 2;
    }
    // Port PCIe : une carte AMD dédiée a son propre commutateur interne ;
    // le vrai lien avec l'emplacement est sur le commutateur le plus haut.
    let linkDir = dir;
    try {
      const real = fs.realpathSync(dir).split("/");
      for (let i = real.length - 2; i > 0; i--) {
        const up = real.slice(0, i + 1).join("/");
        if (!/^[0-9a-f]{4}:/.test(real[i]) || read(path.join(up, "vendor")) !== vid) break;
        linkDir = up;
      }
    } catch {}
    const link = pciLink(linkDir);
    // Resizable BAR : taille de la plus grande fenêtre mémoire de la carte.
    let rebar = null;
    const bars = (read(path.join(dir, "resource")) || "").split("\n").map((l) => l.split(/\s+/).map((x) => BigInt(x || "0")))
      .filter((b) => b.length >= 2 && b[1] > b[0]).map((b) => Number(b[1] - b[0] + 1n));
    const big = Math.max(0, ...bars);
    if (big) rebar = vram ? big >= vram * 0.5 : big > 512 * 1024 ** 2 ? true : big <= 256 * 1024 ** 2 ? false : null;
    // Version du pilote
    let software = null, driverLabel = "Pilote", driverText = null;
    if (driver === "nvidia") {
      software = /Kernel Module\s+([\d.]+)/.exec(read("/proc/driver/nvidia/version") || "")?.[1] || null;
      driverLabel = "Pilote NVIDIA";
      driverText = "Le pilote NVIDIA de Debian (paquet nvidia-driver) se met à jour avec le système.";
    } else {
      software = mesa ? `Mesa ${mesa.replace(/-.*$/, "")}` : null;
      driverLabel = `Pilote libre (${driver || "Mesa"})`;
      driverText = `Module ${driver || "graphique"} du noyau ${os.release()}${mesa ? ` et Mesa ${mesa}` : ""}. Ils se mettent à jour avec Debian ; les versions plus récentes de Mesa (dépôt « backports ») corrigent souvent des saccades dans les jeux récents.`;
    }
    out.push({ name, vendor, driver, software, driverLabel, driverText, date: null, age: null, vram, rebar, ...link });
  }
  return out;
}

// --------------------------------------------------------------- disques ---
async function disks() {
  const j = await sh.json("lsblk", ["-J", "-b", "-o", "NAME,TYPE,ROTA,TRAN,MODEL,MOUNTPOINTS,FSAVAIL,FSSIZE"]).catch(() => null);
  const out = [];
  const seen = new Set();   // une partition montée à plusieurs endroits ne compte qu'une fois
  const walk = (n, top) => {
    const mps = (n.mountpoints || []).filter(Boolean).sort((a, b) => a.length - b.length);
    for (const mp of mps) {
      if (seen.has(n.name)) break;
      if (!/^\/($|home|mnt\/|media\/|srv|opt|data|games)/i.test(mp) || /^\/boot/.test(mp)) continue;
      out.push({ letter: mp, tile: mp === "/" ? "/" : path.basename(mp).slice(0, 4), model: top.model?.trim() || null,
        media: top.tran === "nvme" ? "SSD NVMe" : (top.rota === true || top.rota === "1") ? "Disque dur" : "SSD",
        free: Number(n.fsavail) || 0, size: Number(n.fssize) || 0 });
      seen.add(n.name);
    }
    for (const c of n.children || []) walk(c, top);
  };
  for (const d of j?.blockdevices || []) if (d.type === "disk") walk(d, d);
  return out;
}
const mountOf = (p, list) => list.filter((d) => p === d.letter || p.startsWith(d.letter === "/" ? "/" : d.letter + "/")).sort((a, b) => b.letter.length - a.letter.length)[0] || null;

// ------------------------------------------------------------ jeux Steam ---
function steamLibraries() {
  const roots = [path.join(HOME, ".local/share/Steam"), path.join(HOME, ".steam/steam"), path.join(HOME, ".var/app/com.valvesoftware.Steam/.local/share/Steam")];
  const libs = new Set();
  for (const r of roots) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; }
    libs.add(real);
    const vdf = read(path.join(real, "steamapps", "libraryfolders.vdf")) || "";
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) { try { libs.add(fs.realpathSync(m[1])); } catch {} }
  }
  return [...libs];
}
function steamGames(libs) {
  const games = [];
  for (const lib of libs) {
    let files = [];
    try { files = fs.readdirSync(path.join(lib, "steamapps")).filter((f) => /^appmanifest_\d+\.acf$/.test(f)); } catch {}
    for (const f of files) {
      const t = read(path.join(lib, "steamapps", f)) || "";
      const v = (k) => new RegExp(`"${k}"\\s+"([^"]*)"`).exec(t)?.[1];
      const name = v("name");
      if (!name || /^(Steamworks Common Redistributables|Proton|Steam Linux Runtime)/i.test(name)) continue;
      games.push({ name, location: path.join(lib, "steamapps", "common", v("installdir") || name), size: Number(v("SizeOnDisk")) || 0,
        lastUsed: Number(v("LastPlayed")) ? Number(v("LastPlayed")) * 1000 : null });
    }
  }
  return games;
}

// ------------------------------------------------------ caches de shaders ---
function shaderCaches(libs) {
  const C = path.join(HOME, ".cache");
  const list = [
    { id: "mesa", name: "Cache de shaders Mesa", path: path.join(C, "mesa_shader_cache") },
    { id: "mesa-db", name: "Cache de shaders Mesa (base unique)", path: path.join(C, "mesa_shader_cache_db") },
    { id: "nv-gl", name: "Cache de shaders NVIDIA", path: path.join(C, "nvidia", "GLCache") },
    { id: "nv-old", name: "Cache de shaders NVIDIA (ancien)", path: path.join(HOME, ".nv", "GLCache") },
  ];
  for (const lib of libs) list.push({ id: `steam-${lib}`, name: libs.length > 1 ? `Cache de shaders Steam (${lib})` : "Cache de shaders Steam", path: path.join(lib, "steamapps", "shadercache") });
  return list.map((c) => ({ ...c, ...G.dirStat(c.path) })).filter((c) => c.size > 0);
}

// -------------------------------------------- restes de jeux désinstallés ---
// Steam garde souvent, après une désinstallation : le préfixe Proton
// (steamapps/compatdata/<appid>, 0,5 à 1 Go), le cache de shaders du jeu
// (steamapps/shadercache/<appid>) et parfois le dossier du jeu (steamapps/common).
// Un préfixe peut contenir des sauvegardes (jeux sans sauvegarde dans le
// cloud) : il est alors marqué « à vérifier » avec les dossiers concernés.
const SAVE_DIRS = ["Documents", "Saved Games", "AppData/Roaming", "AppData/LocalLow", "AppData/Local"];
const NOT_SAVES = /^(Microsoft|Temp|My Music|My Pictures|My Videos|Desktop|Downloads|CrashDumps|D3DSCache|NVIDIA|AMD|openvr|cache)$/i;
function prefixSaves(prefix) {
  const user = path.join(prefix, "pfx", "drive_c", "users", "steamuser");
  const found = [];
  for (const d of SAVE_DIRS) {
    let names = [];
    try { names = fs.readdirSync(path.join(user, d), { withFileTypes: true }).filter((e) => e.isDirectory() && !NOT_SAVES.test(e.name)).map((e) => e.name); } catch {}
    for (const n of names) {
      // « My Games » regroupe les sauvegardes de nombreux jeux : on descend d'un niveau.
      const sub = /^My Games$/i.test(n) ? (() => { try { return fs.readdirSync(path.join(user, d, n)).map((x) => `${n}/${x}`); } catch { return []; } })() : [n];
      for (const s of sub) if (G.dirStat(path.join(user, d, s)).size > 0) found.push(`${d}/${s}`);
    }
  }
  return found;
}
// Nom d'un jeu désinstallé : demandé à la boutique Steam (seul l'identifiant part), gardé en mémoire.
const gameNames = new Map();
async function steamName(appid) {
  if (gameNames.has(appid)) return gameNames.get(appid);
  let name = null;
  try {
    const r = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic&l=french`, { signal: AbortSignal.timeout(6000) });
    name = (await r.json())?.[appid]?.data?.name || null;
  } catch {}
  gameNames.set(appid, name);
  return name;
}
async function gameLeftovers(libs) {
  const installed = new Set(), dirs = new Set();
  for (const lib of libs) {
    let files = [];
    try { files = fs.readdirSync(path.join(lib, "steamapps")); } catch {}
    for (const f of files) {
      const m = /^appmanifest_(\d+)\.acf$/.exec(f);
      if (!m) continue;
      installed.add(m[1]);
      const dir = /"installdir"\s+"([^"]*)"/.exec(read(path.join(lib, "steamapps", f)) || "")?.[1];
      if (dir) dirs.add(dir.toLowerCase());
    }
  }
  const out = [];
  for (const lib of libs) {
    const sa = path.join(lib, "steamapps");
    // Les raccourcis hors Steam ont des identifiants au-delà de 2^31 : leurs préfixes ne sont pas touchés.
    const orphanIds = (sub) => { try { return fs.readdirSync(path.join(sa, sub)).filter((x) => /^\d+$/.test(x) && x !== "0" && Number(x) < 2 ** 31 && !installed.has(x)); } catch { return []; } };
    for (const id of orphanIds("compatdata")) {
      const p = path.join(sa, "compatdata", id);
      out.push({ kind: "prefix", appid: id, path: p, ...G.dirStat(p), saves: prefixSaves(p) });
    }
    for (const id of orphanIds("shadercache")) {
      const p = path.join(sa, "shadercache", id);
      out.push({ kind: "shader", appid: id, path: p, ...G.dirStat(p), saves: [] });
    }
    let common = [];
    try { common = fs.readdirSync(path.join(sa, "common"), { withFileTypes: true }).filter((e) => e.isDirectory() && !dirs.has(e.name.toLowerCase())).map((e) => e.name); } catch {}
    for (const n of common) {
      const p = path.join(sa, "common", n);
      out.push({ kind: "files", name: n, path: p, ...G.dirStat(p), saves: [] });
    }
  }
  const keep = out.filter((x) => x.size > 1024 ** 2).sort((a, b) => b.size - a.size).slice(0, 40);
  await Promise.all(keep.filter((x) => x.appid).map(async (x) => { x.name = (await steamName(x.appid)) || `Jeu n° ${x.appid}`; }));
  return keep;
}

// ------------------------------------------------------------- réglages ---
async function powerProfile() {
  if (!sh.which("powerprofilesctl")) return null;
  const active = (await sh.tryExec("powerprofilesctl", ["get"])).trim();
  const avail = [...(await sh.tryExec("powerprofilesctl", ["list"])).matchAll(/^\s*\*?\s*([\w-]+):\s*$/gm)].map((m) => m[1]);
  return { active: Object.keys(PROFILES).find((k) => PROFILES[k] === active) || null, name: active || null, available: Object.keys(PROFILES).filter((k) => avail.includes(PROFILES[k])) };
}
async function mouseProfile() {
  if (!sh.which("gsettings")) return null;
  const v = (await sh.tryExec("gsettings", ["get", "org.gnome.desktop.peripherals.mouse", "accel-profile"])).trim().replace(/'/g, "");
  return v || null;
}
function secureBoot() {
  if (!fs.existsSync("/sys/firmware/efi")) return "legacy";
  try {
    const f = fs.readdirSync("/sys/firmware/efi/efivars").find((x) => x.startsWith("SecureBoot-"));
    if (!f) return null;
    const b = fs.readFileSync(path.join("/sys/firmware/efi/efivars", f));
    return b[b.length - 1] === 1;
  } catch { return null; }
}

// RAM : dmidecode (droits administrateur).
function parseDmi(txt) {
  const sticks = [];
  for (const block of txt.split(/\n(?=Handle )/)) {
    if (!/Memory Device/.test(block)) continue;
    const f = (k) => new RegExp(`^\\s*${k}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
    const sz = /^(\d+)\s*(GB|MB)/.exec(f("Size") || "");
    if (!sz) continue;
    sticks.push({ size: Number(sz[1]) * (sz[2] === "GB" ? 1024 ** 3 : 1024 ** 2), type: f("Type"), speed: Number(/\d+/.exec(f("Speed") || "")?.[0]) || 0,
      configured: Number(/\d+/.exec(f("Configured Memory Speed") || f("Configured Clock Speed") || "")?.[0]) || 0, part: (f("Part Number") || "").trim() });
  }
  if (!sticks.length) return null;
  const conf = Math.min(...sticks.map((m) => m.configured || m.speed));
  const rated = Math.max(0, ...sticks.map((m) => G.ratedFromPart(m.part) || 0)) || null;
  const ddr = /DDR\d/.exec(sticks[0].type || "")?.[0] || "";
  const base = ddr === "DDR5" ? 4800 : ddr === "DDR4" ? 2666 : 0;
  const cl = /F[45]-\d{4}[A-Z](\d{2})/i.exec(sticks[0].part)?.[1] || /\d{4}C(\d{2})/i.exec(sticks[0].part)?.[1] || null;
  return { conf, rated, ddr, cl, profile: ddr === "DDR4" ? "XMP" : "EXPO", count: sticks.length, stick: sticks[0].size,
    total: sticks.reduce((a, m) => a + m.size, 0), part: sticks[0].part || null, slow: rated ? conf < rated - 200 : !!(base && conf <= base) };
}

module.exports = (ctx) => {
  const setProfile = (p) => sh.exec("powerprofilesctl", ["set", p]);
  const setAccel = (v) => sh.exec("gsettings", ["set", "org.gnome.desktop.peripherals.mouse", "accel-profile", v]);
  ctx.reverters["gaming-ppd"] = ({ profile }) => setProfile(profile);
  ctx.reverters["gaming-accel"] = ({ value }) => setAccel(value);
  ctx.reverters["gaming-apt-remove"] = ({ pkgs }) => {
    const list = [].concat(pkgs || []).filter((p) => GAMEMODE_PKGS.includes(p));
    return list.length ? sh.runElevated('DEBIAN_FRONTEND=noninteractive apt-get remove -y "$@"', list) : null;
  };

  let last = null, ram = null;

  async function info() {
    const [mutter, gpuList, diskList, power, accel, procsTxt, uuActive] = await Promise.all([
      displaysMutter(), gpus(), disks(), powerProfile(), mouseProfile(),
      sh.tryExec("ps", ["-eo", "comm=,rss="]), sh.tryExec("systemctl", ["is-enabled", "unattended-upgrades"]),
    ]);
    const displays = mutter?.length ? mutter : (await displaysXrandr()) || [];
    const libs = steamLibraries();

    // --- Jeux : manifestes Steam, puis dossiers de jeux vus par le scan.
    const games = new Map();
    const add = (g) => {
      const k = g.name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (games.has(k)) return;
      const m = mountOf(g.location, diskList);
      games.set(k, { ...g, drive: m?.letter || "?", media: m?.media || "?" });
    };
    for (const g of steamGames(libs)) add(g);
    const scan = ctx.getScan();
    if (scan) for (const d of scan.index.values()) {
      const m = /\/steamapps\/common\/([^/]+)$|\/Games\/Heroic\/([^/]+)$|\/Games\/([^/]+)$/.exec(d.path);
      const name = m?.slice(1).find(Boolean);
      if (name && !/^(Heroic|Steamworks Shared|Proton.*|SteamLinuxRuntime.*)$/i.test(name)) add({ name, location: d.path, size: d.size, lastUsed: d.atime || null });
    }
    const gameList = [...games.values()].filter((g) => g.size >= MIN_GAME).sort((a, b) => b.size - a.size);
    for (const d of diskList) d.games = gameList.filter((g) => g.drive === d.letter).map((g) => g.name);

    // --- En fond
    const procs = procsTxt.split("\n").map((l) => /^(.*\S)\s+(\d+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ name: m[1], mem: Number(m[2]) * 1024 }));
    const background = [];
    for (const b of BACKGROUND) {
      const p = procs.filter((x) => b.re.test(x.name));
      if (p.length) background.push({ name: b.name, kind: b.kind, mem: p.reduce((a, x) => a + x.mem, 0), count: p.length });
    }
    const launcherUse = {};
    try {
      for (const a of await ctx.listApps()) {
        const b = BACKGROUND.find((x) => x.app.test(a.name));
        if (b && a.lastUsed) launcherUse[b.name] = Math.max(launcherUse[b.name] || 0, a.lastUsed);
      }
    } catch {}
    const overlays = background.filter((b) => b.kind === "overlay" || b.name === "Steam");
    const aptBusy = procs.some((p) => /^(apt|apt-get|dpkg)$/.test(p.name))   // unattended-upgr tourne en permanence (attente);
    const uu = uuActive.trim() === "enabled";
    const bgNow = [
      { icon: "overlay", name: overlays.length ? `Overlays : ${overlays.map((b) => b.name).join(", ")}` : "Overlays",
        desc: overlays.length ? "Actifs dans tous les jeux. Coût faible, sauf avec certains anti-triche." : "Aucun overlay ne tourne en ce moment." },
      { icon: "update", kind: "updates", name: "Mises à jour de Debian",
        desc: aptBusy ? "Une installation de paquets est en cours en ce moment." : uu ? "Les mises à jour de sécurité automatiques sont actives : elles s'installent en arrière-plan, rarement pendant une partie." : "Pas de mise à jour automatique : elles se font depuis la page Mises à jour.",
        short: aptBusy ? "Installation en cours" : uu ? "Automatiques (sécurité)" : "À la main" },
    ];

    // --- Réglages liés au jeu
    // État du paquet, relu à chaque fois (une installation faite depuis Sonde se voit tout de suite).
    const gm = (await installedPkgs(["gamemode"])).length > 0;
    const tweaks = [
      { id: "gamemode", kind: "info", title: "GameMode (Feral)", ok: gm, tag: gm ? "Installé" : "Conseil : installer",
        desc: gm ? "Les jeux qui le demandent passent en priorité, avec le processeur à pleine fréquence. Pour un jeu Steam : options de lancement « gamemoderun %command% ». Beaucoup de jeux Feral et Lutris l'utilisent tout seuls."
          : "L'équivalent du mode Jeu de Windows : priorité au jeu et processeur à pleine fréquence pendant la partie, puis retour à la normale. Paquet Debian « gamemode ».",
        action: gm ? null : { id: "gamemode-install", label: "Installer", admin: true, title: "Installer GameMode ?",
          body: "Sonde installe le paquet Debian « gamemode » (apt). Ensuite, pour un jeu Steam, ajoute « gamemoderun %command% » dans ses options de lancement. Annulable depuis le journal.",
          done: "GameMode installé. Annulable depuis le journal." } },
    ];
    if (power) tweaks.push({ id: "power", kind: "seg", title: "Mode d'alimentation", value: power.active, ok: power.active !== "saver",
      tag: power.active === "saver" ? "Conseil : Équilibré" : "Bien réglé",
      options: [["saver", "Économie"], ["balanced", "Équilibré"], ["high", "Performances"]].map(([k, label]) => ({ k, label, disabled: !power.available.includes(k) })),
      confirm: "Même réglage que le mode d'énergie de GNOME (Paramètres › Énergie).",
      desc: "Sur un PC fixe récent, Équilibré suffit : le processeur monte en fréquence en quelques millisecondes. Performances évite seulement de rares baisses de fréquence. Économie bride le jeu." });
    else tweaks.push({ id: "power", kind: "info", title: "Mode d'alimentation", ok: null, tag: "Non disponible",
      desc: "power-profiles-daemon n'est pas installé : le mode d'énergie ne se règle pas depuis Sonde." });
    if (accel) tweaks.push({ id: "mouse", kind: "toggle", title: "Accélération de la souris", on: accel !== "flat", keepOn: false,
      desc: "La distance parcourue par le pointeur dépend de la vitesse du geste. La couper (profil « plat ») rend la visée constante. Beaucoup de jeux l'ignorent déjà." });

    // --- Protection du système
    const sb = secureBoot();
    const security = { title: "Démarrage sécurisé (Secure Boot)", tag: sb === true ? "Activé" : sb === false ? "Désactivé" : sb === "legacy" ? "BIOS ancien" : "Non disponible",
      text: sb === true ? "Le micrologiciel vérifie que le chargeur et le noyau sont signés. Aucun coût en jeu. Avec le pilote NVIDIA propriétaire, son module doit être signé : Debian le propose à l'installation (DKMS)."
        : sb === false ? "Désactivé : un chargeur de démarrage modifié ne serait pas détecté. Aucun effet sur les FPS ; il se réactive dans le BIOS, si tu n'utilises pas de module non signé."
          : sb === "legacy" ? "Le PC démarre en mode BIOS ancien (pas UEFI) : le démarrage sécurisé n'existe pas dans ce mode." : "Le système ne donne pas cette information.",
      tool: null };

    // --- Points à regarder
    const issues = [];
    for (const d of displays) if (d.max > d.hz + 5) issues.push(`${d.name} à ${d.hz} Hz`);
    if (ram?.slow) issues.push("RAM sous sa vitesse prévue");
    if (power?.active === "saver") issues.push("mode Économie");
    if (accel && accel !== "flat") issues.push("accélération de la souris");

    last = { power, accel };
    return { canSetHz: false, displayNote: displays.length ? null : "Écrans : Non disponible (GNOME ou xrandr introuvable).",
      ramSource: "dmidecode", ram, ramAdmin: !ram, displays, gpus: gpuList, tweaks, bgNow, security, disks: diskList, games: gameList,
      background: background.sort((a, b) => b.mem - a.mem), launcherUse, wuPause: null, issues, shaders: shaderCaches(libs),
      leftovers: await gameLeftovers(libs), servers: G.servers() };
  }

  return {
    "GET /api/gaming": async () => info(),

    // RAM : lue une fois avec le mot de passe administrateur, puis gardée en mémoire.
    "POST /api/gaming/ram": async () => {
      if (!sh.which("dmidecode") && !fs.existsSync("/usr/sbin/dmidecode")) throw new Error("dmidecode est introuvable : installe le paquet « dmidecode ».");
      ram = parseDmi(await sh.runElevated("dmidecode -t 17"));
      if (!ram) throw new Error("Les barrettes de mémoire n'ont pas pu être lues.");
      return ram;
    },

    // Réseau pour le jeu : câble ou Wi-Fi, débit en cours, NAT et UPnP.
    "GET /api/gaming/net": async () => {
      const h = netHelpers();
      const [ads, wifi, gw] = await Promise.all([h.adapters().catch(() => []), h.wifiInfo().catch(() => null), h.gateway().catch(() => null)]);
      const a = ads.find((x) => x.ip && !x.wifi) || ads.find((x) => x.ip) || ads[0] || null;
      let rate = null;
      if (a) {
        const s = (k) => Number(read(`/sys/class/net/${a.name}/statistics/${k}`)) || 0;
        const r1 = s("rx_bytes"), t1 = s("tx_bytes");
        await new Promise((r) => setTimeout(r, 2000));
        rate = { down: (s("rx_bytes") - r1) / 2, up: (s("tx_bytes") - t1) / 2 };
      }
      return { adapter: a ? { name: a.name, desc: a.desc, speed: a.speed, wifi: a.wifi } : null, wifi, gateway: gw, rate, ...(await G.natInfo()) };
    },

    "POST /api/gaming/apply": async (req) => {
      const { id, params = {}, on } = await ctx.body(req);
      if (!last) await info();
      if (id === "power") {
        const p = PROFILES[params.plan];
        if (!p || !last.power?.available.includes(params.plan)) throw new Error("Ce mode d'alimentation n'existe pas sur ce PC.");
        await setProfile(p);
        const label = { saver: "Économie", balanced: "Équilibré", high: "Performances" }[params.plan];
        ctx.journal.add({ kind: "system", title: `Mode d'alimentation : ${label}`, revert: last.power.name ? { type: "gaming-ppd", args: { profile: last.power.name } } : undefined });
      } else if (id === "mouse") {
        if (!last.accel) throw new Error("Réglage de la souris introuvable (GNOME).");
        await setAccel(on ? "default" : "flat");
        ctx.journal.add({ kind: "system", title: `Accélération de la souris ${on ? "activée" : "désactivée"}`, revert: { type: "gaming-accel", args: { value: last.accel } } });
      } else if (id === "gamemode-install") {
        // L'annulation ne retire que les paquets ajoutés par cette installation.
        const before = await installedPkgs(GAMEMODE_PKGS);
        await sh.runElevated("DEBIAN_FRONTEND=noninteractive apt-get install -y gamemode");
        const added = (await installedPkgs(GAMEMODE_PKGS)).filter((p) => !before.includes(p));
        ctx.journal.add({ kind: "system", title: "GameMode installé (paquet gamemode)", revert: added.length ? { type: "gaming-apt-remove", args: { pkgs: added } } : undefined });
      } else throw new Error("Réglage inconnu.");
      last = null;
      return { ok: true };
    },

    // En flux : ping des serveurs de jeu, ou latence sous charge (lib/gaming-net.js).
    "POST /api/gaming/test": G.testRoute(ctx),
  };
};
