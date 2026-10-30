// Sonde — page Gaming (Windows), d'après la maquette « Sonde v2 » : onglets
// Jeu, Composants, Réseau et « Ce qu'on ne fait pas ». Tout vient des mesures
// faites sur ce PC ; ce qui ne peut pas être mesuré est affiché « Non disponible ».
"use strict";

const GI = {
  screen: "M3 4h18v12H3zM8 20h8M12 16v4",
  ram: "M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8M6 16v3M18 16v3",
  wave: "M3 12h4l3-8 4 16 3-8h4",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  overlay: "M3 5h18v14H3zM7 9h6",
  cloud: "M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 8z",
  update: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  x: "M6 6l12 12M18 6L6 18",
};
const GRADES = ["A+", "A", "B", "C", "D", "F"];
const GRADE_BG = { "A+": G("#059669", "#34d399"), A: G("#059669", "#34d399"), B: G("#0d9488", "#5eead4"), C: G("#d97706", "#fbbf24"), D: G("#c2410c", "#fb923c"), F: G("#b91c1c", "#f87171") };
const GRADE_GLOW = { "A+": "rgba(52,211,153,.35)", A: "rgba(52,211,153,.35)", B: "rgba(94,234,212,.3)", C: "rgba(251,191,36,.35)", D: "rgba(251,146,60,.35)", F: "rgba(248,113,113,.35)" };
// Launchers reconnus dans les entrées de démarrage (nom ou commande).
const LAUNCHERS = [
  { re: /steam/i, name: "Steam", c: ["#1e3a8a", "#3b82f6"] },
  { re: /epic\s*games|EpicGamesLauncher/i, name: "Epic Games Launcher", c: ["#27272a", "#52525b"] },
  { re: /\bEA(\s*app|Desktop)?\b|Origin/i, name: "EA app", c: ["#b91c1c", "#f87171"] },
  { re: /ubisoft|uplay|upc\.exe/i, name: "Ubisoft Connect", c: ["#1d4ed8", "#60a5fa"] },
  { re: /GOG|Galaxy/i, name: "GOG Galaxy", c: ["#6d28d9", "#a78bfa"] },
  { re: /battle\.net/i, name: "Battle.net", c: ["#0369a1", "#38bdf8"] },
  { re: /riot/i, name: "Riot Client", c: ["#b91c1c", "#ef4444"] },
  { re: /rockstar/i, name: "Rockstar Games Launcher", c: ["#a16207", "#facc15"] },
  { re: /overwolf/i, name: "Overwolf", c: ["#be185d", "#ec4899"] },
];
const RARE_DAYS = 30;

// Données partagées par les quatre onglets ; relues après chaque changement.
let gData = null, gAt = 0, gBloat = null, gPings = null, gNet = null;
async function gamingData(force = false) {
  if (!force && gData && Date.now() - gAt < 60000) return gData;
  gData = await api("/api/gaming");
  gAt = Date.now();
  return gData;
}
const gTag = (text, kind = "") => `<span class="tag ${kind}">${esc(text)}</span>`;
const na = `<span class="na">Non disponible</span>`;
const initials = (s) => (String(s).match(/\b[A-Z0-9]/g) || [String(s)[0] || "?"]).slice(0, 2).join("").toUpperCase();
async function gLoad(v, msg) {
  v.innerHTML = loading(msg);
  try { return await gamingData(); } catch (e) { v.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return null; }
}
// Applique un réglage après confirmation, puis redessine l'onglet.
async function gApply(title, body, payload, { admin = false, ok = "Appliquer", done = "Fait. Annulable depuis le journal.", b = null } = {}) {
  if (!await confirmBox({ title, body, admin, ok })) return false;
  const r = await act(b, () => api("/api/gaming/apply", payload), "…");
  if (!r) return false;
  toast(done, 6000);
  await gamingData(true).catch(() => {});
  show(state.view);
  return true;
}

// ================================================================== JEU ===
V.gaming = async () => {
  const v = $("#view-gaming");
  const d = await gLoad(v, "Vérification de ton PC de jeu");
  if (!d) return;
  const startup = await api("/api/startup").catch(() => []);
  v.innerHTML = "";
  const n = d.issues.length;
  const pill = el(`<div class="g-pill ${n ? "" : "ok"}"><i></i><span></span></div>`);
  $("span", pill).textContent = n ? `${n} point${n > 1 ? "s" : ""} à regarder` : "Rien à corriger";
  pill.title = d.issues.join(" · ");
  v.append(head("Gaming", "Ce qui freine vraiment tes jeux, mesuré sur ton PC. Chaque réglage est expliqué, et Sonde n'applique rien sans ton accord.", pill));

  const cols = el(`<div class="g-cols3"></div>`);
  cols.append(hzCard(d), ramCard(d), bloatCard());
  v.append(cols);
  v.append(backgroundPanel(d, startup));
  v.append(winPanel(d));
};

// --- Fréquence de l'écran
function hzCard(d) {
  const ds = d.displays;
  const shown = ds.find((x) => x.max > x.hz + 5) || ds.find((x) => x.primary) || ds[0];
  const c = el(`<div class="panel g-card"><div class="g-head"><div class="tile" style="background:${G("#0284c7", "#22d3ee")}">${svg(GI.screen)}</div><span class="gt">Fréquence de l'écran</span><span class="gtag"></span></div>
    <div class="hz-now"><b></b><span></span></div>
    <div class="hzfx"></div>
    <p class="g-p">Un écran 144 ou 165 Hz qui tourne à 60 Hz arrive souvent, par exemple après un changement de câble ou de pilote. Sonde lit les fréquences possibles et propose la plus haute, en un clic.</p>
    <div class="g-meta"></div><div class="g-act"></div></div>`);
  if (!shown) {
    $(".hz-now b", c).innerHTML = na;
    return c;
  }
  const low = shown.max > shown.hz + 5;
  $(".gtag", c).innerHTML = low ? gTag(`${shown.hz} Hz au lieu de ${shown.max}`, "warn") : gTag("Au maximum", "good");
  $(".hz-now b", c).textContent = `${shown.hz} Hz`;
  $(".hz-now b", c).style.color = low ? "var(--warn)" : "var(--safe)";
  $(".hz-now span", c).textContent = low ? `sur un écran ${shown.max} Hz` : "la plus haute possible";
  // Aperçu ralenti : un point qui avance par à-coups, d'autant plus fins que la fréquence est haute.
  const fx = $(".hzfx", c);
  for (const hz of [60, Math.max(shown.max, 120)]) {
    const r = el(`<div class="hzfx-row"><span>${hz} Hz</span><div class="hzfx-track"><i style="animation:hzmove 1.6s steps(${Math.round(hz * .15)}) infinite alternate;background:${hz === 60 ? "var(--warn)" : "var(--safe)"};box-shadow:0 0 10px ${hz === 60 ? "var(--warn)" : "var(--safe)"}"></i></div></div>`);
    fx.append(r);
  }
  fx.append(el(`<div class="hzfx-note">aperçu ralenti de la fluidité</div>`));
  const modes = (shown.modes || []).filter((m) => m >= 50);
  $(".g-meta", c).textContent = [shown.name, shown.conn, modes.length ? `${modes.join(", ")} Hz` : null].filter(Boolean).join(" · ")
    + (ds.length > 1 ? ` · ${ds.length} écrans : ${ds.map((x) => `${x.name} ${x.hz} Hz`).join(", ")}` : "");
  $(".g-act", c).append(low
    ? btn(`Passer à ${shown.max} Hz`, (b) => gApply(`Passer ${shown.name} à ${shown.max} Hz ?`,
      `<p>L'écran et la carte graphique acceptent ${shown.max} Hz en ${shown.width}×${shown.height}.</p><p>L'écran peut clignoter une seconde. Si l'image ne revient pas, elle reprend toute seule l'ancienne fréquence au bout de quelques secondes, et le journal permet d'annuler.</p>`,
      { id: "hz", params: { device: shown.device, hz: shown.max } }, { b, ok: `Passer à ${shown.max} Hz`, done: `Écran réglé sur ${shown.max} Hz. Annulable depuis le journal.` }), "primary")
    : Object.assign(btn("✓ Au maximum", () => {}), { disabled: true }));
  return c;
}

// --- Vitesse de la RAM (EXPO / XMP)
function ramCard(d) {
  const r = d.ram;
  const c = el(`<div class="panel g-card"><div class="g-head"><div class="tile" style="background:${G("#7c3aed", "#a78bfa")}">${svg(GI.ram)}</div><span class="gt">Vitesse de la RAM</span><span class="gtag"></span></div>
    <div class="ram-bars"></div>
    <p class="g-p">Sonde compare la vitesse réelle à la vitesse prévue par les barrettes (Win32_PhysicalMemory). Si l'EXPO n'est pas activé dans le BIOS, le gain sur les FPS minimum est réel. Sonde ne peut pas l'activer depuis Windows, mais peut expliquer comment.</p>
    <div class="g-meta"></div><div class="ram-steps" hidden></div><div class="g-act"></div></div>`);
  if (!r) { $(".ram-bars", c).innerHTML = na; return c; }
  const prof = r.profile;
  $(".gtag", c).innerHTML = r.slow ? gTag(`${prof} désactivé`, "warn") : r.rated ? gTag(`${prof} actif`, "good") : gTag("Vitesse prévue inconnue");
  const top = Math.max(r.rated || 0, r.conf);
  $(".ram-bars", c).innerHTML = `
    <div><div class="rb-l"><span>Vitesse réelle</span><b style="color:${r.slow ? "var(--warn)" : "var(--text)"}">${nf0.format(r.conf)} MT/s</b></div>
      <div class="rb-t"><span class="fx-bar" style="width:${(r.conf / top) * 100}%;background:${r.slow ? "linear-gradient(90deg,#d97706,#ffc85e)" : "linear-gradient(90deg,var(--a1),var(--a3))"}"></span></div></div>
    <div><div class="rb-l"><span>Prévue par les barrettes</span><b>${r.rated ? `${nf0.format(r.rated)} MT/s` : na}</b></div>
      <div class="rb-t">${r.rated ? `<span class="fx-bar" style="width:100%"></span>` : ""}</div></div>`;
  $(".g-meta", c).textContent = [`${r.count} × ${size(r.stick).replace(",0 ", " ")} ${r.ddr}`.trim(), r.rated ? `profil ${prof} ${r.rated}${r.cl ? ` CL${r.cl}` : ""}` : r.part].filter(Boolean).join(" · ");
  const steps = [
    "Redémarre et appuie sur Suppr (ou F2) pendant l'allumage pour entrer dans le BIOS.",
    `Cherche ${prof === "XMP" ? "XMP" : "EXPO (ou XMP sur Intel)"}, souvent dans l'onglet « Ai Tweaker », « OC » ou « Extreme Tweaker ».`,
    "Choisis le profil 1, enregistre avec F10 et redémarre.",
    `Rouvre Sonde : la vitesse réelle doit afficher ${r.rated ? `${r.rated} MT/s` : "la vitesse prévue"}.`,
  ];
  const box = $(".ram-steps", c);
  box.innerHTML = steps.map((t, i) => `<div><span>${i + 1}</span><span>${esc(t)}</span></div>`).join("");
  const b = btn("Comment l'activer", () => { box.hidden = !box.hidden; b.textContent = box.hidden ? "Comment l'activer" : "Masquer les étapes"; });
  $(".g-act", c).append(b);
  return c;
}

// --- Latence sous charge (bufferbloat)
function bloatCard() {
  const c = el(`<div class="panel g-card"><div class="g-head"><div class="tile" style="background:${G("#be185d", "#ec4899")}">${svg(GI.wave)}</div><span class="gt">Latence sous charge</span><span class="g-mono">bufferbloat</span></div>
    <div class="bb-top"><div class="bb-grade">…</div><div class="bb-vals"><div><div class="k">Au repos</div><b class="idle">—</b></div><div><div class="k">Sous charge</div><b class="load">—</b></div></div></div>
    <div class="bb-scale">${GRADES.map((g) => `<div data-g="${g}">${g}</div>`).join("")}</div>
    <p class="g-p">Le ping est mesuré pendant un gros téléchargement. C'est la vraie cause des pics de lag quand quelqu'un regarde Netflix à côté. Sonde donne une note de A à F, et conseille d'activer la qualité de service (QoS) de la box si besoin.</p>
    <div class="bb-advice"></div><div class="g-act"></div></div>`);
  const paint = (bb) => {
    const g = bb?.grade;
    $(".bb-grade", c).textContent = g || "…";
    $(".bb-grade", c).style.background = g ? GRADE_BG[g] : "rgba(255,255,255,.08)";
    $(".bb-grade", c).style.boxShadow = g ? `0 10px 30px ${GRADE_GLOW[g]}` : "none";
    $$(".bb-scale div", c).forEach((x) => { x.classList.toggle("on", x.dataset.g === g); x.style.background = x.dataset.g === g ? GRADE_BG[g] : ""; });
    if (!bb) { $(".bb-advice", c).textContent = "Environ 20 secondes. Évite de lancer un téléchargement pendant la mesure."; return; }
    $(".idle", c).textContent = bb.idle.avg != null ? `${bb.idle.avg} ms` : "—";
    const worst = [bb.down, bb.up].filter((p) => !p.failed && p.avg != null).sort((a, b) => b.avg - a.avg)[0];
    $(".load", c).textContent = worst ? `${worst.avg} ms` : "—";
    $(".load", c).style.color = bb.extra > 60 ? "var(--warn)" : "";
    const good = ["A+", "A"].includes(g);
    const fails = [bb.down.failed ? `téléchargement : ${bb.down.reason || "mesure impossible"}` : "", bb.up.failed ? `envoi : ${bb.up.reason || "mesure impossible"}` : ""].filter(Boolean).join(" · ");
    $(".bb-advice", c).textContent = (good ? `+${bb.extra} ms sous charge : ta connexion reste réactive même chargée.`
      : `+${bb.extra} ms sous charge. Active la qualité de service (QoS ou SQM) dans l'interface de la box pour protéger le ping du jeu ; sinon, évite les gros téléchargements pendant tes parties.`) + (fails ? ` (${fails})` : "");
    $(".bb-advice", c).style.color = good ? "var(--safe)" : "var(--warn)";
  };
  paint(gBloat);
  const run = btn(gBloat ? "Relancer le test" : "Lancer le test", async (b) => {
    b.disabled = true; b.textContent = "Test en cours…";
    $(".bb-advice", c).style.color = "";
    $(".bb-advice", c).textContent = "Mesure du ping au repos…";
    try {
      await streamApi("/api/gaming/test", { what: "bloat" }, (e) => {
        if (e.type === "idle") $(".idle", c).textContent = e.idle.avg != null ? `${e.idle.avg} ms` : "—";
        else if (e.type === "step" && e.phase !== "idle") $(".bb-advice", c).textContent = `Mesure du ping pendant un gros ${e.phase === "down" ? "téléchargement" : "envoi"}…`;
        else if (e.type === "live") $(".load", c).textContent = `${e.ms} ms`;
        else if (e.type === "done") { gBloat = e.bufferbloat; paint(gBloat); }
        else if (e.type === "error") { toast(e.error, 7000); $(".bb-advice", c).textContent = e.error; }
      });
    } catch (err) { toast(err.message); }
    b.disabled = false; b.textContent = "Relancer le test";
  });
  $(".g-act", c).append(run);
  return c;
}

// --- Ce qui tourne en fond
function backgroundPanel(d, startup) {
  const p = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Ce qui tourne en fond pendant le jeu</div>
    <div class="sp-desc">Launchers lancés au démarrage, overlays, synchronisation OneDrive, Windows Update. Sonde propose de couper le démarrage automatique de ceux que tu n'utilises pas.</div></div><div class="cut"></div></div>
    <div class="bg-cols"><div><div class="bg-sub">Lancés au démarrage de Windows</div><div class="bg-l"></div></div><div><div class="bg-sub">En ce moment</div><div class="bg-r"></div></div></div></div>`);
  const now = Date.now();
  const items = [];
  for (const s of startup) {
    const L = LAUNCHERS.find((x) => x.re.test(s.name) || x.re.test(s.command || ""));
    if (!L || items.some((i) => i.s.id === s.id)) continue;
    const used = d.launcherUse[L.name] || null;
    // « Peu utilisé » : ouvert il y a plus d'un mois. Sans date connue, on ne présume rien.
    items.push({ s, L, used, rare: !!used && now - used > RARE_DAYS * 864e5 });
  }
  const left = $(".bg-l", p);
  const draw = () => {
    left.innerHTML = "";
    for (const i of items) {
      const r = el(`<div class="lrow fx-row"><div class="ini" style="background:${G(...i.L.c)};opacity:${i.s.enabled ? 1 : .4}"></div>
        <div><div class="t"></div><div class="s"></div></div><span class="rare"></span><span class="sw"></span></div>`);
      $(".ini", r).textContent = initials(i.L.name);
      $(".t", r).textContent = i.s.name;
      $(".s", r).textContent = i.used ? `ouvert ${ago(i.used)}` : "dernière ouverture inconnue";
      if (i.rare && i.s.enabled) $(".rare", r).innerHTML = gTag("Peu utilisé", "warn");
      const sw = switchEl(i.s.enabled, (on) => toggle(i, on));
      $(".sw", r).append(sw);
      r.onclick = (e) => { if (!e.target.closest("button")) sw.click(); };
      left.append(r);
    }
    if (!items.length) left.append(el(`<div class="empty">Aucun launcher ne démarre avec Windows.</div>`));
    const rare = items.filter((i) => i.rare && i.s.enabled);
    const cut = $(".cut", p);
    cut.innerHTML = "";
    const b = btn(rare.length ? `Couper les ${rare.length} peu utilisés` : "✓ Rien à couper", async () => {
      if (!await confirmBox({ title: `Couper ${rare.length} launcher${rare.length > 1 ? "s" : ""} au démarrage ?`, admin: rare.some((i) => i.s.scope === "machine"),
        body: `<p>${rare.map((i) => esc(i.s.name)).join(", ")} ne démarreront plus avec Windows. Ils restent installés et s'ouvrent normalement quand tu les lances.</p>`, ok: "Couper" })) return;
      for (const i of rare) if (await act(null, () => api("/api/startup/set", { id: i.s.id, enable: false }))) i.s.enabled = false;
      toast("Ces launchers ne démarreront plus avec Windows. Annulable depuis le journal.", 6000);
      draw();
    }, rare.length ? "primary" : "");
    b.disabled = !rare.length;
    cut.append(b);
  };
  async function toggle(i, on) {
    if (i.s.scope === "machine" && !await confirmBox({ title: `${on ? "Activer" : "Désactiver"} ${i.s.name} au démarrage ?`, admin: true, body: "Cette entrée concerne tous les utilisateurs du PC." })) return draw();
    if (await act(null, () => api("/api/startup/set", { id: i.s.id, enable: on }))) { i.s.enabled = on; toast(`${i.s.name} ${on ? "démarrera" : "ne démarrera plus"} avec Windows.`); }
    draw();
  }
  draw();

  // En ce moment : overlays, OneDrive, Windows Update.
  const right = $(".bg-r", p);
  const nowRow = (icon, tile, name, desc, action) => {
    const r = el(`<div class="lrow now fx-row"><div class="tile sm" style="background:${tile}">${svg(icon)}</div><div><div class="t"></div><div class="s"></div></div><span class="a"></span></div>`);
    $(".t", r).textContent = name; $(".s", r).textContent = desc;
    if (action) $(".a", r).append(action);
    right.append(r);
  };
  const overlays = d.background.filter((b) => b.kind === "overlay" || b.name === "Steam" || /NVIDIA/.test(b.name));
  nowRow(GI.overlay, G("#4f46e5", "#818cf8"), overlays.length ? `Overlays : ${overlays.map((b) => b.name).join(", ")}` : "Overlays",
    overlays.length ? "Actifs dans tous les jeux. Coût faible, sauf avec certains anti-triche." : "Aucun overlay ne tourne en ce moment.");
  const od = d.background.find((b) => b.name === "OneDrive");
  nowRow(GI.cloud, G("#0369a1", "#0ea5e9"), "Synchronisation OneDrive",
    od ? `En cours d'exécution · ${size(od.mem)} de mémoire. La pause se fait depuis son icône, près de l'horloge.` : "OneDrive ne tourne pas.");
  const wu = d.wuPause;
  const wuBtn = wu ? null : btn("Suspendre 1 semaine", (b) => gApply("Suspendre Windows Update pendant 1 semaine ?",
    "<p>Windows ne téléchargera ni n'installera de mise à jour pendant 7 jours, comme avec « Suspendre pendant 1 semaine » dans les Paramètres. Les mises à jour reprennent toutes seules ensuite.</p>",
    { id: "wupause" }, { admin: true, b, ok: "Suspendre", done: "Windows Update suspendu pendant 1 semaine. Annulable depuis le journal." }));
  nowRow(GI.update, G("#475569", "#64748b"), "Windows Update", wu ? `En pause jusqu'au ${new Date(wu).toLocaleDateString("fr-FR")}` : "Pas en pause. Téléchargement en cours : Non disponible.", wuBtn);
  return p;
}

// --- Réglages Windows liés au jeu
function winPanel(d) {
  const w = d.win;
  const p = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Réglages Windows liés au jeu</div><div class="sp-desc">Ce que chaque réglage change vraiment, et ce que Sonde conseille.</div></div></div><div class="sp-body"></div></div>`);
  const body = $(".sp-body", p);
  const row = (title, desc, ok, tagText, ctl) => {
    const r = el(`<div class="wg-row fx-row"><div><div class="t"></div>${gTag(tagText, ok ? "good" : "warn")}</div><div class="d"></div><div class="c"></div></div>`);
    $(".t", r).textContent = title; $(".d", r).textContent = desc; $(".c", r).append(ctl);
    body.append(r);
  };
  const tg = (on, id, title, body_, extra = {}) => {
    const wrap = el(`<label class="wg-tg"><span></span></label>`);
    $("span", wrap).textContent = on ? "Activé" : "Désactivé";
    wrap.append(switchEl(on, (next) => gApply(`${next ? "Activer" : "Désactiver"} : ${title} ?`, `<p>${esc(body_)}</p>`, { id, on: next }, { ...extra, ok: next ? "Activer" : "Désactiver" })));
    return wrap;
  };
  const W = [
    ["gamemode", "Mode Jeu", "Windows donne la priorité au jeu au premier plan et repousse les installations de mises à jour et les notifications. Gain faible, sans contrepartie.", w.gameMode, true, {}],
    ["hags", "Planification GPU accélérée par le matériel", "La carte graphique gère elle-même sa file d'images. Réduit un peu la latence, et sert à la génération d'images (AMD Fluid Motion Frames, DLSS Frame Generation). Redémarrage nécessaire.", w.hags, true, { admin: true, done: "Fait. Redémarre le PC pour que ce soit pris en compte." }],
    ["bgrecord", "Enregistrement en arrière-plan (Game Bar)", "Enregistre en continu les dernières secondes de jeu. Coûte quelques pour cent de FPS et une partie de l'encodeur vidéo. L'enregistrement manuel reste possible si tu le coupes.", w.bgRecord, false, {}],
  ];
  for (const [id, title, desc, on, keepOn, extra] of W) {
    const ok = on === keepOn;
    row(title, desc, ok, ok ? (keepOn ? "Conseil : laisser activé" : "Bien réglé") : (keepOn ? "Conseil : activer" : "Conseil : couper"), tg(on, id, title, desc, extra));
  }
  // Mode d'alimentation : trois choix, ceux qui existent sur ce PC.
  const PW = [["saver", "Économie"], ["balanced", "Équilibré"], ["high", "Performances"]];
  const seg = el(`<div class="segs sm"></div>`);
  for (const [k, label] of PW) {
    const b = el(`<button class="${w.plan.active === k ? "on" : ""}"></button>`);
    b.textContent = label;
    b.disabled = !w.plan.available.includes(k);
    if (b.disabled) b.title = "Ce mode n'existe pas sur ce PC.";
    b.onclick = () => w.plan.active !== k && gApply(`Passer en mode ${label} ?`, `<p>Même réglage que « Options d'alimentation » dans le Panneau de configuration.</p>`, { id: "power", params: { plan: k } }, { ok: label });
    seg.append(b);
  }
  row("Mode d'alimentation", `Sur un PC fixe récent, Équilibré suffit : le processeur monte en fréquence en quelques millisecondes. Performances évite seulement de rares baisses de fréquence. Économie bride le jeu.${w.plan.active ? "" : ` Mode actuel : ${w.plan.name || "Non disponible"}.`}`,
    w.plan.active !== "saver", w.plan.active === "saver" ? "Conseil : Équilibré" : "Bien réglé", seg);
  const mDesc = "C'est l'accélération de la souris : la distance parcourue dépend de la vitesse du geste. La couper rend la visée constante. Beaucoup de jeux l'ignorent déjà.";
  row("Précision du pointeur", mDesc, !w.mouseAccel, w.mouseAccel ? "Conseil : couper" : "Bien réglé", tg(w.mouseAccel, "mouse", "Précision du pointeur", mDesc));
  return p;
}

// ============================================================ COMPOSANTS ===
V["gaming-hw"] = async () => {
  const v = $("#view-gaming-hw");
  const d = await gLoad(v, "Lecture des composants");
  if (!d) return;
  v.innerHTML = "";
  v.append(head("Composants", "Carte graphique, stockage et sécurité, vus sous l'angle du jeu."));

  // --- Carte graphique : la plus grosse mémoire vidéo (pas le processeur graphique intégré).
  const g = [...d.gpus].sort((a, b) => (b.vram || 0) - (a.vram || 0))[0];
  const gp = el(`<div class="gpu-hero"><div class="gpu-top"><div class="gpu-logo"></div><div><div class="gpu-name"></div><div class="gpu-sub"></div></div></div><div class="gpu-cards"></div></div>`);
  if (!g) { $(".gpu-name", gp).textContent = "Carte graphique"; $(".gpu-sub", gp).innerHTML = na; }
  else {
    const V_ = { amd: ["AMD", G("#b91c1c", "#f43f5e")], nvidia: ["NVIDIA", G("#15803d", "#4ade80")], intel: ["Intel", G("#1d4ed8", "#60a5fa")] }[g.vendor] || ["GPU", G("#475569", "#64748b")];
    $(".gpu-logo", gp).textContent = V_[0];
    $(".gpu-logo", gp).style.background = V_[1];
    $(".gpu-name", gp).textContent = g.name;
    $(".gpu-sub", gp).textContent = `${g.vram ? `${Math.round(g.vram / 1024 ** 3)} Go de mémoire vidéo` : "mémoire vidéo : Non disponible"} · carte graphique`;
    const cards = $(".gpu-cards", gp);
    const hc = (label, tag, value, text, extra) => {
      const c = el(`<div class="hw-card"><div class="hc-top"><span></span>${tag}</div><div class="hc-v"></div><div class="hc-d"></div></div>`);
      $(".hc-top span", c).textContent = label; $(".hc-v", c).innerHTML = value; $(".hc-d", c).textContent = text;
      if (extra) c.append(extra);
      cards.append(c);
    };
    // Pilote
    const old = g.age != null && g.age > 180;
    const ageTxt = g.age == null ? "date inconnue" : g.age < 31 ? (g.age <= 1 ? "Récent" : `Il y a ${g.age} jours`) : `Il y a ${Math.round(g.age / 30)} mois`;
    const link = el(`<a class="hc-link" href="#"></a>`);
    link.textContent = "Télécharger la mise à jour ↗";
    link.onclick = (e) => { e.preventDefault(); openTool(g.vendor === "nvidia" ? "nvidia" : "amd"); };
    hc(g.vendor === "amd" ? "Pilote AMD Adrenalin" : g.vendor === "nvidia" ? "Pilote NVIDIA" : "Pilote", gTag(ageTxt, old ? "warn" : "good"),
      esc(g.software || g.driver || "?"), `${g.date ? `Installé le ${new Date(g.date).toLocaleDateString("fr-FR")}. ` : ""}Dernière version disponible : Non disponible (Sonde n'interroge pas le site du fabricant). Les nouveaux pilotes corrigent souvent des saccades dans les jeux récents.`,
      ["amd", "nvidia"].includes(g.vendor) ? link : null);
    // Port PCIe : 16 voies dessinées
    const known = g.width != null && g.maxWidth != null;
    const full = known && g.width >= g.maxWidth && (g.gen == null || g.maxGen == null || g.gen >= g.maxGen);
    const lanes = el(`<div class="lanes"></div>`);
    const total = Math.max(16, g.maxWidth || 16);
    for (let i = 0; i < total; i++) lanes.append(el(`<i class="${known && i < g.width ? "on" : ""}"></i>`));
    hc("Port PCIe", known ? gTag(full ? "Comme prévu" : `x${g.width} au lieu de x${g.maxWidth}`, full ? "good" : "warn") : gTag("Non disponible"),
      known ? `x${g.width}${g.gen ? ` · PCIe ${g.gen}.0` : ""}` : na,
      full ? "Une carte branchée en x4 au lieu de x16, ça arrive : mauvais emplacement ou carte mal enfoncée. Ici, tout est en place."
        : known ? "La carte communique sur moins de voies qu'elle ne peut : mauvais emplacement, carte mal enfoncée, ou voies partagées avec un SSD M.2. Vérifie le manuel de la carte mère." : "Windows n'a pas donné la largeur du port.", lanes);
    // Resizable BAR : Windows ne l'expose pas de façon fiable.
    hc(g.vendor === "amd" ? "Smart Access Memory" : "Resizable BAR", gTag("Non disponible"), "Resizable BAR",
      `Windows ne donne pas cette information de façon fiable. Elle se vérifie dans ${g.vendor === "amd" ? "AMD Software › Performances › Réglages" : g.vendor === "nvidia" ? "le Panneau de configuration NVIDIA › Informations système" : "le logiciel du pilote"} ou dans le BIOS.`);
  }
  v.append(gp);

  const grid = el(`<div class="hw-grid"></div>`);
  // --- Stockage des jeux
  const st = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Stockage des jeux</div><div class="sp-desc">Sonde connaît l'emplacement des jeux et le type de chaque disque.</div></div></div><div class="sp-body"></div></div>`);
  for (const k of d.disks) {
    const hdd = k.media === "Disque dur";
    const pct = k.size ? (1 - k.free / k.size) * 100 : 0;
    const warn = hdd || pct > 90;
    const r = el(`<div class="disk-item fx-row"><div class="di-top"><div class="tile sm" style="background:${hdd ? G("#78350f", "#d97706") : G("#0f766e", "#14b8a6")}"></div>
      <div class="di-n"><div class="t"></div><div class="s"></div></div>${gTag(k.media ? `${k.media}${hdd ? ` · ${Math.round(pct)} %` : ""}` : "type inconnu", k.media ? (warn ? "warn" : "good") : "")}</div>
      <div class="di-bar"><span class="fx-bar" style="width:${pct}%;${warn ? "background:linear-gradient(90deg,#d97706,#ffc85e)" : ""}"></span></div><div class="di-games"></div></div>`);
    $(".tile", r).textContent = k.letter;
    $(".t", r).textContent = k.model ? `${k.model}${k.media ? ` · ${k.media}` : ""}` : k.letter;
    $(".s", r).textContent = `${size(k.free)} libres sur ${size(k.size)} · ${k.games.length} jeu${k.games.length > 1 ? "x" : ""}`;
    const gm = $(".di-games", r);
    for (const n of k.games.slice(0, 3)) { const s = el(`<span></span>`); s.textContent = n; gm.append(s); }
    if (k.games.length > 3) gm.append(el(`<span>+ ${k.games.length - 3} autres</span>`));
    $(".sp-body", st).append(r);
  }
  if (!d.disks.length) $(".sp-body", st).innerHTML = `<div class="empty">Disques : Non disponible.</div>`;
  const onHdd = d.games.filter((x) => x.media === "Disque dur");
  if (onHdd.length) {
    const full = d.disks.some((k) => k.media === "Disque dur" && k.games.length && k.free / k.size < .15);
    st.append(el(`<div class="g-alert">${onHdd.length} jeu${onHdd.length > 1 ? "x sont" : " est"} sur un disque dur classique${full ? ", presque plein" : ""}. Pour ceux auxquels tu joues, Steam › Propriétés › Fichiers installés › Déplacer vers un SSD.</div>`));
  } else if (!d.games.length) st.append(el(`<div class="g-note">Aucun jeu trouvé. Lance un scan des disques où sont tes jeux pour qu'ils apparaissent ici.</div>`));

  const right = el(`<div class="hw-right"></div>`);
  // --- Isolation du noyau
  const hv = d.win.hvci;
  const iso = el(`<div class="panel g-card"><div class="g-head"><div class="tile" style="background:${G("#059669", "#34d399")}">${svg(GI.shield)}</div><span class="gt">Isolation du noyau</span>${gTag(hv ? "Activée · compromis" : "Désactivée")}</div>
    <p class="g-p"></p><div class="g-act"></div></div>`);
  $(".g-p", iso).textContent = hv
    ? "L'intégrité de la mémoire empêche un pilote malveillant de modifier le cœur de Windows. Elle coûte quelques pour cent dans certains jeux, et souvent rien. C'est une vraie protection : Sonde ne la coupe pas et ne te pousse pas à le faire."
    : "L'intégrité de la mémoire est désactivée : un pilote malveillant pourrait modifier le cœur de Windows. Son coût en jeu est faible (quelques pour cent au plus, souvent rien). Sonde ne la change pas : c'est à toi de choisir, dans Sécurité Windows.";
  $(".g-act", iso).append(btn("Ouvrir Sécurité Windows ↗", () => openTool("coreisolation")));
  right.append(iso);
  // --- Caches de shaders : sélection et corbeille de l'app.
  const sh = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Caches de shaders</div><div class="sp-desc">À vider en cas de saccades ou de plantages au chargement. Les jeux les recompilent : le premier lancement sera plus long.</div></div></div><div class="rows"></div></div>`);
  for (const s of d.shaders) $(".rows", sh).append(rowEl({ path: s.path, name: s.name.replace(/^Cache de shaders /, ""), size: s.size, type: "dir", contenu: true, niveau: "sur", count: s.count },
    { sub: esc(short(s.path)), tile: G("#7c3aed", "#c084fc") }));
  if (!d.shaders.length) $(".rows", sh).append(el(`<div class="empty">Aucun cache de shaders trouvé.</div>`));
  right.append(sh);
  grid.append(st, right);
  v.append(grid);
};

// ================================================================ RÉSEAU ===
V["gaming-net"] = async () => {
  const v = $("#view-gaming-net");
  const d = await gLoad(v, "Lecture de la connexion");
  if (!d) return;
  v.innerHTML = "";
  const again = btn("Re-tester", () => runPing(again), "primary");
  v.append(head("Réseau pour le jeu", "Ping vers les vrais serveurs de jeu. Le ping vers Google ne veut pas dire grand-chose.", again));

  const list = el(`<div class="panel ping-list"></div>`);
  v.append(list);
  const COLORS = { riot: ["#b91c1c", "#ef4444"], steam: ["#1e3a8a", "#3b82f6"], epic: ["#27272a", "#52525b"], blizzard: ["#0369a1", "#38bdf8"], valve: ["#9a3412", "#f97316"], google: ["#334155", "#64748b"] };
  const drawPings = (busy = null) => {
    list.innerHTML = "";
    for (const s of d.servers) {
      const m = gPings?.[s.id];
      const ms = m?.avg;
      const col = s.ref ? "rgba(255,255,255,.25)" : ms == null ? "rgba(255,255,255,.1)" : ms < 30 ? "var(--safe)" : ms < 60 ? "var(--warn)" : "var(--bad)";
      const r = el(`<div class="ping-row fx-row ${s.ref ? "ref" : ""}"><div class="ini" style="background:${G(...COLORS[s.id])}"></div><div><div class="t"></div><div class="s"></div></div>
        <div class="pr-bar"><span class="fx-bar" style="width:${ms != null ? Math.min(100, (ms / 60) * 100) : 0}%;background:${col}"></span></div><span class="pr-ms"></span></div>`);
      $(".ini", r).textContent = s.name[0];
      $(".t", r).textContent = s.name;
      $(".s", r).textContent = m?.where ? `${s.where === "le plus proche" ? "le plus proche · " : ""}${m.where}` : s.where;
      const out = $(".pr-ms", r);
      if (m) { out.innerHTML = ms != null ? `${ms} ms` : na; out.style.color = s.ref ? "rgba(236,233,255,.5)" : ms == null ? "" : col; if (ms != null) out.title = `gigue ${m.jitter} ms · pertes ${m.loss} %`; }
      else out.innerHTML = busy ? `<span class="working"></span>` : "—";
      list.append(r);
    }
  };
  async function runPing(b) {
    b.disabled = true;
    gPings = {};
    drawPings(true);
    try {
      await streamApi("/api/gaming/test", { what: "ping" }, (e) => {
        if (e.type === "ping") { gPings[e.id] = e; if (list.isConnected) drawPings(true); }
        else if (e.type === "error") toast(e.error, 7000);
      });
    } catch (err) { toast(err.message); }
    b.disabled = false;
    if (list.isConnected) drawPings();
  }
  drawPings();
  // Premier passage : le test se lance tout seul (quelques secondes, très peu de données).
  if (!gPings) runPing(again);

  const cards = el(`<div class="g-cols3 net3"><div class="panel g-card wired"><div class="loading-s working">Lecture de la carte réseau</div></div>
    <div class="panel g-card nat"><div class="loading-s working">Test du NAT et de l'UPnP</div></div><div class="panel g-card bw"><div class="loading-s working">Mesure du trafic en cours</div></div></div>`);
  v.append(cards);
  let n = gNet;
  if (!n || Date.now() - n.at > 60000) {
    try { n = gNet = { ...(await api("/api/gaming/net")), at: Date.now() }; } catch (e) { $$(".loading-s", cards).forEach((x) => { x.className = "na"; x.textContent = e.message; }); return; }
  }
  if (!cards.isConnected) return;
  // Wi-Fi ou câble
  const a = n.adapter;
  const wired = $(".wired", cards);
  const wifiTxt = a?.wifi ? [n.wifi?.band, n.wifi?.signal != null ? `signal ${n.wifi.signal} %` : null].filter(Boolean).join(" · ") : "";
  wired.innerHTML = `<div class="gc-h"><span>Wi-Fi ou câble</span>${a ? gTag(a.wifi ? "Wi-Fi" : "Câble", a.wifi ? "warn" : "good") : gTag("Non disponible")}</div>
    <div class="gc-v">${a ? `${a.wifi ? "Wi-Fi" : "Ethernet"} · ${esc(a.speed >= 1e9 ? `${nf1.format(a.speed / 1e9)} Gb/s` : `${nf0.format(a.speed / 1e6)} Mb/s`)}` : na}</div>
    <div class="gc-d"></div>`;
  $(".gc-d", wired).textContent = !a ? "Aucune carte réseau connectée." : a.wifi
    ? `${wifiTxt ? `${wifiTxt}. ` : ""}En Wi-Fi, préfère la bande 5 ou 6 GHz, rapproche-toi de la box, et coupe l'économie d'énergie de la carte (page Réseau). Le câble reste le plus stable pour jouer.`
    : "Le meilleur cas pour jouer : pas d'interférences ni de variations de signal.";
  // NAT et UPnP
  const nat = $(".nat", cards);
  const NAT = { open: ["Ouvert", "good"], moderate: ["Modéré", "warn"], strict: ["Strict", "bad"] }[n.nat] || ["Non disponible", ""];
  nat.innerHTML = `<div class="gc-h"><span>Type de NAT et UPnP</span>${gTag(NAT[0], NAT[1])}</div>
    <div class="gc-chips"><span>NAT ${esc(NAT[0].toLowerCase())}</span><span class="${n.upnp?.found ? "ok" : "bad"}">UPnP ${n.upnp?.found ? "actif" : "non détecté"}</span></div>
    <div class="gc-d">${n.nat ? "Estimé avec deux serveurs STUN : " : ""}${n.nat === "strict" ? "le port public change selon le serveur contacté, ce qui gêne le multijoueur pair à pair et le chat de groupe." : n.nat ? "le port public reste le même d'un serveur à l'autre." : "Le test n'a pas abouti."} Utile pour le chat de groupe et le multijoueur Xbox. Activer l'UPnP dans l'interface de la box suffit le plus souvent à passer en NAT ouvert.</div>`;
  if (n.gateway) {
    const l = el(`<a class="hc-link" target="_blank" rel="noopener"></a>`);
    l.href = `http://${n.gateway}`;
    l.textContent = `Ouvrir la box (${n.gateway}) ↗`;
    nat.append(l);
  }
  // Bande passante utilisée en ce moment
  const bw = $(".bw", cards);
  const rate = (x) => `${nf1.format((x * 8) / 1e6)} Mb/s`;
  bw.innerHTML = `<div class="gc-h"><span>Bande passante utilisée</span></div><div class="gc-v">${n.rate ? `↓ ${rate(n.rate.down)} · ↑ ${rate(n.rate.up)}` : na}</div>
    <div class="gc-d">Mesuré sur la carte réseau pendant 2 secondes. Le détail par programme : Non disponible (Windows ne le donne pas sans outil de capture).</div><div class="bw-rows"></div>`;
  const rows = $(".bw-rows", bw);
  const wu = d.wuPause;
  const r = el(`<div class="lrow"><div><div class="t">Windows Update</div><div class="s"></div></div><span class="a"></span></div>`);
  $(".s", r).textContent = wu ? `En pause jusqu'au ${new Date(wu).toLocaleDateString("fr-FR")}` : "Pas en pause";
  if (!wu) $(".a", r).append(btn("Suspendre", (b) => gApply("Suspendre Windows Update pendant 1 semaine ?",
    "<p>Windows ne téléchargera ni n'installera de mise à jour pendant 7 jours. Les mises à jour reprennent toutes seules ensuite.</p>",
    { id: "wupause" }, { admin: true, b, ok: "Suspendre", done: "Windows Update suspendu pendant 1 semaine. Annulable depuis le journal." }), "sm"));
  rows.append(r);
  const steam = d.background.find((x) => x.name === "Steam");
  if (steam) rows.append(el(`<div class="lrow"><div><div class="t">Steam</div><div class="s">Ouvert. Ses téléchargements se mettent en pause depuis Steam › Téléchargements.</div></div></div>`));
};

// ================================================== CE QU'ON NE FAIT PAS ===
V["gaming-no"] = () => {
  const v = $("#view-gaming-no");
  v.innerHTML = "";
  v.append(head("Ce qu'on ne fait pas, et pourquoi", "Des « optimisations » qu'on trouve partout et que Sonde refuse d'appliquer."));
  const grid = el(`<div class="nope-grid"></div>`);
  for (const [t, d] of [
    ["Réglages TCPNoDelay et Nagle", "Sans effet : les jeux utilisent l'UDP. Ces clés du registre ne concernent que le TCP."],
    ["Changer de DNS pour le ping", "Le DNS n'agit que sur le chargement des sites. Une fois connecté au serveur de jeu, il ne sert plus."],
    ["« Nettoyeurs de RAM »", "Windows se sert de la mémoire libre comme cache. La vider l'oblige à tout relire depuis le disque, ce qui ralentit plutôt."],
    ["« Mode haute priorité »", "Passer un jeu en priorité haute ne lui donne pas plus de puissance, et peut faire saccader le son, la souris ou Discord."],
  ]) {
    const c = el(`<div class="panel nope"><div class="nope-i">${svg(GI.x)}</div><div><div class="t"></div><div class="d"></div></div></div>`);
    $(".t", c).textContent = t; $(".d", c).textContent = d;
    grid.append(c);
  }
  v.append(grid);
};
