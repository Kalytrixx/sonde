// Réglages de l'IA : modèle Ollama (n'importe lequel parmi ceux installés)
// ou IA en ligne par API (Claude, OpenAI, Mistral, OpenRouter, Groq, ou tout
// serveur compatible OpenAI). La clé d'API est chiffrée par le système et
// n'est jamais renvoyée à la page.

const llm = require("../../llm");
const secret = require("../../secret");

const MODEL_RE = /^[\w.:/@+-]{1,200}$/;

module.exports = (ctx) => {
  // Réglage enregistré -> réglage en vigueur.
  ctx.applyAI = () => {
    const a = ctx.settings.ai || {};
    if (a.provider && a.provider !== "ollama" && llm.PRESETS[a.provider]) {
      llm.configure({ provider: a.provider, model: a.model, baseUrl: a.baseUrl, key: secret.open(a.key) });
    } else {
      llm.configure({ provider: "ollama", model: ctx.settings.model || process.env.SONDE_MODEL || "gpt-oss:latest",
        baseUrl: a.ollamaUrl || llm.PRESETS.ollama.baseUrl, key: null });
    }
  };
  ctx.applyAI();

  // Valide une demande de la page et en fait un réglage complet. La clé :
  // celle saisie, sinon celle déjà enregistrée pour ce fournisseur.
  function fromRequest(b) {
    const preset = llm.PRESETS[b.provider];
    if (!preset) throw new Error("Fournisseur inconnu.");
    const model = String(b.model || "").trim();
    if (!MODEL_RE.test(model)) throw new Error("Nom de modèle invalide.");
    let baseUrl = preset.baseUrl;
    if (preset.custom || b.provider === "ollama") {
      baseUrl = String(b.baseUrl || preset.baseUrl).trim().replace(/\/+$/, "");
      let u;
      try { u = new URL(baseUrl); } catch { throw new Error("Adresse du serveur invalide."); }
      if (!/^https?:$/.test(u.protocol)) throw new Error("L'adresse doit commencer par http:// ou https://.");
      // Une clé ne part jamais en clair sur Internet.
      if (u.protocol === "http:" && !llm.isLocalUrl(baseUrl) && b.provider !== "ollama") throw new Error("Pour un serveur sur Internet, l'adresse doit être en https://.");
    }
    const saved = ctx.settings.ai || {};
    const key = b.apiKey ? String(b.apiKey).trim() : saved.provider === b.provider ? secret.open(saved.key) : null;
    return { provider: b.provider, model, baseUrl, key };
  }

  return {
    "GET /api/ai/config": async () => {
      const cur = llm.describe();
      const a = ctx.settings.ai || {};
      let ollama = { running: false, models: [] };
      try { ollama = { running: true, models: await llm.listModels({ provider: "ollama", baseUrl: a.ollamaUrl }) }; } catch {}
      return {
        current: cur,
        saved: { provider: a.provider || "ollama", model: a.model || null, baseUrl: a.baseUrl || null, hasKey: !!a.key, consent: !!a.consent },
        ollamaModel: ctx.settings.model || null,
        keyProtected: secret.protectedStorage(),
        presets: Object.fromEntries(Object.entries(llm.PRESETS).map(([k, p]) => [k, { label: p.label, kind: p.kind, baseUrl: p.baseUrl,
          keyUrl: p.keyUrl || null, suggest: p.suggest || [], custom: !!p.custom, keyOptional: !!p.keyOptional }])),
        ollama,
      };
    },

    // Liste des modèles proposés par un fournisseur (avec la clé saisie ou enregistrée).
    "POST /api/ai/models": async (req) => {
      const b = await ctx.body(req);
      const c = fromRequest({ ...b, model: b.model || "x" });
      return { models: await llm.listModels(c) };
    },

    // Essai d'un réglage avant de l'enregistrer.
    "POST /api/ai/test": async (req) => {
      const c = fromRequest(await ctx.body(req));
      return llm.test(c);
    },

    // Enregistre et active. Une IA en ligne demande l'accord explicite de
    // l'utilisateur : les noms de ses fichiers partiront chez le fournisseur.
    "POST /api/ai/config": async (req) => {
      const b = await ctx.body(req);
      if (b.provider === "ollama") {
        const c = fromRequest(b);
        ctx.settings.model = c.model;
        ctx.settings.ai = { ...(ctx.settings.ai || {}), provider: "ollama", ollamaUrl: c.baseUrl === llm.PRESETS.ollama.baseUrl ? undefined : c.baseUrl };
      } else {
        const c = fromRequest(b);
        const remote = !llm.isLocalUrl(c.baseUrl);
        if (remote && !b.consent) throw new Error("Il faut accepter l'envoi des informations au fournisseur pour utiliser une IA en ligne.");
        if (!c.key && !llm.PRESETS[c.provider].keyOptional) throw new Error("Colle ta clé d'API.");
        const prev = ctx.settings.ai || {};
        ctx.settings.ai = { ...prev, provider: c.provider, model: c.model, baseUrl: c.baseUrl, consent: remote ? true : !!prev.consent,
          key: b.apiKey ? secret.seal(c.key) : prev.provider === c.provider ? prev.key : null };
      }
      ctx.saveSettings();
      ctx.applyAI();
      const d = llm.describe();
      ctx.journal.add({ kind: "system", title: `IA : ${d.model} (${d.provider === "ollama" ? "sur ce PC" : d.label}${d.remote ? ", en ligne" : ""})` });
      return { ok: true, current: d };
    },

    // Oublie la clé d'API enregistrée.
    "POST /api/ai/forget-key": async () => {
      if (ctx.settings.ai) delete ctx.settings.ai.key;
      ctx.saveSettings();
      ctx.applyAI();
      return { ok: true };
    },
  };
};
