// Sonde — serveur local. N'écoute que sur 127.0.0.1.
process.env.UV_THREADPOOL_SIZE ||= "64";   // lectures disque en parallèle

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { Scan, view } = require("./lib/scan");
const { isProtected, CATEGORY_LABELS, categorize } = require("./lib/rules");
const ai = require("./lib/ai");
const trash = require("./lib/trash");
const P = require("./lib/platform");
// Exécution de commandes système : PowerShell sous Windows, shell sous Linux.
const ps = P.IS_WIN ? require("./lib/ps") : require("./lib/sh");
const { Journal } = require("./lib/journal");
const { History } = require("./lib/history");

// PORT : fourni par l'aperçu de l'éditeur quand 4777 est déjà pris par Sonde.bat.
const PORT = Number(process.env.SONDE_PORT || process.env.PORT || 4777);
const ROOT = __dirname;
// Données (scan, notes, journal…) : dans %APPDATA%\Sonde (Windows) ou
// ~/.config/Sonde (Linux) pour l'application installée, sinon à côté du code.
const DATA = process.env.SONDE_DATA || path.join(ROOT, "data");
const SCAN_FILE = path.join(DATA, "scan.json.gz");
const ANALYSE_FILE = path.join(DATA, "analyse.json");
fs.mkdirSync(DATA, { recursive: true });

const notes = new ai.Notes(path.join(DATA, "notes.json"));
const journal = new Journal(path.join(DATA, "journal.json"));
const history = new History(path.join(DATA, "history"));
const SETTINGS_FILE = path.join(DATA, "settings.json");
const settings = Object.assign({ alertFreeGB: 50 }, (() => { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; } })());
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 1), "utf8");
// Le modèle (Ollama ou API) est réglé par lib/modules/common/ai.js au chargement des modules.
let scan = null;
let scanning = null;          // scan en cours
let aiBusy = null;            // AbortController de l'appel IA en cours

try {
  if (fs.existsSync(SCAN_FILE)) {
    scan = Scan.load(SCAN_FILE);
    console.log(`Scan précédent rechargé : ${scan.root}`);
  }
} catch (e) {
  console.log("Scan précédent illisible, ignoré :", e.message);
}

const readAnalyse = () => { try { return JSON.parse(fs.readFileSync(ANALYSE_FILE, "utf8")); } catch { return null; } };
const saveAnalyse = (a) => fs.writeFileSync(ANALYSE_FILE, JSON.stringify(a), "utf8");

// ------------------------------------------------------------- utilitaires -
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8" };

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 5e6) req.destroy(); });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// Réponse en flux : une ligne JSON par événement.
function stream(res) {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  return (evt) => { if (!res.writableEnded) res.write(JSON.stringify(evt) + "\n"); };
}

async function freeSpace(root) {
  try {
    const s = await fs.promises.statfs(P.IS_WIN ? root.slice(0, 3) : root);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return { free: null, total: null }; }
}

async function drives() {
  const out = [];
  for (const d of P.drives()) {
    const sp = await freeSpace(d);
    if (sp.total) out.push({ root: d, name: P.driveName(d), ...sp });
  }
  return out;
}

// Espace des disques couverts par un scan (additionné s'il y en a plusieurs).
async function diskSpace(s) {
  // Un disque par racine (deux dossiers du même disque ne comptent qu'une fois).
  const disks = [...new Set(s.roots.map((r) => (P.IS_WIN ? r.slice(0, 3).toUpperCase() : P.driveOf(r))))];
  const all = await Promise.all(disks.map(freeSpace));
  if (all.some((x) => x.total == null)) return { free: null, total: null };
  return all.reduce((a, x) => ({ free: a.free + x.free, total: a.total + x.total }), { free: 0, total: 0 });
}

// Ajoute la note de l'IA à chaque nœud d'une vue.
function withNotes(node) {
  if (node.path) { const n = notes.get(node.path); if (n) node.note = n.text; }
  node.protected = node.path ? isProtected(node.path) : true;
  if (node.children) node.children.forEach(withNotes);
  return node;
}

// Répartition par famille : chaque octet est compté une seule fois.
function categoryMap(from = scan.tree) {
  const tot = {};
  const add = (cat, n) => { tot[cat] = (tot[cat] || 0) + n; };
  const stack = [from];
  while (stack.length) {
    const d = stack.pop();
    const cat = categorize(d.path);
    add(cat, d.smallSize);
    for (const f of d.files) { const c = categorize(P.join(d.path, f.name)); add(c === "autre" ? cat : c, f.size); }
    stack.push(...d.children);
  }
  return Object.entries(tot).map(([id, size]) => ({ id, label: CATEGORY_LABELS[id], size }))
    .sort((a, b) => b.size - a.size);
}

// ----------------------------------------------------------------- routes -
const routes = {
  "GET /api/status": async () => {
    const st = await ai.status();
    const fsp = scan ? await diskSpace(scan) : null;
    return { ai: st, drives: await drives(), scanRoots: settings.scanRoots || null, scanning: scanning ? scanning.progress() : null,
      scan: scan ? { ...scan.progress(), size: scan.tree.size, count: scan.tree.count, disk: fsp } : null,
      analyse: !!readAnalyse(), aiBusy: !!aiBusy, home: P.HOME || null, platform: P.ID, sep: P.SEP,
      update: ctx.updateState ? ctx.updateState() : null };
  },

  "POST /api/scan": async (req, res) => {
    const { root, roots } = await body(req);
    if (scanning) return send(res, 409, { error: "Un scan est déjà en cours." });
    const targets = [...new Set([].concat(roots || root || (P.IS_WIN ? "C:\\" : "/")).map((r) => path.resolve(r)))];
    if (!targets.length || targets.some((t) => !fs.existsSync(t))) return send(res, 400, { error: "Chemin introuvable." });
    // Plusieurs cibles : uniquement des disques entiers.
    if (targets.length > 1 && targets.some((t) => !P.isDriveRoot(t))) return send(res, 400, { error: "Plusieurs cibles : seulement des disques entiers." });
    if (targets.every((t) => P.isDriveRoot(t))) { settings.scanRoots = targets; saveSettings(); }
    const emit = stream(res);
    const s = new Scan(targets);
    scanning = s;
    try {
      // Espace occupé sur les disques : l'interface en tire un arc de progression.
      const disk = await diskSpace(s);
      const isDrive = targets.every((t) => P.isDriveRoot(t));
      emit({ type: "start", root: s.root, used: isDrive && disk.total ? disk.total - disk.free : null });
      await s.run((p) => emit({ type: "progress", ...p, top: s.preview() }));
      scan = s;
      s.save(SCAN_FILE);
      history.record(s, await diskSpace(s));
      emit({ type: "done", ...s.progress(), size: s.tree.size });
    } catch (e) {
      emit({ type: "error", error: e.message });
    } finally {
      scanning = null;
      res.end();
    }
  },

  "GET /api/node": async (req, res, url) => {
    if (!scan) return send(res, 404, { error: "Aucun scan." });
    const d = scan.get(url.searchParams.get("path"));
    if (!d) return send(res, 404, { error: "Introuvable." });
    const depth = Math.min(3, Number(url.searchParams.get("depth") || 2));
    const node = withNotes(view(d, depth));
    // Fil d'Ariane
    const crumbs = [];
    for (let a = d; a; a = a.parent) crumbs.unshift({ name: a.name, path: a.path });
    node.crumbs = crumbs;
    return node;
  },

  "GET /api/overview": async () => {
    if (!scan) return { none: true };
    // Un résumé par disque quand le scan en couvre plusieurs.
    const disks = scan.multi ? await Promise.all(scan.tree.children.map(async (d) => ({
      root: d.path, size: d.size, count: d.count, disk: await freeSpace(P.IS_WIN ? d.path + "\\" : d.path),
      categories: categoryMap(d), extensions: scan.extensions(12, d.path) }))) : null;
    return { root: scan.root, roots: scan.roots, multi: scan.multi, size: scan.tree.size, count: scan.tree.count,
      disk: await diskSpace(scan), categories: categoryMap(),
      extensions: scan.extensions(12), stats: scan.progress(), disks };
  },

  "GET /api/bigfiles": async (req, res, url) => {
    if (!scan) return [];
    const n = Math.min(500, Number(url.searchParams.get("limit") || 150));
    return scan.topFiles.slice(0, n).map((f) => ({ ...f, name: path.basename(f.path), type: "file",
      cat: categorize(f.path), protected: isProtected(f.path), note: notes.get(f.path)?.text }));
  },

  "GET /api/candidates": async () => (scan ? scan.candidates(1024 * 1024) : []),

  "GET /api/duplicates": async () => {
    if (!scan) return [];
    const groups = await scan.duplicates();
    return groups.map((g) => ({ ...g, files: g.files.map((f) => ({ ...f, name: path.basename(f.path), type: "file",
      cat: categorize(f.path), protected: isProtected(f.path), note: notes.get(f.path)?.text })) }));
  },

  "GET /api/analyse": async () => readAnalyse() || { none: true },

  "POST /api/analyse": async (req, res) => {
    if (!scan) return send(res, 400, { error: "Lance d'abord un scan." });
    if (aiBusy) return send(res, 409, { error: "GPT-OSS est déjà occupé." });
    const emit = stream(res);
    aiBusy = new AbortController();
    res.on("close", () => { if (!res.writableFinished) aiBusy?.abort(); });
    try {
      const { free } = await diskSpace(scan);
      const r = await ai.analyse({ scan, notes, freeBytes: free, emit, signal: aiBusy.signal });
      const saved = { at: Date.now(), root: scan.root, summary: r.summary, recos: r.recos, map: r.map || [] };
      saveAnalyse(saved);
      emit({ type: "done", ...saved });
    } catch (e) {
      emit({ type: "error", error: e.name === "AbortError" ? "Analyse interrompue." : e.message });
    } finally {
      aiBusy = null;
      res.end();
    }
  },

  "POST /api/chat": async (req, res) => {
    if (!scan) return send(res, 400, { error: "Lance d'abord un scan." });
    if (aiBusy) return send(res, 409, { error: "GPT-OSS est déjà occupé." });
    const { messages } = await body(req);
    const emit = stream(res);
    aiBusy = new AbortController();
    res.on("close", () => { if (!res.writableFinished) aiBusy?.abort(); });
    try {
      const { free } = await diskSpace(scan);
      const text = await ai.chat({ scan, notes, freeBytes: free, messages: messages || [], emit, signal: aiBusy.signal,
        apps: () => (ctx.listApps ? ctx.listApps() : []) });
      emit({ type: "done", text });
    } catch (e) {
      emit({ type: "error", error: e.name === "AbortError" ? "Interrompu." : e.message });
    } finally {
      aiBusy = null;
      res.end();
    }
  },

  "POST /api/explain": async (req, res) => {
    if (!scan) return send(res, 400, { error: "Lance d'abord un scan." });
    if (aiBusy) return send(res, 409, { error: "GPT-OSS est déjà occupé." });
    const { path: target } = await body(req);
    const emit = stream(res);
    aiBusy = new AbortController();
    try {
      const text = await ai.explain({ scan, notes, target, emit, signal: aiBusy.signal });
      emit({ type: "done", text, note: notes.get(target)?.text });
    } catch (e) {
      emit({ type: "error", error: e.message });
    } finally {
      aiBusy = null;
      res.end();
    }
  },

  "POST /api/stop": async () => { aiBusy?.abort(); return { ok: true }; },

  "POST /api/trash/check": async (req) => {
    const { items } = await body(req);
    return trash.check(items || []);
  },

  // Envoi à la corbeille, en flux : la page suit la progression et peut
  // arrêter (ce qui est déjà parti reste dans la corbeille, récupérable).
  "POST /api/trash": async (req, res) => {
    const { items } = await body(req);
    const c = await trash.check(items || []);
    if (c.blocked) return send(res, 409, { error: "Corbeille insuffisante.", check: c });
    const emit = stream(res);
    let stop = false;
    res.on("close", () => { if (!res.writableFinished) stop = true; });
    let last = 0;
    let results;
    try {
      results = await trash.send(c.ok, (p) => {
        if (Date.now() - last < 150 && p.done !== p.total) return;
        last = Date.now();
        emit({ type: "progress", ...p });
      }, () => stop);
    } catch (e) {
      emit({ type: "error", error: e.message });
      return res.end();
    }
    let freed = 0;
    for (const r of results) {
      const it = c.ok.find((x) => x.path === r.path);
      if (!scan || !it) continue;
      if (r.failed === 0 && !it.contenu) freed += scan.remove(it.path);
      else if (r.failed === 0 && it.contenu) freed += scan.removeContents(it.path);
      else { const before = scan.get(it.path)?.size || 0; await scan.refresh(it.path); freed += before - (scan.get(it.path)?.size || 0); }
    }
    if (scan) scan.save(SCAN_FILE);
    const sent = results.filter((r) => r.done > 0);
    if (sent.length) {
      journal.add({ kind: "trash", title: `${sent.length} élément(s) mis à la corbeille`, freed,
        items: c.ok.filter((it) => sent.some((r) => r.path === it.path)).map((it) => ({ path: it.path, size: it.size, contenu: !!it.contenu })) });
    }
    // Retire des recommandations enregistrées ce qui vient de partir.
    const an = readAnalyse();
    if (an) { an.recos = an.recos.filter((x) => !results.some((r) => r.path === x.path && r.failed === 0)); saveAnalyse(an); }
    emit({ type: "done", results, refused: c.refused, freed, stopped: stop });
    res.end();
  },

  "POST /api/open": async (req) => {
    const { path: p } = await body(req);
    if (!p || !fs.existsSync(p)) return { ok: false };
    // Ouvre l'Explorateur (ou Fichiers sous GNOME) sur l'élément, sans passer par un shell.
    if (P.IS_WIN) require("child_process").spawn("explorer.exe", ["/select,", p], { detached: true, stdio: "ignore" }).unref();
    else await ps.reveal(p);
    return { ok: true };
  },

  "GET /api/settings": async () => publicSettings(),
  "POST /api/settings": async (req) => {
    const b = await body(req);
    if (Number.isFinite(b.alertFreeGB) && b.alertFreeGB >= 0 && b.alertFreeGB <= 10000) settings.alertFreeGB = b.alertFreeGB;
    saveSettings();
    return publicSettings();
  },
};

// Réglages tels que la page peut les voir : sans la clé d'API (même chiffrée).
function publicSettings() {
  const { ai, ...rest } = settings;
  if (!ai) return rest;
  const { key, ...pub } = ai;
  return { ...rest, ai: { ...pub, hasKey: !!key } };
}

// Route qui fait travailler GPT-OSS en flux : un seul appel IA à la fois.
function aiRoute(handler) {
  return async (req, res, url) => {
    if (aiBusy) return send(res, 409, { error: "GPT-OSS est déjà occupé." });
    const input = req.method === "POST" ? await body(req) : {};
    const emit = stream(res);
    aiBusy = new AbortController();
    res.on("close", () => { if (!res.writableFinished) aiBusy?.abort(); });
    try {
      const out = await handler({ input, url, emit, signal: aiBusy.signal });
      emit({ type: "done", ...(out && typeof out === "object" ? out : { text: out }) });
    } catch (e) {
      emit({ type: "error", error: e.name === "AbortError" ? "Interrompu." : e.message });
    } finally {
      aiBusy = null;
      res.end();
    }
  };
}

// ----------------------------------------------------------------- modules -
// Chaque fichier de lib/modules/common et lib/modules/<système> ajoute ses
// routes. Ils reçoivent ce contexte.
const ctx = {
  ROOT, DATA, P, ps, ai, notes, journal, history, settings, saveSettings,
  getScan: () => scan, freeSpace, diskSpace, body, send, stream, aiRoute,
  reverters: {},   // type -> fonction qui annule un changement système journalisé
};
for (const dir of ["common", P.ID]) {
  for (const f of fs.readdirSync(path.join(ROOT, "lib", "modules", dir)).filter((f) => f.endsWith(".js")).sort()) {
    Object.assign(routes, require(path.join(ROOT, "lib", "modules", dir, f))(ctx));
  }
}

// ------------------------------------------------------------------ serveur -
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Un site web ouvert dans le navigateur pourrait viser ce serveur local :
  // on refuse tout hôte inconnu, et les API exigent un en-tête que les
  // formulaires et les requêtes simples inter-sites ne peuvent pas envoyer.
  const host = (req.headers.host || "").toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: "Hôte refusé." });
  if (url.pathname.startsWith("/api/") && req.headers["x-sonde"] !== "1") return send(res, 403, { error: "En-tête manquant." });

  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      const out = await handler(req, res, url);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: e.message });
      else res.end();
    }
    return;
  }
  if (req.method !== "GET") return send(res, 404, { error: "Inconnu." });
  // Icônes des programmes, extraites dans le dossier de données.
  const icon = url.pathname.match(/^\/icons\/([a-f0-9]{16})\.(png|svg)$/);
  if (icon) {
    const f = path.join(DATA, "icons", icon[1] + "." + icon[2]);
    // Un SVG venu d'un thème d'icônes ne doit rien exécuter : on l'interdit.
    const type = icon[2] === "svg" ? "image/svg+xml" : "image/png";
    if (!fs.existsSync(f)) return send(res, 404, "", "text/plain");
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "max-age=86400", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
    return res.end(fs.readFileSync(f));
  }
  const vendor = { "/vendor/d3.js": ["d3", "dist", "d3.min.js"], "/vendor/marked.js": ["marked", "lib", "marked.umd.js"] };
  if (vendor[url.pathname]) {
    return send(res, 200, fs.readFileSync(path.join(ROOT, "node_modules", ...vendor[url.pathname])), MIME[".js"]);
  }
  const file = path.normalize(path.join(ROOT, "public", url.pathname === "/" ? "index.html" : url.pathname));
  if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, "Introuvable", "text/plain; charset=utf-8");
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream");
});

// Mode planifié : « node server.js --scan C:\ » (ou « --scan / ») scanne, enregistre
// l'historique, prévient si l'espace libre passe sous le seuil, et s'arrête.
const scanArg = process.argv.indexOf("--scan");
if (scanArg >= 0) {
  (async () => {
    const args = P.IS_WIN
      ? process.argv.slice(scanArg + 1).filter((a) => /^[A-Z]:[\\/]?$/i.test(a)).map((a) => a.slice(0, 2) + "\\")
      : process.argv.slice(scanArg + 1).filter((a) => a.startsWith("/") && P.isDriveRoot(a));
    const s = new Scan(args.length ? args : settings.scanRoots || (P.IS_WIN ? "C:\\" : "/"));
    await s.run();
    s.save(SCAN_FILE);
    const disk = await diskSpace(s);
    history.record(s, disk);
    const freeGB = disk.free / 1024 ** 3;
    console.log(`Scan planifié terminé : ${s.root}, ${freeGB.toFixed(1)} Go libres.`);
    if (disk.free != null && freeGB < settings.alertFreeGB) {
      await require(`./lib/modules/${P.ID}/history`).notify("Sonde : disque presque plein",
        `Il ne reste que ${freeGB.toFixed(0)} Go libres sur ${s.root}. Ouvre Sonde pour voir ce qui a grossi.`).catch(() => {});
    }
    process.exit(0);
  })();
} else {
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}`;
    console.log(`Sonde est prêt : ${url}`);
    if (process.argv.includes("--open")) {
      if (P.IS_WIN) exec(`start "" "${url}"`);
      else require("child_process").spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  });
}
