// Mises à jour des applications (Windows) via winget, l'outil de Microsoft :
// liste de ce qui a une version plus récente, mise à jour une par une en flux.
// Les navigateurs et winget lui-même se mettent à jour seuls : ils ne sont
// que montrés.

const { spawn, execFile } = require("child_process");

// Se mettent à jour tout seuls (ou ne doivent pas être mis à jour pendant que winget tourne).
const SELF = [
  [/^Google\.Chrome/i, "se met à jour tout seul"], [/^Mozilla\.Firefox/i, "se met à jour tout seul"],
  [/^Microsoft\.Edge/i, "se met à jour tout seul"], [/^Brave\.Brave/i, "se met à jour tout seul"],
  [/^Opera\./i, "se met à jour tout seul"], [/^Vivaldi\./i, "se met à jour tout seul"],
  [/^Microsoft\.AppInstaller$/i, "mis à jour par le Microsoft Store"],
  [/^Valve\.Steam$/i, "se met à jour tout seul"], [/^Discord\.Discord$/i, "se met à jour tout seul"],
];
const ID_RE = /^[\w.+-]{2,120}$/;
const WINGET_ARGS = ["--accept-source-agreements", "--disable-interactivity"];

const run = (args, timeout = 120000) => new Promise((resolve) => {
  execFile("winget", args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, out) => resolve({ code: err?.code ?? 0, out: String(out || "") }));
});

// Tableau texte de « winget upgrade » : colonnes repérées sur la ligne de titres
// (juste au-dessus des tirets). Les noms longs peuvent être tronqués par « … ».
function parse(out) {
  const lines = out.split(/\r?\n/).map((l) => l.replace(/^[\s\\|/-]*\r?/, (m) => (/[\\|/]/.test(m) ? "" : m)));
  const dash = lines.findIndex((l) => /^-{10,}/.test(l.trim()));
  if (dash < 1) return [];
  const header = lines[dash - 1];
  const cols = [...header.matchAll(/\S+/g)].map((m) => m.index);
  if (cols.length < 4) return [];
  const items = [];
  for (const l of lines.slice(dash + 1)) {
    if (!l.trim() || /^\d+ (mises?|upgrades?|package)/i.test(l.trim()) || l.length < cols[3]) continue;
    const cut = (i) => l.slice(cols[i], cols[i + 1] ?? l.length).trim();
    const id = cut(1), version = cut(2), available = cut(3), source = cols[4] != null ? cut(4) : "";
    if (!ID_RE.test(id) || !available) continue;
    const self = SELF.find(([re]) => re.test(id));
    items.push({ name: cut(0).replace(/…$/, ""), id, version, available, source, self: self ? self[1] : null });
  }
  return items;
}

module.exports = (ctx) => {
  let last = null;
  const available = () => run(["--version"], 15000).then((r) => r.code === 0);

  return {
    "GET /api/appupdates": async () => {
      if (!(await available())) return { winget: false, items: [] };
      const r = await run(["upgrade", ...WINGET_ARGS], 180000);
      last = parse(r.out);
      return { winget: true, items: last, at: Date.now() };
    },

    // Met à jour les applications choisies, une par une, en flux.
    "POST /api/appupdates/run": async (req, res) => {
      const { ids } = await ctx.body(req);
      const emit = ctx.stream(res);
      try {
        if (!last) throw new Error("Actualise d'abord la liste.");
        const chosen = last.filter((i) => (ids || []).includes(i.id) && !i.self && ID_RE.test(i.id));
        if (!chosen.length) throw new Error("Rien à mettre à jour.");
        const done = [];
        for (const [k, it] of chosen.entries()) {
          emit({ type: "step", index: k, total: chosen.length, id: it.id, label: `${it.name} : ${it.version} → ${it.available}` });
          // Le programme d'installation demande lui-même l'autorisation administrateur s'il en a besoin.
          const code = await new Promise((resolve) => {
            const p = spawn("winget", ["upgrade", "--id", it.id, "--exact", "--silent", "--accept-package-agreements", ...WINGET_ARGS], { windowsHide: true });
            const relay = (b) => {
              for (const l of String(b).split(/[\r\n]+/)) {
                const pct = /(\d{1,3})\s*%/.exec(l);
                if (pct) emit({ type: "progress", id: it.id, pct: Number(pct[1]) });
                else if (/\w{3,}/.test(l) && !/^[\s█▒-]+$/.test(l)) emit({ type: "log", id: it.id, text: l.trim().slice(0, 200) });
              }
            };
            p.stdout.on("data", relay);
            p.stderr.on("data", relay);
            p.on("close", (c) => resolve(c));
            p.on("error", () => resolve(-1));
          });
          const ok = code === 0;
          emit({ type: "result", id: it.id, ok, code });
          if (ok) done.push(it);
        }
        if (done.length) ctx.journal.add({ kind: "system", title: `Applications mises à jour : ${done.length}`,
          detail: `${done.map((i) => `${i.name} ${i.available}`).join(", ")}. Pas d'annulation automatique : winget ne revient pas à une ancienne version.` });
        last = null;
        emit({ type: "done", updated: done.length, failed: chosen.length - done.length });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally { res.end(); }
    },
  };
};
