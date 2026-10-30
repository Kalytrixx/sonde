// Sonde — interface principale : navigation, accueil et scan, analyse IA,
// carte du disque, listes de fichiers, sélection, « Demande à Sonde ».
"use strict";

// ------------------------------------------------------------- utilitaires -
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const H = { "X-Sonde": "1", "Content-Type": "application/json" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });

function size(n) {
  if (n == null) return "–";
  if (n >= 1024 ** 4) return nf1.format(n / 1024 ** 4) + " To";
  if (n >= 1024 ** 3) return nf1.format(n / 1024 ** 3) + " Go";
  if (n >= 1024 ** 2) return nf0.format(n / 1024 ** 2) + " Mo";
  if (n >= 1024) return nf0.format(n / 1024) + " Ko";
  return n + " o";
}

function ago(ms) {
  if (!ms) return "";
  const d = (Date.now() - ms) / 864e5;
  if (d < 1) return "aujourd'hui";
  if (d < 2) return "hier";
  if (d < 31) return `il y a ${Math.floor(d)} jours`;
  if (d < 365) return `il y a ${Math.floor(d / 30.4)} mois`;
  const y = Math.floor(d / 365);
  return `il y a ${y} an${y > 1 ? "s" : ""}`;
}

// « Dernier accès » dit si un fichier sert encore ; la modification n'est
// souvent que la date du téléchargement.
function lastUse(it) {
  if (it.atime && it.atime > (it.mtime || 0) + 864e5) return `ouvert ${ago(it.atime)}`;
  return it.mtime ? `modifié ${ago(it.mtime)}` : "";
}

// Système du serveur (Windows ou Debian) : séparateur de chemins et textes.
let SEP = "\\";
const OS_TEXT = {
  win32: {
    name: "Windows", fileManager: "l'Explorateur", trash: "la corbeille Windows", cleanup: "Nettoyage Windows",
    taskmgr: "Gestionnaire des tâches", pathHint: "C:\\Users\\…",
    admin: "Windows va afficher une fenêtre de contrôle de compte (UAC) : c'est toi qui autorises l'opération. Elle est enregistrée dans le journal et peut y être annulée.",
  },
  linux: {
    name: "Debian", fileManager: "Fichiers", trash: "la corbeille", cleanup: "Nettoyage système",
    taskmgr: "Moniteur système", pathHint: "/home/…",
    admin: "Debian va demander le mot de passe administrateur : c'est toi qui autorises l'opération. Elle est enregistrée dans le journal et peut y être annulée.",
  },
};
let OS = OS_TEXT.win32;
const isLinux = () => state.status?.platform === "linux";
const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
// Nom court d'un disque : « C: » sous Windows, le point de montage sous Linux.
const driveName = (r) => (isLinux() ? r : String(r).slice(0, 2));

// Nom court de l'IA en service (GPT-OSS, Claude, Qwen3…) pour les textes.
function aiName() {
  const m = state.status?.ai?.model || "";
  if (!m) return "l'IA";
  if (/gpt-oss/i.test(m)) return "GPT-OSS";
  if (/claude/i.test(m)) return "Claude";
  const base = m.split("/").pop().split(":")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}
// L'IA est-elle en ligne (les noms de fichiers quittent le PC) ?
const aiRemote = () => !!state.status?.ai?.remote;

// Chemins raccourcis : le dossier personnel devient « ~ ».
let HOME_DIR = null;
const short = (p) => (HOME_DIR && p && p.toLowerCase().startsWith(HOME_DIR.toLowerCase()) ? "~" + p.slice(HOME_DIR.length) : p || "");
// Garde la fin d'un chemin trop long : « …\blobs\sha256-e7b2… ».
function tail(p, max = 64) {
  p = short(p);
  if (p.length <= max) return p;
  const parts = p.split(SEP);
  let out = parts.pop();
  while (parts.length && out.length + parts[parts.length - 1].length + 2 <= max) out = parts.pop() + SEP + out;
  return (out.length > max ? out.slice(0, max - 1) + "…" : "…" + SEP + out);
}

const CATS = {
  cache: "Caches et temporaires", systeme: "Système", ia: "IA et modèles", jeux: "Jeux", dev: "Développement",
  apps: "Applications", medias: "Médias", docs: "Documents", autre: "Autres",
};
const catColor = (c) => getComputedStyle(document.documentElement).getPropertyValue(`--c-${c || "autre"}`).trim() || "#5b6478";
const G = (a, b) => `linear-gradient(135deg,${a},${b})`;
// Tuiles dégradées par famille de fichiers, dans l'esprit de la maquette.
const CAT_GRAD = {
  cache: G("#be185d", "#ec4899"), systeme: G("#475569", "#64748b"), ia: G("#7c3aed", "#a78bfa"), jeux: G("#b45309", "#f59e0b"),
  dev: G("#0f766e", "#14b8a6"), apps: G("#1d4ed8", "#3b9cf6"), medias: G("#9d174d", "#db2777"), docs: G("#4338ca", "#818cf8"),
  autre: G("#334155", "#64748b"),
};
// Palette de la carte du disque (une teinte par cellule).
const TMG = [["#6d4aff", "#a26bff"], ["#1d4ed8", "#3b9cf6"], ["#0f766e", "#14b8a6"], ["#7c3aed", "#a78bfa"], ["#be185d", "#ec4899"],
  ["#0369a1", "#0ea5e9"], ["#4338ca", "#818cf8"], ["#b45309", "#f59e0b"], ["#475569", "#64748b"], ["#9d174d", "#db2777"]];
const NIVEAU = { sur: "Sûr", a_verifier: "À vérifier" };
const ICON = {
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM9 12l2 2 4-4",
  wifi: "M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01",
  hist: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  gear: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6",
  game: "M7 9v4M5 11h4M15.5 10.5h.01M18 12.5h.01M6.5 6h11a4 4 0 0 1 3.9 3.1l1 4.6a2.6 2.6 0 0 1-4.6 2.1L16 14H8l-1.8 1.8a2.6 2.6 0 0 1-4.6-2.1l1-4.6A4 4 0 0 1 6.5 6z",
};
const svg = (d, cls = "") => `<svg viewBox="0 0 24 24" class="${cls}"><path d="${d}"/></svg>`;

async function api(url, body) {
  const r = await fetch(url, body === undefined ? { headers: H } : { method: "POST", headers: H, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Erreur ${r.status}`), { data: j });
  return j;
}

// Réponse en flux NDJSON : un appel à `onEvent` par ligne.
async function streamApi(url, body, onEvent, signal) {
  const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body || {}), signal });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `Erreur ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onEvent(JSON.parse(line));
    }
  }
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// Le HTML éventuel produit par le modèle est affiché tel quel, jamais interprété.
marked.use({ renderer: { html: (t) => esc(typeof t === "string" ? t : t.text) } });
const md = (s) => marked.parse(s || "");

// Stockage local : simple confort (onglet, ambiance, guide). S'il est effacé, rien de grave.
const store = {
  get(k) { try { return localStorage.getItem("sonde:" + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem("sonde:" + k, v); } catch {} },
};

// Compteur qui défile jusqu'à sa valeur (titres de l'accueil, scan).
function countUp(el, to, { ms = 1100, fmt = size } = {}) {
  if (!el) return;
  const from = Number(el.dataset.v || 0);
  const t0 = performance.now();
  el.dataset.v = to;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ------------------------------------------------------------------ état ---
const state = {
  status: null,
  view: "home",
  node: null,               // dossier affiché dans la carte du disque
  selection: new Map(),     // chemin en minuscules -> élément
  chat: [],
  aiRunning: false,
};

// ---------------------------------------------------------------- ambiance -
function setAmbiance(a) {
  document.body.dataset.amb = a;
  $$("#ambPick button").forEach((b) => b.classList.toggle("on", b.dataset.amb === a));
  store.set("amb", a);
}
$$("#ambPick button").forEach((b) => (b.onclick = () => setAmbiance(b.dataset.amb)));
setAmbiance(store.get("amb") || "violet");

// ------------------------------------------------------------ navigation ---
window.VIEWS = window.VIEWS || {};
const SECTIONS = {
  home: { label: "Accueil", icon: ICON.home, tile: G("var(--a1)", "var(--a3)"), views: [["home", "Accueil"]] },
  analyse: { label: "Analyse IA", icon: ICON.spark, tile: G("#8b5cf6", "#d946ef"), views: [["analyse", "Analyse IA"]] },
  files: { label: "Fichiers", icon: ICON.folder, tile: G("#2563eb", "#38bdf8"), meta: "navSize",
    views: [["telescope", "Carte du disque"], ["search", "Recherche"], ["bigfiles", "Gros fichiers"], ["dups", "Doublons"], ["clean", "Caches et temporaires"]] },
  apps: { label: "Applications", icon: ICON.grid, tile: G("#f59e0b", "#f97316"), views: [["apps", "Programmes installés"], ["active", "En cours et au démarrage"]] },
  system: { label: "Système", icon: ICON.cpu, tile: G("#0d9488", "#2dd4bf"), views: [["services", "Services et vie privée"], ["drivers", "Pilotes"], ["wincleanup", "Nettoyage Windows"]] },
  security: { label: "Sécurité", icon: ICON.shield, tile: G("#059669", "#34d399"), views: [["security", "Sécurité"]] },
  network: { label: "Réseau", icon: ICON.wifi, tile: G("#0284c7", "#22d3ee"), views: [["network", "Réseau"]] },
  gaming: { label: "Gaming", icon: ICON.game, tile: G("#e11d48", "#a855f7"),
    views: [["gaming", "Jeu"], ["gaming-hw", "Composants"], ["gaming-net", "Réseau"], ["gaming-no", "Ce qu'on ne fait pas"]] },
  history: { label: "Historique", icon: ICON.hist, tile: G("#64748b", "#94a3b8"), views: [["history", "Évolution"], ["journal", "Journal"]] },
  settings: { label: "Paramètres", icon: ICON.gear, tile: G("#334155", "#7c8aa5"),
    views: [["settings", "Général"], ["set-ai", "IA"], ["set-update", "Mise à jour"], ["set-privacy", "Confidentialité"]] },
};
const sectionOf = (view) => Object.keys(SECTIONS).find((s) => SECTIONS[s].views.some(([v]) => v === view)) || "home";
const lastInSection = {};
// Vues qui ont besoin d'un scan, et vues où l'on sélectionne des fichiers.
const SCAN_VIEWS = new Set(["telescope", "bigfiles", "clean", "dups"]);
const SEL_VIEWS = new Set(["home", "analyse", "telescope", "search", "bigfiles", "dups", "clean", "apps", "gaming-hw"]);

$("#nav").innerHTML = Object.entries(SECTIONS).map(([id, s]) => `
  <a data-section="${id}" tabindex="0">
    <span class="ntile" style="background:${s.tile}">${svg(s.icon)}</span>
    <span class="nlabel">${esc(s.label)}</span>
    <span class="nav-size" ${s.meta ? `id="${s.meta}"` : ""}></span>
  </a>`).join("");
$$("#nav a").forEach((a) => {
  const go = () => show(lastInSection[a.dataset.section] || SECTIONS[a.dataset.section].views[0][0]);
  a.onclick = go;
  a.onkeydown = (e) => { if (e.key === "Enter") go(); };
});

function show(view) {
  if (!document.getElementById(`view-${view}`)) view = "home";
  state.view = view;
  const section = sectionOf(view);
  lastInSection[section] = view;
  store.set("seen:" + view, "1");
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.section === section));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  const tabs = SECTIONS[section].views;
  $("#subnav").innerHTML = tabs.length > 1 ? tabs.map(([v, label]) => `<button data-view="${v}" class="${v === view ? "on" : ""}">${esc(label)}</button>`).join("") : "";
  $$("#subnav button").forEach((b) => (b.onclick = () => show(b.dataset.view)));
  $("main").classList.toggle("has-sub", tabs.length > 1);
  $("main").classList.toggle("no-sel", !SEL_VIEWS.has(view));
  history.replaceState(null, "", `#${view}`);
  $(`#view-${view}`).scrollTop = 0;
  const done = SCAN_VIEWS.has(view) && !state.status?.scan ? renderNoScan(view)
    : ({ home: renderHome, analyse: loadAnalyse, telescope: () => loadNode(state.node?.path ?? null), bigfiles: loadBigFiles,
      clean: loadClean, dups: loadDups, ...window.VIEWS })[view]?.();
  // Effets d'entrée de la page (fx.js), une fois le rendu terminé.
  window.FX?.page($(`#view-${view}`), done);
}

function renderNoScan(view) {
  $(`#view-${view}`).innerHTML = `<div class="stage">${orbHtml({ size: 200 })}
    <h1 style="font-size:34px">Il faut d'abord scanner le disque</h1>
    <p class="hero-p">Le scan dure environ une minute. Ensuite, tout s'affiche ici.</p>
    <button class="btn primary big" onclick="show('home')">Aller au scan</button></div>`;
}

// ---------------------------------------------------------------- statut ---
async function refreshStatus() {
  try { state.status = await api("/api/status"); } catch { state.status = null; }
  if (state.status?.home) HOME_DIR = state.status.home;
  if (state.status?.platform && OS !== OS_TEXT[state.status.platform]) {
    OS = OS_TEXT[state.status.platform] || OS_TEXT.win32;
    SEP = state.status.sep || SEP;
    SECTIONS.system.views.find(([v]) => v === "wincleanup")[1] = OS.cleanup;
    // Debian : les mises à jour (apt, Flatpak, dépôts) en tête de la section Système.
    if (state.status.platform === "linux" && !SECTIONS.system.views.some(([v]) => v === "updates")) SECTIONS.system.views.unshift(["updates", "Mises à jour"]);
    document.body.dataset.os = state.status.platform;
    const t = $("#trashNote");
    if (t) t.textContent = `Tout part dans ${OS.trash} : récupérable tant que tu ne la vides pas.`;
  }
  const s = state.status;
  const pill = $("#aiPill");
  pill.className = "ai-pill";
  const remote = s?.ai?.provider && s.ai.provider !== "ollama";
  if (!s || !s.ai.ok) { pill.classList.add("err"); $("#aiText").textContent = remote ? `${s.ai.label} · clé d'API à vérifier` : "Ollama éteint · préparer l'IA"; }
  else if (!s.ai.available) { pill.classList.add("err"); $("#aiText").textContent = "IA absente · la préparer"; }
  else if (s.aiBusy || state.aiRunning) { pill.classList.add("busy"); $("#aiText").textContent = `${aiName()} réfléchit…`; }
  else { pill.classList.add("ok"); $("#aiText").textContent = `${aiName()} prêt · ${s.ai.remote ? `en ligne (${s.ai.label})` : "sur ton PC"}`; }
  pill.classList.toggle("remote", !!s?.ai?.remote);
  // Textes qui promettent que rien ne quitte le PC : faux avec une IA en ligne.
  const pn = $("#palNote");
  if (pn) pn.textContent = s?.ai?.remote ? `${aiName()} explore le scan pour répondre. Les noms et tailles des fichiers concernés sont envoyés à ${s.ai.label}.`
    : `${aiName()} explore le scan pour répondre. Rien ne quitte ton PC.`;
  const dk = $("#drawerKicker");
  if (dk) dk.textContent = `✦ ${aiName()} explique`;

  const d = s?.scan?.disk;
  if (d && d.total) {
    const used = d.total - d.free;
    $("#diskName").textContent = s.scan.roots?.length > 1 ? s.scan.root : `Disque ${driveName(s.scan.root)}`;
    $("#diskPct").textContent = `${nf0.format((used / d.total) * 100)} %`;
    $("#diskBar").style.width = `${(used / d.total) * 100}%`;
    $("#diskFree").innerHTML = `<b>${size(d.free)}</b> libres sur ${size(d.total)}`;
    $("#navSize").textContent = size(s.scan.size).replace(",0 ", " ");
  }
  return s;
}
setInterval(refreshStatus, 5000);

// ================================================================== ORBE ===
// Sphère-radar : balayage, trois pistes, un point qui s'allume là où il y a
// quelque chose. `blips` : positions relatives (0 à 1).
function orbHtml({ size = 330, cls = "", blips = [[.72, .27], [.3, .66]], arc = false, label = "", targets = null } = {}) {
  return `<div class="orb ${cls}" style="--s:${size}px">
    <div class="glow"></div>
    <div class="sphere"><div class="sweep"></div><div class="tint"></div></div>
    <div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div>
    <div class="waves"><div class="wave"></div><div class="wave"></div><div class="wave"></div></div>
    <div class="core"></div>
    ${targets ? targetsHtml(targets) : blips.map(([x, y], i) => `<div class="blip ${i ? "b2" : ""}" style="left:${x * 100}%;top:${y * 100}%"></div>`).join("")}
    <div class="sparks"></div>
    <div class="shine"></div>
    ${arc ? `<svg class="arc" viewBox="0 0 100 100"><circle class="bg" cx="50" cy="50" r="48"/><circle class="fg" cx="50" cy="50" r="48" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/></svg>` : ""}
    ${label ? `<div class="orb-label">${label}</div>` : ""}
  </div>`;
}

// Détections du radar : une par famille, placées en cercle ; la taille du
// point suit le poids de la famille. Chacune s'allume quand le balayage
// (un tour en 4 s, depuis le haut, sens horaire) passe sur elle.
function targetsHtml(cats, phase = 0) {
  const tot = cats.reduce((x, c) => x + c.size, 0) || 1;
  const list = cats.filter((c) => c.size / tot >= 0.01).slice(0, 6);
  return list.map((c, i) => {
    // Positions fixes, étiquettes vers l'extérieur : côtés d'abord, puis haut et bas.
    const deg = [55, 235, 125, 305, 0, 180][i];
    const r = deg % 180 === 0 ? 0.27 : 0.3;
    const a = (deg * Math.PI) / 180;
    const x = 0.5 + r * Math.sin(a), y = 0.5 - r * Math.cos(a);
    const d = 7 + Math.sqrt(c.size / tot) * 14;
    // `phase` : où en est le balayage (s) quand les points sont ajoutés.
    const delay = (-(4 - (((deg / 90 - phase) % 4) + 4) % 4)).toFixed(2);
    return `<div class="target ${x < 0.49 ? "l" : ""}" style="left:${x * 100}%;top:${y * 100}%;--c:${catColor(c.id)};--d:${d.toFixed(1)}px;--delay:${delay}s" title="${esc(c.label)} · ${size(c.size)}">
      <i></i><span class="tl"><b>${esc(c.label)}</b>${size(c.size)}</span></div>`;
  }).join("");
}

// Un point qui s'allume puis s'éteint sur l'orbe (découverte pendant le scan).
function spark(orb) {
  const box = $(".sparks", orb);
  if (!box) return;
  const a = Math.random() * Math.PI * 2, r = .12 + Math.random() * .34;
  const s = document.createElement("div");
  s.className = "spark";
  s.style.left = `${50 + Math.cos(a) * r * 100}%`;
  s.style.top = `${50 + Math.sin(a) * r * 100}%`;
  box.append(s);
  setTimeout(() => s.remove(), 2700);
}

// ================================================================ ACCUEIL ===
async function renderHome() {
  // Pendant l'animation de scan, l'accueil ne doit pas se redessiner par-dessus.
  if (state.scanningUI) return;
  const s = state.status || (await refreshStatus());
  const el = $("#view-home");
  if (!s) { el.innerHTML = `<div class="stage"><h1>Serveur injoignable</h1></div>`; return; }
  if (s.scanning) return renderScanning({ root: s.scanning.root, progress: s.scanning });
  if (!s.scan) return renderWelcome(s);

  const [o, a, cands] = await Promise.all([api("/api/overview"), api("/api/analyse"), api("/api/candidates").catch(() => [])]);
  if (state.scanningUI) return;
  // Ce qu'il y a à récupérer : les propositions de l'analyse, sinon les caches reconnus.
  const recos = a.none ? [] : a.recos || [];
  const total = recos.reduce((x, r) => x + r.size, 0);
  const safe = recos.filter((r) => r.niveau === "sur").reduce((x, r) => x + r.size, 0);
  const cacheTotal = cands.filter((c) => c.rule.niveau === "sur").reduce((x, c) => x + c.size, 0);
  const wholeDrives = o.roots.every((r) => (s.drives || []).some((d) => d.root === r));

  const hero = recos.length
    ? { n: total, line: "à récupérer",
        p: `${aiName()} a trouvé ${recos.length} élément${recos.length > 1 ? "s" : ""}${safe ? `, dont ${size(safe)} qui se recréent tout seuls` : ""}. Tout passe par la corbeille.`,
        actions: `<button class="btn primary big" id="hGo">Voir les propositions</button>` }
    : { n: cacheTotal, line: "de caches repérés",
        p: "Sonde a reconnu des caches et des temporaires qui se recréent tout seuls. L'analyse IA va plus loin : doublons, vieux modèles, fichiers oubliés.",
        actions: `<button class="btn primary big" id="hAnalyse">Lancer l'analyse IA</button><button class="btn big" id="hCaches">Voir les caches</button>` };

  el.innerHTML = `
    <div class="home-hero">
      <div class="orb-box rise">${orbHtml({ size: 330, targets: o.categories })}</div>
      <div class="hero-text">
        <div class="hero-meta rise d1"><i></i>Scan de ${esc(o.root)} ${esc(ago(o.stats.finished || Date.now()))} · ${nf0.format(o.count)} fichiers</div>
        <h1 class="hero-title rise d1"><span class="grad-text" id="hNum">${size(0)}</span><br>${hero.line}</h1>
        <p class="hero-p rise d2">${hero.p}</p>
        <div class="hero-actions rise d3">${hero.actions}<button class="btn big" id="hRescan">Rescanner</button></div>
        ${s.drives.length > 1 && wholeDrives ? `<div class="drive-pick-wrap left rise d4"><div class="dp-title">Disques à scanner</div>${drivePicker(s)}</div>` : ""}
      </div>
    </div>
    <div class="home-cards">
      <div class="panel rise d3" id="guide"></div>
      <div class="panel rise d4" id="usage"></div>
    </div>`;
  countUp($("#hNum"), hero.n);
  $("#hGo") && ($("#hGo").onclick = () => show("analyse"));
  $("#hAnalyse") && ($("#hAnalyse").onclick = () => { show("analyse"); if (!state.aiRunning) runAnalyse(); });
  $("#hCaches") && ($("#hCaches").onclick = () => show("clean"));
  // Le bouton suit les cases : « Rescanner » si rien n'a changé, sinon il
  // annonce le nouveau périmètre.
  let roots = wholeDrives ? o.roots : o.root;
  const same = (r) => r.length === o.roots.length && r.every((x) => o.roots.includes(x));
  wireDrivePicker((r) => {
    roots = r;
    const b = $("#hRescan");
    b.textContent = same(r) ? "Rescanner" : `Scanner ${r.map(driveName).join(" + ")}`;
    b.classList.toggle("primary", !same(r));
  });
  $("#hRescan").onclick = () => startScan(roots);
  renderUsage(o);
  renderGuide(s, a);
}

// « Ce qui occupe le disque » : un onglet par disque quand le scan en couvre
// plusieurs, pour ne pas mélanger le système de C: et les jeux de D:.
function renderUsage(o) {
  const box = $("#usage");
  if (!box) return;
  const tabsList = o.disks ? [{ id: "all", label: "Tous", d: o }, ...o.disks.map((d) => ({ id: d.root, label: d.root, d }))] : [{ id: "all", d: o }];
  let cur = store.get("usageTab");
  if (!tabsList.some((t) => t.id === cur)) cur = "all";
  const draw = () => {
    const t = tabsList.find((x) => x.id === cur).d;
    const tot = t.categories.reduce((x, c) => x + c.size, 0) || 1;
    const used = t.disk?.total ? t.disk.total - t.disk.free : null;
    box.innerHTML = `
      <div class="panel-title"><span>${o.disks ? "Ce qui occupe tes disques" : "Ce qui occupe le disque"}</span><span class="pmeta">${size(t.size)} analysés</span></div>
      ${o.disks ? `<div class="segs sm usage-tabs">${tabsList.map((x) => `<button class="${x.id === cur ? "on" : ""}" data-t="${esc(x.id)}">${esc(x.label)}${x.id === "all" ? "" : `<small>${size(x.d.size)}</small>`}</button>`).join("")}</div>` : ""}
      ${cur === "all" && o.disks ? `<div class="disk-rows">${o.disks.map((d) => {
        const u = d.disk.total ? d.disk.total - d.disk.free : d.size;
        return `<button class="disk-row" data-t="${esc(d.root)}"><b>${esc(d.root)}</b>
          <span class="dr-bar"><i style="width:${d.disk.total ? (u / d.disk.total) * 100 : 0}%"></i></span>
          <span class="dr-num">${size(u)} <em>/ ${size(d.disk.total)}</em></span></button>`;
      }).join("")}</div>` : ""}
      ${cur !== "all" && used ? `<div class="usage-note">${size(t.disk.free)} libres sur ${size(t.disk.total)} · ${nf0.format((used / t.disk.total) * 100)} % occupé</div>` : ""}
      <div class="cat-bar">${t.categories.map((c) => `<span title="${esc(c.label)} · ${size(c.size)}" style="flex:${c.size};background:${catColor(c.id)};box-shadow:${c.id === "cache" ? `0 0 14px ${catColor(c.id)}` : "none"}"></span>`).join("")}</div>
      <div class="legend">${t.categories.map((c) => `<div><i style="background:${catColor(c.id)}"></i><span>${esc(c.label)}</span><b>${size(c.size)}</b><em>${nf0.format((c.size / tot) * 100)} %</em></div>`).join("")}</div>
      <div class="ext-chips">${t.extensions.slice(0, 10).map((e) => `<span><i>${esc(e.ext)}</i><b>${size(e.size)}</b></span>`).join("")}</div>`;
    $$("[data-t]", box).forEach((b) => (b.onclick = () => { cur = b.dataset.t; store.set("usageTab", cur); draw(); }));
    // Le radar de l'accueil montre le même disque que l'onglet.
    const orb = $(".home-hero .orb");
    if (orb) {
      $$(".target", orb).forEach((x) => x.remove());
      const sweep = $(".sweep", orb).getAnimations()[0];
      const phase = sweep ? (Number(sweep.currentTime) % 4000) / 1000 : 0;
      $(".sparks", orb).insertAdjacentHTML("beforebegin", targetsHtml(t.categories, phase));
    }
  };
  draw();
}

// Guide « Par où commencer » : les étapes se cochent toutes seules.
async function renderGuide(s, a) {
  const box = $("#guide");
  if (!box) return;
  const journal = await api("/api/journal").catch(() => []);
  const steps = [
    { done: !!s.scan, title: "Scanner le disque", desc: "Environ une minute." },
    { done: !a.none, title: `Laisser ${aiName()} analyser`, desc: "Il explore les gros dossiers.", action: "Analyser", go: () => { show("analyse"); if (!state.aiRunning) runAnalyse(); } },
    { done: journal.some((e) => e.kind === "trash"), title: "Faire le tri", desc: "Tout passe par la corbeille.", action: "Trier", go: () => show("analyse") },
    ...(isLinux() ? [{ done: !!store.get("seen:updates"), title: "Mettre Debian à jour", desc: "Sécurité, paquets et Flatpak.", action: "Voir", go: () => show("updates") }] : []),
    { done: !!store.get("seen:security"), title: "Vérifier la sécurité", desc: "Antivirus, pare-feu, démarrage.", action: "Vérifier", go: () => show("security") },
    { done: !!store.get("seen:active"), title: "Alléger le démarrage", desc: "Ce qui ralentit l'allumage.", action: "Voir", go: () => show("active") },
  ];
  const n = steps.filter((x) => x.done).length;
  const cur = steps.findIndex((x) => !x.done);
  box.innerHTML = `
    <div class="panel-title"><span>Par où commencer</span><span class="pmeta">${n} / ${steps.length}</span></div>
    <div class="guide-bar"><span style="width:${(n / steps.length) * 100}%"></span></div>
    ${steps.map((x, i) => `
      <div class="gstep ${x.done ? "done" : ""} ${i === cur ? "cur" : ""}">
        <div class="gnum">${x.done ? "✓" : i + 1}</div>
        <div class="gbody"><div class="gtitle">${esc(x.title)}</div><div class="gdesc">${esc(x.desc)}</div></div>
        ${!x.done && x.action ? `<button class="btn sm ${i === cur ? "primary" : ""}" data-i="${i}">${esc(x.action)}</button>` : ""}
      </div>`).join("")}`;
  $$("[data-i]", box).forEach((b) => (b.onclick = () => steps[b.dataset.i].go()));
}

// ------------------------------------------------------- choix des disques ---
// Les disques cochés sont retenus d'une fois sur l'autre (le serveur garde
// ceux du dernier scan ; le navigateur, la sélection en cours).
function chosenDrives(s) {
  const all = s.drives.map((d) => d.root);
  let mine = null;
  try { mine = JSON.parse(store.get("drives")); } catch {}
  const saved = [].concat(mine || s.scanRoots || []).filter((r) => all.includes(r));
  return saved.length ? saved : all.slice(0, 1);
}

function drivePicker(s) {
  const on = new Set(chosenDrives(s));
  return `<div class="drive-pick" id="drivePick">${s.drives.map((d) => {
    const used = d.total - d.free;
    return `<button type="button" class="drive-chip ${on.has(d.root) ? "on" : ""}" data-root="${esc(d.root)}" title="${on.has(d.root) ? "Retirer du scan" : "Ajouter au scan"}">
      <span class="check ${on.has(d.root) ? "on" : ""}"></span>
      <span class="dc-body"><span class="dc-top"><b>${esc(driveName(d.root))}</b><span>${size(d.free)} libres</span></span>
        <span class="dc-bar"><i style="width:${(used / d.total) * 100}%"></i></span>
        <span class="dc-sub">${size(used)} occupés sur ${size(d.total)}</span></span>
    </button>`;
  }).join("")}</div>`;
}

// Branche les cases ; `onChange` reçoit la liste cochée (au moins un disque).
function wireDrivePicker(onChange) {
  const box = $("#drivePick");
  if (!box) return;
  const read = () => $$(".drive-chip.on", box).map((b) => b.dataset.root);
  $$(".drive-chip", box).forEach((b) => (b.onclick = () => {
    if (b.classList.contains("on") && read().length === 1) return toast("Garde au moins un disque.");
    b.classList.toggle("on");
    $(".check", b).classList.toggle("on", b.classList.contains("on"));
    store.set("drives", JSON.stringify(read()));
    onChange && onChange(read());
  }));
  onChange && onChange(read());
}

const drivesLabel = (roots) => roots.length > 1 ? `${roots.length} disques` : isLinux() && roots[0] === "/" ? "le disque principal" : `le disque ${driveName(roots[0])}`;

// Premier lancement : l'orbe est le bouton de scan.
function renderWelcome(s) {
  let roots = chosenDrives(s);
  $("#view-home").innerHTML = `
    <div class="stage">
      <button class="orb-btn rise" id="btnScan" title="Scanner">${orbHtml({ size: 280, blips: [[.72, .27]], label: `Scanner<small>${esc(drivesLabel(roots))}</small>` })}</button>
      <h1 class="rise d1">Bienvenue dans Sonde</h1>
      <p class="hero-p rise d2">Un radar posé sur ton disque. Sonde le scanne, ${aiName()} t'explique ce qu'il trouve, et tu choisis ce qui part. ${aiRemote() ? `L'IA choisie est en ligne (${esc(state.status.ai.label)}) : les noms de tes fichiers lui sont envoyés, jamais leur contenu.` : "L'IA tourne sur ton PC : rien n'est envoyé sur Internet."}</p>
      ${s.drives.length > 1 ? `<div class="drive-pick-wrap rise d2"><div class="dp-title">Coche les disques à scanner</div>${drivePicker(s)}</div>` : ""}
      <div class="welcome-steps rise d3">
        <div><b>1</b>Sonde scanne ${s.drives.length > 1 ? "tes disques" : "ton disque"}<small>environ une minute par disque</small></div>
        <div><b>2</b>${aiName()} explique ce qu'il trouve<small>et propose quoi libérer</small></div>
        <div><b>3</b>Tu choisis ce qui part<small>tout passe par la corbeille</small></div>
      </div>
      <details class="scan-alt rise d4"><summary>Scanner seulement un dossier</summary>
        <div class="toolbar"><input type="text" id="customPath" placeholder="${esc(OS.pathHint)}" size="30"></div>
      </details>
    </div>`;
  wireDrivePicker((r) => { roots = r; $(".orb-label small").textContent = drivesLabel(r); });
  $("#btnScan").onclick = () => startScan($("#customPath").value.trim() || roots, $("#btnScan .orb"));
}

// ============================================================ ANIMATION SCAN
// L'orbe s'embrase, puis balaie vite pendant que des ondes partent ; chaque
// gros fichier découvert allume un point et s'inscrit en dessous ; à la fin,
// l'orbe éclate et l'accueil affiche le résultat.
async function startScan(root, orbEl) {
  if (orbEl) {
    orbEl.classList.remove("ignite");
    void orbEl.offsetWidth;
    orbEl.classList.add("ignite");
    await new Promise((r) => setTimeout(r, 480));
  }
  state.scanningUI = true;
  show("home");
  renderScanning({ root: [].concat(root).map((r) => (!isLinux() && r.length <= 3 ? r.slice(0, 2) : r)).join(" + ") });
  let used = null, lastTop = new Set(), lastFiles = 0;
  try {
    await streamApi("/api/scan", Array.isArray(root) ? { roots: root } : { root }, (e) => {
      if (e.type === "start") { used = e.used; $("#view-home .orb .arc")?.classList.toggle("hidden", !used); }
      else if (e.type === "progress") {
        updateScanning(e, used);
        // Nouveaux gros fichiers : un point s'allume et la liste s'enrichit.
        for (const f of e.top || []) {
          if (lastTop.has(f.path)) continue;
          lastTop.add(f.path);
          addFound(f);
        }
        if (e.files - lastFiles > 4000) { lastFiles = e.files; spark($("#view-home .orb")); }
      } else if (e.type === "error") toast(e.error, 7000);
    });
  } catch (err) {
    toast(err.message);
  }
  const orb = $("#view-home .orb");
  if (orb) {
    orb.classList.remove("scanning");
    orb.classList.add("burst");
    const fg = $(".arc .fg", orb);
    if (fg) fg.style.strokeDashoffset = 0;
    await new Promise((r) => setTimeout(r, 850));
  }
  state.node = null;
  state.scanningUI = false;
  await refreshStatus();
  renderHome();
}

function renderScanning({ root, progress }) {
  $("#view-home").innerHTML = `
    <div class="stage scan-stage">
      <div class="orb-box">${orbHtml({ size: 260, cls: "scanning", blips: [], arc: true })}</div>
      <div class="scan-count" id="sBytes">${size(0)}</div>
      <div class="scan-sub">trouvés sur <span class="mono">${esc(root || "")}</span></div>
      <div class="scan-stats">
        <div><b id="sFiles">0</b><span>fichiers</span></div>
        <div><b id="sDirs">0</b><span>dossiers</span></div>
        <div><b id="sTime">0 s</b><span>écoulées</span></div>
      </div>
      <div class="scan-path" id="sPath"></div>
      <div class="scan-found" id="sFound"></div>
    </div>`;
  if (progress) updateScanning(progress, null);
}

function updateScanning(p, used) {
  const b = $("#sBytes");
  if (!b) return;
  b.textContent = size(p.bytes);
  $("#sFiles").textContent = nf0.format(p.files);
  $("#sDirs").textContent = nf0.format(p.dirs);
  $("#sTime").textContent = `${nf0.format(p.elapsed)} s`;
  $("#sPath").textContent = tail(p.current || "", 90);
  const fg = $("#view-home .orb .arc .fg");
  if (fg && used) fg.style.strokeDashoffset = 100 - Math.min(99, (p.bytes / used) * 100);
}

function addFound(f) {
  const box = $("#sFound");
  if (!box) return;
  const d = document.createElement("div");
  d.innerHTML = `<span>${esc(tail(f.path, 62))}</span><b>${size(f.size)}</b>`;
  box.prepend(d);
  while (box.children.length > 5) box.lastChild.remove();
  spark($("#view-home .orb"));
}

// -------------------------------------------------------------- sélection ---
function isSelected(p) {
  if (!p) return false;
  const k = p.toLowerCase();
  if (state.selection.has(k)) return true;
  for (const s of state.selection.keys()) if (k.startsWith(s + SEP)) return true;
  return false;
}

function select(item, on = true) {
  const k = item.path.toLowerCase();
  if (!on) { state.selection.delete(k); return syncSelection(); }
  for (const s of state.selection.keys()) if (k.startsWith(s + SEP)) return toast("Déjà inclus dans un dossier sélectionné.");
  for (const s of [...state.selection.keys()]) if (s.startsWith(k + SEP)) state.selection.delete(s);
  state.selection.set(k, {
    path: item.path, name: item.name || baseName(item.path), size: item.size,
    contenu: !!(item.contenu ?? item.rule?.contenu), cat: item.cat, niveau: item.niveau || item.rule?.niveau, type: item.type,
  });
  syncSelection();
}

function syncSelection() {
  const n = state.selection.size;
  const total = [...state.selection.values()].reduce((a, x) => a + (x.size || 0), 0);
  $("#selSize").textContent = size(total);
  $("#selCount").textContent = n;
  $("#selWord").textContent = n > 1 ? "éléments" : "élément";
  $("#selbar").classList.toggle("show", n > 0);
  $$("[data-path]").forEach((r) => {
    const on = isSelected(r.dataset.path);
    r.classList.toggle("sel", on);
    r.classList.toggle("on", on);
    const c = $(".check", r);
    if (c) c.classList.toggle("on", on);
    const add = $(".add-btn", r);
    if (add) { add.textContent = on ? "✓ Ajouté" : "Ajouter"; add.classList.toggle("added", on); }
  });
}

// -------------------------------------------------------------- lignes ---
// Tuile d'un élément : dossier, ou extension du fichier.
function tileHtml(it, bg) {
  const back = bg || CAT_GRAD[it.cat] || CAT_GRAD.autre;
  if (it.type === "rest") return `<div class="tile rest"></div>`;
  if (it.type === "file") {
    const ext = (it.name.match(/\.([a-z0-9]{1,5})$/i) || [, ""])[1].toUpperCase();
    return `<div class="tile" style="background:${back}">${ext ? esc(ext) : svg(ICON.file)}</div>`;
  }
  return `<div class="tile" style="background:${back}">${svg(ICON.folder)}</div>`;
}

// Une ligne de liste, réutilisée partout : case, tuile, nom et chemin, taille.
function rowEl(it, { onNav, sub, tile } = {}) {
  const row = document.createElement("div");
  row.className = "row";
  const nav = onNav && it.type === "dir" && it.hasChildren !== false;
  if (nav) row.classList.add("nav");
  if (it.path) row.dataset.path = it.path;
  const locked = it.protected || !it.path || it.type === "rest";
  const subtitle = sub ?? [
    it.note ? `<span class="note">${esc(it.note)}</span>` : "",
    it.rule ? esc(it.rule.label) : "",
    !it.note && !it.rule && it.type === "dir" ? `${nf0.format(it.count)} fichiers` : "",
    lastUse(it),
  ].filter(Boolean).join(" · ");
  const badge = it.rule ? `<span class="badge ${it.rule.niveau}">${NIVEAU[it.rule.niveau]}</span>`
    : it.niveau ? `<span class="badge ${it.niveau}">${NIVEAU[it.niveau]}</span>` : "";
  row.innerHTML = `
    <button class="check" ${locked ? "disabled" : ""} title="${locked ? "Protégé" : "Sélectionner"}"></button>
    ${tileHtml(it, tile)}
    <div class="rname">
      <div class="t">${esc(it.name)}${badge}${it.protected && it.path ? `<span class="badge lock">protégé</span>` : ""}</div>
      <div class="s">${subtitle}</div>
    </div>
    <div class="rsize">${size(it.size)}</div>
    <div class="ractions">
      ${it.path ? `<button class="icon-btn" data-a="explain" title="Qu'est-ce que c'est ? (${aiName()})">?</button>
      <button class="icon-btn" data-a="open" title="Montrer dans ${esc(OS.fileManager)}">↗</button>` : ""}
      <span class="chev">${nav ? "›" : ""}</span>
    </div>`;
  if (!locked) $(".check", row).onclick = (e) => { e.stopPropagation(); select(it, !isSelected(it.path)); };
  const ex = $('[data-a="explain"]', row);
  if (ex) ex.onclick = (e) => { e.stopPropagation(); explain(it); };
  const op = $('[data-a="open"]', row);
  if (op) op.onclick = (e) => { e.stopPropagation(); api("/api/open", { path: it.path }); };
  if (nav) row.onclick = () => onNav(it);
  else if (!locked) row.onclick = () => select(it, !isSelected(it.path));
  if (isSelected(it.path)) { row.classList.add("sel"); $(".check", row).classList.add("on"); }
  return row;
}

// ======================================================= CARTE DU DISQUE ===
async function loadNode(p) {
  const v = $("#view-telescope");
  let node;
  try {
    node = await api(`/api/node?depth=1${p ? "&path=" + encodeURIComponent(p) : ""}`);
  } catch (e) {
    if (p) return loadNode(null);
    v.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  state.node = node;
  const kids = (node.children || []).filter((c) => c.size > 0);
  v.innerHTML = `
    <div class="view-head">
      <div><h1>Carte du disque</h1><div class="crumbs" id="crumbs"></div></div>
      <div class="head-stat"><b>${size(node.size)}</b><span>${node.note ? esc(node.note) : "dans ce dossier"}</span></div>
    </div>
    <div class="tele">
      <div class="panel tight tele-list"><div class="rows" id="rows"></div></div>
      <div class="tele-map"><div class="tm" id="tm"></div><div class="map-tip" id="mapTip"></div></div>
    </div>`;
  const cr = $("#crumbs");
  if (node.crumbs.length > 1) {
    const back = document.createElement("button");
    back.className = "back";
    back.textContent = "‹";
    back.title = "Dossier parent";
    back.onclick = () => loadNode(node.crumbs[node.crumbs.length - 2].path);
    cr.append(back);
  }
  node.crumbs.forEach((c, i) => {
    if (i) cr.insertAdjacentHTML("beforeend", `<span class="sep">›</span>`);
    const b = document.createElement("button");
    b.textContent = c.name;
    if (i === node.crumbs.length - 1) b.className = "cur";
    b.onclick = () => loadNode(c.path);
    cr.append(b);
  });
  const rows = $("#rows");
  kids.forEach((c, i) => {
    const gr = TMG[i % TMG.length];
    const r = rowEl(c, { onNav: (x) => loadNode(x.path), tile: G(gr[0], gr[1]) });
    r.dataset.i = i;
    r.onmouseenter = () => hotCell(i, true);
    r.onmouseleave = () => hotCell(i, false);
    rows.append(r);
  });
  if (!kids.length) rows.innerHTML = `<div class="empty">Dossier vide.</div>`;
  renderTreemap(kids);
}

// Mosaïque : chaque rectangle a la surface de ce qu'il pèse.
function renderTreemap(kids) {
  const tm = $("#tm");
  if (!tm) return;
  const MAX = 30;
  let items = kids.slice(0, MAX).map((c, i) => ({ ...c, i }));
  const rest = kids.slice(MAX).reduce((a, c) => a + c.size, 0);
  if (rest > 0) items.push({ name: `${kids.length - MAX} autres`, size: rest, type: "rest", i: -1 });
  if (!items.length) { tm.innerHTML = ""; return; }
  const W = 1000, Hh = 1000 * (tm.clientHeight / Math.max(tm.clientWidth, 1) || .8);
  const root = d3.hierarchy({ children: items }).sum((d) => (d.children ? 0 : Math.max(d.size, 1))).sort((a, b) => b.value - a.value);
  d3.treemap().tile(d3.treemapSquarify.ratio(1.2)).size([W, Hh]).round(false)(root);
  const px = tm.clientWidth / W;
  tm.innerHTML = root.leaves().map((l, k) => {
    const d = l.data, w = l.x1 - l.x0, h = l.y1 - l.y0;
    const gr = d.i >= 0 ? TMG[d.i % TMG.length] : ["#334155", "#475569"];
    const pw = w * px, ph = h * px;
    const big = pw > 200 && ph > 140, lab = pw > 64 && ph > 46;
    // Petites cellules : ni marge intérieure ni gros arrondi, sinon elles débordent.
    const small = pw < 48 || ph < 40;
    const inner = small ? `padding:0;border-radius:${Math.max(2, Math.min(14, pw / 4, ph / 4))}px;` : "";
    return `<div class="tm-cell ${d.type === "rest" ? "rest" : ""} ${isSelected(d.path) ? "on" : ""}" data-i="${d.i}" ${d.path ? `data-path="${esc(d.path)}"` : ""}
      style="left:${(l.x0 / W) * 100}%;top:${(l.y0 / Hh) * 100}%;width:${(w / W) * 100}%;height:${(h / Hh) * 100}%;--cg:${gr[1]};animation-delay:${Math.min(k * 25, 400)}ms;${small ? "padding:1px;" : ""}">
      <div style="background:linear-gradient(145deg,${gr[0]},${gr[1]});${inner}">
        ${lab ? `<span class="n" style="font-size:${big ? 24 : 13}px">${esc(d.name)}</span><span class="z">${size(d.size)}</span>` : ""}
      </div></div>`;
  }).join("");
  const tip = $("#mapTip");
  $$(".tm-cell", tm).forEach((c) => {
    const i = Number(c.dataset.i);
    const d = i >= 0 ? kids[i] : null;
    c.onmouseenter = () => { hotCell(i, true); };
    c.onmouseleave = () => { hotCell(i, false); tip.style.opacity = 0; };
    c.onmousemove = (ev) => {
      if (!d) return;
      const r = $(".tele-map").getBoundingClientRect();
      tip.style.opacity = 1;
      tip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 330)}px`;
      tip.style.top = `${Math.min(ev.clientY - r.top + 14, r.height - 60)}px`;
      tip.innerHTML = `<b>${esc(d.name)}</b> · <span class="mono">${size(d.size)}</span><br><span class="muted">${esc(d.note || CATS[d.cat] || "")}</span>`;
    };
    c.onclick = () => {
      if (!d) return;
      if (d.type === "dir" && d.hasChildren) loadNode(d.path);
      else if (d.path && !d.protected) select(d, !isSelected(d.path));
    };
  });
}

// Survol : la cellule et la ligne correspondantes s'allument, le reste s'efface.
function hotCell(i, on) {
  const tm = $("#tm");
  if (!tm) return;
  tm.classList.toggle("dim", on && i >= 0);
  $$(".tm-cell", tm).forEach((c) => c.classList.toggle("hot", on && Number(c.dataset.i) === i));
  $$("#rows .row").forEach((r) => r.classList.toggle("hover", on && Number(r.dataset.i) === i));
  if (on) $(`#rows .row[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.view === "telescope" && state.node) renderTreemap((state.node.children || []).filter((c) => c.size > 0)); }, 150);
});

// ========================================================== GROS FICHIERS ===
const KIND = {
  systeme: ["Système", G("#475569", "#64748b")], ia: ["Modèle IA", G("#7c3aed", "#a78bfa")], jeux: ["Jeu", G("#be185d", "#ec4899")],
  medias: ["Média", G("#9d174d", "#db2777")], dev: ["Développement", G("#0f766e", "#14b8a6")], apps: ["Application", G("#1d4ed8", "#3b9cf6")],
  cache: ["Cache", G("#b45309", "#f59e0b")], docs: ["Document", G("#4338ca", "#818cf8")], autre: ["Autre", G("#334155", "#64748b")],
};

async function loadBigFiles() {
  const v = $("#view-bigfiles");
  v.innerHTML = `<div class="empty working">Chargement</div>`;
  const list = await api("/api/bigfiles?limit=200");
  const total = list.reduce((a, f) => a + f.size, 0);
  const max = list[0]?.size || 1;
  v.innerHTML = `
    <div class="view-head">
      <div><h1>Gros fichiers</h1><p class="sub">Tous les fichiers de plus de 50 Mo, du plus gros au plus petit.</p></div>
      <div class="head-stat"><b>${nf0.format(list.length)} fichiers</b><span>${size(total)} au total</span></div>
    </div>
    <div class="panel tight"><div class="rows" id="bigRows"></div></div>`;
  const box = $("#bigRows");
  if (!list.length) { box.innerHTML = `<div class="empty">Aucun fichier de plus de 50 Mo.</div>`; return; }
  for (const f of list) {
    const k = KIND[f.cat] || KIND.autre;
    const folder = f.path.slice(0, f.path.length - f.name.length - 1);
    const r = rowEl(f, { tile: k[1], sub: `${f.note ? `<span class="note">${esc(f.note)}</span> · ` : ""}${esc(short(folder))} · ${lastUse(f)}` });
    r.style.gridTemplateColumns = "20px 36px minmax(0,1fr) 110px 150px 64px 64px";
    if (f.protected) r.style.opacity = .5;
    const kind = document.createElement("span");
    kind.className = "tag";
    kind.style.justifySelf = "start";
    kind.textContent = f.protected ? "Protégé" : k[0];
    const bar = document.createElement("div");
    bar.className = "sizebar";
    bar.innerHTML = `<span style="width:${(f.size / max) * 100}%"></span>`;
    r.insertBefore(kind, $(".rsize", r));
    r.insertBefore(bar, $(".rsize", r));
    box.append(r);
  }
}

// =============================================================== DOUBLONS ===
async function loadDups() {
  const v = $("#view-dups");
  v.innerHTML = `<div class="view-head"><div><h1>Doublons</h1><p class="sub">Fichiers de plus de 50 Mo présents en plusieurs exemplaires identiques. La copie la plus récente est en premier : garde celle dont le programme a besoin.</p></div></div><div id="dupBox"><div class="empty working">Comparaison des fichiers</div></div>`;
  const groups = await api("/api/duplicates");
  const box = $("#dupBox");
  if (!groups.length) {
    box.innerHTML = `<div class="panel"><div class="empty-state"><div class="es-icon">✓</div><div class="es-title">Aucun doublon</div><div class="muted">Parmi les fichiers de plus de 50 Mo.</div></div></div>`;
    return;
  }
  box.innerHTML = "";
  for (const g of groups) {
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `<div class="group-head"><div class="tile sm" style="background:${G("#7c3aed", "#a78bfa")}">×${g.files.length}</div>
      <div class="gt"><b>${g.files.length} copies identiques de ${size(g.size)}</b><span>${size(g.wasted)} en trop</span></div></div>`;
    g.files.forEach((f, i) => {
      const folder = f.path.slice(0, f.path.length - f.name.length - 1);
      card.append(rowEl(f, { sub: `${i === 0 ? "la plus récente · " : ""}${esc(short(folder))} · ${lastUse(f)}` }));
    });
    box.append(card);
  }
}

// ================================================== CACHES ET TEMPORAIRES ===
let cleanCache = [];
async function loadClean() {
  const v = $("#view-clean");
  v.innerHTML = `<div class="empty working">Chargement</div>`;
  cleanCache = await api("/api/candidates");
  v.innerHTML = `
    <div class="view-head">
      <div><h1>Caches et temporaires</h1><p class="sub">Ce que Sonde reconnaît sans l'IA. « Sûr » veut dire que ça se recrée tout seul.</p></div>
      <div class="toolbar"><button class="btn" id="btnSelectSafe">Tout sélectionner (sûr)</button></div>
    </div><div id="cleanBox"></div>`;
  const box = $("#cleanBox");
  if (!cleanCache.length) { box.innerHTML = `<div class="panel"><div class="empty">Rien de reconnu.</div></div>`; return; }
  const groups = new Map();
  for (const c of cleanCache) {
    if (!groups.has(c.rule.label)) groups.set(c.rule.label, []);
    groups.get(c.rule.label).push(c);
  }
  let gi = 0;
  for (const [label, items] of groups) {
    const gr = TMG[gi++ % TMG.length];
    const tot = items.reduce((a, x) => a + x.size, 0);
    const abbr = label.replace(/[^A-ZÉÈa-zéè ]/g, "").split(/\s+/).filter((w) => w.length > 2).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "C";
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `<div class="group-head"><div class="tile sm" style="background:${G(gr[0], gr[1])}">${esc(abbr)}</div>
      <div class="gt"><b>${esc(label)}</b><span>${esc(items[0].rule.pourquoi)}</span></div><span class="gz">${size(tot)}</span></div>`;
    for (const c of items) {
      const it = { ...c, name: baseName(c.path), type: "dir", cat: "cache" };
      card.append(rowEl(it, { tile: G(gr[0], gr[1]), sub: `${esc(short(c.path))}${c.rule.contenu ? " · le contenu sera vidé" : ""} · ${lastUse(c)}` }));
    }
    box.append(card);
  }
  $("#btnSelectSafe").onclick = () => {
    let n = 0;
    for (const c of cleanCache) if (c.rule.niveau === "sur" && !isSelected(c.path)) { select({ ...c, cat: "cache" }); n++; }
    toast(n ? `${n} éléments ajoutés à la sélection.` : "Déjà tout sélectionné.");
  };
}

// ====================================================== ANALYSE INTELLIGENTE
// Présentée comme un plan d'action : ce qu'on peut libérer, action par action,
// avec des boutons ; le texte brut de GPT-OSS n'est qu'en complément.
const TOOL_LABEL = {
  lister_dossier: (a) => [a.chemin, "Exploration du dossier"],
  infos: (a) => [a.chemin, "Inspection"],
  gros_fichiers: (a) => [a.dans || "Tout le disque", `Recherche des gros fichiers${a.extension ? " " + a.extension : ""}`],
  rechercher: (a) => [`« ${a.motif} »`, "Recherche de dossiers"],
  doublons: () => ["Doublons", "Comparaison des copies identiques"],
  programmes_installes: (a) => [a.filtre ? `« ${a.filtre} »` : "Tous les disques", "Programmes et jeux installés"],
  decrire: (a) => [a.chemin, a.description],
  recommander: (a) => [a.chemin, "Recommandation"],
};

const analyseData = { recos: [], map: [], summary: "", at: null };

function analyseShell() {
  const v = $("#view-analyse");
  if ($("#feed", v)) return;
  v.innerHTML = `
    <div class="view-head">
      <div><h1>Analyse intelligente</h1><p class="sub">${aiName()} explore ton disque et prépare un plan d'action. Rien n'est supprimé sans ta confirmation, et tout passe par la corbeille.</p></div>
      <div class="toolbar"><span class="pmeta" id="aDate"></span><button class="btn" id="btnAnalyse">Lancer l'analyse</button></div>
    </div>
    <div class="plan-banner" id="planBanner"></div>
    <div class="plan-grid">
      <div class="panel"><div class="panel-title"><span>Ce que tu peux faire</span><span class="pmeta" id="recoTotal"></span></div><div id="recos"></div></div>
      <div class="panel"><div class="panel-title"><span>Ce que ${aiName()} a regardé</span><span class="pmeta" id="feedCount"></span></div>
        <div class="thinking" id="thinking"></div><div class="feed" id="feed"></div></div>
    </div>
    <div class="grid-2">
      <div class="panel"><div class="panel-title"><span>Ce qui occupe ton disque</span><span class="pmeta" id="repHome"></span></div><div id="mapList"></div></div>
      <div class="panel"><div class="panel-title"><span>Bon à savoir</span></div><div id="tips"></div></div>
    </div>
    <details class="panel raw-report"><summary>Lire le rapport complet de ${aiName()}</summary><div class="md" id="summary"></div></details>`;
  $("#btnAnalyse").onclick = runAnalyse;
}

function feedStep(p, d, sz = "", cls = "") {
  const f = $("#feed");
  if (!f) return;
  f.insertAdjacentHTML("beforeend", `<div class="fstep ${cls}"><div class="rail"><i></i><u></u></div>
    <div style="min-width:0"><div class="p">${esc(short(p))}</div>${d ? `<div class="d">${esc(d)}</div>` : ""}</div><span class="sz">${esc(sz)}</span></div>`);
  f.scrollTop = f.scrollHeight;
  $("#feedCount").textContent = `${f.children.length} étapes`;
}

// Le bandeau du haut : combien on peut libérer, et le bouton qui fait tout.
function renderBanner(state_) {
  const b = $("#planBanner");
  if (!b) return;
  const recos = analyseData.recos;
  const total = recos.reduce((a, r) => a + r.size, 0);
  const safe = recos.filter((r) => r.niveau === "sur");
  const safeTotal = safe.reduce((a, r) => a + r.size, 0);
  if (state_ === "running") {
    b.innerHTML = `<div class="pb-orb">${orbHtml({ size: 84, cls: "scanning", blips: [] })}</div>
      <div class="pb-text"><div class="pb-title">${aiName()} analyse ton disque…</div>
      <div class="pb-sub">Il explore les gros dossiers et prépare tes actions. Compte 1 à 4 minutes. Les propositions apparaissent au fur et à mesure.</div></div>`;
    return;
  }
  if (!recos.length) {
    b.innerHTML = `<div class="pb-orb">${orbHtml({ size: 84, blips: [[.72, .27]] })}</div>
      <div class="pb-text"><div class="pb-title">${state_ === "empty" ? "Aucune proposition pour l'instant" : "Pas encore d'analyse"}</div>
      <div class="pb-sub">${state_ === "empty" ? `${aiName()} n'a rien trouvé à libérer sans risque. Ton disque est déjà propre.` : `${aiName()} va explorer ton disque et te proposer quoi libérer, avec la raison pour chaque élément.`}</div></div>
      <div class="pb-actions"><button class="btn primary big" id="pbRun">${state_ === "empty" ? "Relancer l'analyse" : "Lancer l'analyse"}</button></div>`;
    $("#pbRun").onclick = runAnalyse;
    return;
  }
  b.innerHTML = `<div class="pb-num"><span class="grad-text">${size(total)}</span><small>peuvent être libérés</small></div>
    <div class="pb-text"><div class="pb-title">${recos.length} action${recos.length > 1 ? "s" : ""} proposée${recos.length > 1 ? "s" : ""}</div>
      <div class="pb-sub">${safe.length ? `<b>${size(safeTotal)} sans aucun risque</b> : des caches qui se recréent tout seuls.` : ""} ${recos.length - safe.length ? `${recos.length - safe.length} élément${recos.length - safe.length > 1 ? "s" : ""} à vérifier avant de supprimer.` : ""}<br>Tu confirmes toujours avant l'envoi à la corbeille.</div></div>
    <div class="pb-actions">
      ${safe.length ? `<button class="btn primary big" id="pbSafe">Nettoyer sans risque · ${size(safeTotal)}</button>` : ""}
      <button class="btn big" id="pbAll">Tout sélectionner</button>
    </div>`;
  $("#pbSafe") && ($("#pbSafe").onclick = () => { safe.forEach((r) => isSelected(r.path) || select(r)); openReview(); });
  $("#pbAll").onclick = () => { recos.forEach((r) => isSelected(r.path) || select(r)); toast(`${recos.length} éléments sélectionnés. Passe-les en revue avec la barre en bas.`); };
}

// Le programme à qui appartient un dossier d'AppData : « …\Local\Google\Chrome\… » -> Chrome.
// Sous Linux : ~/.config/<programme>, ~/.cache/<programme>, ~/.var/app/<id Flatpak>.
function ownerOf(p) {
  // Flatpak : « org.mozilla.firefox » -> « firefox ».
  const fp = /\/\.var\/app\/([^/]+)/.exec(p);
  if (fp) return fp[1].split(".").pop();
  const m = p.match(/\\AppData\\(?:Local|Roaming|LocalLow)\\([^\\]+)(?:\\([^\\]+))?/i)
    || p.match(/\/\.(?:config|cache|local\/share)\/([^/]+)(?:\/([^/]+))?/);
  if (!m) return null;
  const VENDORS = /^(Google|Microsoft|Mozilla|BraveSoftware|Programs|Packages|JetBrains)$/i;
  return VENDORS.test(m[1]) && m[2] ? m[2] : m[1];
}

// Titre d'une action en français simple, avec le programme concerné.
function actionTitle(r) {
  const name = baseName(r.path);
  if (/^temp$/i.test(name)) return "Vider les fichiers temporaires";
  const owner = ownerOf(r.path);
  const of = owner && owner.toLowerCase() !== name.toLowerCase() ? ` de ${owner}` : "";
  if (r.contenu) return /^cache$/i.test(name) ? `Vider le cache${of}` : `Vider « ${name} »${of}`;
  return r.type === "file" ? `Supprimer le fichier « ${name} »` : `Supprimer le dossier « ${name} »${of}`;
}

// Une action compréhensible par tout le monde : quoi, pourquoi, combien, et les boutons.
function actionCard(r) {
  const name = baseName(r.path);
  const title = actionTitle(r);
  const c = document.createElement("div");
  c.className = "act-card";
  c.dataset.path = r.path;
  c.innerHTML = `${tileHtml({ ...r, name }, r.niveau === "sur" ? G("#0d9488", "#2dd4bf") : G("#d97706", "#fbbf24"))}
    <div class="act-body">
      <div class="act-title">${esc(title)}</div>
      <div class="act-why">${esc(r.raison)}</div>
      <div class="act-path">${esc(short(r.path))} · ${esc(lastUse(r))}</div>
    </div>
    <div class="act-size">${size(r.size)}</div>
    <div class="act-btns">
      <button class="btn sm add-btn"></button>
      <button class="icon-btn" data-a="explain" title="Qu'est-ce que c'est ? (${aiName()})">?</button>
      <button class="icon-btn" data-a="open" title="Montrer dans ${esc(OS.fileManager)}">↗</button>
    </div>`;
  const add = $(".add-btn", c);
  const paint = () => { const on = isSelected(r.path); c.classList.toggle("on", on); add.textContent = on ? "✓ Ajouté" : "Ajouter"; add.classList.toggle("added", on); };
  add.onclick = () => { select(r, !isSelected(r.path)); paint(); };
  $('[data-a="explain"]', c).onclick = () => explain(r);
  $('[data-a="open"]', c).onclick = () => api("/api/open", { path: r.path });
  paint();
  return c;
}

function renderRecos(recos) {
  analyseData.recos = recos;
  const el = $("#recos");
  if (!el) return;
  el.innerHTML = "";
  const total = recos.reduce((a, r) => a + r.size, 0);
  $("#recoTotal").textContent = recos.length ? `${recos.length} · ${size(total)}` : "";
  if (!recos.length) { el.innerHTML = `<div class="empty">${state.aiRunning ? "Les propositions arrivent au fur et à mesure…" : "Aucune proposition pour l'instant."}</div>`; return; }
  const GROUPS = { sur: ["Sans risque", "Se recrée tout seul : caches, temporaires.", "good"], a_verifier: ["À vérifier", `Regarde avant de supprimer : ${aiName()} explique pourquoi.`, "warn"] };
  for (const niveau of ["sur", "a_verifier"]) {
    const items = recos.filter((r) => r.niveau === niveau).sort((a, b) => b.size - a.size);
    if (!items.length) continue;
    const [label, hint, cls] = GROUPS[niveau];
    const head = document.createElement("div");
    head.className = "act-group";
    head.innerHTML = `<div><span class="tag ${cls}">${label}</span><span class="act-hint">${hint}</span></div>
      <div><span class="pmeta">${size(items.reduce((a, r) => a + r.size, 0))}</span><button class="link-btn">Tout ajouter</button></div>`;
    $("button", head).onclick = () => { items.forEach((r) => isSelected(r.path) || select(r)); renderRecos(analyseData.recos); };
    el.append(head);
    for (const r of items) el.append(actionCard(r));
  }
}

// « Ce qui occupe ton disque » : les gros blocs compris par GPT-OSS.
function renderMap(map, text) {
  const box = $("#mapList");
  if (!box) return;
  let items = (map || []).filter((m) => m.path && m.note);
  // Anciennes analyses : on relit la section « Carte » du texte.
  if (!items.length && text) {
    const sec = (text.split(/^#{1,3}\s*/m).find((s) => /^carte/i.test(s)) || "");
    for (const line of sec.split("\n")) {
      const m = line.match(/`([^`]+)`\s*(?:\(([\d.,]+\s*[GMK]o)\))?\s*[–:-]?\s*(?:([\d.,]+\s*[GMK]o)\s*)?[:–-]?\s*(.*)$/);
      if (!m) continue;
      const p = HOME_DIR ? m[1].replace(/^~/, HOME_DIR) : m[1];
      const sz = (m[2] || m[3] || "").replace(",", ".");
      const n = parseFloat(sz) * (/Go/.test(sz) ? 1024 ** 3 : /Mo/.test(sz) ? 1024 ** 2 : 1024);
      items.push({ path: p, size: n || 0, note: m[4].replace(/\.$/, "") });
    }
  }
  if (!items.length) { box.innerHTML = `<div class="empty">Disponible après une analyse.</div>`; return; }
  const max = Math.max(...items.map((i) => i.size), 1);
  box.innerHTML = "";
  for (const it of items.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "map-row";
    // La description de GPT-OSS en titre : « site-packages » ne parle à personne.
    const label = String(it.note || baseName(it.path)).replace(/\.$/, "").replace(/^./, (c) => c.toUpperCase());
    row.innerHTML = `<div class="map-main"><div class="map-name">${esc(label)}</div>
        <div class="map-path">${esc(short(it.path))}</div></div>
      <div class="map-side"><b>${it.size ? size(it.size) : ""}</b><div class="sizebar"><span style="width:${(it.size / max) * 100}%"></span></div></div>
      <button class="btn sm">Voir</button>`;
    $("button", row).onclick = () => { state.node = { path: it.path }; show("telescope"); };
    box.append(row);
  }
}

// « Bon à savoir » : les conseils du rapport, un par carte.
function renderTips(text) {
  const box = $("#tips");
  if (!box) return;
  const sec = (String(text || "").split(/^#{1,3}\s*/m).find((s) => /^(à|a) savoir/i.test(s)) || "");
  const tips = sec.split("\n").slice(1).map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter((l) => l && !/^#/.test(l));
  if (!tips.length) { box.innerHTML = `<div class="empty">Rien de particulier.</div>`; return; }
  box.innerHTML = tips.map((t) => `<div class="tip"><span class="tip-i">i</span><div>${marked.parseInline(t)}</div></div>`).join("");
}

function renderReport(text, map) {
  analyseData.summary = text;
  if (HOME_DIR) {
    text = String(text || "").split(HOME_DIR).join("~");
    $("#repHome") && ($("#repHome").textContent = `~ = ${HOME_DIR}`);
  }
  $("#summary") && ($("#summary").innerHTML = md(text));
  renderMap(map ?? analyseData.map, text);
  renderTips(text);
}

async function loadAnalyse() {
  analyseShell();
  if (state.aiRunning) return;
  const a = await api("/api/analyse");
  $("#feed").innerHTML = "";
  if (a.none) {
    feedStep(state.status?.scan ? "Prêt" : "Scan nécessaire", state.status?.scan ? "Lance l'analyse : 1 à 4 minutes." : "Lance d'abord un scan depuis l'accueil.");
    analyseData.recos = [];
    renderRecos([]);
    renderBanner("none");
    renderReport("", []);
    return;
  }
  analyseData.map = a.map || [];
  feedStep("Analyse enregistrée", new Date(a.at).toLocaleString("fr-FR"), "", "fin");
  $("#aDate").textContent = new Date(a.at).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
  $("#btnAnalyse").textContent = "Relancer l'analyse";
  renderRecos(a.recos);
  renderBanner(a.recos.length ? "done" : "empty");
  renderReport(a.summary, a.map);
}

let analyseCtl = null;
async function runAnalyse() {
  analyseShell();
  if (state.aiRunning) { analyseCtl?.abort(); api("/api/stop", {}); return; }
  if (!state.status?.scan) return toast("Lance d'abord un scan.");
  state.aiRunning = true;
  refreshStatus();
  analyseCtl = new AbortController();
  const btn = $("#btnAnalyse");
  btn.textContent = "Arrêter";
  $("#feed").innerHTML = "";
  $("#feedCount").textContent = "";
  feedStep(`${aiName()} se réveille`, "Chargement du modèle");
  $("#thinking").textContent = "";
  const recos = [];
  renderRecos(recos);
  renderBanner("running");
  $("#mapList").innerHTML = `<div class="empty working">${aiName()} explore</div>`;
  $("#tips").innerHTML = `<div class="empty working">Rédaction à la fin</div>`;
  let summary = "", thinking = "";
  try {
    await streamApi("/api/analyse", {}, (e) => {
      if (e.type === "think") { thinking = (thinking + e.text).slice(-300); $("#thinking").textContent = thinking; }
      else if (e.type === "round") thinking = "";
      else if (e.type === "status") feedStep(e.text, "");
      else if (e.type === "tool") {
        if (e.name === "recommander") return;
        const [p, d] = (TOOL_LABEL[e.name] || (() => [e.name, ""]))(e.args || {});
        feedStep(p, d);
      } else if (e.type === "tool_result" && e.name === "recommander" && !/^Ajouté/.test(e.result)) {
        feedStep(e.args.chemin, e.result.replace(/^Refusé : [^—]*— /, "Refusé : "), "", "refused");
      } else if (e.type === "reco") {
        recos.push(e.reco);
        feedStep(e.reco.path, e.reco.raison, size(e.reco.size), "reco");
        renderRecos(recos);
      } else if (e.type === "text") {
        summary += e.text;
      } else if (e.type === "done") {
        analyseData.map = e.map || [];
        renderRecos(e.recos);
        renderBanner(e.recos.length ? "done" : "empty");
        renderReport(e.summary, e.map);
        feedStep("Plan d'action prêt", `${e.recos.length} propositions`, "", "fin");
        $("#aDate").textContent = new Date().toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
      } else if (e.type === "error") { feedStep("Erreur", e.error, "", "refused"); toast(e.error); }
    }, analyseCtl.signal);
  } catch (e) {
    if (e.name !== "AbortError") toast(e.message);
    else feedStep("Analyse arrêtée", "", "", "refused");
    renderBanner(recos.length ? "done" : "none");
  }
  state.aiRunning = false;
  $("#thinking").textContent = "";
  btn.textContent = "Relancer l'analyse";
  refreshStatus();
}

// ================================================ « DEMANDE À SONDE » (Ctrl K)
const HINTS = ["Pourquoi mon disque est-il si plein ?", "Quels projets n'ai-je pas touchés depuis longtemps ?",
  "Y a-t-il des vidéos ou des installateurs oubliés ?", "Qu'est-ce que je peux supprimer sans aucun risque ?"];

function openPalette(q) {
  $("#palette").classList.add("open");
  renderPalette();
  const i = $("#palInput");
  if (q) i.value = q;
  setTimeout(() => i.focus(), 30);
}
function closePalette() { $("#palette").classList.remove("open"); }

function renderPalette() {
  const b = $("#palBody");
  if (state.chat.length || b.dataset.live) return;
  b.innerHTML = `<div class="pal-label">Suggestions</div>${HINTS.map((h) => `<div class="pal-hint">${esc(h)}</div>`).join("")}`;
  $$(".pal-hint", b).forEach((d) => (d.onclick = () => askSonde(d.textContent)));
}

async function askSonde(text) {
  text = text.trim();
  if (!text || state.aiRunning) return;
  if (!state.status?.scan) return toast(`Lance d'abord un scan : ${aiName()} répond à partir de lui.`);
  const b = $("#palBody");
  if (!state.chat.length) b.innerHTML = "";
  b.dataset.live = "1";
  state.chat.push({ role: "user", content: text });
  b.insertAdjacentHTML("beforeend", `<div class="pal-msg user">${esc(text)}</div>`);
  const m = document.createElement("div");
  m.className = "pal-msg";
  m.innerHTML = `<div class="tools"></div><div class="md"><span class="muted working">${aiName()} réfléchit</span></div><div class="chips-row"></div>`;
  b.append(m);
  b.scrollTop = b.scrollHeight;
  $("#palInput").value = "";
  state.aiRunning = true;
  refreshStatus();
  let out = "", raf = 0;
  try {
    await streamApi("/api/chat", { messages: state.chat }, (e) => {
      if (e.type === "tool" && e.name !== "recommander") {
        const [p, d] = (TOOL_LABEL[e.name] || (() => [e.name, ""]))(e.args || {});
        $(".tools", m).insertAdjacentHTML("beforeend", `<div>› ${esc(d)} · ${esc(short(p))}</div>`);
      } else if (e.type === "reco") {
        select(e.reco);
        $(".chips-row", m).insertAdjacentHTML("beforeend", `<span class="chip">＋ ${esc(baseName(e.reco.path))} · ${size(e.reco.size)}</span>`);
      } else if (e.type === "text") {
        out += e.text;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { $(".md", m).innerHTML = md(out); b.scrollTop = b.scrollHeight; });
      } else if (e.type === "done") { out = e.text; $(".md", m).innerHTML = md(out); }
      else if (e.type === "error") $(".md", m).innerHTML = `<span style="color:var(--bad)">${esc(e.error)}</span>`;
    });
    state.chat.push({ role: "assistant", content: out });
  } catch (e) {
    $(".md", m).innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
  state.aiRunning = false;
  refreshStatus();
  b.scrollTop = b.scrollHeight;
}

$("#askBtn").onclick = () => openPalette();
$("#palette").onclick = (e) => { if (e.target.id === "palette") closePalette(); };
$("#palForm").onsubmit = (e) => { e.preventDefault(); askSonde($("#palInput").value); };
$("#palReset").onclick = () => { state.chat = []; delete $("#palBody").dataset.live; renderPalette(); $("#palInput").focus(); };

// ============================================================ EXPLICATION ===
let explainCtl = null;
async function explain(it) {
  if (state.aiRunning) return toast(`${aiName()} est occupé. Attends la fin de l'analyse.`);
  explainCtl?.abort();
  explainCtl = new AbortController();
  $("#drawerTitle").textContent = short(it.path);
  $("#drawerBody").innerHTML = `<span class="muted working">${aiName()} regarde</span>`;
  $("#drawer").classList.add("open");
  let out = "";
  try {
    await streamApi("/api/explain", { path: it.path }, (e) => {
      if (e.type === "text") { out += e.text; $("#drawerBody").innerHTML = md(out); }
      else if (e.type === "error") $("#drawerBody").innerHTML = `<span style="color:var(--bad)">${esc(e.error)}</span>`;
    }, explainCtl.signal);
  } catch (e) {
    if (e.name !== "AbortError") $("#drawerBody").innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`;
  }
}
$("#drawerClose").onclick = () => { explainCtl?.abort(); $("#drawer").classList.remove("open"); };

// ===================================================== REVUE ET CORBEILLE ===
async function openReview() {
  if (!state.selection.size) return;
  const items = [...state.selection.values()].sort((a, b) => b.size - a.size);
  const list = $("#modalList");
  list.innerHTML = "";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `${tileHtml({ ...it, name: it.name })}
      <div class="rname"><div class="t">${esc(it.name)}${it.niveau ? `<span class="badge ${it.niveau}">${NIVEAU[it.niveau]}</span>` : ""}</div>
        <div class="s">${esc(short(it.path))}${it.contenu ? " · le contenu sera vidé, le dossier reste" : ""}</div></div>
      <div class="rsize">${size(it.size)}</div>
      <button class="icon-btn" title="Retirer">✕</button>`;
    $("button", row).onclick = () => { select(it, false); openReview(); };
    list.append(row);
  }
  if (!state.selection.size) return closeReview();
  $("#modal").classList.add("open");
  const bs = $("#binStatus");
  bs.className = "bin-status";
  bs.innerHTML = `<span class="working">Vérification de la place dans la corbeille</span>`;
  $("#btnConfirm").disabled = true;
  try {
    const c = await api("/api/trash/check", { items });
    const lines = [];
    for (const [drive, b] of Object.entries(c.bins)) {
      lines.push(b.problem ? `<b>${esc(drive)}</b> : ${esc(b.problem)}`
        : b.capacity == null ? `<b>${esc(drive)}</b> : ${size(b.need)} à envoyer.${b.warning ? ` ${esc(b.warning)}` : ""}`
        : `<b>${esc(drive)}</b> : ${size(b.need)} à envoyer, ${size(b.free)} disponibles dans la corbeille (maximum ${size(b.capacity)}).`);
    }
    for (const r of c.refused) lines.push(`Ignoré : ${esc(short(r.path))} — ${esc(r.reason)}`);
    bs.innerHTML = lines.join("<br>");
    bs.classList.toggle("bad", c.blocked);
    $("#btnConfirm").disabled = c.blocked || !c.ok.length;
  } catch (e) {
    bs.classList.add("bad");
    bs.textContent = e.message;
  }
}
function closeReview() { $("#modal").classList.remove("open"); }

$("#btnReview").onclick = openReview;
$("#btnTrash").onclick = openReview;
$("#btnClearSel").onclick = () => { state.selection.clear(); syncSelection(); };
$("#modalClose").onclick = closeReview;
$("#modal").onclick = (e) => { if (e.target.id === "modal") closeReview(); };

$("#btnConfirm").onclick = async () => {
  const items = [...state.selection.values()];
  const btn = $("#btnConfirm");
  btn.disabled = true;
  btn.textContent = "Envoi en cours…";
  // Progression en direct : nombre d'éléments, élément en cours, déjà envoyé.
  const bs = $("#binStatus");
  bs.className = "bin-status";
  bs.innerHTML = `<div class="sprog-bar"><span style="width:2%"></span></div><div class="trash-now working">Préparation : vérification des éléments récents</div>
    <button class="link-btn" id="trashStop">Arrêter</button>`;
  const ctl = new AbortController();
  $("#trashStop").onclick = () => { ctl.abort(); $("#trashStop").textContent = "Arrêt…"; };
  try {
    let r = null, sentBytes = 0;
    await streamApi("/api/trash", { items }, (e) => {
      if (e.type === "progress") {
        sentBytes = e.bytes || 0;
        const pct = e.total ? (e.done / e.total) * 100 : 0;
        $(".sprog-bar span", bs).style.width = `${Math.max(2, pct)}%`;
        $(".trash-now", bs).classList.toggle("working", !e.path);
        $(".trash-now", bs).textContent = e.path
          ? `${nf0.format(e.done)} / ${nf0.format(e.total)} · ${size(e.bytes)} envoyés · ${tail(e.path, 60)}`
          : `${nf0.format(e.total)} élément(s) à envoyer`;
      } else if (e.type === "done") r = e;
      else if (e.type === "error") throw new Error(e.error);
    }, ctl.signal).catch((err) => { if (err.name !== "AbortError") throw err; });
    // Arrêt demandé : ce qui est parti reste dans la corbeille.
    if (!r) { toast("Envoi arrêté. Ce qui est déjà parti est dans la corbeille (voir le Journal).", 7000); closeReview(); await refreshStatus(); show(state.view); return; }
    let partial = 0;
    for (const x of r.results) {
      if (x.failed === 0) state.selection.delete(x.path.toLowerCase());
      else partial++;
    }
    syncSelection();
    closeReview();
    // Les lignes envoyées quittent la liste en glissant (fx.js) avant le nouveau rendu.
    await window.FX?.trashOut(r.results.filter((x) => x.failed === 0).map((x) => x.path));
    toast(`${size(Math.max(r.freed || 0, sentBytes))} envoyés à la corbeille. Récupérables tant qu'elle n'est pas vidée.${partial ? ` ${partial} élément(s) en partie verrouillé(s) ou récent(s), laissé(s) en place.` : ""}`, 6000);
    await refreshStatus();
    show(state.view);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.textContent = "Mettre à la corbeille";
  }
};

// ---------------------------------------------------------------- clavier ---
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
  if (e.key === "Escape") { closePalette(); closeReview(); $("#drawer").classList.remove("open"); }
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName);
  if (e.key === "Backspace" && state.view === "telescope" && !typing) {
    const c = state.node?.crumbs;
    if (c && c.length > 1) loadNode(c[c.length - 2].path);
  }
});

// Démarrage après le chargement de system.js et setup.js, qui ajoutent leurs vues.
window.addEventListener("DOMContentLoaded", async () => {
  syncSelection();
  const s = await refreshStatus();
  HOME_DIR = s?.home || null;
  show(location.hash.slice(1) || "home");
});
