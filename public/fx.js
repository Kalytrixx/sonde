// Sonde — effets d'animation et de navigation (toute l'app), d'après la
// maquette « Sonde v2 » : entrée des pages, cascade des panneaux, lignes,
// barres, chiffres qui défilent, carte du disque, cases cochées, corbeille,
// barre de sélection, notifications, palette, fond, logo pendant un scan.
// Rien ici ne change l'état final d'une page : seulement la façon d'y arriver.
"use strict";

const FX = (() => {
  const E = "cubic-bezier(.2,.8,.2,1)", SPR = "cubic-bezier(.34,1.56,.64,1)";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const on = () => store.get("anim") !== "0" && !reduce.matches;
  const apply = () => {
    document.documentElement.classList.toggle("fx", on());
    document.documentElement.classList.toggle("no-fx", !on());
  };
  apply();
  reduce.addEventListener?.("change", apply);

  // ------------------------------------------------------------- fond ---
  const bg = document.createElement("div");
  bg.className = "bg-fx";
  bg.innerHTML = `<i class="b1"></i><i class="b2"></i><i class="b3"></i>`;
  document.body.prepend(bg);

  // ------------------------------------------------- barre latérale ---
  const glider = document.createElement("span");
  glider.className = "nav-glider still";
  $("#nav").prepend(glider);
  function nav() {
    const a = $("#nav a.active");
    glider.style.display = a ? "" : "none";
    if (a) glider.style.top = `${a.offsetTop}px`;
    // Pas de glissement au premier placement.
    if (glider.classList.contains("still")) requestAnimationFrame(() => requestAnimationFrame(() => glider.classList.remove("still")));
  }
  window.addEventListener("resize", () => { glider.classList.add("still"); nav(); });

  // ------------------------------------------------- entrée d'une page ---
  // Lignes, barres et chiffres qui reçoivent les effets, dans toutes les pages.
  const ROWS = ".row, .gstep, .opt, .tbl tbody tr, .act-card, .card, .set-row, .zone, .game-ping, .legend > div, .fx-row";
  const BARS = ".meter > span, .guide-bar span, .sizebar span, .bars .track span, .dr-bar i, .dc-bar i, .fx-bar";
  const COUNTS = "[data-count], .kpi .v, .stat b, .head-stat b, .pb-num .grad-text";
  let lastView = null;

  // Appelé par show() : `done` est la promesse du rendu de la page.
  function page(view, done) {
    nav();
    const same = view?.id === lastView;
    lastView = view?.id;
    if (!view || same || !on()) return;
    view.animate([{ opacity: 0, filter: "blur(14px)" }, { opacity: 1, filter: "blur(0px)" }], { duration: 440, easing: E });
    Promise.resolve(done).then(() => { if (view.classList.contains("active")) enter(view); }, () => {});
  }

  function enter(sc) {
    let blocks = [...sc.children];
    if (blocks.length === 1) blocks = [...blocks[0].children];
    blocks.slice(0, 8).forEach((b, i) => b.animate([{ opacity: 0, transform: "translateY(14px)", filter: "blur(6px)" }, { opacity: 1, transform: "none", filter: "blur(0px)" }],
      { duration: 540, delay: 60 + i * 70, easing: E, fill: "backwards" }));
    [...sc.querySelectorAll(ROWS)].slice(0, 26).forEach((r, i) => r.animate([{ opacity: 0, transform: "translateX(-10px)" }, { opacity: 1, transform: "none" }],
      { duration: 400, delay: 200 + i * 26, easing: E, fill: "backwards" }));
    let bi = 0;
    sc.querySelectorAll(BARS).forEach((b) => {
      b.style.transformOrigin = "left center";
      b.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: 900, delay: 220 + Math.min(bi++, 20) * 35, easing: E, fill: "backwards" });
    });
    sc.querySelectorAll(COUNTS).forEach(countUp);
  }

  // Un chiffre défile de 0 jusqu'à sa valeur, au format français (« 230,8 Go »).
  // S'arrête si la page réécrit le texte entre-temps.
  function countUp(el) {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) return;
    const t = node.nodeValue, m = t.match(/^([\d\s  ]*\d(?:,\d+)?)(.*)$/s);
    // Adresses, versions, heures : pas des quantités.
    if (!m || /^[.:/\d-]/.test(m[2])) return;
    const target = parseFloat(m[1].replace(/[\s  ]/g, "").replace(",", "."));
    if (!target) return;
    const dec = (m[1].split(",")[1] || "").length, t0 = performance.now();
    const fmt = (x) => x.toLocaleString("fr-FR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    let wrote = null;
    const step = (n) => {
      if (wrote !== null && node.nodeValue !== wrote) return;
      const k = Math.min(1, (n - t0) / 950), e = 1 - Math.pow(1 - k, 3);
      node.nodeValue = wrote = k < 1 ? fmt(target * e) + m[2] : t;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ------------------------------------------------- carte du disque ---
  // Les blocs apparaissent en mosaïque, à chaque dessin de la carte.
  new MutationObserver((muts) => {
    if (!on()) return;
    const cells = muts.flatMap((m) => [...m.addedNodes]).filter((n) => n.classList?.contains("tm-cell"));
    cells.forEach((c, i) => c.animate([{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }],
      { duration: 560, delay: 140 + i * 60, easing: "cubic-bezier(.34,1.4,.64,1)", fill: "backwards" }));
  }).observe($("#view-telescope"), { childList: true, subtree: true });

  // ------------------------------------------------------ cases cochées ---
  function burst(el) {
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const cs = getComputedStyle(document.body);
    const cols = ["--a1", "--a2", "--a3"].map((v) => cs.getPropertyValue(v).trim() || "#fff");
    const mk = (css) => { const d = document.createElement("div"); d.style.cssText = "position:fixed;pointer-events:none;z-index:60;border-radius:50%;" + css; document.body.appendChild(d); return d; };
    const ring = mk(`left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;border:2px solid ${cols[1]}`);
    ring.animate([{ transform: "scale(1)", opacity: .9 }, { transform: "scale(2.6)", opacity: 0 }], { duration: 520, easing: E }).onfinish = () => ring.remove();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2, d = r.width * 1.4;
      const p = mk(`left:${cx - 2.5}px;top:${cy - 2.5}px;width:5px;height:5px;background:${cols[i % 3]}`);
      p.animate([{ transform: "translate(0,0) scale(1)", opacity: 1 }, { transform: `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(.3)`, opacity: 0 }],
        { duration: 580, easing: E }).onfinish = () => p.remove();
    }
  }
  document.addEventListener("click", (e) => {
    if (!on()) return;
    const host = e.target.closest?.(".check, [data-path], .drive-chip, .fx-check");
    if (!host) return;
    const cb = host.matches(".check") ? host : host.querySelector(".check");
    if (!cb || cb.disabled) return;
    setTimeout(() => {
      cb.animate([{ transform: "scale(.6)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }], { duration: 420, easing: SPR });
      if (cb.classList.contains("on")) burst(cb);
    }, 16);
  }, true);

  // ------------------------------------------------ reflet des boutons ---
  document.addEventListener("mouseover", (e) => {
    if (!on()) return;
    const b = e.target.closest?.(".btn.primary");
    if (!b || b.disabled) return;
    const now = performance.now();
    if (b._shT && now - b._shT < 900) return;
    b._shT = now;
    b.animate([{ backgroundPosition: "130% 0, 0 0" }, { backgroundPosition: "-30% 0, 0 0" }], { duration: 850, easing: "cubic-bezier(.4,0,.2,1)" });
  });

  // ------------------------------------------------------------ corbeille ---
  // Les lignes envoyées glissent à droite, s'effacent puis se replient.
  // La promesse se résout quand la page peut les retirer.
  function trashOut(paths) {
    const keys = new Set(paths.map((p) => p.toLowerCase()));
    const view = $(".view.active");
    const els = view ? [...view.querySelectorAll("[data-path]")].filter((r) => keys.has(r.dataset.path.toLowerCase())) : [];
    if (!on() || !els.length) return Promise.resolve();
    const n = Math.min(els.length, 26);
    els.forEach((el, i) => {
      const h = el.offsetHeight;
      el.style.overflow = "hidden";
      el.animate([{ opacity: 1, transform: "none", height: h + "px" }, { opacity: 0, transform: "translateX(56px)", height: h + "px", offset: .55 },
        { opacity: 0, transform: "translateX(56px)", height: "0px", paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px" }],
        { duration: 560, delay: Math.min(i, n) * 40, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    });
    return new Promise((r) => setTimeout(r, 580 + n * 40));
  }

  // ---------------------------- barre de sélection, notifications, palette ---
  const onClass = (el, cls, fn) => {
    let had = el.classList.contains(cls);
    new MutationObserver(() => {
      const has = el.classList.contains(cls);
      if (has && !had && on()) fn();
      had = has;
    }).observe(el, { attributes: true, attributeFilter: ["class"] });
  };
  onClass($("#selbar"), "show", () => $("#selbar").animate([{ opacity: 0, transform: "translate(-50%,70px) scale(.92)" }, { opacity: 1, transform: "translate(-50%,0)" }], { duration: 650, easing: SPR }));
  onClass($("#toast"), "show", () => $("#toast").animate([{ opacity: 0, transform: "translateY(-28px) scale(.95)" }, { opacity: 1, transform: "none" }], { duration: 560, easing: SPR }));
  onClass($("#palette"), "open", () => $("#palette .pal-box").animate([{ opacity: 0, transform: "translateY(-14px) scale(.97)", filter: "blur(8px)" }, { opacity: 1, transform: "none", filter: "blur(0)" }], { duration: 380, easing: E }));

  // ------------------------------------------- logo pendant un scan ---
  setInterval(() => document.body.classList.toggle("scanning", !!(state.scanningUI || state.status?.scanning)), 500);

  return {
    on, nav, page, trashOut, countUp,
    // Réglage « Animations » (Paramètres › Général › Apparence).
    enabled: () => store.get("anim") !== "0",
    set(v) { store.set("anim", v ? "1" : "0"); apply(); },
    reduced: () => reduce.matches,
  };
})();
window.FX = FX;
