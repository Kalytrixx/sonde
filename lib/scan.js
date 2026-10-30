// Parcours du disque. On garde un arbre des dossiers, et pour chaque dossier
// seulement ses gros fichiers : les petits sont additionnés. Ça tient en
// mémoire même pour un disque entier.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { categorize, matchRule, SCAN } = require("./rules");

const BIG_FILE = 5 * 1024 * 1024;      // gardé individuellement au-dessus
const TOP_FILE = 50 * 1024 * 1024;     // entre dans le classement global
const CONCURRENCY = 48;
const { INTERNAL, EXECUTABLE, GENERIC } = SCAN;
const P = require("./platform");
const { SEP, key, IS_WIN } = P;
// « C:\ » -> « C: » (racine d'un disque Windows) ; « /home/ » -> « /home ». « / » reste « / ».
const strip = (p) => (IS_WIN ? p.replace(/\\$/, "") : p.length > 1 ? p.replace(/\/+$/, "") : p);
const withSep = (p) => (p.endsWith(SEP) ? p : p + SEP);

class Dir {
  constructor(name, full, parent) {
    this.name = name;
    this.path = full;
    this.parent = parent;
    this.children = [];
    this.files = [];        // [{ name, size, mtime }] au-dessus de BIG_FILE
    this.smallSize = 0;     // total des petits fichiers de CE dossier
    this.smallCount = 0;
    this.size = 0;          // total récursif, calculé à la fin
    this.count = 0;         // nombre de fichiers, récursif
    this.mtime = 0;         // modification la plus récente, récursive
    this.atime = 0;         // dernier accès le plus récent, récursif
    this.denied = false;
    // Racine du disque auquel appartient le dossier (extensions par disque).
    this.drive = parent ? parent.drive : full;
  }
}

// Racine virtuelle quand plusieurs disques sont scannés ensemble : ses
// enfants sont les disques (« C: », « G: »).
const VIRTUAL = "::pc";

class Scan {
  constructor(root) {
    const roots = [].concat(root).map((r) => path.resolve(r));
    this.roots = roots;
    this.multi = roots.length > 1;
    this.root = this.multi ? roots.map((r) => r.slice(0, 2)).join(" + ") : roots[0];
    this.tree = null;
    this.index = new Map();     // chemin en minuscules -> Dir
    this.topFiles = [];
    this.exts = new Map();      // extension -> { size, count }
    this.extsBy = {};           // « C: » -> extensions de ce disque seul
    this.stats = { files: 0, dirs: 0, bytes: 0, denied: 0, current: "", started: 0, finished: 0 };
    this.state = "idle";
    this.unreadable = [];       // fichiers dont Node ne lit pas la taille
  }

  async run(onProgress) {
    this.state = "running";
    this.stats.started = Date.now();
    const queue = [];
    this.skip = IS_WIN ? null : new Set([...P.allMountPoints()].filter((m) => !this.roots.includes(m)));
    if (this.multi) {
      this.tree = new Dir("Ce PC", VIRTUAL, null);
      for (const r of this.roots) {
        const p = strip(r) || r;
        const d = new Dir(p, p, this.tree);
        d.drive = p;
        this.tree.children.push(d);
        this.index.set(key(p), d);
        queue.push(d);
      }
    } else {
      const p = strip(this.root) || this.root;
      this.tree = new Dir(p, p, null);
      this.index.set(key(p), this.tree);
      queue.push(this.tree);
    }
    let active = 0;
    const tick = setInterval(() => onProgress && onProgress(this.progress()), 250);

    await new Promise((resolve) => {
      const pump = () => {
        while (active < CONCURRENCY && queue.length) {
          const d = queue.pop();
          active++;
          this.readDir(d, queue).finally(() => {
            active--;
            if (!queue.length && !active) resolve();
            else pump();
          });
        }
        if (!queue.length && !active) resolve();
      };
      pump();
    });

    clearInterval(tick);
    this.recoverUnreadable();
    this.finish(this.tree);
    this.topFiles.sort((a, b) => b.size - a.size);
    this.topFiles = this.topFiles.slice(0, 500);
    this.stats.finished = Date.now();
    this.stats.current = "";
    this.state = "done";
    onProgress && onProgress(this.progress());
  }

  async readDir(d, queue) {
    const base = withSep(d.path);
    this.stats.current = d.path;
    let entries;
    try {
      entries = await fs.promises.readdir(base, { withFileTypes: true });
    } catch {
      d.denied = true;
      this.stats.denied++;
      return;
    }
    this.stats.dirs++;
    const files = [];
    for (const e of entries) {
      const full = base + e.name;
      // Les jonctions et liens symboliques mènent ailleurs : on ne les suit
      // pas, sinon on compte deux fois (ou on boucle).
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        // Un autre système de fichiers monté ici : il a son propre scan.
        if (this.skip && this.skip.has(full)) continue;
        const child = new Dir(e.name, full, d);
        d.children.push(child);
        this.index.set(key(full), child);
        queue.push(child);
      } else if (e.isFile()) {
        files.push(e);
      }
    }
    // Les tailles d'un même dossier sont lues en parallèle, par paquets.
    for (let i = 0; i < files.length; i += 256) {
      const batch = files.slice(i, i + 256);
      const stats = await Promise.all(batch.map((e) => fs.promises.lstat(base + e.name).catch(() => null)));
      for (let j = 0; j < batch.length; j++) {
        const st = stats[j];
        if (!st) { this.unreadable.push([d, batch[j].name]); continue; }
        const e = batch[j];
        const full = base + e.name;
        const size = st.size;
        const mtime = st.mtimeMs;
        // Le dernier accès dit si un fichier sert encore ; la date de
        // modification n'est souvent que celle du téléchargement.
        const atime = Math.max(st.atimeMs, mtime);
        this.stats.files++;
        this.stats.bytes += size;
        if (size >= BIG_FILE) d.files.push({ name: e.name, size, mtime, atime });
        else { d.smallSize += size; d.smallCount++; }
        if (mtime > d.mtime) d.mtime = mtime;
        if (atime > d.atime) d.atime = atime;
        const ext = path.extname(e.name).toLowerCase() || "(sans)";
        this.addExt(ext, d.drive, size);
        if (size >= TOP_FILE) this.topFiles.push({ path: full, size, mtime, atime });
      }
    }
  }

  addExt(ext, drive, size) {
    for (const m of [this.exts, this.extsBy[drive] || (this.extsBy[drive] = new Map())]) {
      const x = m.get(ext) || { size: 0, count: 0 };
      x.size += size; x.count++;
      m.set(ext, x);
    }
  }

  // Dossiers de premier niveau, tous disques confondus.
  tops() {
    return this.multi ? this.tree.children.flatMap((d) => d.children) : this.tree.children;
  }

  // pagefile.sys, hiberfil.sys… refusent lstat à Node (EPERM) mais leur
  // taille se lit via l'énumération de dossier de Windows, qu'utilise
  // PowerShell. Sans ça, des dizaines de Go manqueraient sur la carte.
  recoverUnreadable() {
    if (!IS_WIN) return;
    const list = this.unreadable.slice(0, 500);
    if (!list.length) return;
    const tmp = path.join(require("os").tmpdir(), `sonde-unreadable-${process.pid}.json`);
    // Get-Item échoue aussi sur ces fichiers : seule l'énumération du dossier
    // parent renvoie leur taille. On regroupe donc par dossier.
    const byDir = new Map();
    for (const [d, name] of list) {
      if (!byDir.has(d)) byDir.set(d, new Set());
      byDir.get(d).add(name.toLowerCase());
    }
    const dirs = [...byDir.keys()];
    fs.writeFileSync(tmp, JSON.stringify(dirs.map((d) => d.path.endsWith("\\") ? d.path : d.path + "\\")), "utf8");
    try {
      const out = require("child_process").execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$p = Get-Content -LiteralPath '${tmp.replace(/'/g, "''")}' -Raw -Encoding UTF8 | ConvertFrom-Json; ` +
        "$k = 0; @(foreach ($dir in $p) { foreach ($f in (Get-ChildItem -LiteralPath $dir -Force -File -ErrorAction SilentlyContinue)) { " +
        "[pscustomobject]@{ d = $k; n = $f.Name; l = [int64]$f.Length; m = [int64]([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds() } }; $k++ }) | ConvertTo-Json -Compress"],
        { encoding: "utf8", timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      const res = [].concat(JSON.parse(out.trim() || "[]"));
      for (const r of res) {
        const d = dirs[r.d];
        if (!d || !byDir.get(d).has(r.n.toLowerCase())) continue;
        const name = r.n, size = r.l, mtime = r.m;
        this.stats.files++;
        this.stats.bytes += size;
        if (size >= BIG_FILE) d.files.push({ name, size, mtime });
        else { d.smallSize += size; d.smallCount++; }
        if (size >= TOP_FILE) this.topFiles.push({ path: (d.path.endsWith("\\") ? d.path : d.path + "\\") + name, size, mtime });
      }
    } catch {
      // Tant pis : ces fichiers resteront absents du total.
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // Remonte les tailles, du bas vers le haut. Itératif : un arbre profond
  // ferait déborder la pile en récursif.
  finish(root) {
    const order = [];
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      order.push(d);
      for (const c of d.children) stack.push(c);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const d = order[i];
      let size = d.smallSize, count = d.smallCount, mtime = d.mtime, atime = d.atime;
      for (const f of d.files) { size += f.size; count++; if (f.mtime > mtime) mtime = f.mtime; if ((f.atime || 0) > atime) atime = f.atime; }
      for (const c of d.children) { size += c.size; count += c.count; if (c.mtime > mtime) mtime = c.mtime; if (c.atime > atime) atime = c.atime; }
      d.size = size; d.count = count; d.mtime = mtime; d.atime = Math.max(atime, mtime);
      d.children.sort((a, b) => b.size - a.size);
      d.files.sort((a, b) => b.size - a.size);
    }
  }

  // Les plus gros fichiers trouvés jusqu'ici, pour l'animation du scan.
  preview(n = 5) {
    const best = [];
    for (const f of this.topFiles) {
      if (best.length < n || f.size > best[best.length - 1].size) {
        best.push(f);
        best.sort((a, b) => b.size - a.size);
        if (best.length > n) best.pop();
      }
    }
    return best.map((f) => ({ path: f.path, size: f.size }));
  }

  progress() {
    const s = this.stats;
    return {
      state: this.state, root: this.root, roots: this.roots, files: s.files, dirs: s.dirs, bytes: s.bytes,
      denied: s.denied, current: s.current, finished: s.finished,
      elapsed: ((s.finished || Date.now()) - s.started) / 1000,
    };
  }

  get(p) {
    if (!p || p === VIRTUAL) return this.tree;
    return this.index.get(key(strip(path.resolve(p)))) ||
      (key(path.resolve(p)) === key(this.root) ? this.tree : null);
  }

  // Trouve un fichier connu (gros fichier gardé dans son dossier parent).
  getFile(p) {
    const full = path.resolve(p);
    const parent = this.get(path.dirname(full));
    if (!parent) return null;
    const name = key(path.basename(full));
    const f = parent.files.find((x) => key(x.name) === name);
    return f ? { parent, file: f } : null;
  }

  // Retire un élément supprimé et corrige les tailles des ancêtres.
  remove(p) {
    this._dups = null;
    const d = this.get(p);
    if (d && d.parent) {
      d.parent.children = d.parent.children.filter((c) => c !== d);
      for (let a = d.parent; a; a = a.parent) { a.size -= d.size; a.count -= d.count; }
      const stack = [d];
      while (stack.length) {
        const x = stack.pop();
        this.index.delete(key(x.path));
        stack.push(...x.children);
      }
      this.topFiles = this.topFiles.filter((f) => !key(f.path).startsWith(key(withSep(d.path))));
      return d.size;
    }
    const hit = this.getFile(p);
    if (hit) {
      hit.parent.files = hit.parent.files.filter((f) => f !== hit.file);
      for (let a = hit.parent; a; a = a.parent) { a.size -= hit.file.size; a.count -= 1; }
      this.topFiles = this.topFiles.filter((f) => key(f.path) !== key(path.resolve(p)));
      return hit.file.size;
    }
    return 0;
  }

  // Vider un dossier sans le supprimer : ses enfants partent, lui reste.
  removeContents(p) {
    const d = this.get(p);
    if (!d) return 0;
    let freed = 0;
    for (const c of [...d.children]) freed += this.remove(c.path);
    for (const f of [...d.files]) freed += this.remove(path.join(d.path, f.name));
    for (let a = d; a; a = a.parent) { a.size -= d.smallSize; a.count -= d.smallCount; }
    freed += d.smallSize;
    d.smallSize = 0; d.smallCount = 0;
    return freed;
  }

  // Rescanne un seul dossier et le regreffe dans l'arbre (après une
  // suppression partielle, par exemple quand des fichiers étaient verrouillés).
  async refresh(p) {
    this._dups = null;
    const d = this.get(p);
    if (!d) return;
    const sub = new Scan(d.path);
    await sub.run();
    const t = sub.tree;
    const delta = t.size - d.size, dcount = t.count - d.count;
    const stack = [...d.children];
    while (stack.length) { const x = stack.pop(); this.index.delete(key(x.path)); stack.push(...x.children); }
    for (const [k, v] of sub.index) if (v !== t) this.index.set(k, v);
    for (const c of t.children) c.parent = d;
    Object.assign(d, { children: t.children, files: t.files, smallSize: t.smallSize, smallCount: t.smallCount,
      size: t.size, count: t.count, mtime: t.mtime });
    for (let a = d.parent; a; a = a.parent) { a.size += delta; a.count += dcount; }
    const prefix = key(withSep(d.path));
    this.topFiles = this.topFiles.filter((f) => !key(f.path).startsWith(prefix))
      .concat(sub.topFiles).sort((a, b) => b.size - a.size).slice(0, 500);
  }

  // Doublons parmi les gros fichiers : même taille, puis même empreinte
  // (début, milieu et fin du fichier). Lire 3 Mo par fichier suffit à
  // distinguer des fichiers de même taille sans tout relire.
  async duplicates() {
    if (this._dups) return this._dups;
    const bySize = new Map();
    for (const f of this.topFiles) {
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f);
    }
    const groups = [];
    for (const [size, files] of bySize) {
      if (files.length < 2) continue;
      const byHash = new Map();
      for (const f of files) {
        const h = await quickHash(f.path, size).catch(() => null);
        if (!h) continue;
        if (!byHash.has(h)) byHash.set(h, []);
        byHash.get(h).push(f);
      }
      for (const same of byHash.values()) {
        // Les copies internes aux programmes (DLL, site-packages…) ne se
        // suppriment pas à la main : elles n'intéressent pas l'utilisateur.
        if (same.some((f) => INTERNAL.test(f.path) || EXECUTABLE.test(f.path))) continue;
        if (same.length > 1) groups.push({ size, files: same.sort((a, b) => b.mtime - a.mtime), wasted: size * (same.length - 1) });
      }
    }
    this._dups = groups.sort((a, b) => b.wasted - a.wasted);
    return this._dups;
  }

  // « Blocs à comprendre » : les dossiers qui forment une unité de sens.
  // On descend tant qu'un seul enfant porte l'essentiel du poids ; on
  // s'arrête là où le poids se répartit (ComfyUI\models, un jeu, un projet…).
  blocks(min = 2 * 1024 ** 3, limit = 20) {
    const out = [];
    const visit = (d, depth) => {
      if (d.size < min || depth > 12) return;
      const big = d.children.filter((c) => c.size >= min);
      const top = d.children[0];
      if (top && top.size >= d.size * 0.6 && top.size >= min) { big.forEach((c) => visit(c, depth + 1)); return; }
      if (depth >= 2 && !GENERIC.test(d.path)) out.push(d);
      for (const c of big) if (c.size >= d.size * 0.25) visit(c, depth + 1);
    };
    if (this.multi) this.tree.children.forEach((c) => visit(c, 0));
    else visit(this.tree, 0);
    // Un bloc qui en contient un autre de la liste est retiré : on garde le plus précis.
    const kept = out.filter((d) => !out.some((o) => o !== d && key(o.path).startsWith(key(withSep(d.path))) && o.size >= d.size * 0.6));
    return kept.sort((a, b) => b.size - a.size).slice(0, limit);
  }

  // Tous les dossiers reconnus par une règle de nettoyage (sans descendre
  // dans un dossier déjà reconnu).
  candidates(min = 1024 * 1024) {
    const out = [];
    const stack = [this.tree];
    while (stack.length) {
      const d = stack.pop();
      const r = matchRule(d.path);
      if (r) {
        if (d.size >= min) out.push({ path: d.path, size: d.size, count: d.count, mtime: d.mtime, rule: ruleInfo(r) });
        continue;
      }
      for (const c of d.children) if (c.size >= min) stack.push(c);
    }
    return out.sort((a, b) => b.size - a.size);
  }

  extensions(limit = 30, drive = null) {
    const m = drive ? this.extsBy[IS_WIN ? drive.slice(0, 2).toUpperCase() : strip(drive)] || new Map() : this.exts;
    return [...m.entries()]
      .map(([ext, v]) => ({ ext, ...v }))
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  // --- sauvegarde compacte, pour ne pas rescanner à chaque démarrage -----
  save(file) {
    const enc = (d) => [d.name, d.smallSize, d.smallCount, d.ownMtime ?? d.mtime, d.denied ? 1 : 0,
      d.files.map((f) => [f.name, f.size, f.mtime, f.atime || f.mtime]), d.children.map(enc), d.ownAtime ?? d.atime];
    const payload = { v: 2, root: this.root, roots: this.roots, stats: this.stats, topFiles: this.topFiles,
      exts: [...this.exts.entries()],
      extsBy: Object.fromEntries(Object.entries(this.extsBy).map(([k, m]) => [k, [...m.entries()]])), tree: enc(this.tree) };
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(payload)));
  }

  static load(file) {
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    const s = new Scan(payload.roots || payload.root);
    const dec = (a, parent, full) => {
      const d = new Dir(a[0], full, parent);
      d.smallSize = a[1]; d.smallCount = a[2]; d.mtime = a[3]; d.denied = !!a[4]; d.atime = a[7] || a[3];
      d.files = a[5].map(([name, size, mtime, atime]) => ({ name, size, mtime, atime: atime || mtime }));
      s.index.set(key(full), d);
      const base = withSep(full);
      d.children = a[6].map((c) => dec(c, d, full === VIRTUAL ? c[0] : base + c[0]));
      if (full === VIRTUAL) for (const c of d.children) c.drive = c.path;
      return d;
    };
    s.tree = dec(payload.tree, null, s.multi ? VIRTUAL : payload.tree[0]);
    s.stats = payload.stats;
    s.topFiles = payload.topFiles;
    s.exts = new Map(payload.exts);
    s.extsBy = Object.fromEntries(Object.entries(payload.extsBy || {}).map(([k, e]) => [k, new Map(e)]));
    if (!payload.extsBy && !s.multi) s.extsBy[s.tree.path] = s.exts;
    s.finish(s.tree);
    s.state = "done";
    return s;
  }
}

async function quickHash(file, size) {
  const crypto = require("crypto");
  const h = crypto.createHash("sha1");
  const fd = await fs.promises.open(file, "r");
  try {
    const chunk = 1024 * 1024;
    for (const pos of [0, Math.floor(size / 2), Math.max(0, size - chunk)]) {
      const buf = Buffer.alloc(Math.min(chunk, size));
      const { bytesRead } = await fd.read(buf, 0, buf.length, pos);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  return h.digest("hex");
}

function ruleInfo(r) {
  return { label: r.label, niveau: r.niveau, pourquoi: r.pourquoi, contenu: !!r.contenu };
}

// Vue d'un dossier pour l'interface : enfants + gros fichiers + petits
// fichiers regroupés, avec `depth` niveaux de profondeur pour la carte.
function view(d, depth = 1, limit = 60) {
  const r = matchRule(d.path);
  const node = {
    name: d.name, path: d.path, size: d.size, count: d.count, mtime: d.mtime, atime: d.atime,
    type: "dir", cat: categorize(d.path), rule: r ? ruleInfo(r) : null, denied: d.denied,
    hasChildren: d.children.length > 0 || d.files.length > 0,
  };
  if (depth > 0) {
    const kids = d.children.slice(0, limit).map((c) => view(c, depth - 1, depth > 1 ? 20 : limit));
    const base = withSep(d.path);
    for (const f of d.files.slice(0, limit)) {
      kids.push({ name: f.name, path: base + f.name, size: f.size, count: 1, mtime: f.mtime, atime: f.atime,
        type: "file", cat: categorize(base + f.name), rule: null });
    }
    const hidden = d.children.slice(limit).reduce((s, c) => s + c.size, 0) +
      d.files.slice(limit).reduce((s, f) => s + f.size, 0);
    if (d.smallSize + hidden > 0) {
      kids.push({ name: "(petits fichiers)", path: null, size: d.smallSize + hidden,
        count: d.smallCount, type: "rest", cat: "autre" });
    }
    node.children = kids.sort((a, b) => b.size - a.size);
  }
  return node;
}

module.exports = { Scan, view, VIRTUAL };
