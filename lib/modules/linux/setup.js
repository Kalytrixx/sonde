// Assistant de premier lancement (Linux) : vérifie le PC, installe Ollama
// (script officiel, avec le mot de passe administrateur) et télécharge le modèle.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const sh = require("../../sh");

const OLLAMA = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
const OLLAMA_SCRIPT_URL = "https://ollama.com/install.sh";

// Mêmes modèles que sous Windows. `need` : mémoire (vidéo ou vive) conseillée.
const MODELS = [
  { id: "gpt-oss:20b", aliases: ["gpt-oss:latest", "gpt-oss"], label: "GPT-OSS 20B", size: 13.8e9, need: 16,
    desc: "Le modèle pour lequel Sonde a été réglé. Le plus fiable pour l'analyse." },
  { id: "qwen3:8b", aliases: [], label: "Qwen3 8B", size: 5.2e9, need: 8,
    desc: "Plus léger, pour les PC avec moins de mémoire. Analyse un peu moins fine." },
  { id: "qwen3:4b", aliases: [], label: "Qwen3 4B", size: 2.6e9, need: 5,
    desc: "Pour les petites configurations. Explications correctes, analyse plus sommaire." },
];

async function ollamaUp() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    return j.models.map((m) => m.name);
  } catch { return null; }
}

function present(names, model) {
  const m = MODELS.find((x) => x.id === model);
  const accepted = [model, ...(m?.aliases || [])];
  return names.find((n) => accepted.includes(n)) || null;
}

// Cartes graphiques et leur mémoire : nvidia-smi pour NVIDIA, sysfs pour AMD
// (amdgpu publie mem_info_vram_total). Les puces Intel intégrées partagent la RAM.
async function gpus() {
  const out = [];
  if (sh.which("nvidia-smi")) {
    const txt = await sh.tryExec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 8000 });
    for (const l of txt.split("\n").filter(Boolean)) {
      const [name, mib] = l.split(",").map((x) => x.trim());
      out.push({ name, vramGB: Number(mib) / 1024 });
    }
  }
  let cards = [];
  try { cards = fs.readdirSync("/sys/class/drm").filter((c) => /^card\d+$/.test(c)); } catch {}
  for (const c of cards) {
    const dev = path.join("/sys/class/drm", c, "device");
    let vram = 0;
    try { vram = Number(fs.readFileSync(path.join(dev, "mem_info_vram_total"), "utf8")); } catch { continue; }
    let name = "Carte graphique AMD";
    try {
      const slot = /PCI_SLOT_NAME=(.+)/.exec(fs.readFileSync(path.join(dev, "uevent"), "utf8"))?.[1];
      const line = slot && (await sh.tryExec("lspci", ["-mm", "-s", slot]));
      const f = line && line.match(/"([^"]*)"/g)?.map((x) => x.slice(1, -1));
      if (f && f[2]) name = `${f[1].replace(/\s*\[AMD\/ATI\]/, "")} ${f[2]}`.trim();
    } catch {}
    if (vram > 512 * 1024 ** 2) out.push({ name, vramGB: vram / 1024 ** 3 });
  }
  return out;
}

const ollamaBin = () => sh.which("ollama") || ["/usr/local/bin/ollama", "/usr/bin/ollama"].find((f) => fs.existsSync(f)) || null;

module.exports = (ctx) => {
  let hw = null;
  let installer = null;   // processus d'installation en cours

  async function hardware() {
    if (hw) return hw;
    const g = await gpus().catch(() => []);
    hw = { ramGB: os.totalmem() / 1024 ** 3, gpus: g };
    hw.vramGB = Math.max(0, ...g.map((x) => x.vramGB));
    return hw;
  }

  function recommend(h) {
    const room = Math.max(h.vramGB, h.ramGB * 0.6);
    return (MODELS.find((m) => room >= m.need) || MODELS[MODELS.length - 1]).id;
  }

  // Ollama installé par son script : service systemd « ollama ». Sinon, on
  // lance « ollama serve » au nom de l'utilisateur.
  async function startOllama() {
    const bin = ollamaBin();
    if (!bin) return false;
    const unit = await sh.tryExec("systemctl", ["show", "ollama.service", "-p", "LoadState", "--value"]);
    if (unit.trim() === "loaded") {
      await sh.runElevated('systemctl start ollama.service').catch(() => {});
      return true;
    }
    spawn(bin, ["serve"], { detached: true, stdio: "ignore" }).unref();
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
        ollama: { installed: !!ollamaBin() || !!names, running: !!names, models: names || [] },
        ready: ctx.ai.describe().provider === "ollama" ? !!found : (await ctx.ai.status()).ok, skipped: !!ctx.settings.setupSkipped,
        ai: ctx.ai.describe(), platform: "linux",
      };
    },

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
      if (!(await startOllama())) throw new Error("Ollama n'est pas installé.");
      return { running: !!(await waitUp(30)) };
    },

    // Télécharge le script officiel d'Ollama et l'exécute avec les droits
    // administrateur (fenêtre de mot de passe de GNOME). Le script installe
    // Ollama dans /usr/local, crée le service systemd et ajoute les
    // bibliothèques ROCm ou CUDA selon la carte graphique.
    "POST /api/setup/install-ollama": async (req, res) => {
      const emit = ctx.stream(res);
      const file = path.join(os.tmpdir(), `ollama-install-${Date.now()}.sh`);
      let aborted = false;
      res.on("close", () => { if (!res.writableFinished) { aborted = true; installer?.kill("SIGTERM"); } });
      try {
        if (!sh.which("curl")) throw new Error("curl est nécessaire : installe-le avec « sudo apt install curl ».");
        emit({ type: "step", label: "Téléchargement du script d'installation d'Ollama" });
        const r = await fetch(OLLAMA_SCRIPT_URL, { redirect: "follow", signal: AbortSignal.timeout(30000) });
        if (!r.ok) throw new Error(`Téléchargement impossible (${r.status}).`);
        const script = await r.text();
        if (!/ollama/i.test(script) || !script.startsWith("#!")) throw new Error("Le script reçu n'est pas celui d'Ollama.");
        fs.writeFileSync(file, script, { mode: 0o644 });
        emit({ type: "step", label: "Installation d'Ollama (mot de passe administrateur)" });
        const code = await new Promise((ok) => {
          installer = spawn("pkexec", ["/bin/sh", file], { env: { ...process.env, LC_ALL: "C.UTF-8" } });
          let last = 0;
          const onData = (d) => {
            const txt = String(d);
            // Barre de progression de curl : « ###### 42.5% »
            const m = [...txt.matchAll(/(\d{1,3}(?:\.\d)?)%/g)].pop();
            if (m && Date.now() - last > 300) { last = Date.now(); emit({ type: "progress", completed: Number(m[1]), total: 100 }); }
            const line = txt.split(/[\r\n]/).map((l) => l.replace(/^[#\s]+/, "").trim()).filter((l) => l && !/%$/.test(l)).pop();
            if (line && /^>>>/.test(line)) emit({ type: "step", label: line.replace(/^>>>\s*/, "") });
          };
          installer.stdout.on("data", onData);
          installer.stderr.on("data", onData);
          installer.on("close", ok);
          installer.on("error", () => ok(-1));
        });
        installer = null;
        if (aborted) throw new Error("Installation annulée.");
        if (code === 126 || code === 127) throw new Error("Autorisation administrateur refusée.");
        if (code !== 0) throw new Error(`L'installation d'Ollama a échoué (code ${code}).`);
        emit({ type: "step", label: "Démarrage d'Ollama" });
        if (!(await waitUp(10))) await startOllama();
        if (!(await waitUp(60))) throw new Error("Ollama est installé mais ne démarre pas. Essaie « sudo systemctl start ollama ».");
        emit({ type: "done", ok: true });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally {
        fs.rmSync(file, { force: true });
        res.end();
      }
    },

    // Téléchargement du modèle : identique à Windows (API d'Ollama).
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
