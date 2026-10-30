// Sonde — page Paramètres, d'après la maquette « Sonde v2 » : Général
// (apparence, démarrage, surveillance du disque, données de Sonde), IA,
// Mise à jour et Confidentialité. Un onglet par vue, dans la barre du haut.
"use strict";

const AMBS = [
  ["violet", "Violet", "#7c5cff", "#c455ff", "#ff5fa2", "rgba(196,85,255,.38)"],
  ["aurore", "Aurore", "#2563eb", "#22d3ee", "#5eead4", "rgba(34,211,238,.32)"],
  ["braise", "Braise", "#f43f5e", "#fb7185", "#fbbf24", "rgba(244,63,94,.34)"],
];
const SET_ICON = {
  power: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  note: "M4 4h16v12H8l-4 4zM8 9h8M8 12h5",
  chart: "M3 3v18h18M7 15l4-4 3 3 5-6",
  report: "M6 3h9l4 4v14H6zM9 12h6M9 16h6",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  download: "M12 3v12M7 10l5 5 5-5M5 21h14",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7z",
  check: "M5 12l5 5L20 7",
  chip: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z",
};

// Ligne de réglage : tuile en dégradé, titre et explication, contrôle à droite.
function srow({ icon, tile, title, desc, control, onClick, dim }) {
  const r = el(`<div class="srow fx-row ${onClick ? "click" : ""}"><div class="tile" style="background:${tile}${dim ? ";opacity:.35" : ""}">${svg(icon)}</div>
    <div class="sr-body"><div class="t"></div><div class="s"></div></div><div class="sr-ctl"></div></div>`);
  $(".t", r).textContent = title;
  $(".s", r).textContent = desc || "";
  if (control) $(".sr-ctl", r).append(control);
  if (onClick) r.onclick = (e) => { if (!e.target.closest("button")) onClick(e); };
  return r;
}
const spanel = (title, desc) => {
  const p = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title"></div>${desc ? `<div class="sp-desc"></div>` : ""}</div></div><div class="sp-body"></div></div>`);
  $(".sp-title", p).textContent = title;
  if (desc) $(".sp-desc", p).textContent = desc;
  return p;
};
const setHead = () => head("Paramètres", "Les réglages de Sonde. Tout est enregistré sur ton PC.");

// ---------------------------------------------------------------- Général -
V.settings = async () => {
  const v = $("#view-settings");
  v.innerHTML = loading();
  let p;
  try { p = await api("/api/prefs"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  v.append(setHead());

  // Apparence : trois cartes avec un aperçu, et l'interrupteur « Animations ».
  const look = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Apparence</div><div class="sp-desc">Les couleurs de l'interface. Le changement est immédiat.</div></div>
    <label class="anim-tg">Animations</label></div><div class="amb-cards"></div></div>`);
  const sw = switchEl(FX.enabled(), (on, s) => { FX.set(on); s.classList.toggle("on", on); toast(on ? "Animations activées." : "Animations coupées."); });
  $(".anim-tg", look).append(sw);
  if (FX.reduced()) $(".anim-tg", look).title = "Windows demande de réduire les animations : elles restent coupées.";
  const cardsBox = $(".amb-cards", look);
  const drawAmbs = () => {
    cardsBox.innerHTML = "";
    const cur = document.body.dataset.amb;
    for (const [k, label, a, b, c, glow] of AMBS) {
      const on = cur === k, grad = `linear-gradient(135deg,${a},${b} 55%,${c})`;
      const card = el(`<button class="amb-card ${on ? "on" : ""}" style="--ring:linear-gradient(135deg,${a},${c})">
        <div class="ac-in">
          <div class="ac-prev" style="background:radial-gradient(160px 90px at 15% 0%,${glow},transparent 70%),radial-gradient(140px 90px at 100% 100%,${c}40,transparent 70%),#0b0a17">
            <div class="ac-side"><i style="background:${grad}"></i><i></i><i></i><i></i></div>
            <div class="ac-main"><i class="h"></i><i class="p"></i><i class="b" style="background:${grad};box-shadow:0 4px 14px ${glow}"></i></div>
          </div>
          <div class="ac-foot"><i class="dot" style="background:${grad}"></i><span></span><span class="check ${on ? "on" : ""}"></span></div>
        </div></button>`);
      $(".ac-foot span", card).textContent = label;
      card.onclick = () => { setAmbiance(k); drawAmbs(); };
      cardsBox.append(card);
    }
  };
  drawAmbs();
  v.append(look);

  // Démarrage et surveillance du disque, côte à côte.
  const grid = el(`<div class="set-grid"></div>`);
  const start = spanel("Démarrage");
  const sb = $(".sp-body", start);
  if (p.openAtLogin == null) {
    sb.append(srow({ icon: SET_ICON.power, tile: G("#0d9488", "#2dd4bf"), title: "Lancer Sonde à l'ouverture de session",
      desc: isLinux() ? "Bientôt disponible sous Debian." : "Disponible dans l'application installée.", dim: true }));
  } else {
    const login = switchEl(p.openAtLogin, async (on, s) => {
      if (await act(null, () => api("/api/prefs", { openAtLogin: on }))) { s.classList.toggle("on", on); toast(on ? "Sonde se lancera avec Windows." : "Sonde ne se lancera plus avec Windows."); }
    });
    sb.append(srow({ icon: SET_ICON.power, tile: G("#0d9488", "#2dd4bf"), title: "Lancer Sonde à l'ouverture de session",
      desc: "Sonde s'ouvre tout seul quand tu te connectes à Windows.", control: login, onClick: () => login.click() }));
  }
  sb.append(srow({ icon: ICON.spark, tile: G("#8b5cf6", "#d946ef"), title: "Assistant de l'IA", desc: "Rouvrir l'assistant qui prépare l'IA (Ollama, modèle, ou IA en ligne).",
    control: btn("Ouvrir", () => openSetup()), onClick: () => openSetup() }));

  // Seuil d'alerte : − et +, jauge de l'espace libre avec un repère au seuil.
  const watch = el(`<div class="panel spanel watch"><div class="sp-title">Surveillance du disque</div>
    <div class="w-row"><div><div class="t">Alerte d'espace libre</div><div class="s">Une notification te prévient quand l'espace libre passe sous ce seuil, à chaque scan automatique.</div></div>
      <div class="stepper"><button data-d="-1" title="Baisser le seuil">−</button><span class="thr"></span><button data-d="1" title="Monter le seuil">+</button></div></div>
    <div class="w-gauge"><div class="wg-track"><span class="wg-free fx-bar"></span><i class="wg-mark"></i></div>
      <div class="wg-legend"><span class="free"></span><span class="alert"></span></div></div></div>`);
  const disk = state.status?.scan?.disk?.total ? state.status.scan.disk : state.status?.drives?.[0];
  const totGB = disk?.total ? disk.total / 1024 ** 3 : null;
  let thr = p.alertFreeGB, saveT;
  const drawThr = () => {
    $(".thr", watch).textContent = `${nf0.format(thr)} Go`;
    $(".alert", watch).textContent = thr ? `alerte sous ${nf0.format(thr)} Go` : "alerte désactivée";
    if (totGB) {
      $(".wg-free", watch).style.width = `${Math.min(100, (disk.free / disk.total) * 100)}%`;
      $(".wg-mark", watch).style.left = `${Math.min(100, (thr / totGB) * 100)}%`;
      $(".free", watch).innerHTML = `<b>${size(disk.free)}</b> libres aujourd'hui`;
    } else {
      $(".w-gauge", watch).classList.add("na");
      $(".free", watch).textContent = "Espace libre : Non disponible (lance un scan)";
    }
  };
  $$(".stepper button", watch).forEach((b) => (b.onclick = () => {
    thr = Math.max(0, Math.min(10000, thr + Number(b.dataset.d) * 10));
    drawThr();
    clearTimeout(saveT);
    saveT = setTimeout(() => api("/api/settings", { alertFreeGB: thr }).then(() => toast("Seuil enregistré.")).catch((e) => toast(e.message)), 700);
  }));
  drawThr();
  const sched = el(`<button class="w-link"><div><div class="t">Scan automatique</div><div class="s">Se règle dans Historique › Évolution</div></div><span>Régler ›</span></button>`);
  sched.onclick = () => show("history");
  watch.append(sched);
  grid.append(start, watch);
  v.append(grid);

  // Données de Sonde : poids, dossier, une ligne par type de données.
  const data = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Données de Sonde</div>
      <div class="sp-desc">Scans, notes de l'IA, journal et réglages : uniquement sur ton PC. Les effacer ne touche jamais à tes fichiers.</div></div>
      <div class="sp-total"><b data-count></b><span>au total</span></div></div>
    <div class="data-path">${svg(SET_ICON.folder)}<span></span></div><div class="sp-body"></div></div>`);
  $(".sp-total b", data).textContent = size(p.data.size);
  $(".data-path span", data).textContent = p.data.dir;
  $(".data-path", data).append(btn("Ouvrir le dossier", () => api("/api/data/open", {}).catch((e) => toast(e.message)), "sm"));
  const sz = p.data.sizes || {};
  const rows = [
    ["notes", "Notes de l'IA sur la carte du disque", `${p.data.notes} dossier${p.data.notes > 1 ? "s" : ""} décrit${p.data.notes > 1 ? "s" : ""} par l'IA`, !p.data.notes, SET_ICON.note, G("#8b5cf6", "#d946ef"), "La description des dossiers se réécrit à la prochaine analyse."],
    ["history", "Historique des scans", `${p.data.history} instantané${p.data.history > 1 ? "s" : ""} pour la courbe d'évolution`, !p.data.history, SET_ICON.chart, G("#0284c7", "#22d3ee"), "La courbe repart de zéro au prochain scan."],
    ["analyse", "Dernier rapport d'analyse", p.data.analyse ? "Le plan d'action de la dernière analyse IA" : "Aucun rapport enregistré", !p.data.analyse, SET_ICON.report, G("#d97706", "#fbbf24"), "Relance une analyse pour en obtenir un nouveau."],
  ];
  for (const [what, title, desc, empty, icon, tile, after] of rows) {
    const r = el(`<div class="drow fx-row"><div class="tile" style="background:${tile}${empty ? ";opacity:.35" : ""}">${svg(icon)}</div>
      <div><div class="t"></div><div class="s"></div></div><span class="dsz"></span><button class="btn sm dclear"></button></div>`);
    $(".t", r).textContent = title;
    $(".s", r).textContent = desc;
    $(".dsz", r).textContent = size(sz[what] || 0);
    const b = $(".dclear", r);
    b.textContent = empty ? "Vide" : "Effacer";
    b.disabled = empty;
    // Effacer demande une confirmation : un second clic sur « Confirmer ? ».
    let armed = false, armT;
    b.onclick = async () => {
      if (!armed) {
        armed = true; b.textContent = "Confirmer ?"; b.classList.add("armed");
        armT = setTimeout(() => { armed = false; b.textContent = "Effacer"; b.classList.remove("armed"); }, 4000);
        return;
      }
      clearTimeout(armT);
      if (await act(b, () => api("/api/data/clear", { what }))) {
        b.textContent = "Effacé"; b.disabled = true; b.classList.remove("armed");
        $(".s", r).textContent = `Effacé · ${after}`;
        $(".dsz", r).textContent = size(0);
        $(".tile", r).style.opacity = ".35";
        toast("Effacé.");
      }
    };
    $(".sp-body", data).append(r);
  }
  v.append(data);
};

// --------------------------------------------------------------------- IA -
V["set-ai"] = async () => {
  const v = $("#view-set-ai");
  v.innerHTML = loading();
  let c;
  try { c = await api("/api/ai/config"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  v.append(setHead());
  const cur = c.current;
  const local = cur.provider === "ollama";
  const st = state.status?.ai;
  const ready = st?.ok && st?.available;
  const p = spanel("IA utilisée");
  const where = local ? "via Ollama, sur ton PC" : cur.remote ? `en ligne, chez ${cur.label}` : `serveur sur ton réseau (${cur.baseUrl})`;
  $(".sp-body", p).append(srow({ icon: ICON.spark, tile: G("#8b5cf6", "#d946ef"), title: "Moteur d'IA",
    desc: `${cur.model || "aucun modèle"} ${where} · ${ready ? "prête" : local ? "Ollama ne répond pas ou le modèle est absent" : "clé d'API ou serveur à vérifier"}`,
    control: btn("Changer", () => openSetup()) }));
  const test = srow({ icon: SET_ICON.check, tile: G("#059669", "#34d399"), title: "Tester l'IA", desc: "Vérifie qu'elle répond et qu'elle sait utiliser les outils de Sonde." });
  $(".sr-ctl", test).append(btn("Tester", (b) => act(b, async () => {
    $(".s", test).textContent = "Test en cours…";
    try {
      const t = await api("/api/ai/test", { provider: cur.provider, model: cur.model, baseUrl: cur.baseUrl });
      $(".s", test).textContent = t.tools ? `✓ Répond en ${nf1.format(t.ms / 1000)} s et sait utiliser les outils.` : `Répond en ${nf1.format(t.ms / 1000)} s, mais n'utilise pas les outils : l'analyse et l'assistant risquent d'échouer.`;
    } catch (e) { $(".s", test).textContent = e.message; }
  }, "Test…")));
  $(".sp-body", p).append(test);
  if (!local) {
    $(".sp-body", p).append(srow({ icon: SET_ICON.key, tile: G("#d97706", "#fbbf24"), title: "Clé d'API",
      desc: c.saved.hasKey ? (c.keyProtected ? "Enregistrée et chiffrée par Windows (jamais affichée)." : "Enregistrée en clair : lance l'application installée pour qu'elle soit chiffrée.") : "Aucune clé enregistrée.",
      control: c.saved.hasKey ? btn("Oublier la clé", async (b) => {
        if (!await confirmBox({ title: "Oublier la clé d'API ?", body: "L'IA en ligne ne fonctionnera plus tant que tu n'auras pas remis une clé.", danger: true, ok: "Oublier" })) return;
        if (await act(b, () => api("/api/ai/forget-key", {}))) { toast("Clé oubliée."); await refreshStatus(); V["set-ai"](); }
      }) : null }));
  }
  v.append(p);

  if (local && c.ollama.models.length) {
    const list = spanel(`Modèles installés dans Ollama (${c.ollama.models.length})`, "Pour en changer, utilise « Changer » ci-dessus.");
    for (const m of c.ollama.models) {
      const tools = (m.capabilities || []).includes("tools");
      const r = el(`<div class="drow fx-row"><div class="tile" style="background:${G("#475569", "#64748b")}">${svg(SET_ICON.chip)}</div>
        <div><div class="t"></div><div class="s"></div></div><span class="dsz"></span><span class="tags"></span></div>`);
      $(".t", r).textContent = m.id;
      $(".s", r).textContent = [m.params, m.quant].filter(Boolean).join(" · ");
      $(".dsz", r).textContent = size(m.size);
      $(".tags", r).innerHTML = `${m.id === cur.model ? `<span class="tag good">en service</span>` : ""}${tools ? `<span class="tag">outils</span>` : `<span class="tag warn">pas d'outils</span>`}`;
      $(".sp-body", list).append(r);
    }
    v.append(list);
  }
};

// ---------------------------------------------------------- Mise à jour ---
let updPollT = null;
V["set-update"] = async () => {
  const v = $("#view-set-update");
  v.innerHTML = "";
  v.append(setHead());
  const p = spanel("Mise à jour de Sonde");
  v.append(p);
  await drawUpdate($(".sp-body", p));
};

async function drawUpdate(box) {
  clearTimeout(updPollT);
  if (!box.isConnected && box.parentNode) return;
  let u;
  try { u = await api("/api/update"); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  box.innerHTML = "";
  const a = u.available;
  let desc, ctl = null, extra = "";
  if (!u.supported) desc = u.reason || "Mise à jour indisponible.";
  else if (u.status === "checking") desc = "Recherche d'une nouvelle version…";
  else if (u.status === "available") {
    desc = `La version ${a.version} est disponible${a.date ? ` · publiée ${ago(Date.parse(a.date))}` : ""}.`;
    ctl = btn("Télécharger", async () => { await api("/api/update/download", {}).catch((e) => toast(e.message)); drawUpdate(box); }, "primary");
  } else if (u.status === "downloading") {
    const pr = u.progress || {};
    desc = `Téléchargement de la version ${a?.version || ""} · ${pr.total ? `${size(pr.transferred)} sur ${size(pr.total)}${pr.speed ? ` · ${size(pr.speed)}/s` : ""}` : "connexion…"}`;
    extra = `<div class="sprog-bar upd-bar"><span style="width:${Math.max(3, pr.percent || 0)}%"></span></div>`;
  } else if (u.status === "ready") {
    desc = `La version ${a.version} est prête. Sonde va se fermer, s'installer puis se relancer.${isLinux() ? " Debian demandera ton mot de passe administrateur." : ""}`;
    ctl = btn("Redémarrer et installer", async (b) => { b.disabled = true; b.textContent = "Fermeture…"; await api("/api/update/install", {}).catch((e) => toast(e.message, 7000)); }, "primary");
  } else if (u.status === "error") {
    desc = u.error;
    ctl = btn("Réessayer", async () => { await api("/api/update/check", {}).catch((e) => toast(e.message)); drawUpdate(box); });
  } else {
    desc = `${u.status === "none" ? "Tu as la dernière version" : "Pas encore vérifié"}${u.checkedAt ? ` · vérifié ${ago(u.checkedAt)}` : ""}`;
    ctl = btn("Vérifier", async (b) => { b.disabled = true; await api("/api/update/check", {}).catch((e) => toast(e.message)); drawUpdate(box); });
  }
  const main = srow({ icon: SET_ICON.refresh, tile: G("var(--a1)", "var(--a3)"), title: `Sonde ${u.current}`, desc, control: ctl });
  if (u.status === "error") $(".s", main).style.color = "var(--bad)";
  box.append(main);
  if (extra) box.append(el(extra));
  if (a?.notes && ["available", "ready"].includes(u.status)) {
    const n = el(`<details class="upd-notes" ${u.status === "available" ? "open" : ""}><summary></summary><pre></pre></details>`);
    $("summary", n).textContent = `Nouveautés de la version ${a.version}`;
    $("pre", n).textContent = a.notes;
    box.append(n);
  }
  if (u.supported) {
    box.append(srow({ icon: SET_ICON.download, tile: G("#0d9488", "#2dd4bf"), title: "Mettre à jour automatiquement",
      desc: "Cherche une nouvelle version chaque jour. Chaque fichier téléchargé est vérifié avant l'installation ; tes réglages, ton journal et tes scans sont conservés.",
      control: switchEl(u.auto, async (on, s) => { if (await act(null, () => api("/api/update/auto", { on }))) s.classList.toggle("on", on); }) }));
  }
  // Suivi en direct pendant la recherche et le téléchargement, tant que la page est affichée.
  if (["checking", "downloading"].includes(u.status)) updPollT = setTimeout(() => { if (box.isConnected) drawUpdate(box); }, 700);
}

// ------------------------------------------------------- Confidentialité ---
V["set-privacy"] = async () => {
  const v = $("#view-set-privacy");
  v.innerHTML = loading();
  let c, p;
  try { [c, p] = await Promise.all([api("/api/ai/config"), api("/api/prefs")]); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  v.append(setHead());
  const cur = c.current;
  const remote = cur.remote;

  // En résumé
  const sum = el(`<div class="panel privacy-hero ${remote ? "warn" : ""}">
    <div class="ph-icon">${svg(ICON.shield)}</div>
    <div><div class="ph-title"></div><div class="ph-text"></div></div></div>`);
  $(".ph-title", sum).textContent = remote ? `Ton IA est en ligne, chez ${cur.label}` : "Rien ne quitte ton PC";
  $(".ph-text", sum).textContent = remote
    ? `Sonde n'envoie rien à personne, sauf à ${cur.label} quand tu utilises l'IA : les noms, tailles et dates des dossiers qu'elle explore, les listes de programmes, de services ou de réglages réseau (adresses de la box et du PC, DNS) que tu lui demandes d'expliquer, et tes questions. Jamais le contenu de tes fichiers.`
    : "Sonde n'a ni compte, ni télémétrie, ni statistiques d'utilisation. L'IA tourne sur ton PC : tes scans, tes notes et tes questions ne sont envoyés nulle part.";
  if (remote) sum.append(btn("Revenir à une IA locale", () => { openSetup(); setTimeout(() => $$("#setupTabs button")[0]?.click(), 400); }));
  v.append(sum);

  const rows = spanel("Réglages");
  $(".sp-body", rows).append(
    srow({ icon: SET_ICON.refresh, tile: G("#0d9488", "#2dd4bf"), title: "Recherche automatique des mises à jour",
      desc: "La seule connexion que Sonde fait tout seul. Tu peux la couper : il faudra alors vérifier à la main.",
      control: switchEl(p.autoUpdate, async (on, sw) => {
        if (await act(null, () => api("/api/update/auto", { on }))) { sw.classList.toggle("on", on); toast(on ? "Recherche automatique activée." : "Recherche automatique désactivée."); }
      }) }),
    srow({ icon: ICON.hist, tile: G("#64748b", "#94a3b8"), title: "Journal des actions", desc: "Tout ce que Sonde a supprimé ou modifié, annulable.",
      control: btn("Ouvrir", () => show("journal")), onClick: () => show("journal") }));
  v.append(rows);

  const never = spanel("Ce que Sonde ne fait jamais");
  $(".sp-body", never).append(el(`<ul class="privacy-list">
    <li>Pas de compte, pas d'inscription, pas d'adresse e-mail demandée.</li>
    <li>Pas de télémétrie, pas de statistiques d'utilisation, pas de rapport de plantage envoyé.</li>
    <li>Pas de publicité, pas de traceur.</li>
    <li>Le contenu de tes fichiers n'est jamais lu pour être envoyé : Sonde ne regarde que les noms, tailles et dates.</li>
    <li>Le serveur interne de Sonde n'écoute que sur ton PC (127.0.0.1) et refuse les requêtes venant d'un site web.</li>
  </ul>`));
  v.append(never);

  // Toutes les connexions sortantes, et quand elles ont lieu.
  const out = spanel("Les seules connexions vers Internet", "Chacune a lieu uniquement quand tu la déclenches, ou quand le réglage indiqué est activé.");
  const conns = [
    { when: "IA en ligne (seulement si tu la choisis)", to: remote ? cur.label : "aucun : ton IA est locale", what: "Noms, tailles et dates des dossiers explorés ; listes de programmes, services ou réglages à expliquer ; tes questions.", active: remote },
    { when: "Recherche de mises à jour de Sonde", to: "github.com", what: "Demande de la dernière version. Rien sur toi ni ton PC (hormis ton adresse IP, comme pour tout site).", active: p.autoUpdate, note: p.autoUpdate ? "automatique chaque jour" : "seulement à la main" },
    { when: "Préparer l'IA (assistant)", to: "ollama.com", what: "Téléchargement d'Ollama et du modèle choisi.", active: false },
    { when: "Test de la connexion (pages Réseau et Gaming)", to: "Cloudflare, Google, Quad9", what: "Ping et mesure du débit avec des données de test ; comparaison de serveurs DNS avec des noms de sites connus.", active: false },
    ...(isLinux() ? [] : [
      { when: "Ping des serveurs de jeu (page Gaming)", to: "Valve (Steam), Epic Games, Blizzard, Google", what: "Quelques paquets de ping ; la liste des relais Steam est demandée à Valve.", active: false },
      { when: "Mises à jour de pilotes (page Pilotes)", to: "Windows Update (Microsoft)", what: "Recherche faite par Windows lui-même.", active: false },
      { when: "Signatures antivirus (page Sécurité)", to: "Microsoft Defender", what: "Mise à jour faite par Defender lui-même.", active: false },
    ]),
    { when: "Liens « Créer une clé », site AMD…", to: "ton navigateur", what: "La page s'ouvre dans ton navigateur ; Sonde n'y envoie rien.", active: false },
  ];
  $(".sp-body", out).append(table([
    { label: "Quand", render: (r) => `<div class="t">${esc(r.when)}</div>${r.note ? `<div class="s">${esc(r.note)}</div>` : ""}` },
    { label: "Vers", render: (r) => `<span class="${r.active ? "" : "muted"}">${esc(r.to)}</span>` },
    { label: "Ce qui part", render: (r) => `<span class="muted">${esc(r.what)}</span>` },
  ], conns));
  v.append(out);

  const stored = spanel("Ce qui est enregistré sur ton PC");
  $(".sp-body", stored).append(el(`<ul class="privacy-list">
    <li>Le dernier scan (arborescence et tailles), l'historique des scans, les notes de l'IA, le journal des actions et les réglages, dans <code>${esc(p.data.dir)}</code>.</li>
    <li>${c.saved.hasKey ? (c.keyProtected ? "Ta clé d'API, chiffrée par Windows : seul ton compte Windows peut la lire." : "Ta clé d'API, en clair dans les réglages (version lancée depuis les sources).") : "Aucune clé d'API."}</li>
    <li>Rien d'autre. Tu peux tout effacer dans l'onglet Général, ou en supprimant ce dossier.</li>
  </ul>`));
  v.append(stored);
};
