// Programmes installés sous Debian : applications (paquets apt avec un
// lanceur), gros paquets sans interface, applications Flatpak et Snap.
// Taille, dernière utilisation, désinstallation (avec aperçu de ce qu'apt
// emporterait) et recherche des restes dans le dossier personnel.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sh = require("../../sh");
const P = require("../../platform");
const { isProtected } = require("../../rules");
const { owners } = require("../../debian");

const HOME = P.HOME;
const DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");
const APP_DIRS = [
  "/usr/share/applications", "/usr/local/share/applications", path.join(DATA_HOME, "applications"),
  "/var/lib/flatpak/exports/share/applications", path.join(DATA_HOME, "flatpak/exports/share/applications"),
  "/var/lib/snapd/desktop/applications",
];
const ICON_BASES = [path.join(DATA_HOME, "icons"), path.join(HOME, ".icons"), "/usr/local/share/icons", "/usr/share/icons",
  "/var/lib/flatpak/exports/share/icons", path.join(DATA_HOME, "flatpak/exports/share/icons"), "/var/lib/snapd/desktop/icons"];
const ICON_SIZES = ["scalable", "256x256", "512x512", "128x128", "96x96", "64x64", "48x48", "32x32"];

// Paquets sans lesquels le bureau ou le système ne tient plus : jamais de
// bouton « Désinstaller » pour eux.
const CRITICAL = /^(apt|dpkg|base-files|bash|coreutils|dbus.*|systemd.*|udev|sudo|pkexec|polkitd|policykit-.*|libc6|init|gnome-shell|gnome-session.*|gnome-settings-daemon|gnome-control-center|gdm3|mutter|nautilus|gnome-core|gnome|task-.*|network-manager|xwayland|xserver-xorg-core|pipewire.*|wireplumber|grub-.*|shim-.*|linux-image-amd64|firmware-linux.*|sonde)$/;
// Une désinstallation qui emporterait l'un de ceux-là est refusée.
const BREAKS_DESKTOP = /^(gnome-shell|gnome-session|gdm3|gnome-core|task-gnome-desktop|task-desktop|gnome-control-center|network-manager|systemd|apt|sudo|pipewire|wireplumber|xwayland)$/;
const BIG_PKG = 50 * 1024 * 1024;   // gros paquet sans lanceur : listé à part

// --------------------------------------------------------- fichiers .desktop -
function parseDesktop(file) {
  let txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return null; }
  const sec = /\[Desktop Entry\]([\s\S]*?)(?:\n\[|$)/.exec(txt)?.[1];
  if (!sec) return null;
  const v = {};
  for (const line of sec.split("\n")) {
    const m = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/.exec(line.trim());
    if (m && !(m[1] in v)) v[m[1]] = m[2];
  }
  if (v.Type !== "Application" || v.NoDisplay === "true" || v.Hidden === "true") return null;
  const desk = (process.env.XDG_CURRENT_DESKTOP || "GNOME").split(":");
  if (v.OnlyShowIn && !v.OnlyShowIn.split(";").some((d) => desk.includes(d))) return null;
  if (v.NotShowIn && v.NotShowIn.split(";").some((d) => desk.includes(d))) return null;
  const lang = (process.env.LANG || "fr").slice(0, 2);
  return {
    file, id: path.basename(file, ".desktop"),
    name: v[`Name[${lang}]`] || v.Name || path.basename(file, ".desktop"),
    comment: v[`Comment[${lang}]`] || v.Comment || "",
    icon: v.Icon || null, exec: v.Exec || "", flatpak: v["X-Flatpak"] || null, snap: v["X-SnapInstanceName"] || null,
  };
}

function desktopEntries() {
  const seen = new Map();   // id -> entrée (la première trouvée gagne, comme le bureau)
  for (const d of APP_DIRS) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith(".desktop")); } catch { continue; }
    for (const n of names) {
      const id = n.slice(0, -8);
      if (seen.has(id)) continue;
      const e = parseDesktop(path.join(d, n));
      if (e) seen.set(id, e);
    }
  }
  return [...seen.values()];
}

// Programme lancé par la ligne Exec, pour sa date de dernier accès.
function execPath(exec) {
  const first = (exec.match(/^\s*("([^"]+)"|\S+)/) || [])[2] || (exec.match(/^\s*(\S+)/) || [])[1];
  if (!first || first === "env") return null;
  return first.startsWith("/") ? first : sh.which(first);
}

// --------------------------------------------------------------- icônes ---
function findIcon(name, theme) {
  if (!name) return null;
  if (name.startsWith("/")) return fs.existsSync(name) ? name : null;
  const themes = [...new Set([theme, "hicolor", "Adwaita", "breeze"].filter(Boolean))];
  for (const base of ICON_BASES) {
    for (const t of themes) {
      for (const s of ICON_SIZES) {
        for (const ext of ["svg", "png"]) {
          const f = path.join(base, t, s, "apps", `${name}.${ext}`);
          if (fs.existsSync(f)) return f;
        }
      }
    }
  }
  for (const ext of ["svg", "png"]) {
    const f = path.join("/usr/share/pixmaps", `${name}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// ------------------------------------------------------------- paquets ---
async function dpkgInfo() {
  const out = await sh.exec("dpkg-query", ["-W", "-f",
    "${Package}\t${Version}\t${Installed-Size}\t${Maintainer}\t${db:Status-Abbrev}\t${Priority}\t${Essential}\t${binary:Summary}\n"], { timeout: 60000 });
  const map = new Map();
  for (const l of out.split("\n")) {
    const [pkg, version, kb, maint, status, priority, essential, summary] = l.split("\t");
    if (!pkg || !/^ii/.test(status || "")) continue;
    map.set(pkg, { pkg, version, size: Number(kb || 0) * 1024, maint: (maint || "").replace(/\s*<.*>$/, ""),
      priority, essential: essential === "yes", summary: summary || "" });
  }
  return map;
}

function installDate(pkg) {
  for (const f of [`/var/lib/dpkg/info/${pkg}.list`, `/var/lib/dpkg/info/${pkg}:amd64.list`, `/var/lib/dpkg/info/${pkg}:i386.list`]) {
    try { return fs.statSync(f).mtimeMs; } catch {}
  }
  return null;
}

// « 1,2 GB », « 345.6 MB » (flatpak list) -> octets
function humanBytes(s) {
  const m = /([\d.,]+)\s*([kMGT]?)B/i.exec(s || "");
  if (!m) return 0;
  return Number(m[1].replace(",", ".")) * { "": 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()];
}

async function flatpaks() {
  if (!sh.which("flatpak")) return [];
  const out = await sh.tryExec("flatpak", ["list", "--app", "--columns=application,name,version,size,origin,installation"], { timeout: 30000 });
  return out.split("\n").filter(Boolean).map((l) => {
    const [id, name, version, size, origin, installation] = l.split("\t");
    return { id, name, version, size: humanBytes(size), origin, installation };
  }).filter((f) => f.id && f.id.includes("."));
}

async function snaps() {
  if (!sh.which("snap")) return [];
  const out = await sh.tryExec("snap", ["list"], { timeout: 30000 });
  return out.split("\n").slice(1).filter(Boolean).map((l) => {
    const [name, version, rev, , publisher, notes] = l.split(/\s+/);
    let size = 0;
    try { size = fs.statSync(`/var/lib/snapd/snaps/${name}_${rev}.snap`).size; } catch {}
    return { name, version, rev, publisher: (publisher || "").replace(/\*$/, ""), size, base: /base|core|snapd/.test(notes || "") };
  }).filter((s) => !s.base && !/^(core\d*|snapd|bare|gnome-\d+-\d+|gtk-common-themes)$/.test(s.name));
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(v?\d+([.\-_]\d+)*|x64|x86|64-bit|32-bit|version|inc|ltd|llc|corporation|corp|gmbh|sa|sas)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

module.exports = (ctx) => {
  let cache = null;
  const iconDir = path.join(ctx.DATA, "icons");
  const hash = (k) => crypto.createHash("sha1").update(k).digest("hex").slice(0, 16);

  // L'icône est copiée une fois dans le dossier de données (PNG ou SVG).
  function iconFor(k, name, theme) {
    fs.mkdirSync(iconDir, { recursive: true });
    const h = hash(k);
    for (const ext of ["png", "svg"]) if (fs.existsSync(path.join(iconDir, `${h}.${ext}`))) return `/icons/${h}.${ext}`;
    if (fs.existsSync(path.join(iconDir, `${h}.none`))) return null;
    const src = findIcon(name, theme);
    const ext = src && path.extname(src).slice(1).toLowerCase();
    if (src && (ext === "png" || ext === "svg") && fs.statSync(src).size < 2e6) {
      try { fs.copyFileSync(src, path.join(iconDir, `${h}.${ext}`)); return `/icons/${h}.${ext}`; } catch {}
    }
    fs.writeFileSync(path.join(iconDir, `${h}.none`), "");
    return null;
  }

  async function list(force = false) {
    if (cache && !force && Date.now() - cache.at < 60000) return cache.items;
    const theme = (await sh.tryExec("gsettings", ["get", "org.gnome.desktop.interface", "icon-theme"], { timeout: 3000 })).trim().replace(/^'|'$/g, "");
    const [entries, pkgs, fps, sps] = await Promise.all([Promise.resolve(desktopEntries()), dpkgInfo(), flatpaks(), snaps()]);
    const debFiles = entries.filter((e) => !e.flatpak && !e.snap && /^\/usr\//.test(e.file)).map((e) => e.file);
    const own = await owners(debFiles);
    const items = [];
    const usedPkgs = new Set();

    // Applications venues de paquets Debian : un paquet = une ligne, même
    // s'il a plusieurs lanceurs (on garde le premier).
    for (const e of entries) {
      if (e.flatpak || e.snap) continue;
      const pkg = own.get(e.file);
      const info = pkg && pkgs.get(pkg);
      if (pkg && usedPkgs.has(pkg)) continue;
      if (pkg) usedPkgs.add(pkg);
      const bin = execPath(e.exec);
      let lastUsed = null;
      try { if (bin) lastUsed = fs.statSync(bin).atimeMs; } catch {}
      const k = pkg ? `deb:${pkg}` : `desktop:${e.id}`;
      items.push({
        key: k, kind: pkg ? "app" : "local", name: e.name, publisher: info?.maint || "", version: info?.version || "",
        size: info?.size || 0, sizeSource: info ? "paquet" : null, lastUsed, installed: pkg ? installDate(pkg) : null,
        location: bin ? path.dirname(bin) : null, desc: e.comment || info?.summary || "",
        canUninstall: !!pkg && !CRITICAL.test(pkg) && !info?.essential && !["required", "important"].includes(info?.priority),
        icon: iconFor(k, e.icon, theme), _pkg: pkg || null,
      });
    }
    // Gros paquets sans lanceur, installés à la main (outils, SDK, pilotes…).
    // Ceux installés automatiquement sont des dépendances : apt les retire
    // avec leur programme, ou via « Paquets devenus inutiles ».
    const running = (await sh.tryExec("uname", ["-r"])).trim();
    const manual = new Set((await sh.tryExec("apt-mark", ["showmanual"], { timeout: 30000 })).split("\n").map((l) => l.trim()));
    for (const info of pkgs.values()) {
      if (usedPkgs.has(info.pkg) || info.size < BIG_PKG || !manual.has(info.pkg) || /^lib/.test(info.pkg)) continue;
      const kernelInUse = info.pkg.endsWith(running) && /^linux-(image|headers|modules)/.test(info.pkg);
      const k = `deb:${info.pkg}`;
      items.push({
        key: k, kind: "pkg", name: info.pkg, publisher: info.maint, version: info.version, size: info.size, sizeSource: "paquet",
        lastUsed: null, installed: installDate(info.pkg), location: null, desc: info.summary,
        canUninstall: !CRITICAL.test(info.pkg) && !info.essential && !["required", "important"].includes(info.priority) && !kernelInUse,
        icon: null, _pkg: info.pkg,
      });
    }
    // Flatpak : dernière utilisation = dernière écriture dans ~/.var/app/<id>.
    const fpEntries = new Map(entries.filter((e) => e.flatpak).map((e) => [e.flatpak, e]));
    for (const f of fps) {
      const e = fpEntries.get(f.id);
      let lastUsed = null;
      try { lastUsed = fs.statSync(path.join(HOME, ".var", "app", f.id)).mtimeMs; } catch {}
      let installed = null;
      const base = f.installation === "user" ? path.join(DATA_HOME, "flatpak") : "/var/lib/flatpak";
      try { installed = fs.statSync(path.join(base, "app", f.id)).ctimeMs; } catch {}
      const k = `flatpak:${f.installation}:${f.id}`;
      items.push({
        key: k, kind: "flatpak", name: e?.name || f.name || f.id, publisher: f.origin || "", version: f.version || "",
        size: f.size, sizeSource: f.size ? "paquet" : null, lastUsed, installed, location: path.join(base, "app", f.id),
        desc: e?.comment || f.id, canUninstall: true, icon: iconFor(k, e?.icon || f.id, theme), _flatpak: f,
      });
    }
    for (const s of sps) {
      const k = `snap:${s.name}`;
      items.push({ key: k, kind: "snap", name: s.name, publisher: s.publisher, version: s.version, size: s.size,
        sizeSource: s.size ? "paquet" : null, lastUsed: null, installed: null, location: `/snap/${s.name}`, desc: "",
        canUninstall: true, icon: iconFor(k, `/snap/${s.name}/current/meta/gui/icon.png`, theme), _snap: s.name });
    }
    items.sort((x, y) => y.size - x.size);
    cache = { at: Date.now(), items };
    return items;
  }

  const pub = (a) => { const { _pkg, _flatpak, _snap, ...rest } = a; return rest; };
  ctx.listApps = async () => (await list()).map(pub);

  // Ce qu'apt retirerait vraiment (simulation, sans droits).
  async function aptPreview(pkg) {
    const out = await sh.exec("apt-get", ["-s", "remove", pkg], { timeout: 60000 });
    return [...out.matchAll(/^Remv (\S+)/gm)].map((m) => m[1].replace(/:[a-z0-9]+$/, ""));
  }

  ctx.reverters["apt-reinstall"] = ({ packages }) => {
    const safe = (packages || []).filter((p) => /^[a-z0-9][a-z0-9+.-]+$/.test(p));
    if (!safe.length) throw new Error("Rien à réinstaller.");
    return sh.runElevated('DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"', safe);
  };
  ctx.reverters["flatpak-reinstall"] = ({ id, origin, installation }) =>
    sh.exec("flatpak", ["install", "-y", "--noninteractive", installation === "user" ? "--user" : "--system", origin, id], { timeout: 1800000 });

  return {
    "GET /api/apps": async (req, res, url) => (await list(url.searchParams.get("refresh") === "1")).map(pub),

    // Aperçu avant désinstallation : la page l'affiche dans la confirmation.
    "POST /api/apps/uninstall-preview": async (req) => {
      const { key } = await ctx.body(req);
      const app = (await list()).find((a) => a.key === key);
      if (!app || !app.canUninstall) throw new Error("Ce programme ne peut pas être désinstallé ici.");
      if (app._pkg) {
        const removes = await aptPreview(app._pkg);
        const breaks = removes.filter((p) => BREAKS_DESKTOP.test(p));
        return { kind: "deb", removes, breaks, blocked: breaks.length > 0 };
      }
      if (app._flatpak) return { kind: "flatpak", removes: [app._flatpak.id], breaks: [], blocked: false, installation: app._flatpak.installation };
      return { kind: "snap", removes: [app._snap], breaks: [], blocked: false };
    },

    // Désinstalle. La commande est construite ici, jamais par la page.
    "POST /api/apps/uninstall": async (req) => {
      const { key } = await ctx.body(req);
      const app = (await list()).find((a) => a.key === key);
      if (!app || !app.canUninstall) throw new Error("Programme introuvable ou protégé.");
      let revert;
      if (app._pkg) {
        const removes = await aptPreview(app._pkg);
        if (removes.some((p) => BREAKS_DESKTOP.test(p))) throw new Error("Refusé : cette désinstallation retirerait aussi des éléments du bureau ou du système.");
        await sh.runElevated('DEBIAN_FRONTEND=noninteractive apt-get remove -y -q "$1"', [app._pkg]);
        revert = { type: "apt-reinstall", args: { packages: removes } };
      } else if (app._flatpak) {
        const f = app._flatpak;
        await sh.exec("flatpak", ["uninstall", "-y", "--noninteractive", f.installation === "user" ? "--user" : "--system", f.id], { timeout: 600000 });
        revert = { type: "flatpak-reinstall", args: { id: f.id, origin: f.origin, installation: f.installation } };
      } else if (app._snap) {
        await sh.runElevated('snap remove "$1"', [app._snap]);
      }
      ctx.journal.add({ kind: "system", title: `Désinstallé : ${app.name}`, detail: app.version, revert });
      cache = null;
      return { ok: true, name: app.name, done: true };
    },

    // Restes d'un programme désinstallé dans le dossier personnel : ~/.config,
    // ~/.local/share, ~/.cache, ~/.var/app (Flatpak) et les dossiers cachés.
    "POST /api/apps/leftovers": async (req) => {
      const { name, publisher, key } = await ctx.body(req);
      const apps = await list(true);
      if (apps.some((a) => a.name === name || (key && a.key === key))) return { stillInstalled: true, items: [] };
      const scan = ctx.getScan();
      if (!scan) return { items: [] };
      const ids = [name, key && key.split(":").pop()].filter(Boolean);
      const wanted = ids.map(norm).filter((n) => n.length >= 3);
      const firstWord = norm(String(name).split(/\s+/)[0]);
      const pubWord = norm(String(publisher || "").split(/[\s,]+/)[0]);
      const installedNames = apps.map((a) => norm(a.name)).concat(apps.map((a) => norm(a.key.split(":").pop())));
      const rootPaths = [path.join(HOME, ".config"), path.join(DATA_HOME), path.join(HOME, ".cache"), path.join(HOME, ".var", "app")];
      const roots = rootPaths.map((p) => scan.get(p)).filter(Boolean);
      const home = scan.get(HOME);
      const hits = [];
      const consider = (d) => {
        const dn = norm(d.name);
        if (dn.length < 3) return;
        const match = wanted.some((n) => dn === n || (n.length >= 5 && (dn.includes(n) || n.includes(dn)))) || (firstWord.length >= 5 && dn === firstWord);
        if (match && !installedNames.some((i) => i && (i === dn || i.includes(dn))) && !isProtected(d.path)) {
          hits.push({ path: d.path, name: d.name, size: d.size, mtime: d.mtime, atime: d.atime, type: "dir", cat: "apps" });
        }
      };
      for (const r of roots) {
        for (const c of r.children) {
          consider(c);
          if (pubWord.length >= 4 && norm(c.name) === pubWord) c.children.forEach(consider);
        }
      }
      if (home) for (const c of home.children) if (c.name.startsWith(".")) consider(c);
      return { items: hits.sort((a, b) => b.size - a.size) };
    },
  };
};
