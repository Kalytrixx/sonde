// Journal des actions et corbeille : voir ce qui a été fait, le défaire.

const path = require("path");
const { binItems, restoreOne, restoreEntry } = require("../../trash");
const trash = require("../../trash");

module.exports = (ctx) => {
  // Après une restauration, les dossiers concernés ont changé : on les rescanne.
  async function refreshParents(paths) {
    const scan = ctx.getScan();
    if (!scan) return;
    const parents = [...new Set(paths.map((p) => path.dirname(p).toLowerCase()))].slice(0, 20);
    for (const p of parents) if (scan.get(p)) await scan.refresh(p).catch(() => {});
  }

  return {
    "GET /api/journal": async () => ctx.journal.list(),

    // Annule une entrée : remet les fichiers en place, ou rétablit un réglage.
    "POST /api/journal/undo": async (req) => {
      const { id } = await ctx.body(req);
      const e = ctx.journal.get(id);
      if (!e) throw new Error("Entrée inconnue.");
      if (e.undone) throw new Error("Déjà annulé.");
      if (e.kind === "trash") {
        const results = restoreEntry(e);
        const ok = results.filter((r) => r.ok);
        if (ok.length) ctx.journal.update(id, { undone: Date.now() });
        await refreshParents(ok.map((r) => r.path));
        return { results };
      }
      if (e.kind === "system") {
        const fn = e.revert && ctx.reverters[e.revert.type];
        if (!fn) throw new Error("Cette action ne peut pas être annulée automatiquement.");
        await fn(e.revert.args);
        ctx.journal.update(id, { undone: Date.now() });
        ctx.journal.add({ kind: "system", title: `Annulé : ${e.title}` });
        return { ok: true };
      }
      throw new Error("Action inconnue.");
    },

    "GET /api/bin": async () => {
      const items = binItems();
      const bin = await trash.binStatus("C:").catch(() => null);
      return { items: items.slice(0, 1000), count: items.length, total: items.reduce((a, i) => a + i.size, 0), bin };
    },

    // Restaure des éléments choisis dans la corbeille. Les identifiants sont
    // revérifiés contre le contenu réel de la corbeille.
    "POST /api/bin/restore": async (req) => {
      const { keys } = await ctx.body(req);
      const items = binItems();
      const results = [];
      for (const k of keys || []) {
        const it = items.find((i) => i.id === k.id && i.bin === k.bin);
        if (!it) { results.push({ ok: false, reason: "Introuvable." }); continue; }
        results.push({ path: it.original, ...restoreOne(it) });
      }
      await refreshParents(results.filter((r) => r.ok).map((r) => r.path));
      return { results };
    },
  };
};
