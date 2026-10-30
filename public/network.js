// Sonde — page Réseau (Connexion Internet), d'après la maquette « Sonde v2 » :
// jauge du débit, étapes du test, cartes de la connexion, optimisations
// justifiées par les mesures, programmes connectés.
"use strict";

// Étapes du test côté serveur, avec leur part de la progression et leur durée habituelle.
const NET_STEPS = [
  { id: "ping", label: "Ping de la box et d'Internet", from: 0, to: 15, ms: 9000 },
  { id: "dns", label: "Comparaison des serveurs DNS", from: 15, to: 35, ms: 14000 },
  { id: "latency", label: "Latence vers Internet", from: 35, to: 42, ms: 3000 },
  { id: "down", label: "Débit descendant", from: 42, to: 74, ms: 9000 },
  { id: "up", label: "Débit montant", from: 74, to: 100, ms: 8000 },
];
const NET_ICON = {
  eth: "M4 7h16v10H4zM8 11h.01M12 11h.01M16 11h.01M8 17v3M16 17v3",
  ip: "M5 12h14M12 5v14M5 5h4v4H5zM15 15h4v4h-4z",
  dns: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  info: "M12 8v4M12 16h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  plug: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  wave: "M3 12h4l3-8 4 16 3-8h4",
  up: "M12 21V9M7 14l5-5 5 5M5 3h14",
};
const GAUGE = 433.5;   // longueur de l'arc (3/4 du cercle de rayon 92)
const mbps = (bps) => (bps >= 1e9 ? `${nf1.format(bps / 1e9)} Gb/s` : `${nf0.format(bps / 1e6)} Mb/s`);
const hueOf = (s) => TMG[[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % TMG.length];

V.network = async () => {
  const v = $("#view-network");
  v.innerHTML = loading("Lecture de la connexion");
  let d;
  try { d = await api("/api/network"); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  v.innerHTML = "";
  const main = d.adapters.find((a) => a.ip) || d.adapters[0] || null;
  // L'échelle de la jauge suit la vitesse du lien local (1 Gb/s, 2,5 Gb/s…).
  const max = main?.speed ? Math.round(main.speed / 1e6) : 1000;

  v.append(head("Connexion Internet", "Diagnostic de la connexion, puis des optimisations proposées seulement quand une mesure les justifie. Le test de débit utilise les serveurs de Cloudflare.",
    btn("Vider le cache DNS", (b) => act(b, async () => { await api("/api/network/flushdns", {}); toast("Cache DNS vidé."); })),
    btn("Paramètres réseau ↗", () => openTool("network"))));

  // ----------------------------------------------------------- haut de page ---
  const hero = el(`<div class="net-hero">
    <div class="net-main">
      <div class="gauge">
        <svg viewBox="0 0 220 220" width="220" height="220">
          <defs><linearGradient id="ng" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:var(--a1)"/><stop offset=".55" style="stop-color:var(--a2)"/><stop offset="1" style="stop-color:var(--a3)"/></linearGradient></defs>
          <circle class="g-bg" cx="110" cy="110" r="92"/>
          <circle class="g-fg" cx="110" cy="110" r="92"/>
        </svg>
        <div class="gauge-c"><div class="g-dir">↓ Descendant</div><div class="g-val">—</div><div class="g-unit">Mb/s</div></div>
        <div class="g-min">0</div><div class="g-max">${nf0.format(max)}</div>
      </div>
      <div class="net-sum">
        <div class="net-status"><i></i><span></span></div>
        <div class="net-verdict"></div>
        <div class="net-stats"></div>
        <div class="net-acts"></div>
      </div>
    </div>
    <div class="net-steps"><div class="ns-head"><span>Étapes du test</span><span class="ns-pct">0 %</span></div><div class="ns-list"></div></div>
  </div>`);
  v.append(hero);
  const fg = $(".g-fg", hero);
  const setGauge = (val, dir = "↓ Descendant") => {
    $(".g-dir", hero).textContent = dir;
    $(".g-val", hero).textContent = val == null ? "—" : nf0.format(val);
    fg.style.strokeDasharray = `${(GAUGE * Math.min(1, (val || 0) / max)).toFixed(1)} 578`;
    fg.style.opacity = val ? 1 : 0;   // sinon le bout arrondi laisse un point à zéro
  };
  const setStatus = (text, col) => {
    $(".net-status", hero).style.color = col;
    $(".net-status span", hero).textContent = text;
  };

  // Mesures retenues du dernier test : latence et gigue vers Internet (Cloudflare).
  const inet = (t) => t?.ping?.find((p) => p.host === "1.1.1.1") || t?.ping?.find((p) => p.host !== d.gateway);
  const stat = (k, val, u) => `<div class="net-stat"><div class="k">${esc(k)}</div><div class="v"><b data-count>${val == null ? "—" : esc(String(val).replace(".", ","))}</b><span>${esc(u)}</span></div></div>`;
  function verdict(t) {
    if (!t) return "Lance le test pour mesurer ta connexion : débit, latence et stabilité.";
    const p = inet(t);
    const parts = [];
    if (p && p.loss > 0) parts.push(`Des paquets se perdent (${p.loss} %) : la connexion est instable.`);
    else if (t.down == null) parts.push("Le débit n'a pas pu être mesuré.");
    else if (t.down < 30) parts.push("Ta connexion est lente : les gros téléchargements et la vidéo en haute définition vont souffrir.");
    else if ((p?.jitter ?? 0) >= 10) parts.push("Ta connexion est rapide, mais irrégulière : la latence varie beaucoup.");
    else parts.push(t.down >= 200 ? "Ta connexion est rapide et stable." : "Ta connexion est correcte et stable.");
    if (main && !main.wifi && t.down != null && main.speed && t.down > (main.speed / 1e6) * 0.8) parts.push(`Le lien local limite à ${mbps(main.speed)}.`);
    if (main?.wifi && d.wifi?.signal < 60) parts.push("Le signal Wi-Fi est faible.");
    return parts.join(" ");
  }
  function renderSummary(t) {
    const p = inet(t);
    setStatus(t ? `Test terminé ${ago(t.at)} · Cloudflare` : "Pas encore de test", t ? "var(--safe)" : "rgba(236,233,255,.55)");
    $(".net-verdict", hero).textContent = verdict(t);
    $(".net-stats", hero).innerHTML = stat("↑ Montant", t?.up, "Mb/s") + stat("Latence", p?.avg != null ? Math.round(p.avg) : null, "ms") + stat("Gigue", p?.jitter != null ? Math.round(p.jitter) : null, "ms");
    const acts = $(".net-acts", hero);
    acts.innerHTML = "";
    acts.append(btn(t ? "Relancer le test" : "Lancer le test", (b) => runTest(b), "primary"));
    if (t) acts.append(btn(`Analyse par ${aiName()}`, () => askAI("network", { cartes: d.adapters, passerelle: d.gateway, autoreglage_tcp: d.autotuning, test: t, applis_reseau: d.apps.slice(0, 8) }, "Analyse de la connexion")));
  }

  // Liste des étapes : faites, en cours (avec sa barre), à venir.
  function renderSteps(cur, frac, results) {
    const list = $(".ns-list", hero);
    list.innerHTML = "";
    const ci = NET_STEPS.findIndex((s) => s.id === cur);
    let pct = cur === "done" ? 100 : 0;
    NET_STEPS.forEach((s, i) => {
      const ok = cur === "done" || (ci >= 0 && i < ci), now = i === ci;
      if (now) pct = s.from + (s.to - s.from) * frac;
      const r = el(`<div class="nstep fx-row ${ok ? "ok" : now ? "cur" : ""}"><div class="dot">${ok ? "✓" : ""}</div>
        <div class="ns-body"><div class="ns-label"></div>${now ? `<div class="ns-bar"><span style="width:${frac * 100}%"></span></div>` : ""}</div><span class="ns-res"></span></div>`);
      $(".ns-label", r).textContent = s.label;
      $(".ns-res", r).textContent = results[s.id] || "";
      list.append(r);
    });
    $(".ns-pct", hero).textContent = `${Math.round(pct)} %`;
  }
  function stepResults(t) {
    if (!t) return {};
    const cur = t.dns?.find((x) => x.current);
    const p = inet(t);
    return { ping: p?.avg != null ? `${Math.round(p.avg)} ms` : "", dns: cur ? `${cur.median} ms` : "", latency: t.http != null ? `${t.http} ms` : "",
      down: t.down != null ? `${t.down} Mb/s` : "échec", up: t.up != null ? `${t.up} Mb/s` : "échec" };
  }

  // ---------------------------------------------------------------- cartes ---
  const cards = el(`<div class="net-cards"></div>`);
  v.append(cards);
  function renderCards(t) {
    cards.innerHTML = "";
    const card = (k, val, desc, icon, tile) => {
      const c = el(`<div class="net-card"><div class="tile" style="background:${tile}">${svg(icon)}</div><div><div class="k"></div><div class="v"></div><div class="d"></div></div></div>`);
      $(".k", c).textContent = k; $(".v", c).textContent = val; $(".d", c).textContent = desc;
      cards.append(c);
    };
    if (!main) { cards.append(el(`<div class="net-card"><div class="d">Aucune carte réseau connectée.</div></div>`)); return; }
    card(main.wifi ? `Wi-Fi${d.wifi?.ssid ? ` · ${d.wifi.ssid}` : ""}` : "Ethernet", main.speed ? mbps(main.speed) : "Non disponible",
      main.wifi && d.wifi ? `signal ${d.wifi.signal} % · ${main.desc}` : main.desc, main.wifi ? ICON.wifi : NET_ICON.eth, G("#0284c7", "#22d3ee"));
    card("Adresse locale", main.ip || "Non disponible", d.gateway ? `passerelle ${d.gateway}` : "pas de passerelle", NET_ICON.ip, G("#7c3aed", "#a78bfa"));
    const dns = main.dns?.[0];
    const prov = Object.values(d.dnsProviders || {}).find((p) => p.servers.includes(dns));
    const med = t?.dns?.find((x) => x.server === dns)?.median;
    card(`DNS (${main.dnsStatic ? "manuel" : "automatique"})`, dns || (isLinux() ? "géré par le système" : "Non disponible"),
      [dns && dns === d.gateway ? "celui de la box" : prov ? prov.label : "", med != null ? `${med} ms` : ""].filter(Boolean).join(" · ") || " ",
      NET_ICON.dns, G("#0d9488", "#2dd4bf"));
  }

  // --------------------------------------------------------- optimisations ---
  const optBox = el(`<div></div>`);
  v.append(optBox);
  const OPT_ICON = { dns: NET_ICON.bolt, eee: NET_ICON.plug, autotuning: NET_ICON.wave, dolan: NET_ICON.up, wifips: ICON.wifi, info: NET_ICON.info };
  function renderOpti(opts, t) {
    optBox.innerHTML = `<div class="pg-sec"><span>Optimisations proposées</span><span class="meta">${opts.length ? `${opts.length} proposition${opts.length > 1 ? "s" : ""}` : ""}</span></div>`;
    const list = el(`<div class="opt-cards"></div>`);
    for (const o of opts) {
      const info = o.id === "info";
      // Le DNS est le seul gain chiffré par le test ; les autres sont des réglages conseillés.
      const tag = info ? "Information" : o.id === "dns" ? "Gain mesuré" : "Conseillé";
      const c = el(`<div class="opt-card fx-row ${info ? "info" : ""}"><div class="oc-icon">${svg(OPT_ICON[o.id] || NET_ICON.info)}</div>
        <div><div class="oc-title"><span></span><span class="tag ${info ? "" : "good"}">${tag}</span></div><div class="oc-why"></div></div></div>`);
      $(".oc-title span", c).textContent = o.title;
      $(".oc-why", c).textContent = o.why;
      if (!info) c.append(btn("Appliquer", async (b) => {
        if (!await confirmBox({ title: o.title, admin: o.admin, body: esc(o.why) + (o.id === "eee" ? "<p>La carte réseau redémarre : la connexion est coupée quelques secondes.</p>" : "") })) return;
        if (await act(b, () => api("/api/network/apply", { id: o.id, params: o.params }), "En attente de l'autorisation…")) { toast("Appliqué. Annulable depuis le journal.", 6000); V.network(); }
      }, "primary"));
      list.append(c);
    }
    if (!opts.length) list.append(el(`<div class="panel muted">${t ? "✓ Rien à optimiser d'après les mesures." : "Lance le test pour obtenir des propositions basées sur tes mesures."}</div>`));
    optBox.append(list);
  }

  // ------------------------------------------------- programmes connectés ---
  const apps = d.apps || [];
  const progBox = el(`<div></div>`);
  v.append(progBox);
  function renderProgs() {
    const by = store.get("netSort") === "srv" ? "hosts" : "conns";
    const list = [...apps].sort((a, b) => b[by] - a[by]);
    const top = Math.max(1, ...apps.map((a) => a.conns));
    const total = apps.reduce((a, x) => a + x.conns, 0);
    progBox.innerHTML = `<div class="pg-sec"><div><span>Programmes connectés à Internet</span><span class="meta">${apps.length} programme${apps.length > 1 ? "s" : ""} · ${total} connexion${total > 1 ? "s" : ""}</span></div>
      <div class="segs sm"><button data-s="conns" class="${by === "conns" ? "on" : ""}">Connexions</button><button data-s="srv" class="${by === "hosts" ? "on" : ""}">Serveurs</button></div></div>`;
    $$("[data-s]", progBox).forEach((b) => (b.onclick = () => { store.set("netSort", b.dataset.s); renderProgs(); }));
    const p = el(`<div class="prog-list"><div class="prog-row ph"><span></span><span>Programme</span><span>Connexions</span><span>Connexions</span><span>Serveurs</span></div></div>`);
    for (const a of list) {
      const [c1, c2] = hueOf(a.name);
      const r = el(`<div class="prog-row fx-row"><div class="ini" style="background:${G(c1, c2)}"></div><div class="pn"><div class="t"></div><div class="s"></div></div>
        <div class="pbar"><span class="fx-bar" style="width:${(a.conns / top) * 100}%"></span></div><span class="num">${a.conns}</span><span class="num dim">${a.hosts}</span></div>`);
      $(".ini", r).textContent = (a.name || "?")[0].toUpperCase();
      $(".t", r).textContent = a.name || "?";
      $(".s", r).textContent = a.pub || "éditeur non indiqué";
      p.append(r);
    }
    if (!list.length) p.append(el(`<div class="empty">Aucun programme connecté en ce moment.</div>`));
    progBox.append(p);
  }

  // ------------------------------------------------------------- le test ---
  function showTest(t, opts) {
    renderSummary(t);
    renderSteps(t ? "done" : null, 0, stepResults(t));
    renderCards(t);
    renderOpti(opts, t);
  }
  showTest(d.test, d.optimizations);
  renderProgs();
  // La jauge se remplit à l'ouverture de la page (1,2 s).
  const target = d.test?.down ?? null;
  if (target != null && FX.on()) {
    const t0 = performance.now();
    const step = (n) => {
      if (!v.isConnected) return;
      const k = Math.min(1, (n - t0) / 1200), e = 1 - Math.pow(1 - k, 3);
      setGauge(Math.round(target * e));
      if (k < 1) requestAnimationFrame(step);
    };
    setGauge(0);
    requestAnimationFrame(step);
  } else setGauge(target);

  async function runTest(b) {
    b.disabled = true;
    b.textContent = "Test en cours…";
    setStatus("Test en cours…", "var(--soft)");
    $(".net-verdict", hero).textContent = "Mesure en cours, garde les téléchargements en pause.";
    $(".net-stats", hero).innerHTML = stat("↑ Montant", null, "Mb/s") + stat("Latence", null, "ms") + stat("Gigue", null, "ms");
    setGauge(null);
    const res = {};
    let cur = "ping", t0 = performance.now();
    const tick = setInterval(() => {
      const s = NET_STEPS.find((x) => x.id === cur);
      if (s) renderSteps(cur, Math.min(.95, (performance.now() - t0) / s.ms), res);
    }, 200);
    try {
      await streamApi("/api/network/test", {}, (e) => {
        if (e.type === "step") {
          cur = e.step; t0 = performance.now();
          if (cur === "up") setStatus("Mesure du débit montant…", "var(--soft)");
        } else if (e.type === "ping") {
          const p = e.ping.find((x) => x.host === "1.1.1.1");
          if (p?.avg != null) res.ping = `${Math.round(p.avg)} ms`;
        } else if (e.type === "dns") {
          const c = e.dns.find((x) => x.current);
          if (c) res.dns = `${c.median} ms`;
        } else if (e.type === "progress") {
          res[e.step] = `${Math.round(e.mbps)} Mb/s`;
          setGauge(Math.round(e.mbps), e.step === "up" ? "↑ Montant" : "↓ Descendant");
        } else if (e.type === "done") {
          d.test = e.test;
          clearInterval(tick);
          showTest(e.test, e.optimizations);
          setGauge(e.test.down);
        } else if (e.type === "error") toast(e.error, 7000);
      });
    } catch (e) { toast(e.message); renderSummary(d.test); }
    clearInterval(tick);
    if (!d.test) renderSteps(null, 0, {});
  }
};
