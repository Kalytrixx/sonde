// Sonde — vues des modules : évolution, recherche, journal, programmes,
// logiciels actifs, services, pilotes, sécurité, réseau, nettoyage Windows.
// S'appuie sur les utilitaires d'app.js ($, esc, size, api, streamApi…).
"use strict";

const V = window.VIEWS;

// --------------------------------------------------------------- outils ---
function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
const dt = (ms) => (ms ? new Date(ms).toLocaleDateString("fr-FR") : "–");
const dtt = (ms) => (ms ? new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "–");
const loading = (msg = "Chargement") => `<div class="empty working">${esc(msg)}</div>`;
const mo = (n) => size(n);

function btn(label, onclick, cls = "") {
  const b = el(`<button class="btn ${cls}"></button>`);
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); onclick(b); };
  return b;
}
function iconBtn(label, title, onclick) {
  const b = el(`<button class="icon-btn" title="${esc(title)}"></button>`);
  b.textContent = label;
  b.onclick = (e) => { e.stopPropagation(); onclick(b); };
  return b;
}
function group(...nodes) {
  const s = document.createElement("span");
  s.style.cssText = "display:inline-flex;gap:4px;align-items:center";
  s.append(...nodes.filter(Boolean));
  return s;
}
function head(title, subHtml, ...actions) {
  const h = el(`<header class="view-head"><div><h1></h1><p class="sub"></p></div><div class="toolbar" style="margin:0"></div></header>`);
  h.querySelector("h1").textContent = title;
  h.querySelector(".sub").innerHTML = subHtml;
  h.querySelector(".toolbar").append(...actions.filter(Boolean));
  return h;
}
function tabs(names, onPick, initial = 0) {
  const t = el(`<div class="segs" style="display:inline-flex;margin-bottom:16px"></div>`);
  names.forEach((n, i) => {
    const b = el(`<button></button>`);
    b.textContent = n;
    b.onclick = () => { $$("button", t).forEach((x) => x.classList.remove("on")); b.classList.add("on"); onPick(i); };
    if (i === initial) b.classList.add("on");
    t.append(b);
  });
  return t;
}
function switchEl(on, onToggle, disabled = false) {
  const s = el(`<button class="switch ${on ? "on" : ""}" ${disabled ? "disabled" : ""}></button>`);
  s.onclick = (e) => { e.stopPropagation(); onToggle(!s.classList.contains("on"), s); };
  return s;
}

// Tableau : colonnes { label, num, act, render(row) -> html ou Node }.
function table(cols, rows, { empty = "Rien à afficher." } = {}) {
  if (!rows.length) return el(`<div class="panel"><div class="empty">${esc(empty)}</div></div>`);
  const wrap = el(`<div class="tbl-wrap"><table class="tbl"><thead><tr></tr></thead><tbody></tbody></table></div>`);
  const t = $("table", wrap);
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c.label || "";
    if (c.num) th.className = "num";
    t.querySelector("tr").append(th);
  }
  const tb = t.querySelector("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const c of cols) {
      const td = document.createElement("td");
      if (c.num) td.className = "num";
      if (c.act) td.className = "act";
      const v = c.render(r, tr);
      if (v instanceof Node) td.append(v);
      else td.innerHTML = v ?? "";
      tr.append(td);
    }
    tb.append(tr);
  }
  return wrap;
}

// Désactive un bouton pendant une action, et affiche l'erreur éventuelle.
async function act(b, fn, busy) {
  const old = b?.textContent;
  if (b) { b.disabled = true; if (busy) b.textContent = busy; }
  try { return await fn(); }
  catch (e) { toast(e.message, 7000); return undefined; }
  finally { if (b) { b.disabled = false; b.textContent = old; } }
}

// Fenêtre de confirmation. `admin` : prévient qu'une fenêtre UAC va s'ouvrir.
function confirmBox({ title, body, admin = false, danger = false, ok = "Confirmer" }) {
  return new Promise((resolve) => {
    $("#confirmTitle").textContent = title;
    $("#confirmBody").innerHTML = body + (admin
      ? `<div class="adminbox">${esc(OS.admin)}</div>` : "");
    const yes = $("#confirmYes");
    yes.textContent = ok;
    yes.className = "btn " + (danger ? "danger" : "primary");
    const m = $("#confirm");
    m.classList.add("open");
    const done = (v) => { m.classList.remove("open"); resolve(v); };
    yes.onclick = () => done(true);
    $("#confirmNo").onclick = () => done(false);
    $("#confirmClose").onclick = () => done(false);
  });
}

// Explication d'un élément système par GPT-OSS, dans le tiroir.
let itemCtl = null;
async function askAI(kind, item, title) {
  if (state.aiRunning) return toast(`${aiName()} est occupé.`);
  itemCtl?.abort();
  itemCtl = new AbortController();
  $("#drawerTitle").textContent = title;
  $("#drawerBody").innerHTML = `<span class="muted working">${aiName()} regarde</span>`;
  $("#drawer").classList.add("open");
  let out = "";
  try {
    await streamApi("/api/ai/item", { kind, item }, (e) => {
      if (e.type === "text") { out += e.text; $("#drawerBody").innerHTML = md(out); }
      else if (e.type === "error") $("#drawerBody").innerHTML = `<span style="color:var(--danger)">${esc(e.error)}</span>`;
    }, itemCtl.signal);
  } catch (e) {
    if (e.name !== "AbortError") $("#drawerBody").innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
  }
}
$("#drawerClose").addEventListener("click", () => itemCtl?.abort());

// Barre d'outils avec marge haute.
function bar(marginTop, ...nodes) {
  const t = el(`<div class="toolbar" style="margin-top:${marginTop}px"></div>`);
  t.append(...nodes.filter(Boolean));
  return t;
}

const openTool = (tool) => api("/api/tool/open", { tool }).catch((e) => toast(e.message));
const isActive = (view) => state.view === view;

// ============================================================= Évolution ===
const DAYS = [["Monday", "lundi"], ["Tuesday", "mardi"], ["Wednesday", "mercredi"], ["Thursday", "jeudi"],
  ["Friday", "vendredi"], ["Saturday", "samedi"], ["Sunday", "dimanche"]];

V.history = async () => {
  const v = $("#view-history");
  v.innerHTML = loading();
  const [h, sch] = await Promise.all([api("/api/history"), api("/api/schedule").catch(() => ({ enabled: false }))]);
  v.innerHTML = "";
  v.append(head("Évolution", "Chaque scan laisse un instantané. Sonde compare deux instantanés pour montrer ce qui a grossi ou diminué."));

  // Réglages : scan hebdomadaire et seuil d'alerte
  const settings = el(`<div class="grid-2">
    <div class="panel"><div class="panel-title">Scan automatique chaque semaine</div>
      <div class="muted" id="schText"></div><div class="toolbar" style="margin-top:12px" id="schBar"></div></div>
    <div class="panel"><div class="panel-title">Alerte d'espace libre</div>
      <div class="muted">Une notification te prévient quand l'espace libre passe sous ce seuil, à chaque scan automatique.</div>
      <div class="toolbar" style="margin-top:12px" id="alertBar"></div></div></div>`);
  v.append(settings);
  $("#schText", settings).textContent = sch.enabled
    ? `Activé${sch.next ? " — prochain scan le " + dtt(Date.parse(sch.next)) : ""}${sch.last ? " · dernier le " + dtt(Date.parse(sch.last)) : ""}`
    : "Désactivé. Sonde scannera le disque en arrière-plan, sans fenêtre, même s'il n'est pas ouvert.";
  const day = el(`<select>${DAYS.map(([en, fr]) => `<option value="${en}" ${en === "Sunday" ? "selected" : ""}>${fr}</option>`).join("")}</select>`);
  const hour = el(`<select>${Array.from({ length: 24 }, (_, i) => `<option value="${i}" ${i === 12 ? "selected" : ""}>${i} h</option>`).join("")}</select>`);
  $("#schBar", settings).append(...(sch.enabled ? [] : [day, hour]),
    btn(sch.enabled ? "Désactiver" : "Activer", (b) => act(b, async () => {
      await api("/api/schedule", { enable: !sch.enabled, day: day.value, hour: Number(hour.value) });
      toast(sch.enabled ? "Scan automatique désactivé." : "Scan automatique activé.");
      V.history();
    }), sch.enabled ? "" : "primary"));
  const alertIn = el(`<input type="number" min="0" max="10000" style="width:90px">`);
  alertIn.value = h.alertFreeGB;
  $("#alertBar", settings).append(alertIn, el(`<span class="muted">Go</span>`),
    btn("Enregistrer", (b) => act(b, async () => { await api("/api/settings", { alertFreeGB: Number(alertIn.value) }); toast("Seuil enregistré."); })),
    btn("Tester la notification", (b) => act(b, () => api("/api/notify/test", {}))));

  // Courbe de l'espace occupé
  // Un scan de C: seul et un scan de C: + G: ne se comparent pas : la courbe
  // ne montre qu'un périmètre à la fois.
  const scopeName = (r) => (r || "").length <= 3 ? (r || "?").slice(0, 2) : r;
  const scopes = [...new Set(h.snapshots.map((s) => scopeName(s.root)))];
  let scope = store.get("histScope");
  if (!scopes.includes(scope)) scope = scopes[0];
  const all = h.snapshots;
  h.snapshots = all.filter((s) => scopeName(s.root) === scope);
  const snaps = [...h.snapshots].reverse();
  const title = el(`<div class="section-title"><span>Espace occupé au fil des scans</span></div>`);
  if (scopes.length > 1) {
    const segs = el(`<div class="segs sm">${scopes.map((x) => `<button class="${x === scope ? "on" : ""}">${esc(x)}</button>`).join("")}</div>`);
    $$("button", segs).forEach((b, i) => (b.onclick = () => { store.set("histScope", scopes[i]); V.history(); }));
    title.append(segs);
  }
  v.append(title);
  if (snaps.length < 2) {
    v.append(el(`<div class="panel muted">${snaps.length ? "Un seul scan pour l'instant." : "Aucun scan enregistré."} Chaque nouveau scan ajoute un point : il en faut au moins deux pour voir l'évolution.</div>`));
    return;
  }
  const chartBox = el(`<div class="panel chart-box"><div class="chart-legend"><span><i></i>Un point = un scan</span><span class="muted">Survole un point pour le détail</span></div><svg class="chart"></svg><div class="chart-tip"></div></div>`);
  v.append(chartBox);
  drawChart($("svg", chartBox), snaps.map((s) => ({ at: s.at, used: s.disk && s.free != null ? s.disk - s.free : s.total })));

  // Comparaison
  const opts = h.snapshots.map((s) => `<option value="${s.id}">${esc(dtt(s.at))} — ${esc(size(s.disk && s.free != null ? s.disk - s.free : s.total))}</option>`).join("");
  const from = el(`<select>${opts}</select>`), to = el(`<select>${opts}</select>`);
  from.selectedIndex = 1; to.selectedIndex = 0;
  const bar = el(`<div class="section-title"><span>Ce qui a changé</span><span class="toolbar" style="margin:0"></span></div>`);
  $(".toolbar", bar).append(el(`<span class="muted">du</span>`), from, el(`<span class="muted">au</span>`), to);
  v.append(bar);
  const out = el(`<div class="grid-2"></div>`);
  v.append(out);
  const load = async () => {
    out.innerHTML = loading("Comparaison");
    const d = await api(`/api/history/diff?from=${from.value}&to=${to.value}`);
    out.innerHTML = "";
    if (d.none) { out.append(el(`<div class="panel muted">${esc(d.reason)}</div>`)); return; }
    const list = (title, rows, cls) => {
      const p = el(`<div class="panel"><div class="panel-title"></div></div>`);
      $(".panel-title", p).textContent = `${title} (${rows.length})`;
      p.append(table([
        { label: "Dossier", render: (r) => { const a = el(`<a href="#" class="t"></a>`); a.textContent = r.path; a.onclick = (e) => { e.preventDefault(); state.node = { path: r.path }; show("telescope"); }; return a; } },
        { label: "Avant", num: true, render: (r) => size(r.before) },
        { label: "Après", num: true, render: (r) => size(r.after) },
        { label: "Écart", num: true, render: (r) => `<span class="${cls}">${r.delta > 0 ? "+" : "−"}${size(Math.abs(r.delta))}</span>` },
      ], rows, { empty: "Rien de notable (variations de moins de 100 Mo ignorées)." }));
      return p;
    };
    out.append(list("A grossi", d.grew, "delta-up"), list("A diminué", d.shrank, "delta-down"));
  };
  from.onchange = to.onchange = load;
  load();
};

// Graphique de l'espace occupé : chaque scan est un point lumineux avec sa
// ligne verticale et sa date sur l'axe, pour voir exactement quand il a eu lieu.
function drawChart(svg, pts) {
  const box = svg.getBoundingClientRect();
  const W = box.width || 800, Hh = 220, m = { l: 62, r: 30, t: 30, b: 34 };
  const s = d3.select(svg).attr("viewBox", `0 0 ${W} ${Hh}`);
  const x = d3.scaleTime().domain(d3.extent(pts, (p) => p.at)).range([m.l, W - m.r]);
  const lo = d3.min(pts, (p) => p.used), hi = d3.max(pts, (p) => p.used);
  const pad = Math.max((hi - lo) * 0.25, 1024 ** 3);
  const y = d3.scaleLinear().domain([Math.max(0, lo - pad), hi + pad]).range([Hh - m.b, m.t]);
  const defs = s.append("defs");
  const g = defs.append("linearGradient").attr("id", "chartFill").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
  g.append("stop").attr("offset", 0).attr("stop-color", "var(--a2)").attr("stop-opacity", .35);
  g.append("stop").attr("offset", 1).attr("stop-color", "var(--a1)").attr("stop-opacity", 0);
  const fmtAxis = d3.timeFormat("%d/%m %H:%M");
  // Lignes verticales : une par scan
  s.append("g").selectAll("line").data(pts).join("line").attr("class", "scanline")
    .attr("x1", (p) => x(p.at)).attr("x2", (p) => x(p.at)).attr("y1", m.t - 8).attr("y2", Hh - m.b);
  s.append("path").attr("class", "area").attr("fill", "url(#chartFill)").attr("d", d3.area().x((p) => x(p.at)).y0(Hh - m.b).y1((p) => y(p.used))(pts));
  s.append("path").attr("class", "line").attr("d", d3.line().x((p) => x(p.at)).y((p) => y(p.used))(pts));
  // Axe : les dates exactes des scans quand ils ne sont pas trop nombreux
  const axis = d3.axisBottom(x).tickSizeOuter(0);
  if (pts.length <= 8) {
    // Deux scans rapprochés : on ne garde que les dates séparées d au moins 90 px.
    const ticks = [];
    for (const p of pts) if (!ticks.length || x(p.at) - x(ticks[ticks.length - 1]) >= 90) ticks.push(p.at);
    if (ticks[ticks.length - 1] !== pts[pts.length - 1].at && ticks.length > 1) ticks[ticks.length - 1] = pts[pts.length - 1].at;
    axis.tickValues(ticks.map((t) => new Date(t))).tickFormat(fmtAxis);
  }
  else axis.ticks(6).tickFormat(d3.timeFormat(pts[pts.length - 1].at - pts[0].at < 3 * 864e5 ? "%d/%m %Hh" : "%d/%m"));
  s.append("g").attr("class", "axis").attr("transform", `translate(0,${Hh - m.b})`).call(axis);
  s.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((v) => size(v)));
  // Points de scan, avec un halo, et la valeur du dernier
  const tip = svg.parentElement.querySelector(".chart-tip");
  const dots = s.append("g").selectAll("g").data(pts).join("g").attr("class", "scandot").attr("transform", (p) => `translate(${x(p.at)},${y(p.used)})`);
  dots.append("circle").attr("class", "halo").attr("r", 11);
  dots.append("circle").attr("class", "dot").attr("r", 5);
  dots.append("circle").attr("class", "hit").attr("r", 16);
  const last = pts[pts.length - 1];
  s.append("text").attr("class", "lastval").attr("x", x(last.at)).attr("y", y(last.used) - 16).attr("text-anchor", "end").text(`${size(last.used)} · dernier scan`);
  dots.on("mouseenter", function (ev, p) {
    d3.select(this).classed("on", true);
    svg.parentElement.classList.add("hovering");
    const i = pts.indexOf(p), prev = pts[i - 1];
    const delta = prev ? p.used - prev.used : null;
    tip.innerHTML = `<b>Scan du ${esc(dtt(p.at))}</b><br>${size(p.used)} occupés` +
      (delta != null ? `<br><span class="${delta > 0 ? "delta-up" : "delta-down"}">${delta > 0 ? "+" : "−"}${size(Math.abs(delta))}</span> depuis le scan précédent` : "<br><span class='muted'>premier scan</span>");
    const r = svg.getBoundingClientRect(), k = r.width / W;
    tip.style.left = `${Math.min(x(p.at) * k + 14, r.width - 230)}px`;
    tip.style.top = `${y(p.used) * k + 34}px`;
    tip.style.opacity = 1;
  }).on("mouseleave", function () { d3.select(this).classed("on", false); tip.style.opacity = 0; svg.parentElement.classList.remove("hovering"); });
}

// ============================================================= Recherche ===
const EXAMPLES = ["Mes vidéos de plus de 1 Go", "Les installateurs dans Téléchargements", "Les modèles d'IA pas ouverts depuis 3 mois",
  "Les images disque ISO", "Les dossiers de plus de 5 Go modifiés cette année", "Les archives zip de plus de 500 Mo"];

V.search = () => {
  const v = $("#view-search");
  if (v.dataset.ready) { $("input", v).focus(); return; }
  v.dataset.ready = "1";
  v.innerHTML = `
    <div class="search-hero">
      <h1 class="rise">Qu'est-ce que tu cherches ?</h1>
      <p class="sub rise d1" style="text-align:center">Décris ce que tu cherches avec tes mots. ${aiName()} traduit la demande en filtres, puis Sonde cherche dans le dernier scan.</p>
      <div class="search-frame rise d2"><form>
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="text" placeholder="les vidéos que je n'ai pas regardées depuis un an">
        <button class="btn primary">Chercher</button>
      </form></div>
      <div class="chips-row rise d3"></div>
    </div>
    <div class="search-results"></div>
    <p class="hint" style="text-align:center;margin-top:14px">Les fichiers de moins de 5 Mo ne sont pas indexés un par un : la recherche porte sur les dossiers et les fichiers plus gros.</p>`;
  const form = $("form", v), input = $("input", form), chips = $(".chips-row", v), out = $(".search-results", v);
  for (const ex of EXAMPLES) {
    const c = el(`<span class="chip ghost"></span>`);
    c.textContent = ex;
    c.onclick = () => { input.value = ex; form.requestSubmit(); };
    chips.append(c);
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (!state.status?.scan) return toast("Lance d'abord un scan.");
    $$(".chip.ghost", chips).forEach((c) => c.classList.toggle("on", c.textContent === q));
    const b = $("button", form);
    b.disabled = true;
    out.innerHTML = `<div class="panel">${loading(`${aiName()} interprète ta demande`)}</div>`;
    try {
      await streamApi("/api/search", { query: q }, (ev) => {
        if (ev.type === "filters") out.innerHTML = `<div class="panel tight">${filtersHtml(ev.filters, "")}${loading("Recherche dans le scan")}</div>`;
        else if (ev.type === "done") {
          out.innerHTML = `<div class="panel tight">${filtersHtml(ev.filters, `${nf0.format(ev.total)} résultat${ev.total > 1 ? "s" : ""}${ev.total > 300 ? " · 300 affichés" : ""}`)}<div class="rows"></div></div>`;
          const rows = $(".rows", out);
          for (const r of ev.results) {
            const folder = r.path.slice(0, r.path.length - r.name.length - 1);
            rows.append(rowEl(r, { sub: `${r.note ? `<span class="note">${esc(r.note)}</span> · ` : ""}${esc(short(folder))} · ${lastUse(r)}` }));
          }
          if (!ev.results.length) rows.innerHTML = `<div class="empty">Aucun résultat.</div>`;
        } else if (ev.type === "error") out.innerHTML = `<div class="panel"><div class="empty" style="color:var(--bad)">${esc(ev.error)}</div></div>`;
      });
    } catch (err) {
      out.innerHTML = `<div class="panel"><div class="empty" style="color:var(--bad)">${esc(err.message)}</div></div>`;
    }
    b.disabled = false;
  };
  input.focus();
};

function filtersHtml(f, count) {
  const parts = [];
  if (f.quoi && f.quoi !== "tout") parts.push(f.quoi);
  if (f.extensions?.length) parts.push(f.extensions.join(" "));
  if (f.nom_contient?.length) parts.push(`nom : ${f.nom_contient.join(", ")}`);
  if (f.taille_min_mo != null) parts.push(`≥ ${size(f.taille_min_mo * 1024 ** 2)}`);
  if (f.taille_max_mo != null) parts.push(`≤ ${size(f.taille_max_mo * 1024 ** 2)}`);
  if (f.modifie_avant) parts.push(`modifié avant le ${f.modifie_avant}`);
  if (f.modifie_apres) parts.push(`modifié après le ${f.modifie_apres}`);
  if (f.ouvert_avant) parts.push(`pas ouvert depuis le ${f.ouvert_avant}`);
  if (f.ouvert_apres) parts.push(`ouvert après le ${f.ouvert_apres}`);
  if (f.dans_dossier) parts.push(`dans ${f.dans_dossier}`);
  return `<div class="understood"><span>Compris :</span>${parts.map((p) => `<span class="chip">${esc(p)}</span>`).join("")}<span style="flex:1"></span><span>${esc(count || "")}</span></div>`;
}

// =============================================================== Journal ===
const UNDO_ADMIN = new Set(["service", "tasks", "dns", "eee", "autotuning", "dolan", "hibernate", "apt-reinstall", "ufw-off", "autoupdates-off", "wifips"]);

V.journal = async () => {
  const v = $("#view-journal");
  v.innerHTML = loading();
  const [entries, bin] = await Promise.all([api("/api/journal"), api("/api/bin")]);
  v.innerHTML = "";
  v.append(head("Journal", "Tout ce que Sonde a fait, du plus récent au plus ancien. Les suppressions et les réglages système peuvent être annulés."));
  v.append(table([
    { label: "Date", render: (e) => `<span class="muted">${esc(dtt(e.at))}</span>` },
    { label: "Action", render: (e) => `<div class="t">${esc(e.title)}</div>${e.detail ? `<div class="s">${esc(e.detail)}</div>` : ""}${e.items?.length ? `<div class="s">${esc(e.items.map((i) => i.path).slice(0, 3).join(" · "))}${e.items.length > 3 ? " …" : ""}</div>` : ""}` },
    { label: "", render: (e) => `<span class="tag">${e.kind === "trash" ? "fichiers" : "système"}</span>` },
    { label: "", num: true, render: (e) => (e.freed ? size(e.freed) : "") },
    { label: "", act: true, render: (e) => {
      if (e.undone) return `<span class="tag good">annulé le ${esc(dt(e.undone))}</span>`;
      if (e.kind !== "trash" && !e.revert) return "";
      return btn("Annuler", async (b) => {
        const admin = e.kind === "system" && UNDO_ADMIN.has(e.revert?.type);
        const okGo = await confirmBox({ title: "Annuler cette action ?", admin,
          body: e.kind === "trash" ? `Les éléments de « ${esc(e.title)} » seront remis à leur place depuis la corbeille.` : `Le réglage sera remis dans son état d'avant : « ${esc(e.title)} ».` });
        if (!okGo) return;
        const r = await act(b, () => api("/api/journal/undo", { id: e.id }), "…");
        if (r) {
          const bad = (r.results || []).filter((x) => !x.ok);
          toast(bad.length ? `${bad.length} élément(s) non restauré(s) : ${bad[0].reason}` : "Action annulée.", 6000);
          V.journal();
        }
      });
    } },
  ], entries, { empty: "Aucune action pour l'instant." }));

  // Corbeille
  const title = el(`<div class="section-title"><span></span><span class="toolbar" style="margin:0"></span></div>`);
  $("span", title).textContent = `Corbeille — ${bin.count} élément(s), ${size(bin.total)}${bin.bin?.capacity ? ` sur ${size(bin.bin.capacity)} maximum (disque C:)` : ""}`;
  const picked = new Set();
  $(".toolbar", title).append(
    btn("Restaurer la sélection", (b) => act(b, async () => {
      if (!picked.size) return toast("Coche d'abord des éléments.");
      const r = await api("/api/bin/restore", { keys: [...picked].map((k) => JSON.parse(k)) });
      const ok = r.results.filter((x) => x.ok).length;
      toast(`${ok} élément(s) restauré(s).${r.results.length - ok ? ` ${r.results.length - ok} échec(s) : ${r.results.find((x) => !x.ok).reason}` : ""}`, 6000);
      V.journal();
    })),
    btn("Ouvrir la Corbeille", () => openTool("recyclebin")));
  v.append(title);
  v.append(table([
    { label: "", render: (i) => { const k = JSON.stringify({ id: i.id, bin: i.bin }); const c = el(`<button class="check"></button>`); c.onclick = () => { c.classList.toggle("on"); c.classList.contains("on") ? picked.add(k) : picked.delete(k); }; return c; } },
    { label: "Élément", render: (i) => `<div class="t">${i.isDir ? "📁 " : ""}${esc(i.name)}</div><div class="s">${esc(i.original.slice(0, i.original.length - i.name.length - 1))}</div>` },
    { label: "Taille", num: true, render: (i) => size(i.size) },
    { label: "Supprimé", render: (i) => `<span class="muted">${esc(ago(i.deleted))}</span>` },
  ], bin.items, { empty: "La corbeille est vide." }));
};

// ================================================= Programmes installés ===
// Icône du programme, ou son initiale sur une pastille de couleur stable.
function appIcon(a) {
  const letter = esc((a.name.match(/[\p{L}\p{N}]/u) || ["?"])[0].toUpperCase());
  let h = 0;
  for (const ch of a.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const fallback = `<span class="app-ico letter" style="background:hsl(${h} 45% 38%)">${letter}</span>`;
  if (!a.icon) return fallback;
  // Si l'image ne charge pas, on retombe sur l'initiale.
  return `<img class="app-ico" src="${esc(a.icon)}" alt="" loading="lazy" onerror="this.outerHTML=this.dataset.fb" data-fb="${esc(fallback)}">`;
}
V.apps = async (refresh = false) => {
  const v = $("#view-apps");
  v.innerHTML = loading("Lecture des programmes installés");
  let apps;
  try { apps = await api("/api/apps" + (refresh ? "?refresh=1" : "")); }
  catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const q = el(`<input type="search" placeholder="Filtrer par nom ou éditeur">`);
  // Familles de programmes présentes sur ce PC.
  const KINDS = { win32: "Programmes", store: "Microsoft Store", app: "Applications", flatpak: "Flatpak", snap: "Snap", pkg: "Gros paquets", local: "Lanceurs locaux" };
  const present = [...new Set(apps.map((a) => a.kind))].filter((k) => KINDS[k]);
  const kind = el(`<select><option value="">Tous</option>${present.map((k) => `<option value="${k}">${KINDS[k]}</option>`).join("")}</select>`);
  const sort = el(`<select><option value="size">Plus gros d'abord</option><option value="name">Nom</option><option value="used">Moins utilisés d'abord</option><option value="installed">Plus récents d'abord</option></select>`);
  v.append(head("Programmes installés", isLinux()
    ? `${apps.length} programmes : applications, Flatpak, et gros paquets installés à la main. La désinstallation passe par apt ou Flatpak, avec ton mot de passe, et s'annule depuis le journal.`
    : `${apps.length} programmes. La taille et la dernière utilisation viennent du scan quand le dossier du programme y figure. La désinstallation lance le désinstalleur officiel du programme.`,
    q, kind, sort, btn("Actualiser", () => V.apps(true))));
  const leftovers = el(`<div></div>`), box = el(`<div></div>`);
  v.append(leftovers, box);
  const pending = new Set();   // programmes dont on a lancé la désinstallation

  const render = () => {
    const f = q.value.toLowerCase();
    let rows = apps.filter((a) => (!kind.value || a.kind === kind.value) && (!f || (a.name + " " + a.publisher).toLowerCase().includes(f)));
    const by = { size: (a, b) => b.size - a.size, name: (a, b) => a.name.localeCompare(b.name, "fr"),
      used: (a, b) => (a.lastUsed || 9e15) - (b.lastUsed || 9e15), installed: (a, b) => (b.installed || 0) - (a.installed || 0) }[sort.value];
    rows = [...rows].sort(by);
    box.innerHTML = "";
    box.append(table([
      { label: "Programme", render: (a) => `<div class="app-cell">${appIcon(a)}<div class="app-txt"><div class="t">${esc(a.name)}</div><div class="s">${esc([a.publisher, a.version].filter(Boolean).join(" · "))}${a.kind !== "win32" && a.kind !== "app" && KINDS[a.kind] ? " · " + KINDS[a.kind] : ""}</div></div></div>` },
      { label: "Taille", num: true, render: (a) => (a.size ? `${size(a.size)}${a.sizeSource === "registre" ? `<div class="s">estimée</div>` : ""}` : `<span class="muted">?</span>`) },
      { label: "Installé", render: (a) => `<span class="muted">${esc(dt(a.installed))}</span>` },
      { label: "Dernière utilisation", render: (a) => (a.lastUsed ? esc(ago(a.lastUsed)) : `<span class="muted">?</span>`) },
      { label: "", act: true, render: (a) => group(
        iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("app", { nom: a.name, editeur: a.publisher, version: a.version, taille: size(a.size), dossier: a.location, derniere_utilisation: a.lastUsed ? dt(a.lastUsed) : "inconnue" }, a.name)),
        pending.has(a.key)
          ? btn("Chercher les restes", (b) => findLeftovers(a, b))
          : a.canUninstall ? btn("Désinstaller", async (b) => {
            if (isLinux()) return uninstallLinux(a, b);
            const okGo = await confirmBox({ title: `Désinstaller ${a.name} ?`, ok: "Désinstaller", danger: true,
              body: a.kind === "store"
                ? "L'application du Microsoft Store sera supprimée immédiatement. Tu pourras la réinstaller depuis le Store."
                : `Le désinstalleur officiel de <b>${esc(a.name)}</b> va s'ouvrir : suis ses étapes. Ensuite, reviens ici et clique sur « Chercher les restes » pour retrouver ce qu'il a laissé dans AppData.` });
            if (!okGo) return;
            const r = await act(b, () => api("/api/apps/uninstall", { key: a.key }), "…");
            if (r) { toast(a.kind === "store" ? `${a.name} désinstallé.` : "Désinstalleur lancé : suis ses instructions.", 6000); pending.add(a.key); render(); }
          }) : null) },
    ], rows, { empty: "Aucun programme ne correspond." }));
  };

  // Debian : aperçu de ce qu'apt retirerait, puis désinstallation directe
  // (pas d'assistant à suivre comme sous Windows).
  async function uninstallLinux(a, b) {
    const pv = await act(b, () => api("/api/apps/uninstall-preview", { key: a.key }), "…");
    if (!pv) return;
    if (pv.blocked) return toast(`Refusé : désinstaller ${a.name} retirerait aussi ${pv.breaks.join(", ")}, indispensable au bureau.`, 8000);
    const list = pv.removes.length > 1 ? `<p>apt retirera aussi ${pv.removes.length - 1} paquet(s) qui en dépendent :</p><ul>${pv.removes.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
    const okGo = await confirmBox({ title: `Désinstaller ${a.name} ?`, ok: "Désinstaller", danger: true, admin: pv.kind !== "flatpak" || pv.installation !== "user",
      body: `${list}<p>Tes fichiers personnels ne sont pas touchés. Ensuite, « Chercher les restes » retrouve les réglages et caches laissés dans ton dossier personnel.</p>` });
    if (!okGo) return;
    const r = await act(b, () => api("/api/apps/uninstall", { key: a.key }), "Désinstallation…");
    if (r) { toast(`${a.name} désinstallé. Annulable depuis le journal.`, 6000); pending.add(a.key); render(); }
  }

  async function findLeftovers(a, b) {
    const r = await act(b, () => api("/api/apps/leftovers", { name: a.name, publisher: a.publisher, key: a.key }), "…");
    if (!r) return;
    if (r.stillInstalled) return toast(`${a.name} est encore installé : termine d'abord la désinstallation.`, 6000);
    leftovers.innerHTML = "";
    const p = el(`<div class="panel" style="margin-bottom:16px"><div class="panel-title"></div><div class="hint">Dossiers au nom du programme dans ${isLinux() ? "~/.config, ~/.local/share, ~/.cache et ~/.var/app" : "AppData et ProgramData"}. Vérifie-les, coche ceux à supprimer, puis utilise le bouton « Supprimer » en bas (corbeille).</div><div class="rows flat"></div></div>`);
    $(".panel-title", p).textContent = `Restes de ${a.name} (${r.items.length})`;
    for (const it of r.items) $(".rows", p).append(rowEl(it, { sub: `${esc(it.path)} · ${lastUse(it)}` }));
    if (!r.items.length) $(".rows", p).innerHTML = `<div class="empty">Aucun reste trouvé dans le dernier scan.</div>`;
    leftovers.append(p);
    pending.delete(a.key);
    apps = apps.filter((x) => x.key !== a.key);
    render();
  }

  q.oninput = kind.onchange = sort.onchange = render;
  render();
};

// ===================================================== Logiciels actifs ===
V.active = async (tab = 0) => {
  const v = $("#view-active");
  v.innerHTML = "";
  v.append(head("Logiciels actifs", isLinux()
    ? "Ce qui tourne en ce moment et ce qui se lance à l'ouverture de ta session. « Tiers » = ni le système ni le bureau GNOME."
    : "Ce qui tourne en ce moment et ce qui se lance avec Windows. « Tiers » = ni Windows ni Microsoft."));
  const body = el(`<div></div>`);
  // Debian : un troisième onglet pour le temps de démarrage (systemd-analyze).
  const pages = [renderProcs, renderStartup, ...(isLinux() ? [renderBoot] : [])];
  v.append(tabs(["En cours", "Au démarrage", ...(isLinux() ? ["Temps de démarrage"] : [])], (i) => pages[i](body), tab), body);
  (pages[tab] || renderProcs)(body);
};

// Temps de démarrage (Debian) : étapes et services les plus lents.
async function renderBoot(body) {
  body.innerHTML = loading("Analyse du démarrage");
  let d;
  try { d = await api("/api/boot"); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  body.innerHTML = "";
  if (!d.available) { body.append(el(`<div class="panel muted">systemd-analyze n'a rien renvoyé : le démarrage n'est peut-être pas encore terminé. Réessaie dans une minute.</div>`)); return; }
  const s = (n) => (!n ? "–" : n < 1000 ? `${n} ms` : `${nf1.format(n / 1000)} s`);
  const ph = d.phases;
  body.append(el(`<div class="kpis">
    <div class="kpi ${d.total > 60000 ? "warn" : "good"}"><div class="k">Démarrage complet</div><div class="v">${s(d.total)}</div><div class="d">${d.graphical ? `écran de connexion après ${s(d.graphical + (ph.kernel || 0) + (ph.initrd || 0))}` : ""}</div></div>
    <div class="kpi"><div class="k">Micrologiciel et chargeur</div><div class="v">${s((ph.firmware || 0) + (ph.loader || 0))}</div><div class="d">BIOS/UEFI et GRUB, avant Linux</div></div>
    <div class="kpi"><div class="k">Noyau</div><div class="v">${s((ph.kernel || 0) + (ph.initrd || 0))}</div><div class="d">démarrage de Linux</div></div>
    <div class="kpi"><div class="k">Services</div><div class="v">${s(ph.userspace)}</div><div class="d">systemd, jusqu'à la fin</div></div></div>`));
  body.append(bar(14, btn(`Analyse par ${aiName()}`, () => askAI("boot", { etapes_ms: ph, total_ms: d.total, plus_lents: d.blame.map((b) => ({ service: b.unit, ms: b.ms })) }, "Temps de démarrage"))));
  body.append(el(`<div class="section-title">Les plus lents</div>`));
  body.append(el(`<p class="hint">Les services démarrent en parallèle : leurs durées se chevauchent, et leur addition dépasse le temps total. Un service lent ne retarde pas forcément l'arrivée du bureau.</p>`));
  const max = Math.max(...d.blame.map((b) => b.ms), 1);
  body.append(table([
    { label: "Service", render: (b) => `<div class="t">${esc(b.name)}</div>${b.why ? `<div class="s">${esc(b.why)}</div>` : ""}` },
    { label: "Durée", render: (b) => `<div class="bars solo" style="min-width:180px"><div class="b"><div class="track"><span style="width:${(b.ms / max) * 100}%"></span></div><b>${s(b.ms)}</b></div></div>` },
    { label: "", act: true, render: (b) => group(
      b.action ? btn(`Passer « ${MODE_FR[b.action]} »`, async (x) => {
        if (!await confirmBox({ title: `${b.name} → ${MODE_FR[b.action]} ?`, admin: true, body: esc(b.why) })) return;
        const ok = await act(x, async () => { await api("/api/services"); return api("/api/services/set", { changes: [{ name: b.name, mode: b.action }] }); }, "En attente de l'autorisation…");
        if (ok) { toast("Fait. Effet au prochain démarrage ; annulable depuis le journal.", 6000); renderBoot(body); }
      }) : null,
      iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("service", { nom: b.unit, duree_au_demarrage: s(b.ms), fiche_sonde: b.why }, b.name))) },
  ], d.blame, { empty: "Aucun service mesuré." }));
}

async function renderProcs(body) {
  body.innerHTML = loading("Mesure des processus (1 seconde)");
  let d;
  try { d = await api("/api/processes"); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  body.innerHTML = "";
  const tiers = d.list.filter((g) => g.cls === "tiers");
  body.append(el(`<div class="kpis">
    <div class="kpi"><div class="k">Processus</div><div class="v">${d.count}</div><div class="d">${d.list.length} programmes</div></div>
    <div class="kpi"><div class="k">Mémoire des programmes tiers</div><div class="v">${size(d.totals.tiers)}</div><div class="d">${tiers.length} programmes</div></div>
    <div class="kpi"><div class="k">${isLinux() ? "Mémoire du système" : "Mémoire de Windows"}</div><div class="v">${size(d.totals.windows)}</div></div>
    <div class="kpi"><div class="k">${isLinux() ? "Mémoire du bureau GNOME" : "Mémoire des applis Microsoft"}</div><div class="v">${size(d.totals.microsoft)}</div></div></div>`));
  const hideWin = el(`<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" checked> Masquer les processus ${isLinux() ? "du système" : "de Windows"}</label>`);
  const bar = el(`<div class="toolbar"></div>`);
  bar.append(hideWin, btn("Actualiser", () => renderProcs(body)), btn(OS.taskmgr, () => openTool("taskmgr")));
  const box = el(`<div></div>`);
  body.append(bar, box);
  const render = () => {
    const rows = d.list.filter((g) => !$("input", hideWin).checked || g.cls !== "windows");
    box.innerHTML = "";
    box.append(table([
      { label: "Programme", render: (g) => `<div class="t">${esc(g.product || g.name)}</div><div class="s">${esc(g.name)}${isLinux() ? "" : ".exe"}${g.count > 1 ? ` ×${g.count}` : ""}${g.company ? " · " + esc(g.company) : ""}${g.services.length ? " · services : " + esc(g.services.slice(0, 4).join(", ")) : ""}</div>` },
      { label: "", render: (g) => `<span class="tag ${g.cls}">${g.cls === "tiers" ? "tiers" : g.cls === "microsoft" ? (isLinux() ? "bureau" : "Microsoft") : (isLinux() ? "système" : "Windows")}</span>` },
      { label: "Mémoire", num: true, render: (g) => size(g.mem) },
      { label: "Processeur", num: true, render: (g) => `${nf1.format(g.cpu)} %` },
      { label: "Connexions", num: true, render: (g) => (g.conn ? g.conn : `<span class="muted">0</span>`) },
      { label: "", act: true, render: (g) => group(
        iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("process", { nom: g.name, produit: g.product, editeur: g.company, chemin: g.path, processus: g.count, memoire: size(g.mem), connexions: g.conn, services: g.services }, g.product || g.name)),
        g.canStop ? btn("Fermer", async (b) => {
          if (!await confirmBox({ title: `Fermer ${g.product || g.name} ?`, ok: "Fermer", danger: true,
            body: `Les ${g.count} processus de ce programme seront arrêtés. Un travail non enregistré dans ce programme serait perdu.` })) return;
          if (await act(b, () => api("/api/processes/stop", { name: g.name }), "…")) { toast("Programme fermé."); renderProcs(body); }
        }) : null) },
    ], rows));
  };
  $("input", hideWin).onchange = render;
  render();
}

async function renderStartup(body) {
  body.innerHTML = loading();
  let list;
  try { list = await api("/api/startup"); } catch (e) { body.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  body.innerHTML = "";
  body.append(el(`<p class="hint">${isLinux()
    ? "Programmes lancés à l'ouverture de ta session (comme dans l'outil Applications au démarrage de GNOME). Désactiver n'efface rien et ne concerne que ton compte : aucun mot de passe demandé."
    : "Même réglage que l'onglet Démarrage du Gestionnaire des tâches. Désactiver n'efface rien : le programme ne se lance simplement plus tout seul. Les entrées « machine » demandent les droits administrateur."}</p>`));
  body.append(table([
    { label: "", render: (s) => switchEl(s.enabled, async (on, sw) => {
      if (s.scope === "machine" && !isLinux() && !await confirmBox({ title: `${on ? "Activer" : "Désactiver"} ${s.name} au démarrage ?`, admin: true, body: "Cette entrée concerne tous les utilisateurs du PC." })) return;
      sw.disabled = true;
      const r = await act(null, () => api("/api/startup/set", { id: s.id, enable: on }));
      sw.disabled = false;
      if (r) { s.enabled = on; sw.classList.toggle("on", on); toast(`${s.name} ${on ? "activé" : "désactivé"} au démarrage.`); }
    }) },
    { label: "Programme", render: (s) => `<div class="t">${esc(s.name)}</div><div class="s">${esc(s.command)}</div>` },
    { label: "", render: (s) => (s.scope === "machine" ? (isLinux() ? `<span class="tag">système</span>` : `<span class="tag admin">machine</span>`) : `<span class="tag">utilisateur</span>`) },
    { label: "", act: true, render: (s) => iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("startup", { nom: s.name, commande: s.command, portee: s.scope }, s.name)) },
  ], list, { empty: "Rien ne se lance au démarrage." }));
}

// ============================================== Services et vie privée ===
V.services = async (tab = 0) => {
  const v = $("#view-services");
  v.innerHTML = loading("Lecture des services");
  let d;
  try { d = await api("/api/services"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const running = d.services.filter((s) => s.state === "Running");
  const toAdjust = d.services.filter((s) => s.advice).length;
  v.append(head("Services et vie privée", isLinux()
    ? "Services systemd : Sonde signale ceux qui ne servent pas sur un PC personnel ou qui ouvrent ton PC au réseau. Tout est annulable depuis le journal."
    : "Sonde signale les services qui envoient des données à Microsoft ou qui ne servent pas sur un PC personnel. Tout est annulable depuis le journal.",
    btn(`Demander à ${aiName()}`, () => askAI("services", running.filter((s) => s.mem > 20 * 1024 ** 2 || s.conn).slice(0, 30)
      .map((s) => ({ nom: s.name, affiche: s.display, memoire: size(s.mem), processus_partage: s.shared, connexions: s.conn, demarrage: s.mode, windows: s.windows })), "Services gourmands")),
    isLinux() ? null : btn("services.msc", () => openTool("services"))));
  v.append(el(`<div class="stats">
    <div class="stat"><b>${d.services.length}</b><span>services installés</span></div>
    <div class="stat"><b>${running.length}</b><span>démarrés en ce moment</span></div>
    <div class="stat glow"><b>${toAdjust}</b><span>à ajuster</span></div></div>`));
  const body = el(`<div></div>`);
  const pages = [() => renderSvcReco(body, d), () => renderSvcAll(body, d), () => renderPrivacy(body, d)];
  v.append(tabs(["Recommandations", "Tous les services", "Confidentialité"], (i) => pages[i](), tab), body);
  pages[tab]();
};

const MODE_WIN = { Automatic: "Automatique", Manual: "Manuel", Disabled: "Désactivé", Boot: "Démarrage", System: "Système" };
// systemd : enabled / disabled / masked.
const MODE_LINUX = { Automatic: "Au démarrage", Manual: "À la demande", Disabled: "Bloqué", Boot: "Système", System: "Système" };
const MODE_FR = new Proxy({}, { get: (_, k) => (isLinux() ? MODE_LINUX : MODE_WIN)[k] });

function renderSvcReco(body, d) {
  body.innerHTML = "";
  const recos = d.services.filter((s) => s.advice);
  // Interrupteur allumé = le changement conseillé sera appliqué.
  const picked = new Set(recos.filter((s) => s.kb.risk === "faible").map((s) => s.name));
  const list = el(`<div class="opt-list"></div>`);
  const applyBtn = btn("", async (b) => {
    const changes = recos.filter((s) => picked.has(s.name)).map((s) => ({ name: s.name, mode: s.advice }));
    if (!changes.length) return toast("Allume au moins un interrupteur.");
    if (!await confirmBox({ title: `Modifier ${changes.length} service(s) ?`, admin: true,
      body: `<ul>${changes.map((c) => `<li>${esc(d.services.find((s) => s.name === c.name).display)} → ${esc(MODE_FR[c.mode])}</li>`).join("")}</ul>` })) return;
    if (await act(b, () => api("/api/services/set", { changes }), "En attente de l'autorisation…")) { toast("Services modifiés. Annulable depuis le journal.", 6000); V.services(0); }
  }, "primary");
  const label = () => { const n = picked.size; applyBtn.textContent = n ? `Appliquer ${n} changement${n > 1 ? "s" : ""}` : "Rien à appliquer"; applyBtn.disabled = !n; };
  for (const s of recos) {
    const o = el(`<div class="opt"><div style="min-width:0"><div class="on-name"></div><div class="on-why"></div></div><div class="fromto"></div></div>`);
    $(".on-name", o).innerHTML = `${esc(s.display)}<small>${esc(s.name)}</small> <span class="tag ${s.kb.risk === "faible" ? "good" : "warn"}">risque ${esc(s.kb.risk)}</span>`;
    $(".on-why", o).innerHTML = `${esc(s.kb.what)} Ce que tu perds : ${esc(s.kb.lose)}${s.state === "Running" && s.mem ? ` · utilise ${size(s.mem)}` : ""}`;
    $(".fromto", o).innerHTML = `<s>${esc(MODE_FR[s.mode])}</s><i>→</i><b>${esc(MODE_FR[s.advice])}</b>`;
    const sw = switchEl(picked.has(s.name), (on) => { on ? picked.add(s.name) : picked.delete(s.name); sw.classList.toggle("on", on); label(); });
    o.append(sw);
    o.onclick = () => sw.click();
    list.append(o);
  }
  if (!recos.length) list.append(el(`<div class="empty">Tout est déjà réglé comme conseillé.</div>`));
  body.append(list);
  if (recos.length) {
    label();
    body.append(bar(12, applyBtn));
  }
  // Tâches planifiées de télémétrie (Windows) / popularity-contest (Debian)
  const ready = d.tasks.filter((t) => t.state !== "Disabled");
  if (isLinux() && !d.tasks.length) return;
  body.append(el(`<div class="section-title">${isLinux() ? "Statistiques envoyées à Debian" : "Tâches planifiées de télémétrie"}</div>`));
  body.append(table([
    { label: "Tâche", render: (t) => `<div class="t">${esc(t.name)}</div><div class="s">${esc(t.what)}</div>` },
    { label: "État", render: (t) => `<span class="tag ${t.state === "Disabled" ? "good" : "warn"}">${t.state === "Disabled" ? "désactivée" : "active"}</span>` },
  ], d.tasks, { empty: "Aucune tâche connue sur ce PC." }));
  if (ready.length) {
    body.append(bar(12, btn(isLinux() ? "Ne plus envoyer ces statistiques" : `Désactiver ces ${ready.length} tâches`, async (b) => {
      if (!await confirmBox({ title: isLinux() ? "Arrêter popularity-contest ?" : "Désactiver les tâches de télémétrie ?", admin: true, body: isLinux() ? "Debian ne recevra plus la liste de tes paquets. Aucun effet sur le fonctionnement du système." : "Elles collectent des données d'usage et de compatibilité pour Microsoft. Les désactiver n'a aucun effet sur le fonctionnement de Windows." })) return;
      if (await act(b, () => api("/api/tasks/set", { names: ready.map((t) => t.name), enable: false }), "En attente de l'autorisation…")) { toast("Tâches désactivées."); V.services(0); }
    })));
  }
  if (!isLinux()) body.append(el(`<p class="hint" style="margin-top:14px">Niveau de télémétrie imposé par stratégie : ${d.telemetryPolicy == null ? "aucun (réglage de Windows par défaut)" : esc(String(d.telemetryPolicy))}. Sur Windows Famille, le minimum possible est « données de diagnostic requises ».</p>`));
}

function renderSvcAll(body, d) {
  body.innerHTML = "";
  const q = el(`<input type="search" placeholder="Filtrer">`);
  const only = el(`<select><option value="run">Démarrés</option><option value="tiers">Tiers seulement</option><option value="">Tous</option></select>`);
  const bar = el(`<div class="toolbar"></div>`);
  bar.append(q, only);
  const box = el(`<div></div>`);
  body.append(bar, box, el(`<p class="hint">${isLinux() ? "« Bloqué » = masqué : le service ne peut plus démarrer, même à la demande d'un autre. « Debian » = livré par un paquet ; « ajouté » = installé à la main ou par un programme." : "Sous Windows 11, chaque service a souvent son propre processus ; quand plusieurs partagent le même, la mémoire indiquée est celle du groupe."}</p>`));
  const render = () => {
    const f = q.value.toLowerCase();
    const rows = d.services.filter((s) => (only.value !== "run" || s.state === "Running") && (only.value !== "tiers" || !s.windows)
      && (!f || (s.name + " " + s.display).toLowerCase().includes(f)));
    box.innerHTML = "";
    box.append(table([
      { label: "Service", render: (s) => `<div class="t">${esc(s.display)}</div><div class="s">${esc(s.name)}${s.kb ? " · " + esc(s.kb.what) : ""}</div>` },
      { label: "", render: (s) => `<span class="tag ${s.windows ? "windows" : "tiers"}">${s.windows ? (isLinux() ? "Debian" : "Windows") : (isLinux() ? "ajouté" : "tiers")}</span>` },
      { label: "État", render: (s) => (s.state === "Running" ? `<span class="tag good">démarré</span>` : `<span class="tag">arrêté</span>`) },
      { label: "Mémoire", num: true, render: (s) => (s.mem ? size(s.mem) + (s.shared > 1 ? ` <span class="muted">(×${s.shared})</span>` : "") : "") },
      { label: "Connexions", num: true, render: (s) => s.conn || "" },
      { label: "Démarrage", render: (s) => {
        if (s.mode === "Boot" || s.mode === "System") return `<span class="muted">${MODE_FR[s.mode]}</span>`;
        const sel = el(`<select>${["Automatic", "Manual", "Disabled"].map((m) => `<option value="${m}" ${m === s.mode ? "selected" : ""}>${MODE_FR[m]}</option>`).join("")}</select>`);
        sel.onchange = async () => {
          const mode = sel.value;
          if (!await confirmBox({ title: `${s.display} → ${MODE_FR[mode]} ?`, admin: true, danger: mode === "Disabled" && !s.kb,
            body: s.kb ? `${esc(s.kb.what)} <b>Ce que tu perds :</b> ${esc(s.kb.lose)}` : `Sonde ne connaît pas ce service. En cas de doute, demande d'abord à ${aiName()} avec le bouton « ? ».` })) { sel.value = s.mode; return; }
          if (await act(null, () => api("/api/services/set", { changes: [{ name: s.name, mode }] }))) { s.mode = mode; toast("Service modifié. Annulable depuis le journal."); }
          else sel.value = s.mode;
        };
        return sel;
      } },
      { label: "", act: true, render: (s) => iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("service", { nom: s.name, affiche: s.display, description: s.desc, etat: s.state, demarrage: s.mode, memoire: size(s.mem), windows: s.windows, fiche_sonde: s.kb ? { role: s.kb.what, si_desactive: s.kb.lose, risque: s.kb.risk, conseil: s.kb.reco } : null }, s.display)) },
    ], rows));
  };
  q.oninput = only.onchange = render;
  render();
}

function renderPrivacy(body, d) {
  body.innerHTML = "";
  body.append(el(`<p class="hint">${isLinux() ? "Réglages de confidentialité de GNOME pour ton compte, sans mot de passe. Désactivé = moins de traces et rien d'envoyé." : "Réglages de ton compte, sans droits administrateur. Désactivé = moins de suivi et de publicités."}</p>`));
  const cards = el(`<div class="cards"></div>`);
  for (const p of d.privacy) {
    const c = el(`<div class="card"><div class="body"><div class="title"></div><div class="why"></div></div></div>`);
    $(".title", c).textContent = p.label;
    $(".why", c).textContent = p.desc;
    c.prepend(switchEl(p.on, async (on, sw) => {
      if (await act(null, () => api("/api/privacy/set", { ids: [p.id], on }))) { p.on = on; sw.classList.toggle("on", on); toast(`${p.label} : ${on ? "activé" : "désactivé"}.`); }
    }));
    cards.append(c);
  }
  body.append(cards);
  const allOff = d.privacy.filter((p) => p.on);
  if (allOff.length) body.append(bar(12, btn(`Tout désactiver (${allOff.length})`, async (b) => {
    if (await act(b, () => api("/api/privacy/set", { ids: allOff.map((p) => p.id), on: false }))) { toast("Réglages désactivés. Annulable depuis le journal."); V.services(2); }
  }, "primary")));
  body.append(bar(12, btn(isLinux() ? "Paramètres de confidentialité" : "Paramètres de confidentialité de Windows", () => openTool("privacy"))));
}

// =============================================================== Pilotes ===
V.drivers = async () => {
  const v = $("#view-drivers");
  v.innerHTML = loading("Lecture des pilotes");
  let d;
  try { d = await api("/api/drivers"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  v.append(isLinux()
    ? head("Pilotes", "Sous Linux, les pilotes viennent avec le noyau. Sonde vérifie les périphériques sans pilote, les firmwares manquants et les mises à jour du noyau, de Mesa et des firmwares.",
      btn("À propos de ce PC", () => openTool("devmgmt")), btn("Logiciels", () => openTool("driverupdates")))
    : head("Pilotes", "Périphériques en erreur, pilotes importants et mises à jour proposées par Windows Update.",
      btn("Gestionnaire de périphériques", () => openTool("devmgmt")), btn("Mises à jour facultatives", () => openTool("driverupdates"))));

  v.append(el(`<div class="section-title">${isLinux() ? "Problèmes de pilotes et de firmware" : "Périphériques en erreur"} (${d.errors.length})</div>`));
  const cards = el(`<div class="cards"></div>`);
  for (const e of d.errors) {
    const c = el(`<div class="card"><div class="body"><div class="title"></div><div class="why"></div></div></div>`);
    $(".title", c).innerHTML = `${esc(e.name || "Périphérique inconnu")} <span class="tag bad">${esc(e.meaning)}</span> <span class="tag">${esc(e.cls)}</span>`;
    $(".why", c).textContent = e.hint || (e.code === 28 ? "Aucun pilote : Windows Update ou le site du fabricant peuvent le fournir." : "Le pilote est installé mais ne fonctionne pas correctement.");
    // Debian : le paquet qui manque s'installe d'ici (liste fermée côté serveur).
    if (e.pkg) c.append(btn(`Installer ${e.pkg}`, async (b) => {
      if (!await confirmBox({ title: `Installer ${e.pkg} ?`, admin: true, body: "Le paquet vient du dépôt non-free-firmware de Debian. Redémarre ensuite pour en profiter." })) return;
      if (await act(b, () => api("/api/drivers/install", { pkg: e.pkg }), "Installation…")) { toast(`${e.pkg} installé. Redémarre pour l'utiliser.`, 7000); V.drivers(); }
    }, "primary"));
    c.append(iconBtn("?", `Que faire ? (${aiName()})`, () => askAI("driver", e, e.name)));
    cards.append(c);
  }
  if (!d.errors.length) cards.append(el(`<div class="panel muted">✓ ${isLinux() ? "Aucun périphérique sans pilote ni firmware manquant." : "Aucun périphérique en erreur."}</div>`));
  if (isLinux() && d.logReadable === false) cards.append(el(`<p class="hint">Le journal du noyau n'est pas lisible par ton compte : les firmwares manquants ne peuvent pas être détectés (ajoute ton compte au groupe « adm »).</p>`));
  v.append(cards);
  if (isLinux()) linuxHardware(v, d);

  const upTitle = el(`<div class="section-title"><span>${isLinux() ? "Mises à jour du noyau et des firmwares" : "Mises à jour de pilotes (Windows Update)"}</span><span class="toolbar" style="margin:0"></span></div>`);
  const upBox = el(`<div></div>`);
  const showUpdates = (u) => {
    upBox.innerHTML = "";
    if (!u) { upBox.append(el(`<div class="panel muted">${isLinux() ? "La recherche prend quelques secondes." : "La recherche prend 15 à 30 secondes."}</div>`)); return; }
    upBox.append(table([
      { label: "Mise à jour", render: (x) => `<div class="t">${esc(x.title)}</div><div class="s">${esc([x.maker, x.model].filter(Boolean).join(" · "))}</div>` },
      { label: "Publiée", render: (x) => `<span class="muted">${esc(x.date || "")}</span>` },
      { label: "Taille", num: true, render: (x) => (x.size ? size(x.size) : "") },
    ], u.items, { empty: isLinux() ? "✓ Aucune mise à jour du noyau, de Mesa ou des firmwares en attente." : "✓ Windows Update ne propose aucun nouveau pilote." }));
    if (u.items.length) upBox.append(el(`<p class="hint" style="margin-top:10px">${isLinux() ? "Pour les installer : Logiciels > Mises à jour (bouton en haut), ou « sudo apt upgrade »." : "Pour les installer : Paramètres > Windows Update > Options avancées > Mises à jour facultatives (bouton en haut)."}</p>`));
  };
  $(".toolbar", upTitle).append(btn(d.updates ? "Relancer la recherche" : "Chercher", (b) => act(b, async () => showUpdates(await api("/api/drivers/updates", { force: true })), "Recherche…")));
  v.append(upTitle, upBox);
  showUpdates(d.updates);

  v.append(el(`<div class="section-title">Pilotes importants</div>`));
  v.append(el(`<p class="hint">${isLinux() ? "La date est celle du noyau en cours : les pilotes évoluent avec lui. Pour les cartes AMD et Intel, c'est la version de Mesa qui compte pour les jeux." : "Les pilotes intégrés à Windows sont masqués : leur date de 2006 est factice. « Ancien » = plus de 2 ans, ce qui n'est un problème que s'il y a un souci avec le périphérique."}</p>`));
  v.append(table([
    { label: "", render: (x) => `<span class="tag">${esc(x.family)}</span>` },
    { label: "Périphérique", render: (x) => `<div class="t">${esc(x.name)}</div><div class="s">${esc(x.maker || "")}</div>` },
    { label: "Version", render: (x) => `<span class="muted">${esc(x.version || "")}</span>` },
    { label: "Date", render: (x) => `${esc(x.date || "")} ${x.old ? `<span class="tag warn">ancien</span>` : ""}` },
    { label: "", act: true, render: (x) => group(
      !isLinux() && x.cls === "DISPLAY" && /AMD|Advanced Micro/i.test(x.maker) ? btn("Site AMD", () => openTool("amd")) : null,
      isLinux() && x.cls === "DISPLAY" && /nvidia/i.test(x.maker) ? btn("Pilote NVIDIA sous Debian", () => openTool("nvidia")) : null,
      iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("driver", x, x.name))) },
  ], d.drivers));
};

// Debian : pilote graphique pour jouer, santé des disques, batterie.
function linuxHardware(v, d) {
  if (d.gpuAssist?.length) {
    v.append(el(`<div class="section-title">Pilote graphique pour jouer</div>`));
    const cards = el(`<div class="cards"></div>`);
    for (const g of d.gpuAssist) {
      const c = el(`<div class="card ${g.action ? "" : "info"}"><div class="body"><div class="title"></div><div class="why"></div></div></div>`);
      $(".title", c).innerHTML = `${esc(g.title)} <span class="tag ${g.ok ? "good" : g.action ? "warn" : ""}">${esc(g.tag)}</span>`;
      $(".why", c).textContent = g.why + (g.note ? ` ${g.note}` : "");
      if (g.action) c.append(btn(g.action.label, async (b) => {
        if (!await confirmBox({ title: `${g.action.label} ?`, admin: true, ok: g.action.label,
          body: `<p>${esc(g.why)}</p>${g.note ? `<p>${esc(g.note)}</p>` : ""}<p>Annulable depuis le journal.</p>` })) return;
        const r = await act(b, () => api("/api/drivers/gpu", { id: g.action.id }), "Installation… (plusieurs minutes)");
        if (!r) return;
        toast(r.unchanged ? "Pas de version plus récente dans les rétroportages : rien n'a changé." : r.reboot ? "Installé. Redémarre pour utiliser le nouveau pilote." : "Fait. Annulable depuis le journal.", 8000);
        V.drivers();
      }, "primary"));
      cards.append(c);
    }
    v.append(cards);
  }

  // Santé des disques (SMART, lu par udisks2 comme l'outil Disques de GNOME).
  if (d.disks) {
    v.append(el(`<div class="section-title">Santé des disques</div>`));
    const ST = { good: ["bon état", "good"], warn: ["à surveiller", "warn"], bad: ["à remplacer", "bad"], unknown: ["Non disponible", ""] };
    v.append(table([
      { label: "Disque", render: (x) => `<div class="t">${esc(x.model)}</div><div class="s">${esc([x.kind, x.size ? size(x.size) : null].filter(Boolean).join(" · "))}</div>` },
      { label: "État", render: (x) => `<span class="tag ${ST[x.state][1]}">${ST[x.state][0]}</span>${x.notes.length ? `<div class="s">${esc(x.notes.join(" · "))}</div>` : ""}` },
      { label: "Température", num: true, render: (x) => (x.temp != null ? `${x.temp} °C` : "–") },
      { label: "En marche", num: true, render: (x) => (x.hours != null ? `${nf0.format(x.hours)} h` : "–") },
      { label: "Usure", num: true, render: (x) => (x.wear != null ? `${x.wear} %` : "–") },
    ], d.disks, { empty: "Aucun disque ne donne son état de santé (SMART)." }));
    v.append(el(`<p class="hint">Un disque « à remplacer » peut lâcher sans prévenir : sauvegarde tes fichiers dès maintenant. L'usure d'un SSD NVMe est celle que le disque annonce lui-même (100 % = durée de vie prévue atteinte).</p>`));
  }

  // Batterie (portables)
  if (d.battery) {
    v.append(el(`<div class="section-title">Batterie</div>`));
    const k = el(`<div class="kpis"></div>`);
    for (const b of d.battery) {
      const h = b.health;
      k.append(el(`<div class="kpi ${h == null ? "" : h < 60 ? "bad" : h < 80 ? "warn" : "good"}"><div class="k">${esc(b.name)}</div><div class="v">${h != null ? `${h} %` : "–"}</div>
        <div class="d">${h != null ? "capacité restante par rapport à neuve" : "usure : Non disponible"}${b.cycles ? ` · ${b.cycles} cycles` : ""}${b.level != null ? ` · chargée à ${b.level} %` : ""}</div></div>`));
    }
    v.append(k);
    const p = d.power;
    const note = !p ? "" : p.tlp && p.ppd ? "TLP et le mode d'énergie de GNOME sont actifs en même temps : ils se contredisent. Garde-en un seul (désinstaller l'un rend la main à l'autre)."
      : p.tlp ? "TLP gère l'énergie : le choix Économie / Équilibré / Performances de GNOME n'est pas disponible. Normal si tu préfères TLP, souvent meilleur au repos."
        : p.ppd ? "Le mode d'énergie de GNOME (Économie, Équilibré, Performances) gère la batterie." : "Aucun gestionnaire d'énergie actif : installe power-profiles-daemon ou TLP pour gagner en autonomie.";
    if (note) v.append(el(`<p class="hint">${esc(note)}</p>`));
  }
}

// ============================================================== Sécurité ===
let secPoll = null;

V.security = async () => {
  const v = $("#view-security");
  v.innerHTML = loading("Lecture de l'état de sécurité");
  let d;
  try { d = await api("/api/security"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const df = d.defender || {};
  const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null);
  const quick = daysSince(df.quickEnd), full = daysSince(df.fullEnd);
  const fwOff = (d.firewall || []).filter((f) => !f.enabled);
  // Debian : le serveur fournit des indicateurs tout prêts.
  const linux = !!d.indicators;
  // Chaque indicateur : état, libellé, valeur, détail, et la phrase à dire s'il cloche.
  const K = linux ? d.indicators.map((i) => [i.state, i.label, i.value, i.detail, i.issue]) : [
    [df.enabled && df.realtime ? "good" : "bad", "Antivirus", df.enabled ? (df.realtime ? "Actif" : "Temps réel coupé") : "Désactivé", (d.av || []).join(", "), "la protection en temps réel est coupée"],
    [df.sigAge <= 2 ? "good" : "warn", "Signatures", df.sigAge === 0 ? "À jour" : `${df.sigAge} jour(s)`, df.sigVersion || "", "les signatures ne sont pas à jour"],
    [quick != null && quick <= 7 ? "good" : "warn", "Analyse rapide", quick == null ? "Jamais" : quick === 0 ? "Aujourd'hui" : `Il y a ${quick} j`, "", "aucune analyse rapide récente"],
    [full != null && full <= 60 ? "good" : "warn", "Analyse complète", full == null ? "Jamais" : `Il y a ${full} j`, "Conseillée de temps en temps", full == null ? "aucune analyse complète n'a jamais été faite" : `la dernière analyse complète date de ${full} jours`],
    [fwOff.length ? "bad" : "good", "Pare-feu", fwOff.length ? `${fwOff.length} profil(s) coupé(s)` : "Actif", "", "le pare-feu est coupé"],
    [d.uac ? "good" : "bad", "Contrôle de compte", d.uac ? "Actif" : "Désactivé", "UAC", "le contrôle de compte est désactivé"],
    [df.tamper ? "good" : "warn", "Anti-falsification", df.tamper ? "Active" : "Désactivée", df.tamper ? "Sécurité Windows" : "À activer dans Sécurité Windows", "la protection contre les falsifications est désactivée"],
    [(d.threats || []).some((t) => !t.ok) ? "bad" : "good", "Menaces", (d.threats || []).length ? `${d.threats.length} détectée(s)` : "Aucune", "historique de Defender", "des menaces restent à traiter"],
  ];
  const issues = K.filter((k) => k[0] !== "good" && k[0] !== "info");
  const bad = K.some((k) => k[0] === "bad");
  const hero = el(`<div class="sec-hero">
    <div class="orb-box">${orbHtml({ size: 200, blips: bad ? [[.72, .27], [.3, .66]] : [[.72, .27]] })}</div>
    <div>
      <div class="sec-status ${bad ? "bad" : issues.length ? "warn" : ""}"><i></i>${esc(linux ? d.status : df.enabled ? "Microsoft Defender actif" : "Antivirus désactivé")}</div>
      <div class="sec-title">${bad ? "Ton PC est exposé." : "Ton PC est protégé."}${issues.length ? `<br><span>${issues.length} point${issues.length > 1 ? "s" : ""} à regarder.</span>` : ""}</div>
      <p class="sub">${issues.length ? esc(issues.map((k) => k[4]).join(", ").replace(/^./, (c) => c.toUpperCase())) + "." : linux ? "Tout est en ordre : pare-feu actif, système à jour." : "Tout est en ordre : antivirus, pare-feu et contrôle de compte sont actifs."}</p>
      <div class="hero-actions" style="margin-top:14px"></div>
    </div></div>`);
  if (linux) $(".hero-actions", hero).append(...[
    d.av ? btn("Analyse complète", async (b) => { if (await confirmBox({ title: "Lancer une analyse complète ?", body: "ClamAV examine tout le disque : cela peut durer plusieurs heures. Le PC reste utilisable." })) startJob(b, "/api/security/scan", { type: "full" }); }) : null,
    d.av ? btn("Analyser le dossier personnel", (b) => startJob(b, "/api/security/scan", { type: "quick" }), "primary") : null,
    d.av ? btn("Mettre à jour les signatures", (b) => startJob(b, "/api/security/update", {})) : null,
    btn("Mises à jour (Logiciels)", () => openTool("windowsupdate"))].filter(Boolean));
  else $(".hero-actions", hero).append(
    btn("Analyse complète", async (b) => { if (await confirmBox({ title: "Lancer une analyse complète ?", body: `Defender vérifie d'abord la mémoire et le démarrage, puis tous les dossiers ${state.status?.scan ? `des disques scannés (${esc(state.status.scan.root)})` : "du disque C:"}, zone par zone : tu vois ce qui est analysé. Cela peut durer une à plusieurs heures ; le PC reste utilisable et tu peux arrêter à tout moment.` })) startJob(b, "/api/security/scan", { type: "full" }); }, full == null || full > 60 ? "primary" : ""),
    btn("Analyse rapide", (b) => startJob(b, "/api/security/scan", { type: "quick" })),
    btn("Mettre à jour les signatures", (b) => startJob(b, "/api/security/update", {})),
    btn("Sécurité Windows", () => openTool("defender")));
  v.append(hero);
  v.append(el(`<div class="kpis" style="grid-template-columns:repeat(4,1fr)">${K.map((k) =>
    `<div class="kpi ${k[0]}"><div class="k">${esc(k[1])}</div><div class="v">${esc(k[2])}</div><div class="d">${esc(k[3])}</div></div>`).join("")}</div>`));
  // Debian : corrections applicables d'un clic (pare-feu, mises à jour automatiques…).
  if (linux && d.fixes?.length) {
    v.append(el(`<div class="section-title">À corriger</div>`));
    const cards = el(`<div class="cards"></div>`);
    for (const f of d.fixes) {
      const c = el(`<div class="card"><div class="body"><div class="title"></div><div class="why"></div></div></div>`);
      $(".title", c).innerHTML = `${esc(f.label)} <span class="tag admin">administrateur</span>`;
      $(".why", c).textContent = f.why;
      c.append(btn("Appliquer", async (b) => {
        if (!await confirmBox({ title: f.label, admin: true, body: esc(f.why) })) return;
        if (await act(b, () => api("/api/security/fix", { id: f.id }), "En attente de l'autorisation…")) { toast("Appliqué. Annulable depuis le journal.", 6000); V.security(); }
      }, f.id === "clamav" ? "" : "primary"));
      cards.append(c);
    }
    v.append(cards);
  }

  // Suivi de l'opération Defender lancée depuis Sonde
  const jobBox = el(`<div class="panel" style="margin-bottom:14px"></div>`);
  v.append(jobBox);
  const renderJob = (job) => {
    jobBox.style.display = job ? "" : "none";
    if (!job) return;
    if (job.kind === "zones") return renderZones(job);
    const secs = Math.round(((job.ended || Date.now()) - job.started) / 1000);
    const ok = job.done && job.code === 0;
    jobBox.innerHTML = `<div class="panel-title">${esc(job.label)} ${job.done ? `<span class="tag ${ok ? "good" : "bad"}">${ok ? "terminée" : "échec"}</span>` : `<span class="tag warn">en cours</span>`} <span class="muted">${secs} s</span></div>
      ${job.done ? "" : `<div class="progress"><span></span></div>`}
      <pre class="muted" style="white-space:pre-wrap;font-size:12px;margin:6px 0 0;max-height:160px;overflow:auto">${esc((job.output || "").trim().split(/\r?\n/).slice(-8).join("\n"))}</pre>
      ${job.done && !ok && /0x80070005|refus|denied|access/i.test(job.output || "") ? `<div class="hint" style="color:var(--warn)">Accès refusé : ${linux ? "certains fichiers ne sont lisibles que par l'administrateur." : "lance cette opération depuis Sécurité Windows."}</div>` : ""}`;
  };
  // Analyse par zones : progression, zone en cours, zones faites et à venir.
  const STEP = { wait: ["", "en attente"], run: ["warn", "en cours"], ok: ["good", "saine"], threat: ["bad", "menace"], error: ["bad", "erreur"], skip: ["", "sautée"] };
  function renderZones(job) {
    const now = job.ended || Date.now();
    const secs = Math.round((now - job.started) / 1000);
    const dur = (n) => (n >= 3600 ? `${Math.floor(n / 3600)} h ${Math.round((n % 3600) / 60)} min` : n >= 60 ? `${Math.floor(n / 60)} min ${n % 60} s` : `${n} s`);
    const left = !job.done && job.percent > 3 ? Math.round((secs * (100 - job.percent)) / job.percent) : null;
    const cur = job.steps.find((z) => z.state === "run");
    const done = job.steps.filter((z) => !["wait", "run"].includes(z.state)).length;
    const status = job.done
      ? job.code === -2 ? `<span class="tag">arrêtée</span>` : job.threats ? `<span class="tag bad">${job.threats} menace(s)</span>` : job.code === 0 ? `<span class="tag good">terminée, rien trouvé</span>` : `<span class="tag warn">terminée avec erreurs</span>`
      : `<span class="tag warn">en cours</span>`;
    jobBox.innerHTML = `<div class="panel-title"><span>${esc(job.label)} ${status}</span><span class="pmeta">${dur(secs)}${left != null ? ` · encore ${dur(left)} environ` : ""}</span></div>
      <div class="sprog-bar"><span style="width:${Math.max(2, job.percent || 0)}%"></span></div>
      <div class="zone-now">${job.done ? `${done} zone(s) sur ${job.steps.length} analysée(s).`
        : cur ? `<span class="working">Analyse de <b>${esc(cur.quick ? cur.label : short(cur.label))}</b></span>${job.currentFile ? `<div class="muted mono">${esc(tail(job.currentFile, 90))}</div>` : ""}` : "Préparation"}
        <span class="muted"> · ${nf0.format(job.percent || 0)} %</span></div>
      <div class="zones">${job.steps.map((z) => `<div class="zone ${z.state}"><i></i><span class="zl">${esc(z.quick ? z.label : short(z.label))}${z.count ? ` <em>${z.count} fichier(s)</em>` : ""}</span>
        <span class="zs">${z.size > 1 && !z.quick ? size(z.size) : ""}</span><span class="tag ${STEP[z.state][0]}">${z.state === "threat" ? `${z.found} menace(s)` : STEP[z.state][1]}</span>
        <span class="zt">${z.secs != null ? dur(z.secs) : ""}</span></div>`).join("")}</div>
      ${job.done ? "" : `<div class="toolbar" style="margin-top:10px"><button class="btn" id="zoneStop">Arrêter l'analyse</button></div>`}`;
    // La zone en cours reste visible dans la liste.
    const runEl = jobBox.querySelector(".zone.run");
    if (runEl) runEl.scrollIntoView({ block: "nearest" });
    jobBox.querySelector("#zoneStop") && (jobBox.querySelector("#zoneStop").onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = "Arrêt…";
      await api("/api/security/cancel", {}).catch(() => {});
    });
  }

  async function startJob(b, url, bodyObj) {
    const r = await act(b, () => api(url, bodyObj));
    if (r) { renderJob(r.job); poll(); }
  }
  const poll = () => {
    clearInterval(secPoll);
    secPoll = setInterval(async () => {
      if (!isActive("security")) return clearInterval(secPoll);
      const { job } = await api("/api/security/job").catch(() => ({}));
      renderJob(job);
      if (!job || job.done) {
        clearInterval(secPoll);
        if (job?.done) toast(job.kind === "zones" ? `${job.label} : ${job.code === -2 ? "arrêtée" : job.threats ? `${job.threats} menace(s) trouvée(s)` : "rien trouvé"}.` : `${job.label} : ${job.code === 0 ? "terminée" : "échec"}.`, 6000);
        if (job?.kind === "zones" && job.threats) V.security();
      }
    }, 1500);
  };
  renderJob(d.job);
  if (d.job && !d.job.done) poll();

  // Menaces
  if (!linux || d.av) v.append(el(`<div class="section-title">Menaces détectées par ${linux ? "ClamAV" : "Defender"} (${(d.threats || []).length})</div>`));
  if (!linux || d.av) v.append(table([
    { label: "Menace", render: (t) => `<div class="t">${esc(t.name || t.id)}</div><div class="s">${esc((t.resources || []).join(" · "))}</div>` },
    { label: "Détectée", render: (t) => `<span class="muted">${esc(t.at ? dtt(Date.parse(t.at)) : "")}</span>` },
    { label: "", render: (t) => `<span class="tag ${t.ok ? "good" : "bad"}">${t.ok ? "traitée" : "à traiter"}</span>` },
  ], d.threats || [], { empty: linux ? "✓ Aucune menace trouvée par les analyses lancées depuis Sonde." : "✓ Aucune menace dans l'historique de Defender." }));

  // Démarrage automatique
  const auTitle = el(`<div class="section-title"><span>Ce qui se lance automatiquement</span><span class="toolbar" style="margin:0"></span></div>`);
  const onlyFlag = el(`<label class="muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox"> À vérifier seulement</label>`);
  const auBox = el(`<div>${loading("Vérification des signatures")}</div>`);
  let au = null;
  $(".toolbar", auTitle).append(onlyFlag,
    btn(`Analyse par ${aiName()}`, () => au && askAI("security", au.items.map((i) => ({ source: i.source, nom: i.name, programme: i.exe, [linux ? "provenance" : "signe_par"]: i.sig?.signer, signature: linux ? undefined : i.sig?.status, alertes: i.flags })), "Audit du démarrage automatique")),
    btn("Actualiser", async () => { auBox.innerHTML = loading("Vérification des signatures"); au = await api("/api/security/autoruns?refresh=1"); renderAu(); }));
  v.append(auTitle, el(`<p class="hint">${linux ? "Ouverture de session, services systemd ajoutés à la main ou par un programme, tâches cron. Ce qui vient d'un paquet Debian est normal ; un élément hors paquet, introuvable ou lancé depuis un dossier inhabituel mérite un coup d'œil." : "Registre, dossier Démarrage, tâches planifiées hors Microsoft et services tiers. Un programme signé par un éditeur connu est normal ; un élément non signé, introuvable ou lancé depuis un dossier inhabituel mérite un coup d'œil."}</p>`), auBox);
  const renderAu = () => {
    const rows = au.items.filter((i) => !$("input", onlyFlag).checked || i.flags.length)
      .sort((a, b) => b.flags.length - a.flags.length);
    auBox.innerHTML = "";
    auBox.append(table([
      { label: "", render: (i) => `<span class="tag">${esc(i.source)}</span>` },
      { label: "Élément", render: (i) => `<div class="t">${esc(i.name)}</div><div class="s">${esc(i.exe || i.command || "")}</div>` },
      { label: linux ? "Provenance" : "Signature", render: (i) => (i.sig?.status === "Valid" ? `<span class="tag good">${esc(i.sig.signer || "signé")}</span>` : i.exists ? `<span class="tag warn">${linux ? "hors paquet" : i.sig?.status === "NotSigned" ? "non signé" : "invalide"}</span>` : "") },
      { label: "À vérifier", render: (i) => i.flags.map((f) => `<span class="tag bad">${esc(f)}</span>`).join(" ") },
      { label: "", act: true, render: (i) => iconBtn("?", `Qu'est-ce que c'est ? (${aiName()})`, () => askAI("startup", { nom: i.name, source: i.source, commande: i.command, programme: i.exe, signature: i.sig, alertes: i.flags }, i.name)) },
    ], rows, { empty: "✓ Rien à signaler." }));
  };
  $("input", onlyFlag).onchange = () => au && renderAu();
  api("/api/security/autoruns").then((r) => { au = r; renderAu(); }).catch((e) => { auBox.innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
};

// La page Réseau (Connexion Internet) est dans network.js.

// ===================================================== Nettoyage Windows ===
V.wincleanup = async () => {
  const v = $("#view-wincleanup");
  v.innerHTML = loading();
  let d;
  try { d = await api("/api/cleanup"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const picked = new Set(d.items.filter((i) => i.risk === "faible").map((i) => i.id));
  // Le bouton annonce ce qui sera libéré, comme dans la maquette.
  const run = btn("", (b) => doRun(b), "primary");
  const label = () => {
    const tot = d.items.filter((i) => picked.has(i.id)).reduce((a, i) => a + (i.size || 0), 0);
    run.textContent = picked.size ? (tot ? `Nettoyer ${size(tot)}` : `Lancer ${picked.size} opération${picked.size > 1 ? "s" : ""}`) : "Rien de coché";
    run.disabled = !picked.size;
  };
  v.append(head(OS.cleanup, isLinux() ? "Ce que seul l'administrateur peut nettoyer (apt, journaux, rapports de plantage), plus Flatpak et la corbeille. Un seul mot de passe pour tout." : "Ce que seul un administrateur peut nettoyer. Une seule autorisation pour tout.", run));
  const list = el(`<div class="opt-list"></div>`);
  for (const i of d.items) {
    const o = el(`<div class="opt chk"><button class="check ${picked.has(i.id) ? "on" : ""}"></button><div style="min-width:0"><div class="on-name"></div><div class="on-why"></div></div><span></span><span class="rsize"></span></div>`);
    $(".on-name", o).innerHTML = `${esc(i.label)} <span class="tag ${i.risk === "faible" ? "good" : i.risk === "définitif" ? "bad" : "warn"}">${i.risk === "définitif" ? "définitif" : "risque " + esc(i.risk)}</span>${i.slow ? ` <span class="tag">long</span>` : ""}`;
    $(".on-why", o).textContent = i.desc;
    $(".rsize", o).textContent = i.size != null ? size(i.size) : i.estimate || "?";
    o.onclick = () => { const on = !picked.has(i.id); on ? picked.add(i.id) : picked.delete(i.id); $(".check", o).classList.toggle("on", on); label(); };
    list.append(o);
  }
  label();
  v.append(list);
  if (d.windowsOld) v.append(el(`<p class="hint" style="margin-top:12px">Un dossier Windows.old existe : supprime-le depuis Paramètres > Stockage > Fichiers temporaires > « Installation(s) précédente(s) de Windows ».</p>`));
  const out = el(`<div style="margin-top:14px"></div>`);
  v.append(out);
  async function doRun(b) {
    const chosen = d.items.filter((i) => picked.has(i.id));
    if (!chosen.length) return toast("Coche au moins une opération.");
    const definitive = chosen.some((i) => i.risk === "définitif");
    if (!await confirmBox({ title: `Lancer ${chosen.length} opération(s) ?`, admin: chosen.some((i) => i.admin), danger: definitive, ok: "Nettoyer",
      body: `<ul>${chosen.map((i) => `<li>${esc(i.label)}</li>`).join("")}</ul>${definitive ? `<div class="warnbox">Vider la corbeille est DÉFINITIF : plus aucune restauration possible, y compris depuis le journal.</div>` : ""}${chosen.some((i) => i.slow) ? "<p>Le nettoyage des composants peut prendre jusqu'à 20 minutes.</p>" : ""}` })) return;
    out.innerHTML = `<div class="panel"><div class="panel-title">Nettoyage en cours</div><div class="progress"><span></span></div></div>`;
    const r = await act(b, () => api("/api/cleanup/run", { ids: chosen.map((i) => i.id) }), "En cours…");
    if (!r) { out.innerHTML = ""; return; }
    out.innerHTML = "";
    out.append(el(`<div class="section-title">Résultat${r.freed != null ? ` — ${size(Math.max(0, r.freed))} libérés` : ""}</div>`));
    out.append(table([
      { label: "Opération", render: (x) => esc(d.items.find((i) => i.id === x.id)?.label || x.id) },
      { label: "", render: (x) => (x.ok ? `<span class="tag good">fait</span>` : `<span class="tag bad">échec</span> <span class="muted">${esc(x.error || "")}</span>`) },
    ], r.results));
    refreshStatus();
  }
};

// ======================================================== Mises à jour ===
// Debian : apt et Flatpak, dépôts, santé de dpkg, TRIM. Les opérations apt
// s'affichent en direct (ce qu'apt est en train de faire).
V.updates = async () => {
  const v = $("#view-updates");
  v.innerHTML = loading("Lecture des mises à jour (quelques secondes)");
  let d;
  try { d = await api("/api/updates"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const apt = d.apt, fp = d.flatpak || [];
  const sec = apt.items.filter((i) => i.security);
  const n = apt.items.length + fp.length;
  const stale = !d.listsAt || Date.now() - d.listsAt > 3 * 864e5;
  const live = el(`<div></div>`);
  v.append(head("Mises à jour",
    `${esc(d.os.name)} · liste des paquets ${d.listsAt ? `vérifiée ${esc(ago(d.listsAt))}` : "jamais vérifiée"}. Une mise à jour qui retirerait un paquet n'est jamais installée d'office : elle reste « retenue ».`,
    btn("Rechercher", (b) => stream(b, "/api/updates/refresh", {}, "Recherche des mises à jour"), stale || !n ? "primary" : ""),
    n ? btn(`Installer ${n} mise${n > 1 ? "s" : ""} à jour`, (b) => install(b), stale ? "" : "primary") : null,
    btn("Logiciels", () => openTool("windowsupdate"))));
  v.append(el(`<div class="kpis">
    <div class="kpi ${sec.length ? "bad" : "good"}"><div class="k">Sécurité</div><div class="v">${sec.length || "Aucune"}</div><div class="d">${sec.length ? "correctifs de sécurité en attente" : "rien en attente"}</div></div>
    <div class="kpi ${apt.items.length ? "warn" : "good"}"><div class="k">Paquets Debian</div><div class="v">${apt.items.length}</div><div class="d">${apt.download ? `${size(apt.download)} à télécharger` : stale ? "liste à rafraîchir" : "à jour"}</div></div>
    <div class="kpi"><div class="k">Applications Flatpak</div><div class="v">${d.flatpak == null ? "–" : fp.length}</div><div class="d">${d.flatpak == null ? "Flatpak absent" : fp.length ? "à mettre à jour" : "à jour"}</div></div>
    <div class="kpi ${apt.kept.length ? "warn" : ""}"><div class="k">Retenues</div><div class="v">${apt.kept.length}</div><div class="d">${apt.kept.length ? esc(apt.kept.slice(0, 3).join(", ")) : "aucune"}</div></div></div>`));
  if (stale) v.append(el(`<p class="hint">La liste des paquets date ${d.listsAt ? esc(ago(d.listsAt)) : "d'avant le premier démarrage"} : clique sur « Rechercher » pour voir les dernières mises à jour.</p>`));
  v.append(live);

  // Entretien : dépôts, dpkg, TRIM, redémarrage.
  const issues = [...d.health, ...d.repoIssues];
  v.append(el(`<div class="section-title">Entretien</div>`));
  const cards = el(`<div class="cards"></div>`);
  const LV = { bad: "bad", warn: "warn", info: "" };
  for (const i of issues) {
    const c = el(`<div class="card ${i.level === "info" ? "info" : ""}"><div class="body"><div class="title"></div><div class="why"></div></div></div>`);
    $(".title", c).innerHTML = `${esc(i.title)} <span class="tag ${LV[i.level]}">${i.level === "bad" ? "important" : i.level === "warn" ? "à regarder" : "information"}</span>`;
    $(".why", c).textContent = i.why;
    if (i.detail) $(".body", c).append(Object.assign(el(`<pre class="issue-detail"></pre>`), { textContent: i.detail }));
    if (i.tool) c.append(btn("Ouvrir Timeshift", () => openTool(i.tool)));
    if (i.fix) c.append(btn(i.fix === "repair" ? "Réparer" : i.fix === "timeshift-install" ? "Installer Timeshift" : "Corriger", async (b) => {
      if (!await confirmBox({ title: i.title, admin: true, body: esc(i.why) })) return;
      if (await act(b, () => api("/api/updates/fix", { id: i.fix }), "En attente de l'autorisation…")) { toast("Fait. Enregistré dans le journal.", 6000); V.updates(); }
    }, "primary"));
    cards.append(c);
  }
  if (!issues.length) cards.append(el(`<div class="panel muted">✓ Rien à signaler : dépôts, installation des paquets et TRIM des SSD sont en ordre.</div>`));
  v.append(cards);

  // Prochaine version de Debian : ce qu'il faut vérifier avant de changer de version.
  const nx = d.nextRelease;
  if (nx) {
    const bad = nx.checks.filter((c) => !c.ok && !c.warnOnly).length, warn = nx.checks.filter((c) => !c.ok && c.warnOnly).length;
    v.append(el(`<div class="section-title"><span>Prêt pour ${esc(nx.next.name)} ?</span><span class="tag ${bad ? "bad" : warn ? "warn" : "good"}">${bad ? `${bad} point${bad > 1 ? "s" : ""} bloquant${bad > 1 ? "s" : ""}` : warn ? `${warn} point${warn > 1 ? "s" : ""} à regarder` : "prêt"}</span></div>`));
    const p = el(`<div class="panel"><p class="hint">${esc(nx.next.name)} (« ${esc(nx.next.codename)} ») se prépare. Ces vérifications reprennent celles des guides de mise à niveau : quand elle sortira, tu sauras si ton système est prêt. Sonde ne change pas de version à ta place.</p><div class="steps up-checks"></div></div>`);
    for (const c of nx.checks) {
      const r = el(`<div class="${c.ok ? "done" : "now"}"><b></b> <span class="muted"></span></div>`);
      $("b", r).textContent = c.title;
      $(".muted", r).textContent = `· ${c.detail}`;
      if (!c.ok) r.style.color = c.warnOnly ? "var(--warn)" : "var(--bad)";
      $(".up-checks", p).append(r);
    }
    v.append(p);
  }

  // Détail des mises à jour
  if (apt.items.length) {
    v.append(el(`<div class="section-title">Paquets Debian (${apt.items.length})</div>`));
    const rows = [...apt.items].sort((a, b) => b.security - a.security || a.pkg.localeCompare(b.pkg));
    v.append(table([
      { label: "Paquet", render: (i) => `<div class="t">${esc(i.pkg)}</div><div class="s">${esc(i.suite)}</div>` },
      { label: "Version", render: (i) => `<span class="muted">${i.from ? `${esc(i.from)} → ` : ""}</span>${esc(i.version)}` },
      { label: "", render: (i) => (i.security ? `<span class="tag bad">sécurité</span>` : i.isNew ? `<span class="tag">nouveau</span>` : "") },
    ], rows));
    v.append(bar(12, btn(`Qu'apportent ces mises à jour ? (${aiName()})`, () => askAI("updates", rows.slice(0, 60).map((i) => ({ paquet: i.pkg, de: i.from, vers: i.version, securite: i.security })), "Mises à jour en attente"))));
  }
  if (fp.length) {
    v.append(el(`<div class="section-title">Applications Flatpak (${fp.length})</div>`));
    v.append(table([
      { label: "Application", render: (f) => `<div class="t">${esc(f.id)}</div><div class="s">${esc(f.origin || "")}</div>` },
      { label: "Version", render: (f) => esc(f.version || "") },
    ], fp));
  }
  v.append(el(`<div class="section-title">Dépôts (${d.repos.length})</div>`));
  v.append(table([
    { label: "Dépôt", render: (r) => `<div class="t">${esc(r.host)}</div><div class="s">${esc(r.file)}</div>` },
    { label: "Versions", render: (r) => esc(r.suites.join(", ")) },
    { label: "Sections", render: (r) => `<span class="muted">${esc(r.components.join(" "))}</span>` },
    { label: "", render: (r) => (r.official ? `<span class="tag good">Debian</span>` : `<span class="tag warn">tiers</span>`) },
  ], d.repos, { empty: "Aucun dépôt trouvé." }));

  // Opération apt en direct : étapes, progression, dernières lignes.
  async function stream(b, url, body, title) {
    b.disabled = true;
    live.innerHTML = "";
    const p = el(`<div class="panel"><div class="panel-title"></div><div class="sprog-bar"><span style="width:5%"></span></div><pre class="live-log"></pre></div>`);
    $(".panel-title", p).textContent = title;
    live.append(p);
    const lines = [];
    let ok = false, failed = null;
    try {
      await streamApi(url, body, (e) => {
        if (e.type === "step") $(".panel-title", p).textContent = e.label;
        else if (e.type === "progress") $(".sprog-bar span", p).style.width = `${Math.max(5, (e.completed / e.total) * 100)}%`;
        else if (e.type === "log") { lines.push(e.text); $(".live-log", p).textContent = lines.slice(-14).join("\n"); }
        else if (e.type === "done") ok = true;
        else if (e.type === "error") failed = e.error;
      });
    } catch (err) { failed = err.message; }
    b.disabled = false;
    if (failed) { toast(failed, 8000); $(".panel-title", p).textContent = failed; $(".sprog-bar", p).remove(); return; }
    if (ok) { toast("Terminé.", 4000); V.updates(); refreshStatus(); }
  }
  async function install(b) {
    // Timeshift configuré : instantané du système proposé (coché) avant l'installation.
    const snap = d.snapshot?.configured && apt.items.length;
    if (!await confirmBox({ title: `Installer ${n} mise${n > 1 ? "s" : ""} à jour ?`, admin: true,
      body: `<p>${apt.items.length} paquet(s) Debian${sec.length ? `, dont ${sec.length} de sécurité` : ""}${apt.download ? ` · ${size(apt.download)} à télécharger` : ""}${fp.length ? ` ; ${fp.length} application(s) Flatpak` : ""}.</p><p>Ne coupe pas le PC pendant l'installation. Un redémarrage peut être demandé ensuite (nouveau noyau).</p>${snap ? `<label class="upd-auto"><input type="checkbox" id="updSnap" checked> Créer d'abord un instantané Timeshift (quelques minutes la première fois)</label>` : ""}` })) return;
    stream(b, "/api/updates/apply", { flatpak: true, snapshot: !!(snap && $("#updSnap")?.checked) }, "Installation des mises à jour");
  }
};
