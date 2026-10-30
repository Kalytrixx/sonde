// L'IA de Sonde (GPT-OSS par défaut, ou tout modèle Ollama ou API choisi
// dans les réglages : voir lib/llm.js). Le modèle ne voit jamais tout le disque d'un coup :
// il reçoit une vue d'ensemble puis explore lui-même avec des outils.
// Chaque recommandation est revérifiée côté serveur (le chemin existe, il
// n'est pas protégé, la taille vient du scan et non du modèle).

const fs = require("fs");
const path = require("path");
const { categorize, matchRule, isProtected, CATEGORY_LABELS, GUARDS, OS } = require("./rules");
const P = require("./platform");
const { key, SEP } = P;
// Les regex ci-dessous acceptent « \ » et « / » : elles valent pour les deux systèmes.

const llm = require("./llm");
// Modèle Ollama choisi par l'assistant de premier lancement (bascule sur Ollama).
const setModel = (m) => { if (m) llm.configure({ provider: "ollama", model: m, baseUrl: llm.PRESETS.ollama.baseUrl, key: null }); };

// ---------------------------------------------------------------- format ---
const go = (n) => {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + " Go";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + " Mo";
  return (n / 1024).toFixed(0) + " Ko";
};
const date = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "?");

// ------------------------------------------------------------ notes (carte) -
// Ce que l'IA a compris de chaque dossier, gardé d'une session à l'autre.
class Notes {
  constructor(file) {
    this.file = file;
    try { this.map = JSON.parse(fs.readFileSync(file, "utf8")); } catch { this.map = {}; }
  }
  get(p) { return this.map[p.toLowerCase()]; }
  set(p, text) {
    this.map[p.toLowerCase()] = { path: p, text, at: Date.now() };
    fs.writeFileSync(this.file, JSON.stringify(this.map, null, 1), "utf8");
  }
  get count() { return Object.keys(this.map).length; }
  clear() { this.map = {}; fs.writeFileSync(this.file, "{}", "utf8"); }
}

// ------------------------------------------------------------ client IA ---
const status = () => llm.status();
// Un appel en streaming, quel que soit le fournisseur. Renvoie le message
// complet ; les morceaux de texte et de réflexion sont transmis au fur et à mesure.
const chatStream = ({ think = "medium", ...o }) => llm.chat({ think, ...o });

// ------------------------------------------------------------- garde-fous -
// Vérifiés ici, quoi qu'en dise le modèle. Il se trompe : il a déjà proposé de
// supprimer les node_modules de VS Code et le fichier de son propre modèle.
const DAY = 864e5;
function guard(scan, p, mtime, rule, dup = false) {
  if (/[\\/](site-packages|dist-packages|node_modules|\.venv|venv)[\\/]/i.test(p))
    return "fait partie d'un environnement Python ou Node : en supprimer un morceau le casserait. Recommande l'environnement entier ou rien.";
  if (/[\\/]\.ollama[\\/]models([\\/]|$)/i.test(p))
    return "modèle Ollama : conseille la commande \"ollama rm <nom>\" (voir \"ollama list\"), jamais de supprimer les blobs à la main. Si c'est un doublon, recommande plutôt l'AUTRE copie, celle qui n'est pas dans .ollama.";
  // Garde-fous propres au système (applications installées, Store, Flatpak…).
  for (const g of GUARDS) {
    if (!g.re.test(p)) continue;
    if (g.unless && g.unless.test(p)) continue;
    if (g.also && !g.also.test(p)) continue;
    return g.why;
  }
  if (!rule && !dup && Date.now() - mtime < 7 * DAY)
    return "modifié il y a moins de 7 jours : probablement encore utilisé.";
  const env = p.match(/^(.*)[\\/](node_modules|\.venv|venv)$/i);
  if (env) {
    const project = scan.get(env[1]);
    if (project && Date.now() - project.mtime < 60 * DAY)
      return `le projet ${env[1]} a été modifié le ${date(project.mtime)} : il sert encore.`;
  }
  return null;
}

// ------------------------------------------------------------------ outils -
const TOOLS = [
  { name: "lister_dossier", description: "Liste le contenu d'un dossier, trié par taille (sous-dossiers et gros fichiers), avec date de dernière modification et règle de nettoyage connue.",
    parameters: { type: "object", properties: { chemin: { type: "string", description: OS.pathKind }, limite: { type: "integer", description: "Nombre de lignes (défaut 20)" } }, required: ["chemin"] } },
  { name: "infos", description: "Détails sur un dossier ou un fichier : taille, nombre de fichiers, dernière modification, types de fichiers dominants, s'il est protégé.",
    parameters: { type: "object", properties: { chemin: { type: "string" } }, required: ["chemin"] } },
  { name: "gros_fichiers", description: "Les plus gros fichiers du disque (plus de 50 Mo), éventuellement limités à un dossier ou une extension.",
    parameters: { type: "object", properties: { dans: { type: "string", description: "Dossier (optionnel)" }, extension: { type: "string", description: "ex. .mp4 (optionnel)" }, limite: { type: "integer" } } } },
  { name: "rechercher", description: "Cherche des dossiers dont le nom contient un mot (ex. 'cache', 'steam', 'backup'). Renvoie les plus gros.",
    parameters: { type: "object", properties: { motif: { type: "string" }, limite: { type: "integer" } }, required: ["motif"] } },
  { name: "doublons", description: "Fichiers de plus de 50 Mo présents en plusieurs exemplaires identiques (même taille, même contenu).",
    parameters: { type: "object", properties: {} } },
  { name: "programmes_installes", description: "Programmes et jeux installés sur TOUS les disques du PC (pas seulement le disque scanné), avec taille, emplacement et dernière utilisation. À utiliser pour toute question sur les jeux, les logiciels ou ce qui prend de la place hors du disque scanné.",
    parameters: { type: "object", properties: { filtre: { type: "string", description: "Mot à chercher dans le nom, l'éditeur ou l'emplacement (optionnel)" }, limite: { type: "integer" } } } },
  { name: "decrire", description: "Note sur la carte, en quelques mots, ce que contient un dossier (ex. 'Modèles de génération vidéo pour ComfyUI'). À appeler pour chaque gros dossier compris.",
    parameters: { type: "object", properties: { chemin: { type: "string" }, description: { type: "string", description: "10 mots maximum" } }, required: ["chemin", "description"] } },
  { name: "recommander", description: "Propose à l'utilisateur de mettre un élément à la corbeille. Il décidera lui-même.",
    parameters: { type: "object", properties: {
      chemin: { type: "string" },
      niveau: { type: "string", enum: ["sur", "a_verifier"], description: "sur = se recrée tout seul (cache, temporaire). a_verifier = récupérable mais l'utilisateur doit confirmer." },
      raison: { type: "string", description: "Explication concrète en une phrase, pour un non-spécialiste." },
      vider_contenu: { type: "boolean", description: "true pour vider le dossier sans supprimer le dossier lui-même (caches)." },
    }, required: ["chemin", "niveau", "raison"] } },
].map((f) => ({ type: "function", function: f }));

class Toolbox {
  constructor(scan, notes, onReco) {
    this.scan = scan;
    this.notes = notes;
    this.onReco = onReco;
    this.recos = new Map();
    this.refused = [];
  }

  resolve(p) {
    if (!p) return null;
    const r = path.resolve(P.IS_WIN ? String(p).replace(/\//g, "\\") : String(p));
    return (r.length > 1 ? r.replace(P.IS_WIN ? /\\$/ : /\/$/, "") : r) || null;
  }

  line(x, isFile) {
    const r = !isFile && matchRule(x.path);
    const note = this.notes.get(x.path);
    return `${go(x.size).padStart(8)}  ${isFile ? "[fichier]" : "[dossier]"} ${x.path}  (modifié ${date(x.mtime)}, dernier accès ${date(x.atime || x.mtime)}` +
      (isFile ? "" : `, ${x.count} fichiers`) + ")" +
      (r ? `  [connu : ${r.label}, ${r.niveau}]` : "") +
      (isProtected(x.path) ? "  [PROTÉGÉ]" : "") +
      (note ? `  [note : ${note.text}]` : "");
  }

  async run(name, args) {
    try {
      const out = this[name] ? await this[name](args || {}) : `Outil inconnu : ${name}`;
      if (name === "recommander" && /^Refusé/.test(out)) this.refused.push(out.replace(/^Refusé : /, ""));
      return out;
    } catch (e) {
      return `Erreur : ${e.message}`;
    }
  }

  // Programmes et jeux installés sur tous les disques : le scan, lui, ne
  // couvre souvent qu'un seul disque (les jeux sont fréquemment sur un autre).
  async programmes_installes({ filtre, limite = 25 }) {
    if (!this.apps) return "Liste des programmes indisponible.";
    let list = await this.apps();
    if (filtre) {
      const f = String(filtre).toLowerCase();
      list = list.filter((a) => `${a.name} ${a.publisher} ${a.location || ""}`.toLowerCase().includes(f));
    }
    list = [...list].sort((a, b) => b.size - a.size).slice(0, Math.min(Math.max(1, limite), 60));
    if (!list.length) return "Aucun programme ne correspond.";
    return list.map((a) => `${go(a.size).padStart(8)}${a.sizeSource === "registre" ? " (taille déclarée)" : ""}  ${a.name} — ${a.publisher || "éditeur inconnu"} — ${a.location || "emplacement inconnu"}` +
      (a.lastUsed ? ` — dernier usage ${date(a.lastUsed)}` : "")).join("\n");
  }

  lister_dossier({ chemin, limite = 20 }) {
    const d = this.scan.get(this.resolve(chemin));
    if (!d) return `Introuvable dans le scan : ${chemin}`;
    const base = d.path.endsWith(SEP) ? d.path : d.path + SEP;
    const items = [
      ...d.children.map((c) => ({ x: c, f: false })),
      ...d.files.map((f) => ({ x: { ...f, path: base + f.name }, f: true })),
    ].sort((a, b) => b.x.size - a.x.size);
    const n = Math.min(Math.max(1, limite), 40);
    const out = [`${d.path} : ${go(d.size)} au total, ${d.count} fichiers, modifié le ${date(d.mtime)}`];
    for (const it of items.slice(0, n)) out.push(this.line(it.x, it.f));
    if (items.length > n) out.push(`… et ${items.length - n} autres éléments`);
    if (d.smallSize) out.push(`${go(d.smallSize).padStart(8)}  ${d.smallCount} petits fichiers directement dans ce dossier`);
    if (d.denied) out.push("(accès refusé à ce dossier)");
    return out.join("\n");
  }

  infos({ chemin }) {
    const p = this.resolve(chemin);
    const d = this.scan.get(p);
    if (!d) {
      const hit = this.scan.getFile(p);
      if (!hit) return `Introuvable dans le scan : ${chemin}`;
      return `${p}\nfichier de ${go(hit.file.size)}, modifié le ${date(hit.file.mtime)}, famille : ${CATEGORY_LABELS[categorize(p)]}` +
        (isProtected(p) ? "\nPROTÉGÉ : ne peut pas être supprimé." : "");
    }
    // Types dominants, d'après les gros fichiers du sous-arbre.
    const exts = new Map();
    const stack = [d];
    let big = 0;
    while (stack.length) {
      const x = stack.pop();
      for (const f of x.files) {
        const e = path.extname(f.name).toLowerCase() || "(sans)";
        exts.set(e, (exts.get(e) || 0) + f.size);
        big += f.size;
      }
      stack.push(...x.children);
    }
    const top = [...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([e, s]) => `${e} ${go(s)}`).join(", ");
    const r = matchRule(d.path);
    const note = this.notes.get(d.path);
    return [
      d.path,
      `taille ${go(d.size)}, ${d.count} fichiers, ${d.children.length} sous-dossiers, modifié le ${date(d.mtime)}`,
      `famille : ${CATEGORY_LABELS[categorize(d.path)]}`,
      top ? `types dominants (fichiers > 5 Mo, ${go(big)}) : ${top}` : "que des petits fichiers",
      r ? `règle connue : ${r.label} (${r.niveau}) — ${r.pourquoi}` : "",
      note ? `note : ${note.text}` : "",
      isProtected(d.path) ? "PROTÉGÉ : ne peut pas être supprimé." : "",
    ].filter(Boolean).join("\n");
  }

  gros_fichiers({ dans, extension, limite = 15 }) {
    let list = this.scan.topFiles;
    if (dans) {
      const pre = key(P.join(this.resolve(dans), ""));
      list = list.filter((f) => key(f.path).startsWith(pre));
    }
    if (extension) {
      const e = extension.startsWith(".") ? extension.toLowerCase() : "." + extension.toLowerCase();
      list = list.filter((f) => f.path.toLowerCase().endsWith(e));
    }
    const n = Math.min(Math.max(1, limite), 40);
    if (!list.length) return "Aucun fichier de plus de 50 Mo ne correspond.";
    return list.slice(0, n).map((f) => this.line(f, true)).join("\n");
  }

  rechercher({ motif, limite = 15 }) {
    const m = String(motif || "").toLowerCase();
    if (m.length < 2) return "Motif trop court.";
    const hits = [];
    for (const d of this.scan.index.values()) {
      if (d.name.toLowerCase().includes(m) && d.size > 1024 * 1024) hits.push(d);
    }
    hits.sort((a, b) => b.size - a.size);
    // On ne garde pas un dossier dont le parent est déjà dans la liste.
    const kept = [];
    for (const h of hits) {
      if (kept.some((k) => P.inside(h.path, k.path))) continue;
      kept.push(h);
      if (kept.length >= Math.min(limite, 30)) break;
    }
    return kept.length ? kept.map((d) => this.line(d, false)).join("\n") : "Aucun dossier de plus de 1 Mo ne correspond.";
  }

  doublons() {
    const groups = this.scan._dups || [];
    if (!groups.length) return "Aucun doublon parmi les fichiers de plus de 50 Mo.";
    return groups.slice(0, 15).map((g) =>
      `${go(g.wasted)} récupérables — ${g.files.length} copies de ${go(g.size)} :\n` +
      g.files.map((f) => `    ${f.path}  (modifié ${date(f.mtime)})`).join("\n")).join("\n");
  }

  decrire({ chemin, description }) {
    const p = this.resolve(chemin);
    const d = this.scan.get(p) || this.scan.getFile(p);
    if (!d) return `Introuvable dans le scan : ${chemin}`;
    this.notes.set(this.scan.get(p) ? this.scan.get(p).path : p, String(description).slice(0, 120));
    return "Noté.";
  }

  recommander({ chemin, niveau, raison, vider_contenu }) {
    const p = this.resolve(chemin);
    if (isProtected(p)) return `Refusé : ${p} est protégé (système ou dossier personnel racine). Choisis un sous-dossier précis.`;
    const d = this.scan.get(p);
    const hit = d ? null : this.scan.getFile(p);
    if (!d && !hit) return `Refusé : ${chemin} n'existe pas dans le scan. Vérifie le chemin avec lister_dossier.`;
    const rule = d && matchRule(d.path);
    const dup = (this.scan._dups || []).some((g) => g.files.some((f) => key(f.path) === key(p)));
    const why = guard(this.scan, d ? d.path : p, d ? d.mtime : hit.file.mtime, rule, dup);
    if (why) return `Refusé : ${p} — ${why}`;
    // "sur" n'est accepté que pour ce que les règles connaissent déjà comme
    // cache. Le modèle peut se tromper ; les règles, elles, sont vérifiées.
    const lvl = niveau === "sur" && !rule && !/[\\/]__pycache__$/i.test(p) ? "a_verifier" : (niveau === "sur" ? "sur" : "a_verifier");
    const item = {
      path: d ? d.path : p,
      size: d ? d.size : hit.file.size,
      mtime: d ? d.mtime : hit.file.mtime,
      type: d ? "dir" : "file",
      niveau: lvl,
      raison: String(raison || "").slice(0, 300),
      contenu: !!(d && (vider_contenu || (rule && rule.contenu))),
      cat: categorize(p),
    };
    for (const k of this.recos.keys()) {
      if (key(item.path).startsWith(k + SEP)) return `Déjà couvert par une recommandation sur ${this.recos.get(k).path}.`;
    }
    // Une recommandation sur un parent remplace celles sur ses enfants.
    for (const k of [...this.recos.keys()]) if (k.startsWith(key(item.path) + SEP)) this.recos.delete(k);
    this.recos.set(key(item.path), item);
    this.onReco && this.onReco(item);
    return `Ajouté (${go(item.size)}, niveau ${lvl}${lvl !== niveau ? " : rétrogradé car ce n'est pas un cache connu" : ""}).`;
  }
}

// ------------------------------------------------------- vue d'ensemble ---
function overview(scan, notes, freeBytes) {
  const t = scan.tree;
  const out = [];
  out.push(`${scan.multi ? "Disques analysés" : "Disque analysé"} : ${scan.root} — ${go(t.size)} de fichiers, ${t.count} fichiers` +
    (freeBytes != null ? `, ${go(freeBytes)} libres` : "") + ".");
  // Les autres disques existent mais ne sont pas dans le scan : le modèle doit le savoir.
  const others = P.drives().filter((d) => !scan.roots.some((r) => key(r) === key(d) || (P.IS_WIN && key(r).startsWith(key(d.slice(0, 2))))));
  if (others.length) out.push(`Autres disques du PC, NON scannés : ${others.join(", ")}. Leurs programmes et jeux sont visibles avec programmes_installes.`);
  out.push("\nARBORESCENCE (dossiers de plus de 1 Go, 2 niveaux) :");
  const walk = (d, depth) => {
    for (const c of d.children) {
      if (c.size < 1024 ** 3 || depth > (scan.multi ? 3 : 2)) continue;
      const note = notes.get(c.path);
      out.push(`${"  ".repeat(depth - 1)}${go(c.size).padStart(8)}  ${c.path}  (modifié ${date(c.mtime)})` + (note ? `  [note : ${note.text}]` : ""));
      if (c.size >= 3 * 1024 ** 3) walk(c, depth + 1);
    }
  };
  walk(t, 1);
  const blocks = scan.blocks();
  if (blocks.length) {
    out.push("\nBLOCS À COMPRENDRE (là où le poids se concentre, à explorer en priorité) :");
    for (const b of blocks) {
      const note = notes.get(b.path);
      out.push(`${go(b.size).padStart(8)}  ${b.path}  (modifié ${date(b.mtime)})` + (note ? `  [note : ${note.text}]` : ""));
    }
  }
  const dups = scan._dups || [];
  if (dups.length) {
    out.push("\nDOUBLONS (fichiers identiques) :");
    for (const g of dups.slice(0, 6)) out.push(`${go(g.wasted).padStart(8)} récupérables : ${g.files.map((f) => f.path).join("  ET  ")}`);
  }
  const cands = scan.candidates(50 * 1024 * 1024).slice(0, 15);
  if (cands.length) {
    out.push("\nCACHES ET TEMPORAIRES RECONNUS :");
    for (const c of cands) out.push(`${go(c.size).padStart(8)}  ${c.path}  [${c.rule.label}, ${c.rule.niveau}]`);
  }
  out.push("\nPLUS GROS FICHIERS :");
  for (const f of scan.topFiles.slice(0, 12)) out.push(`${go(f.size).padStart(8)}  ${f.path}  (modifié ${date(f.mtime)})`);
  out.push("\nTYPES DE FICHIERS :");
  out.push(scan.extensions(10).map((e) => `${e.ext} ${go(e.size)}`).join(", "));
  return out.join("\n");
}

const today = () => new Date().toISOString().slice(0, 10);

const SYSTEM_ANALYSE = () => `Tu es Sonde, un expert du nettoyage de disque sous ${OS.name}. Tu parles français, simplement, à quelqu'un qui n'est pas informaticien. Nous sommes le ${today()}.

Ta mission : COMPRENDRE et CARTOGRAPHIER le disque, puis RECOMMANDER ce qui peut être libéré.

Méthode :
1. Explore avec lister_dossier chaque BLOC À COMPRENDRE de la vue d'ensemble, en descendant jusqu'à savoir précisément ce qu'il contient (quels modèles, quel jeu, quel projet, quelles versions).
2. Ne perds pas de temps avec l'évidence : inutile de décrire ${OS.evident} en général.
3. Appelle decrire pour chaque bloc compris, avec des mots précis (« Modèles vidéo LTX et Wan pour ComfyUI », pas « Dossier de l'utilisateur »).
4. Regarde les doublons : garder la copie la plus récente ou celle utilisée par le bon programme.
5. Appelle recommander pour chaque élément qui mérite d'être supprimé. Si un refus revient, n'insiste pas.
6. Suis les phases que l'utilisateur t'indique (exploration, recommandations, rapport).

Règles de recommandation :
- niveau "sur" : uniquement caches et temporaires qui se recréent seuls.
- niveau "a_verifier" : tout le reste (anciennes versions, doublons, téléchargements oubliés, projets abandonnés, gros fichiers pas touchés depuis longtemps). La raison doit être concrète : date, doublon de quoi, remplacé par quoi.
- Ne recommande JAMAIS : fichiers du système, programmes installés, documents, photos, vidéos personnelles, sauvegardes de jeux, ni un dossier modifié dans les 7 derniers jours (sauf cache).
- Jeux et modèles Ollama (.ollama) : ne recommande pas de supprimer leurs fichiers ; conseille dans le résumé de désinstaller via le lanceur du jeu ou "ollama rm <modèle>".
- Rien à l'intérieur d'une application installée (${OS.neverInside}).
- Environnements Python (.venv, venv) et node_modules : seulement pour un projet abandonné depuis plus de 2 mois, jamais sous ${OS.envUnder}.
- ${OS.trashNote}
- Préfère des chemins précis (un fichier, un sous-dossier) plutôt qu'un gros dossier parent.
- N'invente jamais un chemin ni une taille : utilise uniquement ce que renvoient les outils.

Résumé final, en markdown court, SANS tableau :
- "## Carte" : 5 à 8 puces, une par grand bloc réel (taille, ce que c'est concrètement).
- "## À faire" : 3 à 8 puces, de la plus rentable à la moins rentable, avec l'espace gagné. Seulement ce que tu as vraiment recommandé.
- "## À savoir" : 2 à 5 puces sur ce qu'il faut faire soi-même (vider la corbeille, désinstaller un jeu, ollama rm…).`;

const SYSTEM_CHAT = () => `Tu es Sonde, l'assistant de nettoyage de disque de l'utilisateur, sous ${OS.name}. Tu parles français, simplement. Nous sommes le ${today()}.
Tu as des outils pour explorer le scan du disque. Utilise-les avant de répondre à une question sur le contenu du disque : n'invente jamais un chemin ni une taille.
Si l'utilisateur veut supprimer quelque chose, utilise recommander : l'élément s'ajoutera à sa sélection et il confirmera lui-même. Tu ne supprimes jamais rien directement.
Ne recommande jamais les fichiers du système, les programmes installés (conseille de les désinstaller via ${OS.uninstall}), ni les documents personnels sans demande explicite.
IMPORTANT : le scan ne couvre qu'un seul disque (indiqué dans la vue d'ensemble). Ne conclus jamais sur « tout le PC » à partir du scan seul : précise de quel disque tu parles. Pour toute question sur les jeux ou les logiciels, appelle programmes_installes, qui couvre tous les disques.
Réponds de façon concise. Écris les chemins entre accents graves (\`${OS.pathExample}\`).`;

// ------------------------------------------------------------ boucle agent -
// Fait tourner le modèle avec ses outils jusqu'à ce qu'il réponde sans
// appeler d'outil. `history` est complété sur place, pour enchaîner des phases.
async function agentLoop({ history, box, emit, signal, maxRounds = 30, think = "medium", showText = true }) {
  let nudged = false;
  for (let round = 0; round < maxRounds; round++) {
    emit({ type: "round", round });
    const msg = await chatStream({
      messages: history, tools: TOOLS, think, signal,
      onThink: (t) => emit({ type: "think", text: t }),
      onText: showText ? (t) => emit({ type: "text", text: t }) : null,
    });
    history.push(msg);
    if (!msg.tool_calls) {
      if (!msg.content.trim() && !nudged && showText) {
        nudged = true;
        history.push({ role: "user", content: "Écris maintenant ta réponse finale." });
        continue;
      }
      return msg.content;
    }
    for (const [k, call] of msg.tool_calls.entries()) {
      call.id ||= `call_${round}_${k}`;
      const { name, arguments: args } = call.function;
      emit({ type: "tool", name, args });
      const result = await box.run(name, args);
      emit({ type: "tool_result", name, args, result: result.slice(0, 1500) });
      history.push({ role: "tool", tool_name: name, tool_call_id: call.id, content: result });
    }
  }
  return null;
}

// Candidats présélectionnés pour la phase 2, déjà passés aux garde-fous.
// Seul, le modèle concluait souvent « rien à recommander » ; avec une liste
// concrète à juger, il tranche au cas par cas.
function candidateList(scan) {
  const out = [];
  const seen = new Set();
  const add = (p, size, mtime, why) => {
    const k = key(p);
    if (seen.has(k) || isProtected(p)) return;
    const d = scan.get(p);
    if (guard(scan, p, mtime, d && matchRule(d.path), why.startsWith("doublon"))) return;
    seen.add(k);
    out.push(`${go(size).padStart(8)}  ${p}  (modifié ${date(mtime)}) — ${why}`);
  };
  for (const c of scan.candidates(100 * 1024 ** 2).slice(0, 12)) add(c.path, c.size, c.mtime, `cache connu : ${c.rule.label}`);
  for (const g of (scan._dups || []).slice(0, 10)) {
    // On garde la copie de .ollama si elle existe, sinon la plus récente.
    const keep = g.files.find((f) => /[\\/]\.ollama[\\/]/i.test(f.path)) || g.files[0];
    for (const f of g.files) if (f !== keep) add(f.path, f.size, f.mtime, `doublon identique de ${keep.path} (le programme qui utilise cette copie devra se servir de l'autre)`);
  }
  // Le dernier accès compte plus que la modification : un modèle téléchargé
  // il y a un an mais chargé hier sert encore.
  const old = Date.now() - 90 * DAY;
  const last = (x) => Math.max(x.atime || 0, x.mtime);
  for (const f of scan.topFiles.filter((f) => last(f) < old && f.size >= 512 * 1024 ** 2).slice(0, 15)) {
    add(f.path, f.size, f.mtime, `gros fichier pas ouvert depuis le ${date(last(f))}`);
  }
  for (const b of scan.blocks(1024 ** 3, 40).filter((b) => last(b) < old).slice(0, 8)) {
    add(b.path, b.size, b.mtime, `gros dossier pas ouvert depuis le ${date(last(b))}`);
  }
  return out;
}

// Consignes de chaque phase. Sans phases imposées, le modèle explorait bien
// mais concluait sans jamais appeler `recommander`.
const PHASE_1 = "PHASE 1 — EXPLORATION. Explore les blocs à comprendre et appelle decrire pour chacun. N'écris pas encore de rapport. Quand tu as compris les gros blocs, réponds seulement « Exploration terminée ».";
const PHASE_2 = (cands) => `PHASE 2 — RECOMMANDATIONS.
Voici des CANDIDATS présélectionnés par Sonde (déjà vérifiés : ni système, ni application installée) :
${cands.length ? cands.join("\n") : "(aucun)"}

Juge chaque candidat avec ce que tu as compris pendant l'exploration. Appelle recommander pour chacun de ceux qui méritent d'être libérés, avec une raison concrète ; ignore ceux qui servent encore (modèle utilisé, jeu installé, projet actif). Tu peux aussi recommander d'autres éléments. Rappel de ce qui mérite d'être libéré :
- les caches et temporaires reconnus (niveau sur, vider_contenu true) ;
- les doublons : la copie qui ne sert pas au programme principal (si une copie est dans .ollama, recommande l'autre) ;
- les anciennes versions remplacées par une version plus récente (modèles, installateurs) ;
- les gros fichiers ou dossiers pas modifiés depuis des mois et qui ne servent visiblement plus.
Vérifie un chemin avec lister_dossier si besoin. Un refus est définitif : passe au suivant. Quand tu as fini, réponds seulement « Recommandations terminées ».`;
const PHASE_3 = (accepted, refused, blocks) => `PHASE 3 — RAPPORT. Rédige maintenant le rapport final, sans appeler d'outil.
Écris toujours les chemins entre accents graves, par exemple \`${OS.pathExample}\`.
Blocs compris pendant l'exploration (pour la « Carte ») :
${blocks.length ? blocks.map((b) => `- ${b.path} (${go(b.size)}) : ${b.note}`).join("\n") : "- aucun"}
Recommandations ACCEPTÉES (les seules à mettre dans « À faire ») :
${accepted.length ? accepted.map((r) => `- ${r.path} (${go(r.size)}, ${r.niveau}) : ${r.raison}`).join("\n") : "- aucune"}
Recommandations REFUSÉES par les garde-fous (à mentionner dans « À savoir » seulement si c'est utile, par exemple « désinstaller via ${OS.uninstall} » ou « ollama rm ») :
${refused.length ? refused.slice(0, 12).map((r) => `- ${r}`).join("\n") : "- aucune"}`;

// Rapport sans IA, si le modèle n'arrive pas à rédiger.
function fallbackReport(recos, refused, blocks) {
  const tot = recos.reduce((a, r) => a + r.size, 0);
  return [
    "## Carte",
    ...(blocks.length ? blocks.map((b) => `- \`${b.path}\` (${go(b.size)}) : ${b.note}`) : ["- (aucun bloc décrit)"]),
    "",
    `## À faire (${go(tot)} au total)`,
    ...(recos.length ? [...recos].sort((a, b) => b.size - a.size).map((r) => `- \`${r.path}\` — ${go(r.size)} : ${r.raison}`) : ["- Rien à recommander."]),
    "",
    "## À savoir",
    ...(refused.length ? refused.slice(0, 6).map((r) => `- ${r}`) : ["- Pense à vider la corbeille après le nettoyage."]),
  ].join("\n");
}

async function analyse({ scan, notes, freeBytes, emit, signal }) {
  emit({ type: "status", text: "Recherche des doublons" });
  await scan.duplicates();
  const box = new Toolbox(scan, notes, (r) => emit({ type: "reco", reco: r }));
  const view = overview(scan, notes, freeBytes);
  emit({ type: "overview", text: view });
  const history = [
    { role: "system", content: SYSTEM_ANALYSE() },
    { role: "user", content: `Voici la vue d'ensemble du scan :\n\n${view}\n\n${PHASE_1}` },
  ];
  emit({ type: "status", text: "Phase 1 : exploration" });
  await agentLoop({ history, box, emit, signal, maxRounds: 24, showText: false });

  emit({ type: "status", text: "Phase 2 : recommandations" });
  const cands = candidateList(scan);
  history.push({ role: "user", content: PHASE_2(cands) });
  await agentLoop({ history, box, emit, signal, maxRounds: 20, showText: false });
  if (!box.recos.size && !box.refused.length && cands.length) {
    history.push({ role: "user", content: "Tu n'as appelé recommander aucune fois. Reprends la liste des candidats un par un et appelle recommander pour chacun de ceux qui méritent d'être libérés (au minimum les caches connus)." });
    await agentLoop({ history, box, emit, signal, maxRounds: 16, showText: false });
  }

  emit({ type: "status", text: "Phase 3 : rapport" });
  // Les dossiers décrits pendant la phase 1, pour que le rapport garde sa carte.
  const described = [...scan.blocks(1024 ** 3, 40), ...scan.tops()]
    .map((d) => ({ path: d.path, size: d.size, note: notes.get(d.path)?.text }))
    .filter((b, i, a) => b.note && a.findIndex((x) => x.path === b.path) === i)
    .sort((a, b) => b.size - a.size).slice(0, 12);
  // Le rapport s'écrit dans un contexte neuf : avec tout l'historique d'outils
  // mais sans outils disponibles, le modèle rendait parfois une réponse vide.
  const recos = [...box.recos.values()];
  const report = [
    { role: "system", content: SYSTEM_ANALYSE() },
    { role: "user", content: `${scan.multi ? "Disques" : "Disque"} : ${scan.root}, ${go(scan.tree.size)} analysés` + (freeBytes != null ? `, ${go(freeBytes)} libres` : "") + ".\n\n" + PHASE_3(recos, box.refused, described) },
  ];
  let msg = await chatStream({ messages: report, think: "low", signal, onText: (t) => emit({ type: "text", text: t }) });
  if (!msg.content.trim()) {
    emit({ type: "status", text: "Nouvel essai de rédaction" });
    msg = await chatStream({ messages: report, think: "medium", signal, onText: (t) => emit({ type: "text", text: t }) });
  }
  const summary = msg.content.trim() || fallbackReport(recos, box.refused, described);
  return { summary, recos, map: described };
}

async function chat({ scan, notes, freeBytes, messages, emit, signal, apps }) {
  await scan.duplicates();
  const box = new Toolbox(scan, notes, (r) => emit({ type: "reco", reco: r }));
  box.apps = apps;
  const system = SYSTEM_CHAT() + "\n\nVue d'ensemble du disque :\n" + overview(scan, notes, freeBytes);
  const clean = messages.filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content) })).slice(-12);
  const history = [{ role: "system", content: system }, ...clean];
  const out = await agentLoop({ history, box, emit, signal, maxRounds: 12, think: "low" });
  if (out !== null) return out;
  history.push({ role: "user", content: "Réponds maintenant, sans outil." });
  const msg = await chatStream({ messages: history, think: "low", signal, onText: (t) => emit({ type: "text", text: t }) });
  return msg.content;
}

// Question simple, sans outils, pour les modules système (services, pilotes,
// réseau…). `format` : schéma JSON imposé à la réponse.
async function ask({ system, user, format, think = "low", emit, signal }) {
  const msg = await chatStream({
    messages: [{ role: "system", content: `${system}\nNous sommes le ${today()}. Tu parles français, simplement.` }, { role: "user", content: user }],
    think, format, signal, onText: emit && !format ? (t) => emit({ type: "text", text: t }) : null,
  });
  if (!format) return msg.content.trim();
  try { return JSON.parse(msg.content); } catch { throw new Error("GPT-OSS a renvoyé une réponse illisible."); }
}

// Explication rapide d'un seul dossier ou fichier, sans exploration libre.
async function explain({ scan, notes, target, emit, signal }) {
  const box = new Toolbox(scan, notes);
  const d = scan.get(target);
  const ctx = box.infos({ chemin: target }) + (d ? "\n\nCONTENU :\n" + box.lister_dossier({ chemin: target, limite: 15 }) : "");
  const history = [
    { role: "system", content: `Tu es Sonde, expert ${OS.name}. Tu expliques en français simple, en 4 phrases maximum : ce qu'est cet élément (quel programme l'a créé), s'il peut être supprimé sans risque, et comment le faire proprement (bouton Supprimer de Sonde qui passe par la corbeille, désinstallation via ${OS.uninstall}, ou commande comme "ollama rm"). Ne propose JAMAIS de commande de suppression définitive (${OS.noDelete}). Si tu n'es pas sûr, dis-le. Nous sommes le ${today()}.` },
    { role: "user", content: ctx },
  ];
  const msg = await chatStream({ messages: history, think: "low", signal, onText: (t) => emit({ type: "text", text: t }) });
  const text = msg.content.trim();
  // La première phrase sert de note sur la carte si le dossier n'en a pas.
  if (d && d.size > 256 * 1024 ** 2 && !notes.get(d.path) && text) {
    notes.set(d.path, text.split(/(?<=[.!?])\s/)[0].slice(0, 120));
  }
  return text;
}

module.exports = { status, analyse, chat, explain, ask, Notes, setModel, configure: llm.configure, describe: llm.describe,
  get MODEL() { return llm.config.model; }, _candidateList: candidateList };
