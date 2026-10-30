// Petites fonctions communes aux modules Debian : à quel paquet appartient
// un fichier, quelles mises à jour sont en attente.

const sh = require("./sh");

// Fichiers -> paquet propriétaire, en une seule commande par lot de 200.
async function owners(files) {
  const map = new Map();
  const list = [...new Set(files.filter((f) => f && f.startsWith("/")))];
  for (let i = 0; i < list.length; i += 200) {
    const out = await sh.exec("dpkg", ["-S", ...list.slice(i, i + 200)], { okCodes: [0, 1], timeout: 60000 }).catch(() => "");
    for (const l of out.split("\n")) {
      const m = /^([^:]+(?::[a-z0-9]+)?(?:, [^:]+)*): (\/.*)$/.exec(l);
      if (m) map.set(m[2], m[1].split(", ")[0].replace(/:[a-z0-9]+$/, ""));
    }
  }
  // /bin -> /usr/bin (Debian « usrmerge ») : dpkg connaît parfois l'autre chemin.
  const missing = list.filter((f) => !map.has(f) && /^\/(bin|sbin|lib)\//.test(f));
  if (missing.length) {
    const alt = await owners(missing.map((f) => "/usr" + f));
    for (const f of missing) if (alt.has("/usr" + f)) map.set(f, alt.get("/usr" + f));
  }
  return map;
}

// Paquets à mettre à jour, d'après les listes déjà téléchargées (aucun droit
// requis ; elles sont rafraîchies par apt-daily ou Logiciels).
async function upgradable() {
  const out = await sh.tryExec("apt", ["list", "--upgradable"], { timeout: 60000 });
  return out.split("\n").map((l) => /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(l))
    .filter(Boolean).map((m) => ({ pkg: m[1], suite: m[2], version: m[3], from: m[4], security: /security/.test(m[2]) }));
}

module.exports = { owners, upgradable };
