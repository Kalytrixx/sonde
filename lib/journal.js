// Journal de tout ce que Sonde a fait. La restauration des fichiers passe
// par lib/trash.js (corbeille du système).

const fs = require("fs");
const path = require("path");

// ------------------------------------------------------------- journal ---
class Journal {
  constructor(file) {
    this.file = file;
    try { this.entries = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.entries = []; }
  }
  save() { fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 1), "utf8"); }

  // kind : "trash" (fichiers) ou "system" (réglage Windows, avec de quoi le rétablir)
  add(entry) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), at: Date.now(), ...entry };
    this.entries.unshift(e);
    this.entries = this.entries.slice(0, 500);
    this.save();
    return e;
  }
  get(id) { return this.entries.find((e) => e.id === id); }
  update(id, patch) { Object.assign(this.get(id) || {}, patch); this.save(); }
  list() { return this.entries; }
}

module.exports = { Journal };
