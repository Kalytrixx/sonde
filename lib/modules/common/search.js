// Recherche en langage naturel : GPT-OSS traduit la phrase en filtres
// (réponse JSON imposée), puis les filtres sont appliqués au scan.
// On ne demande jamais au modèle de chercher lui-même : il ne ferait
// qu'inventer des résultats.

const path = require("path");
const { categorize, isProtected, OS } = require("../../rules");
const P = require("../../platform");

const SCHEMA = {
  type: "object",
  properties: {
    quoi: { type: "string", enum: ["fichiers", "dossiers", "tout"] },
    nom_contient: { type: "array", items: { type: "string" } },
    extensions: { type: "array", items: { type: "string" } },
    taille_min_mo: { type: "number" },
    taille_max_mo: { type: "number" },
    modifie_avant: { type: "string", description: "AAAA-MM-JJ" },
    modifie_apres: { type: "string", description: "AAAA-MM-JJ" },
    ouvert_avant: { type: "string", description: "AAAA-MM-JJ" },
    ouvert_apres: { type: "string", description: "AAAA-MM-JJ" },
    dans_dossier: { type: "string" },
    tri: { type: "string", enum: ["taille", "modification", "acces"] },
    explication: { type: "string", description: "La recherche reformulée en une phrase" },
  },
  required: ["quoi", "explication"],
};

const SYSTEM = () => `Tu traduis une demande de recherche de fichiers ${OS.name} en filtres JSON.
Familles d'extensions :
- vidéos : .mp4 .mkv .avi .mov .webm .wmv .m4v
- musique / audio : .mp3 .flac .wav .m4a .ogg .aac
- images / photos : .jpg .jpeg .png .heic .webp .gif .bmp .raw .cr2 .nef .psd
- documents : .pdf .docx .doc .xlsx .xls .pptx .odt .txt
- archives : .zip .rar .7z .tar .gz
- installateurs : ${OS.installers}
- images disque : .iso .img .vhdx .vmdk
- modèles d'IA : .safetensors .gguf .ckpt .pt .pth .onnx .bin
Les dates relatives (« cette année », « depuis 6 mois ») se calculent à partir de la date du jour.
« Pas ouvert / pas utilisé depuis X » se traduit par ouvert_avant. « Téléchargements » : dans_dossier = ${OS.downloads(P.HOME)}.
Toute taille mentionnée va dans taille_min_mo ou taille_max_mo, en Mo (1 Go = 1024 Mo).
N'ajoute que les filtres que la demande exprime.

Exemples :
« les fichiers de plus de 3 Go » -> {"quoi":"fichiers","taille_min_mo":3072,"explication":"Fichiers de plus de 3 Go"}
« mes vidéos de moins de 500 Mo » -> {"quoi":"fichiers","extensions":[".mp4",".mkv",".avi",".mov",".webm",".wmv",".m4v"],"taille_max_mo":500,"explication":"Vidéos de moins de 500 Mo"}
« les dossiers steam » -> {"quoi":"dossiers","nom_contient":["steam"],"explication":"Dossiers dont le nom contient steam"}`;

// Une recherche sans aucun filtre renverrait tout le disque : le modèle a
// oublié de traduire une partie de la demande.
const STOP = new Set(["les", "des", "mes", "mon", "une", "dans", "avec", "pour", "tous", "toutes", "tout", "fichiers", "fichier",
  "dossiers", "dossier", "trouve", "cherche", "montre", "moi", "qui", "que", "sont", "plus", "moins", "gros", "grands"]);
const queryWords = (q) => q.toLowerCase().normalize("NFC").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));
const hasFilter = (f) => ["nom_contient", "extensions"].some((k) => f[k]?.length)
  || ["taille_min_mo", "taille_max_mo", "modifie_avant", "modifie_apres", "ouvert_avant", "ouvert_apres", "dans_dossier"].some((k) => f[k] != null && f[k] !== "");

const day = (s) => { const t = Date.parse(s || ""); return Number.isFinite(t) ? t : null; };

module.exports = (ctx) => ({
  "POST /api/search": ctx.aiRoute(async ({ input, emit, signal }) => {
    const scan = ctx.getScan();
    if (!scan) throw new Error("Lance d'abord un scan.");
    const q = String(input.query || "").slice(0, 500).trim();
    if (!q) throw new Error("Demande vide.");
    const system = SYSTEM();
    let f = await ctx.ai.ask({ system, user: q, format: SCHEMA, signal });
    if (!hasFilter(f) && queryWords(q).length) {
      f = await ctx.ai.ask({ system, signal, format: SCHEMA,
        user: `${q}\n\n(Ta réponse précédente n'avait aucun filtre : traduis chaque élément de la demande — nom, taille, date ou type — dans le champ correspondant.)` });
      // Dernier recours : chercher les mots de la demande dans les noms.
      if (!hasFilter(f)) f = { ...f, nom_contient: queryWords(q) };
    }
    emit({ type: "filters", filters: f });

    const exts = (f.extensions || []).map((e) => (e.startsWith(".") ? e : "." + e).toLowerCase());
    const words = (f.nom_contient || []).map((w) => w.toLowerCase()).filter(Boolean);
    const min = f.taille_min_mo != null ? f.taille_min_mo * 1024 ** 2 : null;
    const max = f.taille_max_mo != null ? f.taille_max_mo * 1024 ** 2 : null;
    const mB = day(f.modifie_avant), mA = day(f.modifie_apres), oB = day(f.ouvert_avant), oA = day(f.ouvert_apres);
    const inside = f.dans_dossier ? P.key(P.join(path.resolve(f.dans_dossier), "")) : null;

    const ok = (p, name, size, mtime, atime, isFile) => {
      if (inside && !P.key(p).startsWith(inside)) return false;
      if (exts.length && (!isFile || !exts.includes(path.extname(name).toLowerCase()))) return false;
      if (words.length && !words.some((w) => name.toLowerCase().includes(w))) return false;
      if (min != null && size < min) return false;
      if (max != null && size > max) return false;
      if (mB != null && mtime >= mB) return false;
      if (mA != null && mtime < mA) return false;
      const a = Math.max(atime || 0, mtime);
      if (oB != null && a >= oB) return false;
      if (oA != null && a < oA) return false;
      return true;
    };

    const hits = [];
    const wantFiles = f.quoi !== "dossiers", wantDirs = f.quoi !== "fichiers" && !exts.length;
    for (const d of scan.index.values()) {
      if (wantDirs && d.parent && ok(d.path, d.name, d.size, d.mtime, d.atime, false)) {
        hits.push({ name: d.name, path: d.path, size: d.size, mtime: d.mtime, atime: d.atime, type: "dir", count: d.count });
      }
      if (wantFiles) {
        const base = P.join(d.path, "");
        for (const x of d.files) {
          if (ok(base + x.name, x.name, x.size, x.mtime, x.atime, true)) {
            hits.push({ name: x.name, path: base + x.name, size: x.size, mtime: x.mtime, atime: x.atime, type: "file" });
          }
        }
      }
    }
    const key = f.tri === "modification" ? "mtime" : f.tri === "acces" ? "atime" : "size";
    hits.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    const results = hits.slice(0, 300).map((h) => ({ ...h, cat: categorize(h.path), protected: isProtected(h.path),
      note: ctx.notes.get(h.path)?.text }));
    return { filters: f, results, total: hits.length };
  }),
});
