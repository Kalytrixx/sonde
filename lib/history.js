// Historique des scans : un instantané compact par scan, pour voir ce qui
// grossit d'une fois sur l'autre.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const MIN_DIR = 50 * 1024 ** 2;     // dossiers suivis
const MIN_DELTA = 100 * 1024 ** 2;  // variation signalée
const KEEP = 60;                    // instantanés conservés

class History {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.indexFile = path.join(dir, "index.json");
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, "utf8")); } catch { this.index = []; }
  }

  // Enregistre l'état du scan (tailles des dossiers de plus de 50 Mo).
  record(scan, disk) {
    const dirs = {};
    const stack = [[scan.tree, 0]];
    while (stack.length) {
      const [d, depth] = stack.pop();
      dirs[d.path] = d.size;
      if (depth < 10) for (const c of d.children) if (c.size >= MIN_DIR) stack.push([c, depth + 1]);
    }
    const at = Date.now();
    const id = String(at);
    fs.writeFileSync(path.join(this.dir, id + ".json.gz"), zlib.gzipSync(JSON.stringify({ at, root: scan.root, dirs })));
    this.index.push({ id, at, root: scan.root, total: scan.tree.size, free: disk?.free ?? null, disk: disk?.total ?? null });
    // On ne garde que les plus récents.
    while (this.index.length > KEEP) {
      const old = this.index.shift();
      fs.rmSync(path.join(this.dir, old.id + ".json.gz"), { force: true });
    }
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index), "utf8");
    return id;
  }

  list() { return [...this.index].reverse(); }

  // Efface tous les instantanés (réglage « Données de Sonde »).
  clear() {
    for (const e of this.index) fs.rmSync(path.join(this.dir, e.id + ".json.gz"), { force: true });
    this.index = [];
    fs.writeFileSync(this.indexFile, "[]", "utf8");
  }

  load(id) {
    const f = path.join(this.dir, id + ".json.gz");
    if (!fs.existsSync(f)) return null;
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString("utf8"));
  }

  // Compare deux instantanés. Pour chaque variation, on garde le dossier le
  // plus précis qui l'explique : si « Temp » grossit de 20 Go à cause de
  // « Temp\conversion-video », c'est ce dernier qui est montré.
  diff(fromId, toId) {
    const a = this.load(fromId), b = this.load(toId);
    if (!a || !b) return null;
    const keys = new Set([...Object.keys(a.dirs), ...Object.keys(b.dirs)]);
    const deltas = [];
    for (const k of keys) {
      const before = a.dirs[k] ?? 0, after = b.dirs[k] ?? 0;
      const delta = after - before;
      if (Math.abs(delta) >= MIN_DELTA) deltas.push({ path: k, before, after, delta,
        status: !(k in a.dirs) ? "nouveau" : !(k in b.dirs) ? "disparu" : "modifié" });
    }
    const prefix = (p) => (p.endsWith("\\") ? p : p + "\\").toLowerCase();
    const specific = deltas.filter((d) => !deltas.some((c) => c !== d
      && c.path.toLowerCase().startsWith(prefix(d.path))
      && Math.sign(c.delta) === Math.sign(d.delta)
      && Math.abs(c.delta) >= 0.7 * Math.abs(d.delta)));
    const grew = specific.filter((d) => d.delta > 0).sort((x, y) => y.delta - x.delta).slice(0, 40);
    const shrank = specific.filter((d) => d.delta < 0).sort((x, y) => x.delta - y.delta).slice(0, 40);
    const meta = (id) => this.index.find((x) => x.id === id);
    return { from: meta(fromId), to: meta(toId), grew, shrank };
  }
}

module.exports = { History };
