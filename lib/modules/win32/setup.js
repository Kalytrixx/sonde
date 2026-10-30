// Assistant de premier lancement : vérifie le PC, installe Ollama (installateur
// officiel, en silencieux, sans droits administrateur) et télécharge le modèle.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const ps = require("../../ps");

const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_DIR = path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama");
const OLLAMA_SETUP_URL = "https://ollama.com/download/OllamaSetup.exe";

// Modèles proposés, du plus capable au plus léger. `need` : mémoire (vidéo ou
// vive) conseillée pour qu'il tourne confortablement.
const MODELS = [
  { id: "gpt-oss:20b", aliases: ["gpt-oss:latest", "gpt-oss"], label: "GPT-OSS 20B", size: 13.8e9, need: 16,
    desc: "Le modèle pour lequel Sonde a été réglé. Le plus fiable pour l'analyse." },
  { id: "qwen3:8b", aliases: [], label: "Qwen3 8B", size: 5.2e9, need: 8,
    desc: "Plus léger, pour les PC avec moins de mémoire. Analyse un peu moins fine." },
  { id: "qwen3:4b", aliases: [], label: "Qwen3 4B", size: 2.6e9, need: 5,
    desc: "Pour les petites configurations. Explications correctes, analyse plus sommaire." },
];

const HARDWARE = `
$gpus = @(Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue |
  Where-Object { $_.PSChildName -match '^\\d{4}$' } | ForEach-Object {
    $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if ($p.DriverDesc) { @{ name = $p.DriverDesc; vram = [int64]$p.'HardwareInformation.qwMemorySize' } }
  })
@{ gpus = $gpus }`;

async function ollamaUp() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j.models.map((m) => m.name);
  } catch { return null; }
}

// Le modèle choisi est-il présent, sous son nom ou un alias (gpt-oss:latest…) ?
function present(names, model) {
  const m = MODELS.find((x) => x.id === model);
  const accepted = [model, ...(m?.aliases || [])];
  return names.find((n) => accepted.includes(n)) || null;
}

module.exports = (ctx) => {
  let hw = null;

  async function hardware() {
    if (hw) return hw;
    const r = await ps.run(HARDWARE).catch(() => ({ gpus: [] }));
    const gpus = [].concat(r.gpus || []).filter((g) => g.name);
    hw = { ramGB: os.totalmem() / 1024 ** 3, gpus: gpus.map((g) => ({ name: g.name, vramGB: g.vram / 1024 ** 3 })) };
    hw.vramGB = Math.max(0, ...hw.gpus.map((g) => g.vramGB));
    return hw;
  }

  // Le plus gros modèle qui tient : la mémoire vidéo d'abord (rapide), sinon
  // la RAM en gardant de la marge pour Windows et les autres programmes.
  function recommend(h) {
    const room = Math.max(h.vramGB, h.ramGB * 0.6);
    return (MODELS.find((m) => room >= m.need) || MODELS[MODELS.length - 1]).id;
  }

  const installed = () => fs.existsSync(path.join(OLLAMA_DIR, "ollama.exe"));

  function startOllama() {
    const exe = path.join(OLLAMA_DIR, "ollama app.exe");
    if (!fs.existsSync(exe)) return false;
    spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  }

  async function waitUp(seconds) {
    for (let i = 0; i < seconds; i++) {
      const names = await ollamaUp();
      if (names) return names;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  return {
    "GET /api/setup": async () => {
      const [h, names] = await Promise.all([hardware(), ollamaUp()]);
      const model = ctx.settings.model || null;
      const found = names && model ? present(names, model) : null;
      return {
        hardware: h, recommended: recommend(h), models: MODELS, model,
        ollama: { installed: installed() || !!names, running: !!names, models: names || [] },
        ready: ctx.ai.describe().provider === "ollama" ? !!found : (await ctx.ai.status()).ok, skipped: !!ctx.settings.setupSkipped,
        ai: ctx.ai.describe(),
      };
    },

    // Choisit le modèle. Si une variante déjà téléchargée existe (gpt-oss:latest
    // pour gpt-oss:20b), c'est elle qui est utilisée : pas de 13 Go à refaire.
    "POST /api/setup/model": async (req) => {
      const { model } = await ctx.body(req);
      const names = (await ollamaUp()) || [];
      // Un modèle du catalogue, ou n'importe quel modèle déjà installé dans Ollama.
      if (!MODELS.some((m) => m.id === model) && !names.includes(model)) throw new Error("Modèle inconnu : il n'est ni proposé par Sonde, ni installé dans Ollama.");
      const use = present(names, model) || model;
      ctx.settings.model = use;
      ctx.settings.ai = { ...(ctx.settings.ai || {}), provider: "ollama" };
      ctx.saveSettings();
      ctx.applyAI();
      return { model: use, present: names.includes(use) };
    },

    "POST /api/setup/skip": async () => { ctx.settings.setupSkipped = true; ctx.saveSettings(); return { ok: true }; },

    "POST /api/setup/start-ollama": async () => {
      if (await ollamaUp()) return { running: true };
      if (!startOllama()) throw new Error("Ollama n'est pas installé.");
      return { running: !!(await waitUp(30)) };
    },

    // Télécharge l'installateur officiel d'Ollama et le lance en silencieux.
    "POST /api/setup/install-ollama": async (req, res) => {
      const emit = ctx.stream(res);
      const file = path.join(os.tmpdir(), `OllamaSetup-${Date.now()}.exe`);
      // Bouton « Annuler » : la page ferme la connexion, on arrête le téléchargement.
      const ctl = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
      try {
        emit({ type: "step", label: "Téléchargement d'Ollama" });
        const r = await fetch(OLLAMA_SETUP_URL, { redirect: "follow", signal: ctl.signal });
        if (!r.ok) throw new Error(`Téléchargement impossible (${r.status}).`);
        const total = Number(r.headers.get("content-length")) || 0;
        const out = fs.createWriteStream(file);
        let got = 0, last = 0;
        for await (const chunk of r.body) {
          out.write(chunk);
          got += chunk.length;
          if (Date.now() - last > 300) { last = Date.now(); emit({ type: "progress", completed: got, total }); }
        }
        await new Promise((ok) => out.end(ok));
        if (ctl.signal.aborted) throw new Error("Installation annulée.");
        emit({ type: "step", label: "Installation d'Ollama" });
        // Installateur Inno Setup : installation pour l'utilisateur courant.
        const code = await new Promise((ok) => {
          const p = spawn(file, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES", "/SP-"], { windowsHide: true });
          p.on("close", ok);
          p.on("error", () => ok(-1));
        });
        if (code !== 0) throw new Error(`L'installation d'Ollama a échoué (code ${code}).`);
        emit({ type: "step", label: "Démarrage d'Ollama" });
        if (!(await waitUp(10))) startOllama();
        if (!(await waitUp(60))) throw new Error("Ollama est installé mais ne démarre pas. Lance-le depuis le menu Démarrer.");
        emit({ type: "done", ok: true });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally {
        fs.rmSync(file, { force: true });
        res.end();
      }
    },

    // Télécharge le modèle via Ollama. Ollama reprend tout seul là où il
    // s'était arrêté si la connexion coupe.
    "POST /api/setup/pull": async (req, res) => {
      const { model } = await ctx.body(req);
      if (!MODELS.some((m) => m.id === model)) return ctx.send(res, 400, { error: "Modèle inconnu." });
      const emit = ctx.stream(res);
      const ctl = new AbortController();
      res.on("close", () => { if (!res.writableFinished) ctl.abort(); });
      try {
        const r = await fetch(`${OLLAMA}/api/pull`, { method: "POST", body: JSON.stringify({ model, stream: true }), signal: ctl.signal });
        if (!r.ok) throw new Error(`Ollama a refusé le téléchargement (${r.status}).`);
        const dec = new TextDecoder();
        let buf = "", last = 0;
        for await (const chunk of r.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            const j = JSON.parse(line);
            if (j.error) throw new Error(j.error);
            if (j.total && Date.now() - last < 300 && j.completed !== j.total) continue;
            last = Date.now();
            emit({ type: "progress", status: j.status, completed: j.completed || 0, total: j.total || 0 });
          }
        }
        ctx.settings.model = model;
        ctx.settings.ai = { ...(ctx.settings.ai || {}), provider: "ollama" };
        ctx.saveSettings();
        ctx.applyAI();
        emit({ type: "done", model });
      } catch (e) {
        emit({ type: "error", error: e.name === "AbortError" ? "Téléchargement interrompu : il reprendra là où il s'est arrêté." : e.message });
      } finally {
        res.end();
      }
    },
  };
};
