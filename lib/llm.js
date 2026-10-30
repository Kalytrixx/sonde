// Fournisseurs d'IA : Ollama (sur ce PC, n'importe quel modèle installé),
// API compatibles OpenAI (OpenAI, Mistral, OpenRouter, Groq, LM Studio…) et
// API d'Anthropic (Claude).
//
// Le reste de Sonde parle un seul format, celui d'Ollama :
//   { role: "system"|"user"|"assistant"|"tool", content, tool_calls?, tool_call_id? }
//   tool_calls : [{ id, function: { name, arguments: objet } }]
// et reçoit toujours { role: "assistant", content, thinking, tool_calls? }.
// Les conversions vers chaque API sont faites ici.

const OLLAMA_DEFAULT = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const CTX = Number(process.env.SONDE_CTX || 24576);

// Fournisseurs proposés. `kind` : protocole utilisé.
const PRESETS = {
  ollama: { kind: "ollama", label: "Ollama", baseUrl: OLLAMA_DEFAULT },
  anthropic: { kind: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys", suggest: ["claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-opus-5-5"] },
  openai: { kind: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", suggest: [] },
  mistral: { kind: "openai", label: "Mistral AI", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys",
    suggest: ["mistral-medium-latest", "mistral-small-latest", "mistral-large-latest"] },
  openrouter: { kind: "openai", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", suggest: [] },
  groq: { kind: "openai", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", suggest: [] },
  custom: { kind: "openai", label: "Autre serveur compatible OpenAI", baseUrl: "http://127.0.0.1:1234/v1", custom: true, keyOptional: true },
};

// Adresse sur ce PC ou le réseau local : les données ne sortent pas de chez toi.
function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, "");
    return /^(localhost|127\.\d+\.\d+\.\d+|::1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i.test(h);
  } catch { return false; }
}

// ---------------------------------------------------------------- réglage -
let cfg = { provider: "ollama", model: process.env.SONDE_MODEL || "gpt-oss:latest", baseUrl: OLLAMA_DEFAULT, key: null };

function normalize(c) {
  const p = PRESETS[c.provider] ? c.provider : "ollama";
  const preset = PRESETS[p];
  return {
    provider: p, kind: preset.kind, model: String(c.model || "").trim(),
    baseUrl: String((preset.custom || p === "ollama") && c.baseUrl ? c.baseUrl : preset.baseUrl).replace(/\/+$/, ""),
    key: c.key || null,
  };
}

function configure(c) { cfg = normalize({ ...cfg, ...c }); return describe(); }
function describe(c = cfg) {
  const preset = PRESETS[c.provider];
  return { provider: c.provider, kind: c.kind || preset.kind, model: c.model, baseUrl: c.baseUrl, label: preset.label,
    remote: c.provider !== "ollama" && !isLocalUrl(c.baseUrl), hasKey: !!c.key };
}

// ------------------------------------------------------------ utilitaires -
async function* sse(res) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

const parseArgs = (a) => { if (a && typeof a === "object") return a; try { return JSON.parse(a || "{}"); } catch { return {}; } };

// Message d'erreur compréhensible à partir de la réponse du fournisseur.
async function apiError(res, label) {
  let detail = "";
  try { const t = await res.text(); try { const j = JSON.parse(t); detail = j.error?.message || j.error || j.message || t; } catch { detail = t; } } catch {}
  detail = String(detail).slice(0, 300);
  if (res.status === 401 || res.status === 403) return new Error(`${label} refuse la clé d'API (${res.status}). Vérifie-la dans les réglages de l'IA.`);
  if (res.status === 402 || res.status === 429) return new Error(`${label} : limite atteinte ou crédit épuisé (${res.status}). ${detail}`);
  if (res.status === 404) return new Error(`${label} : modèle ou adresse introuvable (404). ${detail}`);
  return Object.assign(new Error(`${label} ${res.status} : ${detail}`), { status: res.status, detail });
}

// ----------------------------------------------------------------- Ollama -
const capsCache = new Map();
async function ollamaInfo(model, base = cfg.baseUrl) {
  const k = base + "|" + model;
  if (capsCache.has(k)) return capsCache.get(k);
  try {
    const r = await fetch(`${base}/api/show`, { method: "POST", body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const j = await r.json();
    const info = { capabilities: j.capabilities || ["completion"], family: j.details?.family || "", params: j.details?.parameter_size || "",
      quant: j.details?.quantization_level || "" };
    capsCache.set(k, info);
    return info;
  } catch { return null; }
}

async function ollamaChat({ messages, tools, think, onText, onThink, signal, format }, c) {
  const info = await ollamaInfo(c.model, c.baseUrl);
  const caps = info?.capabilities || [];
  if (tools?.length && info && !caps.includes("tools")) {
    throw new Error(`Le modèle ${c.model} ne sait pas utiliser d'outils : l'analyse et l'assistant ont besoin d'un modèle qui le peut (GPT-OSS, Qwen3, Llama 3.1+, Mistral…). Change de modèle dans les réglages de l'IA.`);
  }
  // Réflexion : niveaux (low/medium/high) pour GPT-OSS, oui/non pour les
  // autres modèles qui réfléchissent, rien pour ceux qui ne savent pas.
  let thinkParam;
  if (caps.includes("thinking")) thinkParam = /gpt-oss/i.test(c.model) ? (think || "medium") : think !== false;
  const res = await fetch(`${c.baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: c.model, messages: messages.map(({ tool_call_id, ...m }) => m), tools: tools?.length ? tools : undefined,
      think: thinkParam, stream: true, format, options: { num_ctx: CTX, temperature: 0.2 } }),
    signal,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status} : ${await res.text()}`);
  const msg = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const j = JSON.parse(line);
      if (j.error) throw new Error(j.error);
      const m = j.message || {};
      if (m.thinking) { msg.thinking += m.thinking; onThink && onThink(m.thinking); }
      if (m.content) { msg.content += m.content; onText && onText(m.content); }
      if (m.tool_calls) msg.tool_calls.push(...m.tool_calls);
    }
  }
  return msg;
}

async function ollamaModels(base = cfg.baseUrl) {
  const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
  const j = await r.json();
  const list = await Promise.all(j.models.map(async (m) => {
    const info = await ollamaInfo(m.name, base);
    return { id: m.name, size: m.size, family: info?.family || m.details?.family || "", params: info?.params || m.details?.parameter_size || "",
      quant: info?.quant || m.details?.quantization_level || "", capabilities: info?.capabilities || [] };
  }));
  // Les modèles d'embedding ne savent pas discuter : inutiles ici.
  return list.filter((m) => !m.capabilities.length || m.capabilities.includes("completion"));
}

// ------------------------------------------------------- compatible OpenAI -
function toOpenAI(messages) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.tool_call_id, content: String(m.content) };
    if (m.role === "assistant") {
      const out = { role: "assistant", content: m.content || (m.tool_calls?.length ? null : "") };
      if (m.tool_calls?.length) out.tool_calls = m.tool_calls.map((t) => ({ id: t.id, type: "function",
        function: { name: t.function.name, arguments: typeof t.function.arguments === "string" ? t.function.arguments : JSON.stringify(t.function.arguments || {}) } }));
      return out;
    }
    return { role: m.role, content: String(m.content) };
  });
}

async function openaiChat({ messages, tools, onText, onThink, signal, format }, c, label) {
  const headers = { "Content-Type": "application/json" };
  if (c.key) headers.Authorization = `Bearer ${c.key}`;
  const body = { model: c.model, stream: true, messages: toOpenAI(messages) };
  if (tools?.length) body.tools = tools;
  if (format) body.response_format = { type: "json_schema", json_schema: { name: "reponse", schema: format } };
  let res = await fetch(`${c.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  // Serveur qui ne connaît pas json_schema : JSON libre, schéma rappelé dans la consigne.
  if (!res.ok && format && res.status === 400) {
    body.response_format = { type: "json_object" };
    body.messages = [...body.messages, { role: "system", content: `Réponds uniquement par un objet JSON conforme à ce schéma : ${JSON.stringify(format)}` }];
    res = await fetch(`${c.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
  if (!res.ok) throw await apiError(res, label);
  const msg = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  const calls = [];
  for await (const data of sse(res)) {
    if (data === "[DONE]") break;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.error) throw new Error(`${label} : ${j.error.message || JSON.stringify(j.error)}`);
    const d = j.choices?.[0]?.delta || {};
    const th = d.reasoning_content || d.reasoning;
    if (th) { msg.thinking += th; onThink && onThink(th); }
    if (d.content) { msg.content += d.content; onText && onText(d.content); }
    for (const tc of d.tool_calls || []) {
      const k = tc.index ?? calls.length;
      const cur = (calls[k] ||= { id: "", name: "", args: "" });
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
    }
  }
  msg.tool_calls = calls.filter(Boolean).map((t, i) => ({ id: t.id || `call_${i}`, function: { name: t.name, arguments: parseArgs(t.args) } }));
  return msg;
}

async function openaiModels(c) {
  const headers = c.key ? { Authorization: `Bearer ${c.key}` } : {};
  const r = await fetch(`${c.baseUrl}/models`, { headers, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw await apiError(r, PRESETS[c.provider].label);
  const j = await r.json();
  return (j.data || j.models || []).map((m) => ({ id: m.id || m.name, label: m.name && m.name !== m.id ? m.name : null }))
    .filter((m) => m.id && !/embed|whisper|tts|dall-e|image|audio|moderation|transcribe|realtime/i.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// --------------------------------------------------------------- Anthropic -
function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out = [];
  const push = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);   // l'API veut des rôles alternés
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content) }]);
    else if (m.role === "assistant") {
      const blocks = [];
      if (m.content && m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const t of m.tool_calls || []) blocks.push({ type: "tool_use", id: t.id, name: t.function.name, input: parseArgs(t.function.arguments) });
      if (!blocks.length) blocks.push({ type: "text", text: "…" });
      push("assistant", blocks);
    } else push("user", [{ type: "text", text: String(m.content) }]);
  }
  return { system, messages: out };
}

async function anthropicChat({ messages, tools, onText, signal, format }, c, label) {
  const { system, messages: msgs } = toAnthropic(messages);
  const body = { model: c.model, max_tokens: 8192, stream: true, messages: msgs };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  // Réponse JSON imposée : un outil « reponse » que le modèle est obligé d'appeler.
  if (format) {
    body.tools = [{ name: "reponse", description: "Donne ta réponse sous forme structurée.", input_schema: format }];
    body.tool_choice = { type: "tool", name: "reponse" };
  }
  const res = await fetch(`${c.baseUrl}/v1/messages`, {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "x-api-key": c.key || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res, label);
  const blocks = [];
  for await (const data of sse(res)) {
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.type === "error") throw new Error(`${label} : ${j.error?.message || "erreur"}`);
    if (j.type === "content_block_start") blocks[j.index] = { ...j.content_block, text: j.content_block.text || "", json: "" };
    else if (j.type === "content_block_delta") {
      const b = blocks[j.index];
      if (!b) continue;
      if (j.delta.type === "text_delta") { b.text += j.delta.text; if (!format) onText && onText(j.delta.text); }
      else if (j.delta.type === "input_json_delta") b.json += j.delta.partial_json;
    }
  }
  const msg = { role: "assistant", content: "", thinking: "", tool_calls: [] };
  for (const b of blocks.filter(Boolean)) {
    if (b.type === "text") msg.content += b.text;
    else if (b.type === "tool_use") {
      const input = parseArgs(b.json || b.input);
      if (format && b.name === "reponse") msg.content = JSON.stringify(input);
      else msg.tool_calls.push({ id: b.id, function: { name: b.name, arguments: input } });
    }
  }
  return msg;
}

async function anthropicModels(c) {
  const r = await fetch(`${c.baseUrl}/v1/models?limit=100`, { headers: { "x-api-key": c.key || "", "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw await apiError(r, "Anthropic");
  const j = await r.json();
  return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || null }));
}

// ------------------------------------------------------------------- API ---
// Un échange en flux. `c` : réglage à utiliser (par défaut, celui en cours).
async function chat(opts, c = cfg) {
  if (!c.model) throw new Error("Aucun modèle choisi : ouvre les réglages de l'IA.");
  const label = PRESETS[c.provider].label;
  if (c.kind !== "ollama" && !c.key && !PRESETS[c.provider].keyOptional) throw new Error(`Aucune clé d'API pour ${label} : ajoute-la dans les réglages de l'IA.`);
  const msg = c.kind === "anthropic" ? await anthropicChat(opts, c, label)
    : c.kind === "openai" ? await openaiChat(opts, c, label)
    : await ollamaChat(opts, c);
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return msg;
}

// État pour le badge de l'interface (appelé toutes les 5 s : pas de requête
// réseau vers un fournisseur en ligne).
async function status() {
  const d = describe();
  if (cfg.kind === "ollama") {
    try {
      const r = await fetch(`${cfg.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      const names = j.models.map((m) => m.name);
      return { ...d, ok: true, available: names.includes(cfg.model), models: names };
    } catch {
      return { ...d, ok: false, available: false, models: [] };
    }
  }
  if (!d.remote) {
    // Serveur local (LM Studio, llama.cpp…) : on vérifie qu'il répond.
    try { await fetch(`${cfg.baseUrl}/models`, { signal: AbortSignal.timeout(2000), headers: cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {} }); return { ...d, ok: true, available: true, models: [] }; }
    catch { return { ...d, ok: false, available: false, models: [] }; }
  }
  const ready = !!cfg.key && !!cfg.model;
  return { ...d, ok: ready, available: ready, models: [] };
}

async function listModels(c) {
  const n = normalize(c);
  if (n.kind === "ollama") return ollamaModels(n.baseUrl);
  if (n.kind === "anthropic") {
    try { return await anthropicModels(n); }
    catch (e) { if (!n.key) return PRESETS.anthropic.suggest.map((id) => ({ id })); throw e; }
  }
  return openaiModels(n);
}

// Essai d'un réglage (pas encore enregistré) : répond-il, et sait-il
// appeler un outil ? Indispensable pour l'analyse et l'assistant.
async function test(c) {
  const n = normalize(c);
  const t0 = Date.now();
  const tool = { type: "function", function: { name: "signaler", description: "Signale que la connexion fonctionne.",
    parameters: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } };
  const messages = [
    { role: "system", content: "Tu testes une connexion. Réponds très brièvement." },
    { role: "user", content: "Appelle l'outil « signaler » avec ok = true." },
  ];
  let msg, toolError = null;
  try {
    msg = await chat({ messages, tools: [tool], think: "low", signal: AbortSignal.timeout(90000) }, n);
  } catch (e) {
    // Clé refusée, modèle introuvable… : inutile de réessayer.
    if (/clé|401|403|404|introuvable|crédit|limite/i.test(e.message)) throw e;
    // Sinon, peut-être un modèle sans outils : on vérifie qu'il répond au moins.
    toolError = e.message;
    msg = await chat({ messages: [{ role: "user", content: "Réponds seulement : OK" }], think: "low", signal: AbortSignal.timeout(90000) }, n);
  }
  return { ok: true, ms: Date.now() - t0, tools: !toolError && !!msg.tool_calls?.some((t) => t.function.name === "signaler"),
    toolError, text: (msg.content || "").slice(0, 200) };
}

module.exports = { PRESETS, configure, describe, chat, status, listModels, test, isLocalUrl, ollamaInfo, get config() { return cfg; } };
