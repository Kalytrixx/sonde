// Sonde — réglages de l'IA : un modèle sur ce PC (Ollama, n'importe lequel
// parmi ceux installés) ou une IA en ligne par API (Claude, OpenAI, Mistral…).
"use strict";

const setupState = { info: null, cfg: null, choice: null, busy: false, tab: null, api: null, apiModels: [], test: null };

async function openSetup() {
  $("#setup").classList.add("open");
  setupState.tab = null;
  setupState.test = null;
  await refreshSetup();
}
function closeSetup() { $("#setup").classList.remove("open"); }

// Même règle que le serveur : adresse sur ce PC ou le réseau local.
function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return /^(localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i.test(h);
  } catch { return false; }
}

async function refreshSetup() {
  const body = $("#setupBody");
  if (!setupState.info) body.innerHTML = `<div class="empty working">Vérification de ton PC</div>`;
  try {
    [setupState.info, setupState.cfg] = await Promise.all([api("/api/setup"), api("/api/ai/config")]);
  } catch (e) {
    body.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const s = setupState.info, c = setupState.cfg;
  setupState.tab ||= c.current.provider === "ollama" ? "local" : "api";
  // Modèle local retenu : celui en service, sinon le conseillé (ou sa variante déjà installée).
  if (!setupState.choice) {
    const installed = c.ollama.models.map((m) => m.id);
    const cur = c.ollamaModel || (c.current.provider === "ollama" ? c.current.model : null);
    const rec = s.models.find((m) => m.id === s.recommended);
    setupState.choice = (cur && (installed.includes(cur) || s.models.some((m) => m.id === cur)) && cur)
      || installed.find((n) => n === rec.id || rec.aliases.includes(n)) || rec.id;
  }
  // Formulaire API : le fournisseur enregistré, sinon Anthropic.
  if (!setupState.api) {
    const sv = c.saved;
    const p = sv.provider && sv.provider !== "ollama" ? sv.provider : "anthropic";
    setupState.api = { provider: p, model: sv.provider === p && sv.model ? sv.model : c.presets[p].suggest[0] || "",
      baseUrl: (sv.provider === p && sv.baseUrl) || c.presets[p].baseUrl, apiKey: "", consent: sv.provider === p && sv.consent };
  }
  renderSetup();
}

function renderSetup() {
  const tabs = [["local", "Sur ce PC (Ollama)"], ["api", "IA en ligne (API)"]];
  $("#setupTabs").innerHTML = tabs.map(([k, l]) => `<button class="${setupState.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("");
  $$("#setupTabs button").forEach((b) => (b.onclick = () => { if (setupState.busy) return; setupState.tab = b.dataset.tab; setupState.test = null; renderSetup(); }));
  $("#setupIntro").textContent = setupState.tab === "local"
    ? "Le modèle tourne sur ton PC grâce à Ollama : rien n'est envoyé sur Internet."
    : isLocalUrl(setupState.api.baseUrl)
      ? "Un autre serveur d'IA compatible OpenAI (LM Studio, llama.cpp…), sur ton PC ou ton réseau : rien ne sort de chez toi."
      : "Une IA en ligne, avec ta clé d'API : rapide même sur un petit PC, mais les noms de tes fichiers quittent ton PC.";
  setupState.tab === "local" ? renderLocal() : renderApi();
}

// ------------------------------------------------------------ sur ce PC ---
function capsTags(m) {
  const c = m.capabilities || [];
  const t = [];
  if (c.includes("tools")) t.push(`<span class="tag good">outils</span>`);
  else if (c.length) t.push(`<span class="tag warn">pas d'outils : analyse et assistant impossibles</span>`);
  if (c.includes("thinking")) t.push(`<span class="tag">réflexion</span>`);
  if (c.includes("vision")) t.push(`<span class="tag">images</span>`);
  return t.join(" ");
}

function renderLocal() {
  const s = setupState.info, c = setupState.cfg;
  const h = s.hardware;
  const room = Math.max(h.vramGB, h.ramGB * 0.6);
  const gpu = h.gpus.slice().sort((a, b) => b.vramGB - a.vramGB)[0];
  const installed = c.ollama.models;
  const ids = installed.map((m) => m.id);
  const rec = s.models.find((m) => m.id === s.recommended);
  // Catalogue : seulement ce qui n'est pas déjà installé (sous son nom ou une variante).
  const catalogue = s.models.filter((m) => !ids.includes(m.id) && !m.aliases.some((a) => ids.includes(a)));
  const choiceCat = s.models.find((m) => m.id === setupState.choice);
  const hasModel = ids.includes(setupState.choice) || (choiceCat && choiceCat.aliases.some((a) => ids.includes(a)));
  const choiceLabel = choiceCat?.label || setupState.choice;
  const inUse = c.current.provider === "ollama" ? c.current.model : null;

  const step = (n, state, title, desc, action = "") => `
    <div class="sstep ${state}">
      <div class="snum">${state === "ok" ? "✓" : n}</div>
      <div class="sbody"><div class="stitle">${title}</div><div class="sdesc">${desc}</div><div class="sextra" id="sx${n}"></div></div>
      <div class="sact">${action}</div>
    </div>`;
  const opt = (id, inner) => `
    <label class="mopt ${id === setupState.choice ? "on" : ""}">
      <input type="radio" name="model" value="${esc(id)}" ${id === setupState.choice ? "checked" : ""}>
      <div>${inner}</div>
    </label>`;
  const installedHtml = installed.map((m) => opt(m.id, `<b>${esc(m.id)}</b>
      ${m.id === inUse ? `<span class="tag good">en service</span>` : ""}
      ${rec && (m.id === rec.id || rec.aliases.includes(m.id)) ? `<span class="tag good">conseillé pour ton PC</span>` : ""} ${capsTags(m)}
      <div class="muted">${[m.params && `${esc(m.params)} de paramètres`, m.quant, m.size && size(m.size)].filter(Boolean).join(" · ")}</div>`)).join("");
  const catalogueHtml = catalogue.map((m) => opt(m.id, `<b>${esc(m.label)}</b> ${m.id === s.recommended ? `<span class="tag good">conseillé pour ton PC</span>` : ""}
      ${room < m.need ? `<span class="tag warn">risque d'être lent</span>` : ""}
      <div class="muted">${esc(m.desc)} ${size(m.size)} à télécharger.</div>`)).join("");

  $("#setupBody").innerHTML = `<div class="ssteps">
    ${step(1, "ok", "Ton PC", `${gpu ? `${esc(gpu.name)} (${nf1.format(gpu.vramGB)} Go de mémoire vidéo)` : "Pas de carte graphique dédiée"} · ${nf0.format(h.ramGB)} Go de mémoire vive`)}
    <div class="models">
      ${installed.length ? `<div class="mgroup">Déjà sur ton PC (${installed.length})</div>${installedHtml}` : ""}
      ${catalogue.length ? `<div class="mgroup">${installed.length ? "Ou à télécharger" : "À télécharger"}</div>${catalogueHtml}` : ""}
      ${!s.ollama.running ? `<div class="muted" style="padding:6px 2px">Démarre Ollama pour voir les modèles déjà installés sur ton PC.</div>` : ""}
    </div>
    ${s.ollama.running
      ? step(2, "ok", "Ollama", "Installé et démarré.")
      : s.ollama.installed
        ? step(2, "todo", "Ollama", "Installé mais arrêté.", `<button class="btn primary" id="sStart">Démarrer</button>`)
        : step(2, "todo", "Ollama", isLinux() ? "Le moteur qui fait tourner l'IA sur ton PC. Script officiel d'Ollama : ton mot de passe administrateur sera demandé." : "Le moteur qui fait tourner l'IA sur ton PC. Installateur officiel, sans droits administrateur.", `<button class="btn primary" id="sInstall">Installer</button>`)}
    ${!s.ollama.running
      ? step(3, "wait", "Le modèle " + esc(choiceLabel), "Après Ollama.")
      : hasModel
        ? step(3, "ok", "Le modèle " + esc(choiceLabel), "Déjà sur ton PC.", `<button class="btn" id="sTest">Tester</button>`)
        : step(3, "todo", "Le modèle " + esc(choiceLabel), `${size(choiceCat?.size)} à télécharger, une seule fois. Si la connexion coupe, le téléchargement reprend là où il s'était arrêté.`, `<button class="btn primary" id="sPull">Télécharger</button>`)}
  </div>`;

  $$('input[name="model"]').forEach((r) => (r.onchange = () => { setupState.choice = r.value; renderSetup(); }));
  $("#sStart") && ($("#sStart").onclick = startOllama);
  $("#sInstall") && ($("#sInstall").onclick = installOllama);
  $("#sPull") && ($("#sPull").onclick = pullModel);
  // Certains modèles se disent capables d'utiliser des outils mais écrivent
  // l'appel en texte : seul un vrai essai le montre.
  $("#sTest") && ($("#sTest").onclick = async () => {
    const b = $("#sTest");
    b.disabled = true; b.textContent = "Test…";
    $("#sx3").innerHTML = progressHtml("Chargement du modèle et essai", 0, 0);
    try {
      const t = await api("/api/ai/test", { provider: "ollama", model: ids.includes(setupState.choice) ? setupState.choice : choiceCat.aliases.find((a) => ids.includes(a)) });
      $("#sx3").innerHTML = t.tools
        ? `<span style="color:var(--safe)">✓ Répond en ${nf1.format(t.ms / 1000)} s et sait utiliser les outils : tout fonctionnera.</span>`
        : `<span style="color:var(--warn)">Répond en ${nf1.format(t.ms / 1000)} s, mais n'utilise pas vraiment les outils : l'analyse et l'assistant risquent d'échouer. Les explications, oui.</span>`;
    } catch (e) { $("#sx3").innerHTML = `<span style="color:var(--bad)">${esc(e.message)}</span>`; }
    b.disabled = false; b.textContent = "Tester";
  });
  const done = $("#setupDone");
  done.textContent = inUse && setupState.choice !== inUse ? "Utiliser ce modèle" : "Commencer";
  done.disabled = !(s.ollama.running && hasModel) || setupState.busy;
  $$('input[name="model"]').forEach((r) => (r.disabled = setupState.busy));
}

// ------------------------------------------------------------ en ligne ---
function apiBody() {
  const a = setupState.api;
  return { provider: a.provider, model: a.model.trim(), baseUrl: a.baseUrl, apiKey: a.apiKey.trim() || undefined, consent: !!a.consent };
}

function renderApi() {
  const c = setupState.cfg, a = setupState.api;
  const preset = c.presets[a.provider];
  const savedHere = c.saved.provider === a.provider && c.saved.hasKey;
  const remote = !isLocalUrl(a.baseUrl);
  const providers = Object.entries(c.presets).filter(([k]) => k !== "ollama");
  const models = [...new Set([...setupState.apiModels.map((m) => m.id), ...preset.suggest])];
  const t = setupState.test;

  $("#setupBody").innerHTML = `<div class="api-form">
    <label><span>Fournisseur</span>
      <select id="apProv">${providers.map(([k, p]) => `<option value="${k}" ${k === a.provider ? "selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
    ${preset.custom ? `<label><span>Adresse du serveur</span><input id="apUrl" type="text" value="${esc(a.baseUrl)}" spellcheck="false">
      <small class="muted">LM Studio : http://127.0.0.1:1234/v1 · llama.cpp : http://127.0.0.1:8080/v1 · Ollama d'un autre PC : http://192.168.x.x:11434/v1</small></label>` : ""}
    <label><span>Clé d'API${preset.keyOptional ? " (facultative)" : ""}</span>
      <input id="apKey" type="password" autocomplete="off" spellcheck="false" placeholder="${savedHere ? "Clé enregistrée : laisse vide pour la garder" : "Colle ta clé ici"}">
      <small class="muted">${c.keyProtected ? "La clé est chiffrée par le système (DPAPI de Windows ou trousseau GNOME) et n'est jamais affichée." : "Attention : ici, la clé sera gardée en clair dans les réglages de Sonde. L'application installée la chiffre."}
        ${preset.keyUrl ? ` <a href="${esc(preset.keyUrl)}" target="_blank" rel="noopener">Créer une clé</a>` : ""}${savedHere ? ` · <a href="#" id="apForget">Oublier la clé enregistrée</a>` : ""}</small></label>
    <label><span>Modèle</span>
      <div class="ap-row"><input id="apModel" type="text" list="apModels" value="${esc(a.model)}" spellcheck="false" placeholder="nom du modèle">
        <button class="btn" id="apLoad">Charger la liste</button></div>
      <datalist id="apModels">${models.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      <small class="muted">L'analyse et l'assistant ont besoin d'un modèle qui sait utiliser des outils (« function calling »). Le bouton « Tester » le vérifie.</small></label>
    ${remote ? `<div class="warnbox">
        <b>Ce qui part chez ${esc(preset.label)}</b> : les noms, tailles et dates de tes dossiers et fichiers que l'IA explore, et les listes de programmes, services ou réglages réseau que tu lui demandes d'expliquer. <b>Jamais le contenu de tes fichiers.</b>
        Le fournisseur facture à l'usage : une analyse complète peut consommer plusieurs centaines de milliers de jetons.
        <label class="consent"><input type="checkbox" id="apConsent" ${a.consent ? "checked" : ""}> J'accepte que ces informations soient envoyées à ${esc(preset.label)}.</label>
      </div>` : `<div class="hint">Serveur sur ton PC ou ton réseau local : rien ne sort de chez toi.</div>`}
    <div class="ap-row"><button class="btn" id="apTest">Tester</button>
      <span id="apResult" class="${t ? (t.error ? "bad" : t.tools ? "good" : "warn") : ""}">${t ? esc(t.error || (t.tools
        ? `✓ Répond en ${nf1.format(t.ms / 1000)} s et sait utiliser les outils : tout fonctionnera.`
        : `Répond en ${nf1.format(t.ms / 1000)} s, mais n'utilise pas les outils : l'analyse et l'assistant ne marcheront pas. Les explications, oui.`)) : ""}</span></div>
  </div>`;

  $("#apProv").onchange = (e) => {
    const p = e.target.value;
    setupState.api = { provider: p, model: c.presets[p].suggest[0] || (c.saved.provider === p ? c.saved.model || "" : ""),
      baseUrl: (c.saved.provider === p && c.saved.baseUrl) || c.presets[p].baseUrl, apiKey: "", consent: c.saved.provider === p && c.saved.consent };
    setupState.apiModels = [];
    setupState.test = null;
    renderSetup();
  };
  $("#apUrl") && ($("#apUrl").oninput = (e) => { a.baseUrl = e.target.value.trim(); });
  $("#apUrl") && ($("#apUrl").onchange = () => renderSetup());
  $("#apKey").oninput = (e) => { a.apiKey = e.target.value; updateApiDone(); };
  $("#apModel").oninput = (e) => { a.model = e.target.value; updateApiDone(); };
  $("#apConsent") && ($("#apConsent").onchange = (e) => { a.consent = e.target.checked; updateApiDone(); });
  $("#apForget") && ($("#apForget").onclick = async (e) => {
    e.preventDefault();
    await api("/api/ai/forget-key", {}).catch((err) => toast(err.message));
    toast("Clé oubliée.");
    await refreshSetup();
  });
  $("#apLoad").onclick = async () => {
    const b = $("#apLoad");
    b.disabled = true; b.textContent = "Chargement…";
    try {
      const r = await api("/api/ai/models", apiBody());
      setupState.apiModels = r.models;
      toast(`${r.models.length} modèle(s) disponible(s).`);
      renderSetup();
    } catch (err) { toast(err.message, 8000); b.disabled = false; b.textContent = "Charger la liste"; }
  };
  $("#apTest").onclick = async () => {
    const b = $("#apTest");
    b.disabled = true; b.textContent = "Test en cours…";
    $("#apResult").textContent = "";
    try { setupState.test = await api("/api/ai/test", apiBody()); }
    catch (err) { setupState.test = { error: err.message }; }
    renderSetup();
  };
  updateApiDone();
}

function updateApiDone() {
  const c = setupState.cfg, a = setupState.api;
  const preset = c.presets[a.provider];
  const hasKey = a.apiKey.trim() || (c.saved.provider === a.provider && c.saved.hasKey) || preset.keyOptional;
  const remote = !isLocalUrl(a.baseUrl);
  const done = $("#setupDone");
  done.textContent = "Utiliser cette IA";
  done.disabled = !a.model.trim() || !hasKey || (remote && !a.consent) || setupState.busy;
}

// ----------------------------------------------------- progression, Ollama -
// `percent` : la progression arrive en pourcentage (script Linux), pas en octets.
function progressHtml(label, completed, total, percent = false) {
  const pct = total ? Math.min(100, (completed / total) * 100) : null;
  if (percent) return `<div class="sprog"><div class="sprog-bar"><span style="width:${pct}%"></span></div><div class="muted">${esc(label)} · ${nf0.format(pct)} %</div></div>`;
  return `<div class="sprog"><div class="sprog-bar"><span style="width:${pct ?? 30}%" class="${pct == null ? "indet" : ""}"></span></div>
    <div class="muted">${esc(label)}${total ? ` · ${size(completed)} sur ${size(total)} (${nf0.format(pct)} %)` : ""}</div></div>`;
}

async function busy(fn) {
  setupState.busy = true;
  $("#setupDone").disabled = true;
  $$('input[name="model"]').forEach((r) => (r.disabled = true));
  $$(".sact button").forEach((b) => (b.disabled = true));
  try { await fn(); }
  catch (e) { toast(e.name === "AbortError" ? "Annulé. Le téléchargement reprendra là où il s'est arrêté si tu le relances." : e.message, 8000); }
  setupState.busy = false;
  await refreshSetup();
}

// Pendant une opération longue, le bouton de l'étape devient « Annuler ».
function cancelButton(btnId, ctl) {
  const b = $("#" + btnId);
  if (!b) return;
  b.textContent = "Annuler";
  b.className = "btn";
  b.disabled = false;
  b.onclick = () => { b.disabled = true; b.textContent = "Annulation…"; ctl.abort(); };
}

const startOllama = () => busy(async () => {
  $("#sx2").innerHTML = progressHtml("Démarrage d'Ollama", 0, 0);
  const r = await api("/api/setup/start-ollama", {});
  if (!r.running) throw new Error(isLinux() ? "Ollama ne répond pas. Essaie « sudo systemctl start ollama » dans un terminal." : "Ollama ne répond pas. Lance « Ollama » depuis le menu Démarrer.");
});

let installCtl = null;
const installOllama = () => busy(async () => {
  installCtl = new AbortController();
  cancelButton("sInstall", installCtl);
  let label = "Préparation";
  await streamApi("/api/setup/install-ollama", {}, (e) => {
    if (e.type === "step") {
      label = e.label;
      $("#sx2").innerHTML = progressHtml(label, 0, 0);
      // Une fois l'installateur lancé, on ne peut plus l'interrompre proprement.
      if (!/^Téléchargement/.test(e.label)) $("#sInstall")?.remove();
    } else if (e.type === "progress") $("#sx2").innerHTML = progressHtml(label, e.completed, e.total, isLinux() && e.total === 100);
    else if (e.type === "error") throw new Error(e.error);
  }, installCtl.signal);
});

let pullCtl = null;
const pullModel = () => busy(async () => {
  pullCtl = new AbortController();
  cancelButton("sPull", pullCtl);
  const t0 = Date.now();
  let base = null;   // déjà téléchargé avant cette reprise : ne compte pas dans la vitesse
  // Le modèle n'est enregistré qu'une fois téléchargé (le serveur s'en charge) :
  // un téléchargement annulé ne doit pas laisser Sonde pointer vers un modèle absent.
  $("#sx3").innerHTML = progressHtml("Connexion", 0, 0);
  await streamApi("/api/setup/pull", { model: setupState.choice }, (e) => {
    if (e.type === "progress") {
      if (e.total && base == null) base = e.completed;
      const secs = (Date.now() - t0) / 1000;
      const speed = (e.completed - (base || 0)) / Math.max(secs, 1);
      const eta = e.total && speed > 0 ? Math.round((e.total - e.completed) / speed / 60) : null;
      const label = e.total ? `Téléchargement${speed > 1e5 ? ` · ${size(speed)}/s` : ""}${eta != null && eta > 0 ? ` · encore ${eta} min environ` : ""}` : (e.status || "Préparation");
      $("#sx3").innerHTML = progressHtml(label, e.completed, e.total);
    } else if (e.type === "error") throw new Error(e.error);
  }, pullCtl.signal);
  await refreshStatus();
});

// ------------------------------------------------------------- validation -
$("#setupDone").onclick = async () => {
  const b = $("#setupDone");
  b.disabled = true;
  try {
    if (setupState.tab === "api") await api("/api/ai/config", apiBody());
    else await api("/api/setup/model", { model: setupState.choice });
  } catch (e) {
    toast(e.message, 8000);
    b.disabled = false;
    return;
  }
  closeSetup();
  setupState.api = null;
  setupState.choice = null;
  await refreshStatus();
  toast(`${aiName()} est prêt${aiRemote() ? ` (en ligne, ${state.status.ai.label})` : ""}.`);
  show(state.view || "home");
};
$("#setupSkip").onclick = async () => {
  pullCtl?.abort();
  await api("/api/setup/skip", {}).catch(() => {});
  closeSetup();
  toast("Sonde fonctionne sans IA. Tu pourras la préparer plus tard en cliquant sur l'état de l'IA, en haut à gauche.", 7000);
};

// L'état de l'IA en haut à gauche ouvre les réglages.
$("#aiPill").style.cursor = "pointer";
$("#aiPill").title = "Choisir ou changer l'IA";
$("#aiPill").onclick = openSetup;

// Au démarrage : si l'IA n'est pas prête et que l'utilisateur n'a pas choisi
// de s'en passer, l'assistant s'ouvre tout seul.
window.addEventListener("DOMContentLoaded", async () => {
  try {
    const s = await api("/api/setup");
    setupState.info = s;
    if (!s.ready && !s.skipped) openSetup();
  } catch {}
});
