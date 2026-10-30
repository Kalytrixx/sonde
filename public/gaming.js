// Sonde — page Gaming (Windows et Debian), d'après la maquette « Sonde v2 » : onglets
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
  // Debian
  { re: /heroic/i, name: "Heroic Games Launcher", c: ["#0f766e", "#2dd4bf"] },
  { re: /lutris/i, name: "Lutris", c: ["#c2410c", "#fb923c"] },
  { re: /bottles/i, name: "Bottles", c: ["#7e22ce", "#c084fc"] },
  { re: /itch/i, name: "itch", c: ["#be123c", "#fb7185"] },
];
const OS_START = () => (isLinux() ? "ta session" : "Windows");
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
    <p class="g-p"></p>
    <div class="g-meta"></div><div class="g-act"></div></div>`);
  // Sous Debian (GNOME), la fréquence se change dans Paramètres › Écrans : Sonde la lit et l'indique.
  $(".g-p", c).textContent = `Un écran 144 ou 165 Hz qui tourne à 60 Hz arrive souvent, par exemple après un changement de câble ou de pilote. ${d.canSetHz
    ? "Sonde lit les fréquences possibles et propose la plus haute, en un clic."
    : "Sonde lit les fréquences possibles et t'indique la plus haute ; elle se change dans Paramètres › Écrans."}`;
  if (!shown) {
    $(".hz-now b", c).innerHTML = na;
    if (d.displayNote) $(".g-meta", c).textContent = d.displayNote;
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
  $(".g-act", c).append(low && !d.canSetHz ? btn("Ouvrir les paramètres d'écran ↗", () => openTool("display"), "primary")
    : low ? btn(`Passer à ${shown.max} Hz`, (b) => gApply(`Passer ${shown.name} à ${shown.max} Hz ?`,
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
    <p class="g-p"></p>
    <div class="g-meta"></div><div class="ram-steps" hidden></div><div class="g-act"></div></div>`);
  $(".g-p", c).textContent = `Sonde compare la vitesse réelle à la vitesse prévue par les barrettes (${d.ramSource}). Si l'EXPO n'est pas activé dans le BIOS, le gain sur les FPS minimum est réel. Sonde ne peut pas l'activer depuis ${isLinux() ? "Debian" : "Windows"}, mais peut expliquer comment.`;
  if (!r) {
    $(".ram-bars", c).innerHTML = na;
    // Debian : la lecture des barrettes (dmidecode) demande le mot de passe administrateur.
    if (d.ramAdmin) {
      $(".g-meta", c).textContent = "La vitesse des barrettes ne se lit qu'avec les droits administrateur.";
      $(".g-act", c).append(btn("Lire la vitesse", async (b) => {
        const ram = await act(b, () => api("/api/gaming/ram", {}), "En attente de l'autorisation…");
        if (ram) { gData.ram = ram; c.replaceWith(ramCard(gData)); }
      }));
    }
    return c;
  }
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
    <div class="sp-desc">${isLinux() ? "Launchers lancés à l'ouverture de session, overlays, mises à jour automatiques" : "Launchers lancés au démarrage, overlays, synchronisation OneDrive, Windows Update"}. Sonde propose de couper le démarrage automatique de ceux que tu n'utilises pas.</div></div><div class="cut"></div></div>
    <div class="bg-cols"><div><div class="bg-sub">${isLinux() ? "Lancés à l'ouverture de session" : "Lancés au démarrage de Windows"}</div><div class="bg-l"></div></div><div><div class="bg-sub">En ce moment</div><div class="bg-r"></div></div></div></div>`);
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
    if (!items.length) left.append(el(`<div class="empty">${isLinux() ? "Aucun launcher ne démarre avec ta session." : "Aucun launcher ne démarre avec Windows."}</div>`));
    const rare = items.filter((i) => i.rare && i.s.enabled);
    const cut = $(".cut", p);
    cut.innerHTML = "";
    const b = btn(rare.length ? `Couper les ${rare.length} peu utilisés` : "✓ Rien à couper", async () => {
      if (!await confirmBox({ title: `Couper ${rare.length} launcher${rare.length > 1 ? "s" : ""} au démarrage ?`, admin: rare.some((i) => i.s.scope === "machine"),
        body: `<p>${rare.map((i) => esc(i.s.name)).join(", ")} ne démarreront plus avec ${OS_START()}. Ils restent installés et s'ouvrent normalement quand tu les lances.</p>`, ok: "Couper" })) return;
      for (const i of rare) if (await act(null, () => api("/api/startup/set", { id: i.s.id, enable: false }))) i.s.enabled = false;
      toast(`Ces launchers ne démarreront plus avec ${OS_START()}. Annulable depuis le journal.`, 6000);
      draw();
    }, rare.length ? "primary" : "");
    b.disabled = !rare.length;
    cut.append(b);
  };
  async function toggle(i, on) {
    if (i.s.scope === "machine" && !await confirmBox({ title: `${on ? "Activer" : "Désactiver"} ${i.s.name} au démarrage ?`, admin: true, body: "Cette entrée concerne tous les utilisateurs du PC." })) return draw();
    if (await act(null, () => api("/api/startup/set", { id: i.s.id, enable: on }))) { i.s.enabled = on; toast(`${i.s.name} ${on ? "démarrera" : "ne démarrera plus"} avec ${OS_START()}.`); }
    draw();
  }
  draw();

  // En ce moment : overlays, synchronisation, mises à jour (décrits par le serveur).
  const right = $(".bg-r", p);
  for (const n of d.bgNow) {
    const r = el(`<div class="lrow now fx-row"><div class="tile sm" style="background:${NOW_TILE[n.icon] || NOW_TILE.update}">${svg(GI[n.icon] || GI.update)}</div><div><div class="t"></div><div class="s"></div></div><span class="a"></span></div>`);
    $(".t", r).textContent = n.name; $(".s", r).textContent = n.desc;
    if (n.action) $(".a", r).append(actionBtn(n.action));
    right.append(r);
  }
  return p;
}
const NOW_TILE = { overlay: G("#4f46e5", "#818cf8"), cloud: G("#0369a1", "#0ea5e9"), update: G("#475569", "#64748b") };
// Bouton d'une action décrite par le serveur : confirmation, puis /api/gaming/apply.
const actionBtn = (a, cls = "") => btn(a.label, (b) => gApply(a.title, `<p>${esc(a.body)}</p>`, { id: a.id, params: a.params },
  { admin: !!a.admin, b, ok: a.ok || a.label, done: a.done }), cls);

// --- Réglages du système liés au jeu (décrits par le serveur)
function winPanel(d) {
  const p = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title"></div><div class="sp-desc">Ce que chaque réglage change vraiment, et ce que Sonde conseille.</div></div></div><div class="sp-body"></div></div>`);
  $(".sp-title", p).textContent = isLinux() ? "Réglages du système liés au jeu" : "Réglages Windows liés au jeu";
  const body = $(".sp-body", p);
  for (const t of d.tweaks) {
    let ok = t.ok, tag = t.tag, ctl;
    if (t.kind === "toggle") {
      ok = t.on === t.keepOn;
      tag = ok ? (t.keepOn ? "Conseil : laisser activé" : "Bien réglé") : (t.keepOn ? "Conseil : activer" : "Conseil : couper");
      ctl = el(`<label class="wg-tg"><span></span></label>`);
      $("span", ctl).textContent = t.on ? "Activé" : "Désactivé";
      ctl.append(switchEl(t.on, (next) => gApply(`${next ? "Activer" : "Désactiver"} : ${t.title} ?`, `<p>${esc(t.desc)}</p>`, { id: t.id, on: next },
        { admin: !!t.admin, done: t.done, ok: next ? "Activer" : "Désactiver" })));
    } else if (t.kind === "seg") {
      // Choix parmi plusieurs modes, seulement ceux qui existent sur ce PC.
      ctl = el(`<div class="segs sm"></div>`);
      for (const o of t.options) {
        const b = el(`<button class="${t.value === o.k ? "on" : ""}"></button>`);
        b.textContent = o.label;
        b.disabled = !!o.disabled;
        if (b.disabled) b.title = "Ce mode n'existe pas sur ce PC.";
        b.onclick = () => t.value !== o.k && gApply(`Passer en mode ${o.label} ?`, `<p>${esc(t.confirm || t.desc)}</p>`, { id: t.id, params: { plan: o.k } }, { ok: o.label });
        ctl.append(b);
      }
    } else ctl = t.action ? actionBtn(t.action) : el(`<span></span>`);
    const r = el(`<div class="wg-row fx-row"><div><div class="t"></div>${gTag(tag, ok ? "good" : ok === false ? "warn" : "")}</div><div class="d"></div><div class="c"></div></div>`);
    $(".t", r).textContent = t.title; $(".d", r).textContent = t.desc; $(".c", r).append(ctl);
    body.append(r);
  }
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
    if (isLinux()) {
      // Debian : le pilote libre (Mesa, noyau) se met à jour avec le système.
      link.textContent = "Voir les mises à jour de Debian ›";
      link.onclick = (e) => { e.preventDefault(); show("updates"); };
      hc(g.driverLabel || "Pilote", gTag(g.software ? "installé" : "Non disponible", g.software ? "good" : ""), esc(g.software || g.driver || "?"),
        g.driverText || "Le pilote graphique se met à jour avec Debian. Les nouvelles versions de Mesa corrigent souvent des saccades dans les jeux récents.", link);
    } else {
      link.textContent = "Télécharger la mise à jour ↗";
      link.onclick = (e) => { e.preventDefault(); openTool(g.vendor === "nvidia" ? "nvidia" : "amd"); };
      hc(g.vendor === "amd" ? "Pilote AMD Adrenalin" : g.vendor === "nvidia" ? "Pilote NVIDIA" : "Pilote", gTag(ageTxt, old ? "warn" : "good"),
        esc(g.software || g.driver || "?"), `${g.date ? `Installé le ${new Date(g.date).toLocaleDateString("fr-FR")}. ` : ""}Dernière version disponible : Non disponible (Sonde n'interroge pas le site du fabricant). Les nouveaux pilotes corrigent souvent des saccades dans les jeux récents.`,
        ["amd", "nvidia"].includes(g.vendor) ? link : null);
    }
    // Port PCIe : 16 voies dessinées
    const known = g.width != null && g.maxWidth != null;
    const full = known && g.width >= g.maxWidth && (g.gen == null || g.maxGen == null || g.gen >= g.maxGen);
    const lanes = el(`<div class="lanes"></div>`);
    const total = Math.max(16, g.maxWidth || 16);
    for (let i = 0; i < total; i++) lanes.append(el(`<i class="${known && i < g.width ? "on" : ""}"></i>`));
    hc("Port PCIe", known ? gTag(full ? "Comme prévu" : `x${g.width} au lieu de x${g.maxWidth}`, full ? "good" : "warn") : gTag("Non disponible"),
      known ? `x${g.width}${g.gen ? ` · PCIe ${g.gen}.0` : ""}` : na,
      full ? "Une carte branchée en x4 au lieu de x16, ça arrive : mauvais emplacement ou carte mal enfoncée. Ici, tout est en place."
        : known ? "La carte communique sur moins de voies qu'elle ne peut : mauvais emplacement, carte mal enfoncée, ou voies partagées avec un SSD M.2. Vérifie le manuel de la carte mère." : `${isLinux() ? "Le système" : "Windows"} n'a pas donné la largeur du port.`, lanes);
    // Resizable BAR : lisible sous Linux (taille de la fenêtre mémoire), pas de façon fiable sous Windows.
    const rb = g.rebar;
    hc(g.vendor === "amd" ? "Smart Access Memory" : "Resizable BAR", rb == null ? gTag("Non disponible") : gTag(rb ? "Activé" : "Désactivé", rb ? "good" : "warn"), "Resizable BAR",
      rb == null ? `${isLinux() ? "Le système" : "Windows"} ne donne pas cette information de façon fiable. Elle se vérifie dans ${g.vendor === "amd" ? "AMD Software › Performances › Réglages" : g.vendor === "nvidia" ? "le Panneau de configuration NVIDIA › Informations système" : "le logiciel du pilote"} ou dans le BIOS.`
        : rb ? "Le processeur accède à toute la mémoire vidéo d'un coup. Lu dans la taille de la fenêtre mémoire de la carte."
          : "Le processeur ne voit la mémoire vidéo que par une petite fenêtre (256 Mo). L'option « Resizable BAR » ou « Above 4G Decoding » du BIOS l'active ; le gain dépend des jeux.");
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
  // --- Protection du système (isolation du noyau sous Windows, démarrage sécurisé sous Debian)
  const sec = d.security;
  const iso = el(`<div class="panel g-card"><div class="g-head"><div class="tile" style="background:${G("#059669", "#34d399")}">${svg(GI.shield)}</div><span class="gt"></span>${gTag(sec.tag)}</div>
    <p class="g-p"></p><div class="g-act"></div></div>`);
  $(".gt", iso).textContent = sec.title;
  $(".g-p", iso).textContent = sec.text;
  if (sec.tool) $(".g-act", iso).append(btn(sec.button, () => openTool(sec.tool)));
  right.append(iso);
  // --- Caches de shaders : sélection et corbeille de l'app.
  const sh = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Caches de shaders</div><div class="sp-desc">À vider en cas de saccades ou de plantages au chargement. Les jeux les recompilent : le premier lancement sera plus long.</div></div></div><div class="rows"></div></div>`);
  for (const s of d.shaders) $(".rows", sh).append(rowEl({ path: s.path, name: s.name.replace(/^Cache de shaders /, ""), size: s.size, type: "dir", contenu: true, niveau: "sur", count: s.count },
    { sub: esc(short(s.path)), tile: G("#7c3aed", "#c084fc") }));
  if (!d.shaders.length) $(".rows", sh).append(el(`<div class="empty">Aucun cache de shaders trouvé.</div>`));
  right.append(sh);
  grid.append(st, right);
  v.append(grid);

  // --- Debian : restes de jeux désinstallés (préfixes Proton, caches, dossiers)
  if (d.leftovers) {
    const KIND = { prefix: "Préfixe Proton", shader: "Cache de shaders du jeu", files: "Dossier du jeu resté sur le disque" };
    const total = d.leftovers.reduce((a, x) => a + x.size, 0);
    const lp = el(`<div class="panel spanel"><div class="sp-head"><div><div class="sp-title">Restes de jeux désinstallés</div>
      <div class="sp-desc">Steam laisse souvent derrière lui le « préfixe » Proton d'un jeu (une petite installation de Windows, 0,5 à 1 Go), son cache de shaders, parfois son dossier. Un préfixe peut contenir des sauvegardes si le jeu ne les envoie pas dans le cloud Steam : il est alors marqué « À vérifier », avec les dossiers concernés. Tout part dans la corbeille.</div></div>
      <div class="sp-total"><b></b><span>récupérables</span></div></div><div class="rows"></div></div>`);
    $(".sp-total b", lp).textContent = size(total);
    for (const x of d.leftovers) {
      const sub = [KIND[x.kind], x.saves.length ? `sauvegardes possibles : ${x.saves.slice(0, 3).join(", ")}${x.saves.length > 3 ? "…" : ""}` : null, short(x.path)].filter(Boolean).map(esc).join(" · ");
      $(".rows", lp).append(rowEl({ path: x.path, name: x.name, size: x.size, type: "dir", niveau: x.saves.length || x.kind === "files" ? "a_verifier" : "sur" },
        { sub, tile: x.kind === "prefix" ? G("#7c2d12", "#f97316") : x.kind === "shader" ? G("#7c3aed", "#c084fc") : G("#334155", "#64748b") }));
    }
    if (!d.leftovers.length) $(".rows", lp).append(el(`<div class="empty">✓ Aucun reste de jeu désinstallé.</div>`));
    v.append(lp);
  }
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
    <div class="gc-d">Mesuré sur la carte réseau pendant 2 secondes. Le détail par programme : Non disponible (${isLinux() ? "le système" : "Windows"} ne le donne pas sans outil de capture).</div><div class="bw-rows"></div>`;
  const rows = $(".bw-rows", bw);
  // Mises à jour du système (Windows Update, ou mises à jour automatiques de Debian).
  const upd = d.bgNow.find((x) => x.kind === "updates");
  if (upd) {
    const r = el(`<div class="lrow"><div><div class="t"></div><div class="s"></div></div><span class="a"></span></div>`);
    $(".t", r).textContent = upd.name;
    $(".s", r).textContent = upd.short || upd.desc;
    if (upd.action) $(".a", r).append(actionBtn({ ...upd.action, label: upd.action.shortLabel || "Suspendre" }, "sm"));
    rows.append(r);
  }
  const steam = d.background.find((x) => x.name === "Steam");
  if (steam) rows.append(el(`<div class="lrow"><div><div class="t">Steam</div><div class="s">Ouvert. Ses téléchargements se mettent en pause depuis Steam › Téléchargements.</div></div></div>`));
};

// ================================================== CE QU'ON NE FAIT PAS ===
const NOPES_WIN = [
  ["Réglages TCPNoDelay et Nagle", "Sans effet : les jeux utilisent l'UDP. Ces clés du registre ne concernent que le TCP."],
  ["Changer de DNS pour le ping", "Le DNS n'agit que sur le chargement des sites. Une fois connecté au serveur de jeu, il ne sert plus."],
  ["« Nettoyeurs de RAM »", "Windows se sert de la mémoire libre comme cache. La vider l'oblige à tout relire depuis le disque, ce qui ralentit plutôt."],
  ["« Mode haute priorité »", "Passer un jeu en priorité haute ne lui donne pas plus de puissance, et peut faire saccader le son, la souris ou Discord."],
];
const NOPES_LINUX = [
  ["Réglages TCP « anti-lag » (sysctl)", "Sans effet : les jeux utilisent l'UDP. Les réglages tcp_* du noyau, comme tcp_low_latency, ne concernent que le TCP."],
  ["Changer de DNS pour le ping", "Le DNS n'agit que sur le chargement des sites. Une fois connecté au serveur de jeu, il ne sert plus."],
  ["Vider le cache mémoire (drop_caches)", "Linux se sert de la mémoire libre comme cache. La vider l'oblige à tout relire depuis le disque, ce qui ralentit plutôt."],
  ["« nice -20 » sur le jeu", "Passer un jeu en priorité maximale ne lui donne pas plus de puissance, et peut faire saccader le son (PipeWire), la souris ou Discord. GameMode le fait proprement."],
];
V["gaming-no"] = () => {
  const v = $("#view-gaming-no");
  v.innerHTML = "";
  v.append(head("Ce qu'on ne fait pas, et pourquoi", "Des « optimisations » qu'on trouve partout et que Sonde refuse d'appliquer."));
  const grid = el(`<div class="nope-grid"></div>`);
  for (const [t, d] of (isLinux() ? NOPES_LINUX : NOPES_WIN)) {
    const c = el(`<div class="panel nope"><div class="nope-i">${svg(GI.x)}</div><div><div class="t"></div><div class="d"></div></div></div>`);
    $(".t", c).textContent = t; $(".d", c).textContent = d;
    grid.append(c);
  }
  v.append(grid);
};
