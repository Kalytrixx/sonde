// Nettoyage système sous Debian : ce que seul l'administrateur peut nettoyer
// (paquets téléchargés, paquets devenus inutiles, journaux, rapports de
// plantage), plus Flatpak et la corbeille. Chaque opération est un script
// fixe ; la page ne choisit que lesquelles.

const fs = require("fs");
const path = require("path");
const sh = require("../../sh");
const P = require("../../platform");

const DAY = 864e5;
const dirSize = (p, budget = { n: 200000 }) => {
  let st;
  try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let t = 0;
  let names = [];
  try { names = fs.readdirSync(p); } catch { return 0; }
  for (const n of names) { if (--budget.n < 0) break; t += dirSize(path.join(p, n), budget); }
  return t;
};

// Taille de ce qu'« apt autoremove » retirerait (simulation, sans droits).
async function autoremovable() {
  const out = await sh.tryExec("apt-get", ["-s", "autoremove"], { timeout: 60000 });
  const pkgs = [...out.matchAll(/^Remv (\S+)/gm)].map((m) => m[1].replace(/:[a-z0-9]+$/, ""));
  if (!pkgs.length) return { pkgs, size: 0 };
  const q = await sh.tryExec("dpkg-query", ["-W", "-f", "${Installed-Size}\n", ...pkgs]);
  return { pkgs, size: q.split("\n").reduce((a, k) => a + (Number(k) || 0) * 1024, 0) };
}

// Paquets désinstallés dont il reste la configuration dans /etc (état « rc »).
async function residualConfigs() {
  const out = await sh.tryExec("dpkg-query", ["-W", "-f", "${db:Status-Abbrev} ${Package}\n"]);
  return out.split("\n").filter((l) => /^rc/.test(l)).map((l) => l.trim().split(/\s+/).pop());
}

// Docker : cache de construction et images sans nom (« dangling »), jamais
// les conteneurs ni les volumes, qui peuvent contenir des données.
async function dockerReclaim() {
  // Docker installé ET démon présent (sinon le nettoyage échouerait).
  if (!sh.which("docker") || !fs.existsSync("/var/run/docker.sock")) return null;
  const out = await sh.tryExec("docker", ["system", "df", "--format", "{{json .}}"], { timeout: 15000 });
  if (!out) return { size: null };   // démon arrêté ou compte hors du groupe docker
  let size = 0;
  for (const l of out.split("\n").filter(Boolean)) {
    try {
      const j = JSON.parse(l);
      if (/Build Cache/i.test(j.Type)) {
        const m = /([\d.]+)\s*([kMGT]?B)/i.exec(j.Reclaimable || "");
        if (m) size += Number(m[1]) * { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2].toUpperCase()];
      }
    } catch {}
  }
  return { size };
}

async function journalSize() {
  const out = await sh.tryExec("journalctl", ["--disk-usage"]);
  const m = /take up ([\d.]+)([KMGT])/.exec(out);
  if (m) return Number(m[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2]];
  return dirSize("/var/log/journal") || null;
}

async function flatpakUnused() {
  if (!sh.which("flatpak")) return null;
  // flatpak n'a pas de simulation : on compte les runtimes qu'aucune appli n'utilise.
  const apps = await sh.tryExec("flatpak", ["list", "--app", "--columns=runtime"]);
  const used = new Set(apps.split("\n").map((l) => l.trim()).filter(Boolean).map((r) => r.split("/")[0]));
  const rts = await sh.tryExec("flatpak", ["list", "--runtime", "--columns=application,size"]);
  let size = 0, n = 0;
  for (const l of rts.split("\n").filter(Boolean)) {
    const [id, sz] = l.split("\t");
    // Les extensions (GL, codecs…) suivent leur runtime : on ne compte que les runtimes « nus ».
    if (!used.has(id) && !/\.(GL|Codecs|Locale|Debug|openh264|VAAPI)/.test(id) && /Platform|Sdk/.test(id)) {
      n++;
      const m = /([\d.,]+)\s*([kMG]?)B/.exec(sz || "");
      if (m) size += Number(m[1].replace(",", ".")) * { "": 1, k: 1e3, M: 1e6, G: 1e9 }[m[2]];
    }
  }
  return { count: n, size };
}

// Données d'applications Flatpak désinstallées : ~/.var/app/<id> reste quand
// on désinstalle depuis Logiciels ou Discover (Flatpak garde les données par défaut).
async function flatpakOrphans() {
  if (!sh.which("flatpak")) return null;
  const base = path.join(require("os").homedir(), ".var", "app");
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return null; }
  const listed = await sh.exec("flatpak", ["list", "--app", "--columns=application"], { timeout: 30000 }).catch(() => null);
  if (listed == null) return null;   // sans la liste, on ne peut rien affirmer
  const installed = new Set(listed.split("\n").map((l) => l.trim()).filter(Boolean));
  const orphans = dirs.filter((id) => id.includes(".") && !installed.has(id)).map((id) => ({ id, path: path.join(base, id), size: dirSize(path.join(base, id)) }));
  return orphans.length ? orphans : null;
}

const ITEMS = [
  { id: "aptclean", label: "Paquets téléchargés par apt",
    desc: "Fichiers .deb gardés après l'installation des mises à jour. apt les retélécharge si besoin.",
    admin: true, risk: "faible", script: "apt-get clean" },
  { id: "autoremove", label: "Paquets devenus inutiles (et anciens noyaux)",
    desc: "Dépendances installées automatiquement que plus aucun programme n'utilise, dont les anciennes versions du noyau. Debian garde toujours le noyau en cours et le précédent.",
    admin: true, risk: "moyen", script: "DEBIAN_FRONTEND=noninteractive apt-get autoremove -y -q" },
  { id: "journal", label: "Journaux système de plus de 2 semaines",
    desc: "Historique des messages du système (journald). On garde les 2 dernières semaines, utiles en cas de souci.",
    admin: true, risk: "faible", script: "journalctl --vacuum-time=2weeks" },
  { id: "coredump", label: "Rapports de plantage",
    desc: "Copies mémoire de programmes plantés (systemd-coredump). Utiles seulement pour un développeur.",
    admin: true, risk: "faible", paths: ["/var/lib/systemd/coredump", "/var/crash"],
    script: "find /var/lib/systemd/coredump /var/crash -mindepth 1 -maxdepth 1 -type f -delete 2>/dev/null; true" },
  { id: "vartmp", label: "Temporaires système anciens",
    desc: "Fichiers de /var/tmp qui n'ont pas bougé depuis plus de 7 jours.",
    admin: true, risk: "faible", paths: ["/var/tmp"],
    script: "find /var/tmp -mindepth 1 -mtime +7 -delete 2>/dev/null; true" },
  { id: "residual", label: "Configurations de paquets désinstallés",
    desc: "Fichiers de réglages laissés dans /etc par des paquets retirés avec « supprimer » plutôt que « purger ». Ils ne servent plus à rien.",
    admin: true, risk: "faible",
    script: "pkgs=$(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\\n' | awk '/^rc/ {print $2}'); [ -z \"$pkgs\" ] || dpkg --purge $pkgs" },
  { id: "docker", label: "Docker : cache de construction et images sans nom",
    desc: "Couches intermédiaires des « docker build » et images remplacées par une version plus récente. Les conteneurs, les images utilisées et les volumes ne sont pas touchés.",
    admin: true, risk: "faible", script: "docker builder prune -f && docker image prune -f" },
  { id: "flatpak", label: "Environnements Flatpak inutilisés",
    desc: "Runtimes Flatpak qu'aucune application installée n'utilise plus (restes de mises à jour ou de désinstallations).",
    admin: false, risk: "faible" },
  { id: "flatpakdata", label: "Données d'applications Flatpak désinstallées",
    desc: "Réglages et fichiers que Flatpak garde dans ~/.var/app après une désinstallation faite depuis Logiciels ou Discover. Ils partent dans la corbeille : récupérables si tu réinstalles l'application.",
    admin: false, risk: "moyen" },
  { id: "recyclebin", label: "Vider la corbeille",
    desc: "Suppression DÉFINITIVE de tout ce qui est dans la corbeille. Plus aucune restauration possible, y compris depuis le journal de Sonde.",
    admin: false, risk: "définitif" },
];

module.exports = (ctx) => {
  // Espace libre de tous les disques : apt libère / ; la corbeille, souvent /home.
  const totalFree = async () => { let f = 0; for (const d of P.drives()) { const s = await ctx.freeSpace(d); if (s.free == null) return { free: null }; f += s.free; } return { free: f }; };

  function scanSize(paths) {
    const scan = ctx.getScan();
    if (!scan) return null;
    let total = 0, known = false;
    for (const p of paths) {
      const d = scan.get(p);
      if (d) { total += d.size; known = true; }
    }
    return known ? total : null;
  }

  const userRun = {
    flatpak: () => sh.exec("flatpak", ["uninstall", "--unused", "-y", "--noninteractive"], { timeout: 1800000 }),
    // Dans la corbeille (pas de suppression définitive), liste relue au moment de l'envoi.
    flatpakdata: async () => {
      const list = await flatpakOrphans();
      if (!list) return;
      const res = await require("../../trash").send(list.map((o) => ({ path: o.path, size: o.size })));
      if (res.some((r) => r.failed)) throw new Error("Certains dossiers n'ont pas pu partir à la corbeille.");
    },
    recyclebin: async () => {
      // gio vide toutes les corbeilles de l'utilisateur, comme le bouton de Fichiers.
      if (sh.which("gio")) return sh.exec("gio", ["trash", "--empty"], { timeout: 600000 });
      const { allTrashDirs } = require("../../trash");
      for (const d of allTrashDirs()) for (const sub of ["files", "info"]) {
        const dir = path.join(d, sub);
        for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      }
    },
  };

  return {
    "GET /api/cleanup": async () => {
      const [ar, js, fp, rc, dk, fo] = await Promise.all([autoremovable(), journalSize(), flatpakUnused(), residualConfigs(), dockerReclaim(), flatpakOrphans()]);
      let bin = null;
      try {
        const { binItems } = require("../../trash");
        const items = binItems();
        bin = { count: items.length, size: items.reduce((a, i) => a + i.size, 0) };
      } catch {}
      const sizes = {
        aptclean: dirSize("/var/cache/apt/archives"),
        autoremove: ar.size,
        // On garde 2 semaines : on estime ce qui part à la moitié au plus.
        journal: js != null ? Math.max(0, js - 64 * 1024 ** 2) : null,
        coredump: scanSize(["/var/lib/systemd/coredump", "/var/crash"]) ?? dirSize("/var/lib/systemd/coredump"),
        vartmp: null,
        flatpak: fp?.size ?? null,
        residual: null,
        docker: dk?.size ?? null,
        flatpakdata: fo ? fo.reduce((a, o) => a + o.size, 0) : null,
        recyclebin: bin?.size ?? null,
      };
      return {
        platform: "linux",
        windowsOld: false,
        items: ITEMS.filter((i) => i.id !== "flatpak" || fp).filter((i) => i.id !== "autoremove" || ar.pkgs.length)
          .filter((i) => i.id !== "residual" || rc.length).filter((i) => i.id !== "docker" || dk).filter((i) => i.id !== "flatpakdata" || fo).map((i) => ({
          id: i.id, label: i.label,
          desc: i.id === "autoremove" ? `${i.desc} ${ar.pkgs.length} paquet(s) : ${ar.pkgs.slice(0, 6).join(", ")}${ar.pkgs.length > 6 ? "…" : ""}.`
            : i.id === "flatpakdata" ? `${i.desc} ${fo.length} application(s) : ${fo.slice(0, 5).map((o) => o.id).join(", ")}${fo.length > 5 ? "…" : ""}.`
            : i.id === "residual" ? `${i.desc} ${rc.length} paquet(s) : ${rc.slice(0, 6).join(", ")}${rc.length > 6 ? "…" : ""}.` : i.desc,
          admin: i.admin, risk: i.risk, slow: !!i.slow, estimate: i.id === "journal" ? "jusqu'à quelques Go" : undefined,
          size: sizes[i.id] ?? null,
        })),
      };
    },

    // Une seule demande de mot de passe pour toutes les opérations administrateur.
    "POST /api/cleanup/run": async (req) => {
      const { ids } = await ctx.body(req);
      const chosen = ITEMS.filter((i) => (ids || []).includes(i.id));
      if (!chosen.length) throw new Error("Rien de sélectionné.");
      const before = await totalFree();
      const results = [];
      const admin = chosen.filter((i) => i.admin);
      if (admin.length) {
        // Chaque opération est isolée : l'échec de l'une n'empêche pas les autres.
        // Le script écrit une ligne « id ok » ou « id ko » par opération.
        const script = admin.map((i) => `( ${i.script} ) >/dev/null 2>&1 && echo "${i.id} ok" || echo "${i.id} ko"`).join("\n");
        try {
          const out = await sh.runElevated(script);
          for (const i of admin) {
            const ok = new RegExp(`^${i.id} ok$`, "m").test(out);
            results.push({ id: i.id, ok, error: ok ? undefined : "La commande a échoué." });
          }
        } catch (e) {
          for (const i of admin) results.push({ id: i.id, ok: false, error: e.message });
        }
      }
      for (const i of chosen.filter((x) => !x.admin)) {
        try { await userRun[i.id](); results.push({ id: i.id, ok: true }); }
        catch (e) { results.push({ id: i.id, ok: false, error: e.message }); }
      }
      const after = await totalFree();
      const freed = before.free != null && after.free != null ? after.free - before.free : null;
      for (const r of results.filter((x) => x.ok)) {
        const item = ITEMS.find((i) => i.id === r.id);
        ctx.journal.add({ kind: "system", title: `Nettoyage système : ${item.label}` });
      }
      return { results, freed };
    },
  };
};
