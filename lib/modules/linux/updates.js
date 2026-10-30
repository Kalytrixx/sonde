// Mises à jour et entretien de Debian : paquets apt (sécurité en tête) et
// Flatpak, installation suivie en direct, contrôle des dépôts (sécurité
// absente, versions de Debian mélangées, dépôts en erreur), santé de dpkg,
// TRIM des SSD.

const fs = require("fs");
const os = require("os");
const path = require("path");
const sh = require("../../sh");

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const OFFICIAL = /(^|\/\/)([\w.-]+\.)?debian\.org\//;

function osRelease() {
  const txt = read("/etc/os-release") || "";
  const v = Object.fromEntries(txt.split("\n").map((l) => /^(\w+)="?(.*?)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  return { name: v.PRETTY_NAME || "Linux", codename: v.VERSION_CODENAME || null, debian: v.ID === "debian" };
}

// ------------------------------------------------------------- dépôts ---
// Lit sources.list (format une ligne) et sources.list.d/*.sources (deb822).
function sources() {
  const out = [];
  const files = ["/etc/apt/sources.list"];
  try { for (const n of fs.readdirSync("/etc/apt/sources.list.d")) files.push(path.join("/etc/apt/sources.list.d", n)); } catch {}
  for (const f of files) {
    const txt = read(f);
    if (!txt) continue;
    if (f.endsWith(".list")) {
      for (const l of txt.split("\n")) {
        const m = /^\s*deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s*(.*)$/.exec(l);
        if (m) out.push({ file: f, uri: m[1], suites: [m[2]], components: m[3].split(/\s+/).filter(Boolean) });
      }
    } else if (f.endsWith(".sources")) {
      for (const stanza of txt.split(/\n\s*\n/)) {
        const v = {};
        for (const l of stanza.split("\n")) { const m = /^([\w-]+):\s*(.*)$/.exec(l); if (m) v[m[1].toLowerCase()] = m[2]; }
        if (!v.types || !/\bdeb\b/.test(v.types) || /^no$/i.test(v.enabled || "")) continue;
        for (const uri of (v.uris || "").split(/\s+/).filter(Boolean)) {
          out.push({ file: f, uri, suites: (v.suites || "").split(/\s+/).filter(Boolean), components: (v.components || "").split(/\s+/).filter(Boolean) });
        }
      }
    }
  }
  return out.map((r) => ({ ...r, official: OFFICIAL.test(r.uri), host: (/^\w+:\/\/([^/]+)/.exec(r.uri) || [])[1] || r.uri }));
}

function checkSources(repos, codename, errors) {
  const issues = [];
  const off = repos.filter((r) => r.official);
  const suites = off.flatMap((r) => r.suites);
  if (codename && off.length && !suites.some((s) => s === `${codename}-security` || s === "stable-security")) {
    issues.push({ level: "bad", id: "security-repo", title: "Le dépôt de sécurité de Debian n'est pas configuré",
      why: "Sans lui, les correctifs de sécurité n'arrivent qu'aux mises à jour de version : les failles connues restent ouvertes.", fix: "security-repo" });
  }
  if (codename) {
    const others = [...new Set(suites.filter((s) => !s.startsWith(codename) && !s.startsWith("stable") && !/^(testing|unstable|sid|experimental)/.test(s)))];
    if (others.length) issues.push({ level: "warn", id: "mixed", title: `Dépôt d'une autre version de Debian : ${others.join(", ")}`,
      why: `Ce système est Debian ${codename}. Mélanger des paquets de versions différentes (« Frankendebian ») finit souvent en mises à jour bloquées. Reste d'une ancienne mise à niveau ? À retirer de ${off.find((r) => r.suites.some((s) => others.includes(s)))?.file}.` });
    const unstable = [...new Set(suites.filter((s) => /^(testing|unstable|sid|experimental)/.test(s)))];
    if (unstable.length) issues.push({ level: "warn", id: "unstable", title: `Dépôt de développement activé : ${unstable.join(", ")}`,
      why: "Ces dépôts reçoivent des paquets non finalisés. Sur une Debian stable, ils peuvent remplacer des pièces du système par des versions incompatibles." });
  }
  const main = off.find((r) => codename && r.suites.includes(codename));
  if (main && !main.components.includes("non-free-firmware")) {
    issues.push({ level: "info", id: "firmware", title: "Le dépôt non-free-firmware n'est pas activé",
      why: "Il contient les firmwares des cartes Wi-Fi, graphiques AMD/Intel récentes et du microcode processeur. Utile seulement si un périphérique fonctionne mal (voir Pilotes)." });
  }
  for (const e of errors) issues.push({ level: "warn", id: "error", title: `Dépôt en erreur : ${e.host}`, why: e.text });
  return issues;
}

// ------------------------------------------------------- mises à jour ---
// Ce qu'apt ferait (simulation, sans droits) : paquets mis à jour, nouveaux,
// retenus, et taille à télécharger.
async function aptPreview() {
  const out = await sh.tryExec("apt-get", ["-s", "-o", "Debug::NoLocking=1", "upgrade", "--with-new-pkgs"], { timeout: 120000 });
  const items = [];
  for (const m of out.matchAll(/^Inst (\S+) (?:\[([^\]]+)\] )?\((\S+) ([^\[)]+)/gm)) {
    items.push({ pkg: m[1], from: m[2] || null, version: m[3], suite: m[4].trim(), security: /security/i.test(m[4]), isNew: !m[2] });
  }
  const kept = (/kept back:\n((?:\s+.+\n)+)/.exec(out)?.[1] || "").trim().split(/\s+/).filter(Boolean);
  const uris = await sh.tryExec("apt-get", ["--print-uris", "-qq", "-o", "Debug::NoLocking=1", "upgrade", "--with-new-pkgs"], { timeout: 120000 });
  const download = uris.split("\n").reduce((a, l) => a + (Number(l.split(" ")[2]) || 0), 0);
  return { items, kept, download };
}

function listsAge() {
  let newest = 0;
  try {
    for (const n of fs.readdirSync("/var/lib/apt/lists")) {
      if (!/InRelease$|Release$/.test(n)) continue;
      newest = Math.max(newest, fs.statSync(path.join("/var/lib/apt/lists", n)).mtimeMs);
    }
  } catch {}
  return newest || null;
}

async function flatpakUpdates() {
  if (!sh.which("flatpak")) return null;
  const out = await sh.tryExec("flatpak", ["remote-ls", "--updates", "--columns=application,version,origin"], { timeout: 30000 });
  return out.split("\n").filter(Boolean).map((l) => { const [id, version, origin] = l.split("\t"); return { id, version, origin }; })
    .filter((f) => f.id && f.id.includes("."));
}

// --------------------------------------------------------------- santé ---
async function health() {
  const issues = [];
  const audit = (await sh.tryExec("dpkg", ["--audit"])).trim();
  if (audit) issues.push({ level: "bad", id: "dpkg", title: "Installation de paquets interrompue",
    why: "Une installation ou une mise à jour s'est arrêtée en cours de route (coupure, fenêtre fermée). Tant que ce n'est pas réparé, apt refusera d'installer autre chose.", fix: "repair", detail: audit.split("\n").slice(0, 6).join("\n") });
  const held = (await sh.tryExec("apt-mark", ["showhold"])).trim().split("\n").filter(Boolean);
  if (held.length) issues.push({ level: "info", id: "held", title: `${held.length} paquet(s) bloqué(s) à leur version actuelle`,
    why: `Ils ne reçoivent plus de mises à jour : ${held.slice(0, 8).join(", ")}${held.length > 8 ? "…" : ""}. Normal si tu l'as voulu (pilote NVIDIA, logiciel figé…).` });
  // TRIM : sans lui, un SSD ralentit avec le temps.
  let ssd = false;
  try {
    for (const b of fs.readdirSync("/sys/block")) {
      if (/^(loop|ram|zram|sr|dm-)/.test(b)) continue;
      if ((read(`/sys/block/${b}/queue/rotational`) || "").trim() === "0") ssd = true;
    }
  } catch {}
  const trim = (await sh.tryExec("systemctl", ["is-enabled", "fstrim.timer"])).trim();
  if (ssd && trim && trim !== "enabled") issues.push({ level: "warn", id: "fstrim", title: "Le TRIM hebdomadaire des SSD est désactivé",
    why: "Le TRIM indique au SSD les blocs libérés. Sans lui, les écritures ralentissent avec le temps. Debian fournit une minuterie hebdomadaire (fstrim.timer), simplement pas activée.", fix: "fstrim" });
  if (fs.existsSync("/run/reboot-required")) issues.push({ level: "warn", id: "reboot", title: "Redémarrage nécessaire",
    why: "Une mise à jour (noyau, bibliothèque système) ne sera active qu'après un redémarrage." });
  else {
    try {
      const running = os.release();
      const k = fs.readdirSync("/lib/modules").filter((d) => fs.existsSync(`/boot/vmlinuz-${d}`)).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
      if (k.length && k.includes(running) && k[k.length - 1] !== running) issues.push({ level: "warn", id: "reboot", title: "Nouveau noyau installé",
        why: `Le noyau ${k[k.length - 1]} est installé mais c'est encore ${running} qui tourne : redémarre pour profiter de ses correctifs.` });
    } catch {}
  }
  return issues;
}

// ---------------------------------------------------------- instantanés ---
// Timeshift : un instantané du système avant les changements risqués.
// Il doit avoir été configuré une fois (emplacement des instantanés).
function timeshift() {
  // Pas sh.which : son cache ne verrait pas une installation faite depuis Sonde.
  const installed = ["/usr/bin/timeshift", "/usr/sbin/timeshift"].some((f) => fs.existsSync(f));
  const conf = read("/etc/timeshift/timeshift.json") || read("/etc/timeshift.json");
  let configured = false;
  try { configured = !!JSON.parse(conf || "{}").backup_device_uuid; } catch {}
  return { installed, configured };
}
const SNAPSHOT = (why) => `timeshift --create --scripted --comments ${JSON.stringify(`Sonde : ${why}`)} --tags O`;

// ------------------------------------------- prochaine version de Debian ---
// Ce que les guides de mise à niveau demandent de vérifier avant de changer
// de version : place libre, système à jour et sain, paquets obsolètes,
// dépôts tiers, paquets bloqués, rétroportages.
const NEXT = { trixie: { name: "Debian 14", codename: "forky" }, bookworm: { name: "Debian 13", codename: "trixie" } };
async function upgradeChecks(rel, repos, apt, healthIssues) {
  const next = NEXT[rel.codename];
  if (!next) return null;
  const checks = [];
  const free = (p) => { try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch { return null; } };
  const root = free("/"), varFree = free("/var/cache/apt/archives");
  const minFree = Math.min(...[root, varFree].filter((x) => x != null));
  checks.push({ id: "space", ok: minFree >= 5 * 1024 ** 3, title: "Au moins 5 Go libres pour télécharger la nouvelle version",
    detail: Number.isFinite(minFree) ? `${(minFree / 1024 ** 3).toFixed(1).replace(".", ",")} Go libres sur la partition du système.` : "Place libre : Non disponible." });
  checks.push({ id: "uptodate", ok: !apt.items.length, title: "Système à jour avant de changer de version",
    detail: apt.items.length ? `${apt.items.length} mise(s) à jour à installer d'abord.` : "Aucune mise à jour en attente." });
  const broken = healthIssues.some((i) => i.id === "dpkg");
  checks.push({ id: "dpkg", ok: !broken, title: "Aucune installation de paquets interrompue", detail: broken ? "À réparer d'abord (bouton « Réparer » plus haut)." : "dpkg est en ordre." });
  const obsolete = (await sh.tryExec("apt", ["list", "--installed", "?obsolete"], { timeout: 60000 })).split("\n").filter((l) => /\//.test(l)).map((l) => l.split("/")[0])
    .filter((p) => p !== "sonde");   // Sonde lui-même, installé depuis son .deb
  checks.push({ id: "obsolete", ok: obsolete.length === 0, warnOnly: true, title: "Paquets qui ne viennent plus d'aucun dépôt",
    detail: obsolete.length ? `${obsolete.length} paquet(s) : ${obsolete.slice(0, 6).join(", ")}${obsolete.length > 6 ? "…" : ""}. Installés à la main ou retirés de Debian : à vérifier, ils peuvent gêner la mise à niveau.` : "Aucun." });
  const third = repos.filter((r) => !r.official);
  checks.push({ id: "thirdparty", ok: third.length === 0, warnOnly: true, title: "Dépôts tiers à désactiver pendant la mise à niveau",
    detail: third.length ? `${[...new Set(third.map((r) => r.host))].join(", ")} : à désactiver avant, puis à réactiver quand leur éditeur prend en charge ${next.name}.` : "Aucun dépôt tiers." });
  const held = (await sh.tryExec("apt-mark", ["showhold"])).trim().split("\n").filter(Boolean);
  checks.push({ id: "held", ok: held.length === 0, warnOnly: true, title: "Paquets bloqués à leur version", detail: held.length ? `${held.join(", ")} : ils ne suivront pas la mise à niveau.` : "Aucun." });
  const bp = (await sh.tryExec("apt", ["list", "--installed", "?archive(-backports$)"], { timeout: 60000 })).split("\n").filter((l) => /\//.test(l)).length;
  checks.push({ id: "backports", ok: true, warnOnly: true, title: "Paquets venant des rétroportages (backports)",
    detail: bp ? `${bp} paquet(s) (Mesa ou un noyau plus récent, par exemple) : normal, ils seront remplacés par les versions de ${next.name}.` : "Aucun." });
  const ts = timeshift();
  checks.push({ id: "snapshot", ok: ts.configured, warnOnly: true, title: "Instantané possible avant de commencer",
    detail: ts.configured ? "Timeshift est prêt : crée un instantané juste avant la mise à niveau." : ts.installed ? "Timeshift est installé mais pas encore configuré." : "Timeshift n'est pas installé : en cas de problème, il faudrait réinstaller." });
  return { next, checks };
}

module.exports = (ctx) => {
  let lastErrors = [];     // dépôts en erreur au dernier « apt update »
  let running = false;

  const FIXES = {
    fstrim: { label: "TRIM hebdomadaire des SSD activé", script: "systemctl enable --now fstrim.timer", revert: "fstrim-off" },
    repair: { label: "Installation de paquets réparée", script: "export DEBIAN_FRONTEND=noninteractive; dpkg --configure -a && apt-get -f install -y -q" },
    "timeshift-install": { label: "Timeshift installé", script: "DEBIAN_FRONTEND=noninteractive apt-get install -y -q timeshift", revert: "timeshift-remove" },
  };
  ctx.reverters["fstrim-off"] = () => sh.runElevated("systemctl disable --now fstrim.timer");
  ctx.reverters["timeshift-remove"] = () => sh.runElevated("DEBIAN_FRONTEND=noninteractive apt-get remove -y -q timeshift");
  ctx.reverters["security-repo-off"] = () => sh.runElevated("rm -f /etc/apt/sources.list.d/debian-security-sonde.sources");

  return {
    "GET /api/updates": async () => {
      const rel = osRelease();
      const [apt, fp, hl] = await Promise.all([aptPreview(), flatpakUpdates(), health()]);
      const repos = sources();
      const ts = timeshift();
      // Timeshift absent ou pas configuré : on le signale dans l'entretien.
      if (!ts.installed) hl.push({ level: "info", id: "timeshift", title: "Pas d'instantané du système possible",
        why: "Timeshift photographie le système (pas tes documents) pour revenir en arrière si une mise à jour tourne mal. Une fois installé, ouvre-le une fois pour choisir où ranger les instantanés.", fix: "timeshift-install" });
      else if (!ts.configured) hl.push({ level: "info", id: "timeshift", title: "Timeshift n'est pas encore configuré",
        why: "Ouvre Timeshift une fois et choisis le disque où ranger les instantanés : Sonde pourra ensuite en créer un avant chaque mise à jour.", tool: "timeshift" });
      return {
        platform: "linux", os: rel, listsAt: listsAge(), apt, flatpak: fp, health: hl, snapshot: ts,
        repos: repos.map(({ file, uri, suites, components, official, host }) => ({ file, uri, suites, components, official, host })),
        repoIssues: checkSources(repos, rel.codename, lastErrors), running, nextRelease: await upgradeChecks(rel, repos, apt, hl).catch(() => null),
      };
    },

    // « apt update » : rafraîchit la liste des paquets disponibles, en flux.
    "POST /api/updates/refresh": async (req, res) => {
      const emit = ctx.stream(res);
      if (running) { emit({ type: "error", error: "Une opération apt est déjà en cours." }); return res.end(); }
      running = true;
      const errors = [];
      try {
        emit({ type: "step", label: "Recherche des mises à jour (mot de passe administrateur)" });
        const code = await sh.streamElevated("apt-get update", [], (l) => {
          const err = /^(?:Err:\d+|E:|W:)\s*(.*)$/.exec(l);
          if (err) {
            const host = (/https?:\/\/([^/\s]+)/.exec(l) || [])[1];
            if (host && !errors.some((e) => e.host === host)) errors.push({ host, text: err[1].slice(0, 300) });
          }
          emit({ type: "log", text: l });
        });
        if (code === 126 || code === 127) throw new Error("Autorisation administrateur refusée.");
        lastErrors = errors;
        emit({ type: "done", code, errors });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally { running = false; res.end(); }
    },

    // Installe les mises à jour apt (sans jamais retirer de paquet : les
    // mises à jour qui en retireraient restent « retenues »), puis Flatpak.
    "POST /api/updates/apply": async (req, res) => {
      const { flatpak = true, snapshot = false } = await ctx.body(req);
      const emit = ctx.stream(res);
      if (running) { emit({ type: "error", error: "Une opération apt est déjà en cours." }); return res.end(); }
      running = true;
      try {
        const pv = await aptPreview();
        const total = pv.items.length;
        let done = 0;
        // Instantané Timeshift d'abord, dans la même autorisation : s'il échoue, rien n'est installé.
        const snap = snapshot && timeshift().configured;
        if (total) {
          emit({ type: "step", label: snap ? "Instantané du système, puis installation (mot de passe administrateur)" : `Installation de ${total} mise(s) à jour (mot de passe administrateur)` });
          const code = await sh.streamElevated(`export DEBIAN_FRONTEND=noninteractive
            ${snap ? `${SNAPSHOT("avant les mises à jour")} || { echo "Instantané Timeshift impossible : rien n'a été installé."; exit 3; }` : ""}
            apt-get update -q
            apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade --with-new-pkgs`, [], (l) => {
            if (/^Setting up /.test(l)) { done++; emit({ type: "progress", completed: Math.min(done, total), total }); }
            emit({ type: "log", text: l });
          });
          if (code === 126 || code === 127) throw new Error("Autorisation administrateur refusée.");
          if (code === 3) throw new Error("L'instantané Timeshift a échoué : aucune mise à jour n'a été installée.");
          if (code !== 0) throw new Error(`apt s'est arrêté en erreur (code ${code}). Regarde le détail ci-dessous ; « Réparer » peut aider.`);
          if (snap) ctx.journal.add({ kind: "system", title: "Instantané Timeshift créé avant les mises à jour", detail: "Pour revenir en arrière : ouvre Timeshift et restaure l'instantané « Sonde : avant les mises à jour »." });
          ctx.journal.add({ kind: "system", title: `Mises à jour installées : ${total} paquet(s)`,
            detail: pv.items.slice(0, 12).map((i) => i.pkg).join(", ") + (total > 12 ? "…" : "") });
        }
        if (flatpak && sh.which("flatpak")) {
          emit({ type: "step", label: "Mise à jour des applications Flatpak" });
          await sh.exec("flatpak", ["update", "-y", "--noninteractive"], { timeout: 3600000 }).then((o) => {
            for (const l of o.split("\n").filter(Boolean).slice(-20)) emit({ type: "log", text: l });
          }).catch((e) => emit({ type: "log", text: `Flatpak : ${e.message}` }));
        }
        emit({ type: "done", installed: total });
      } catch (e) {
        emit({ type: "error", error: e.message });
      } finally { running = false; res.end(); }
    },

    "POST /api/updates/fix": async (req) => {
      const { id } = await ctx.body(req);
      if (id === "security-repo") {
        // Ajoute le dépôt de sécurité de la version installée, au format deb822.
        const { codename } = osRelease();
        if (!codename || !/^[a-z]+$/.test(codename)) throw new Error("Version de Debian inconnue.");
        const main = sources().find((r) => r.official && r.suites.includes(codename));
        const comps = (main?.components.length ? main.components : ["main"]).filter((c) => /^[a-z-]+$/.test(c)).join(" ");
        await sh.runElevated(`cat > /etc/apt/sources.list.d/debian-security-sonde.sources <<EOF
Types: deb
URIs: https://security.debian.org/debian-security
Suites: $1-security
Components: $2
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF`, [codename, comps]);
        ctx.journal.add({ kind: "system", title: "Dépôt de sécurité Debian ajouté", revert: { type: "security-repo-off", args: {} } });
        return { ok: true };
      }
      const f = FIXES[id];
      if (!f) throw new Error("Correction inconnue.");
      await sh.runElevated(f.script, [], { timeout: 30 * 60000 });
      ctx.journal.add({ kind: "system", title: f.label, revert: f.revert ? { type: f.revert, args: {} } : undefined });
      return { ok: true };
    },
  };
};
