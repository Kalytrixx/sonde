// Pilotes sous Debian : sous Linux ils font partie du noyau. Ce qui compte :
// un périphérique sans pilote, un firmware manquant (paquets firmware-*),
// le microcode du processeur, et les mises à jour du noyau, de Mesa, des
// firmwares (apt) et du firmware des appareils (fwupd).

const fs = require("fs");
const os = require("os");
const sh = require("../../sh");
const { upgradable } = require("../../debian");

// Fichier de firmware -> paquet Debian qui le fournit (dépôt non-free-firmware).
const FIRMWARE_PKG = [
  [/^iwlwifi-|^intel\/ibt-/, "firmware-iwlwifi"],
  [/^(rtl_nic|rtl_bt|rtlwifi|rtw88|rtw89)\//, "firmware-realtek"],
  [/^(amdgpu|radeon)\//, "firmware-amd-graphics"],
  [/^(ath9k_htc|ath10k|ath11k|ath12k|qca)\//, "firmware-atheros"],
  [/^brcm\//, "firmware-brcm80211"],
  [/^intel\/sof|^intel\/avs/, "firmware-sof-signed"],
  [/^regulatory\.db/, "wireless-regdb"],
  [/^(i915|xe|nvidia|mediatek|mt76|cirrus|rtl_usb)\//, "firmware-misc-nonfree"],
];
const firmwarePkg = (f) => (FIRMWARE_PKG.find(([re]) => re.test(f)) || [, "firmware-misc-nonfree"])[1];

// Classes PCI qui comptent, et leur famille (mêmes codes que sous Windows).
const CLASSES = [
  [/VGA|3D controller|Display controller/i, "DISPLAY", "Carte graphique"],
  [/Ethernet|Network controller/i, "NET", "Réseau"],
  [/Audio|Multimedia/i, "MEDIA", "Son"],
  [/Non-Volatile memory|SATA|RAID|SCSI|IDE interface/i, "HDC", "Contrôleur de stockage"],
  [/USB controller/i, "USB", "USB"],
];

function lspciRecords(txt) {
  return txt.split(/\n\n+/).map((b) => {
    const o = {};
    for (const l of b.split("\n")) { const m = /^(\w+):\s*(.*)$/.exec(l); if (m && !(m[1] in o)) o[m[1]] = m[2]; }
    return o;
  }).filter((o) => o.Slot);
}

// Date de compilation du noyau (« … Debian 6.12.48-1 (2025-09-20) »).
function kernelDate() {
  const m = /\((\d{4}-\d{2}-\d{2})\)/.exec(os.version ? os.version() : "");
  return m ? m[1] : null;
}

async function pkgVersion(pkg) {
  return (await sh.tryExec("dpkg-query", ["-W", "-f", "${db:Status-Abbrev}\t${Version}", pkg])).replace(/^ii\s*\t?/, "").trim() || null;
}

async function missingFirmware() {
  // Le journal du noyau : lisible par les membres des groupes adm ou systemd-journal.
  let log = await sh.tryExec("journalctl", ["-k", "-b", "-o", "cat", "--no-pager", "-q"], { timeout: 20000 });
  if (!log) log = await sh.tryExec("dmesg", []);
  const files = new Set();
  for (const m of log.matchAll(/(?:Direct firmware load for|firmware: failed to load|failed to load firmware)\s+(\S+?)(?:\s|$|:)/gi)) files.add(m[1]);
  return { files: [...files], readable: !!log };
}

// ------------------------------------------------ pilote graphique (jeu) ---
const readF = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
const codename = () => /^VERSION_CODENAME=(\w+)/m.exec(readF("/etc/os-release") || "")?.[1] || null;
function secureBootOn() {
  try {
    const f = fs.readdirSync("/sys/firmware/efi/efivars").find((x) => x.startsWith("SecureBoot-"));
    const b = f && fs.readFileSync(`/sys/firmware/efi/efivars/${f}`);
    return b ? b[b.length - 1] === 1 : false;
  } catch { return false; }
}
// Versions candidates d'un paquet, par dépôt (« apt-cache policy », sans droits).
async function policy(pkg) {
  const out = await sh.tryExec("apt-cache", ["policy", pkg]);
  const installed = /Installed:\s*(\S+)/.exec(out)?.[1];
  const candidate = /Candidate:\s*(\S+)/.exec(out)?.[1];
  const versions = [];
  let cur = null;
  for (const l of out.split("\n")) {
    const v = /^\s{5}(?:\*\*\*\s)?\s*(\S+)\s+\d+/.exec(l);
    if (v) { cur = { version: v[1], suites: [] }; versions.push(cur); continue; }
    const s = /^\s+\d+\s+\S+\s+(\S+)\//.exec(l);
    if (s && cur) cur.suites.push(s[1]);
  }
  return { installed: installed && installed !== "(none)" ? installed : null, candidate: candidate && candidate !== "(none)" ? candidate : null, versions };
}
// Paquets Mesa installés (toutes architectures : Steam utilise aussi l'i386).
async function mesaPackages() {
  const out = await sh.tryExec("dpkg-query", ["-W", "-f", "${db:Status-Abbrev}\t${binary:Package}\t${source:Package}\t${Version}\n"]);
  return out.split("\n").map((l) => l.split("\t")).filter((c) => /^ii/.test(c[0]) && c[2] === "mesa").map((c) => ({ pkg: c[1], version: c[3] }));
}
const newer = async (a, b) => !!a && !!b && (await sh.exec("dpkg", ["--compare-versions", a, "gt", b], { okCodes: [0, 1] }).then(() => true, () => false));
async function gpuAssist(displays) {
  const out = [];
  const code = codename();
  const nv = displays.find((r) => /NVIDIA/i.test(r.Vendor || ""));
  if (nv && !/^nvidia/.test(nv.Driver || "")) {
    const pol = await policy("nvidia-driver");
    out.push({ id: "nvidia", title: "Pilote NVIDIA propriétaire non installé", tag: "Conseillé pour jouer",
      why: `Ta carte NVIDIA utilise ${nv.Driver === "nouveau" ? "le pilote libre « nouveau »" : "aucun pilote"}, lent dans les jeux et sans Vulkan complet. Le pilote NVIDIA de Debian (paquet nvidia-driver) donne les vraies performances.${secureBootOn() ? " Le démarrage sécurisé est activé : au redémarrage, un écran bleu (MOK) te demandera d'enregistrer la clé de signature du module ; suis-le, sinon le pilote ne se chargera pas." : ""}`,
      action: pol.candidate ? { id: "nvidia", label: "Installer le pilote NVIDIA" } : { id: "nonfree", label: "Activer les dépôts contrib et non-free" },
      note: pol.candidate ? `Version ${pol.candidate}. Redémarrage nécessaire.` : "Le pilote est dans les sections contrib et non-free de Debian, pas encore activées sur ce PC." });
  }
  const amdIntel = displays.find((r) => /AMD|ATI|Intel/i.test(r.Vendor || "") && /amdgpu|i915|xe|radeon/.test(r.Driver || ""));
  if (amdIntel && code) {
    const mesa = await mesaPackages();
    const dri = mesa.find((m) => /^libgl1-mesa-dri(:amd64)?$/.test(m.pkg)) || mesa[0];
    const pol = await policy("libgl1-mesa-dri");
    const bp = pol.versions.find((v) => v.suites.some((s) => s === `${code}-backports`));
    const fromBp = dri && pol.versions.find((v) => v.version === dri.version)?.suites.some((s) => s.endsWith("-backports"));
    if (fromBp) out.push({ id: "mesa-ok", title: `Mesa ${dri.version.replace(/-.*$/, "")} des rétroportages`, tag: "Déjà installé", ok: true,
      why: "Tu utilises déjà la version récente de Mesa (backports) : elle suit les nouveautés pour les jeux récents." });
    else if (dri) {
      const better = bp && await newer(bp.version, dri.version);
      out.push({ id: "mesa", title: "Pilote graphique plus récent (Mesa des rétroportages)", tag: better ? "Version plus récente disponible" : "Information",
        why: `Mesa ${dri.version.replace(/-.*$/, "")} est installé. Les jeux récents (DXVK, VKD3D-Proton) profitent souvent d'un Mesa plus récent, que Debian publie dans ses « rétroportages » (backports). L'annulation remet exactement les versions actuelles.`,
        action: { id: "mesa", label: bp ? (better ? `Installer Mesa ${bp.version.replace(/-.*$/, "")}` : null) : "Chercher une version plus récente" },
        note: bp ? (better ? `${mesa.length} paquet(s) Mesa seront remplacés (architectures 64 et 32 bits).` : "Les rétroportages n'ont pas de version plus récente pour l'instant.") : "Les rétroportages ne sont pas activés : Sonde les active, regarde s'il y a mieux, et les retire si ce n'est pas le cas." });
      if (out[out.length - 1].action && !out[out.length - 1].action.label) delete out[out.length - 1].action;
    }
  }
  return out;
}

// Ajoute « contrib » et « non-free » aux dépôts Debian (fichiers en $@),
// après une copie « .sonde-bak » de chacun (pour l'annulation).
const NONFREE_SCRIPT = String.raw`
for f in "$@"; do
  cp -f "$f" "$f.sonde-bak"
  case "$f" in *.sources) d822=1 ;; *) d822=0 ;; esac
  awk -v d822="$d822" '
    (d822 == 1 && /^Components:/) || (d822 == 0 && /^deb(-src)?[ \t]/ && /debian\.org/) {
      if ($0 !~ /[ \t]contrib([ \t]|$)/) $0 = $0 " contrib"
      if ($0 !~ /[ \t]non-free([ \t]|$)/) $0 = $0 " non-free"
    }
    { print }' "$f.sonde-bak" > "$f"
done
apt-get update -q`;

// Mesa des rétroportages. $1 : nom de la version (trixie…), $2 : 1 s'il faut
// ajouter le dépôt backports, puis les paquets Mesa installés. Si rien ne
// change (pas de version plus récente), le dépôt ajouté est retiré.
const MESA_SCRIPT = String.raw`
export DEBIAN_FRONTEND=noninteractive
code="$1"; add="$2"; shift 2
src=/etc/apt/sources.list.d/debian-backports-sonde.sources
if [ "$add" = 1 ]; then
  printf 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: %s-backports\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$code" > "$src"
fi
apt-get update -q
before=$(dpkg-query -W -f "\${Version} " "$@")
apt-get install -y -q -t "$code-backports" "$@"
after=$(dpkg-query -W -f "\${Version} " "$@")
if [ "$before" = "$after" ]; then
  if [ "$add" = 1 ]; then rm -f "$src"; apt-get update -q; fi
  echo SONDE_UNCHANGED
fi`;

// ---------------------------------------------------------- batterie ---
function battery() {
  const base = "/sys/class/power_supply";
  let names = [];
  try { names = fs.readdirSync(base); } catch { return null; }
  const bats = names.filter((n) => (readF(`${base}/${n}/type`) || "").trim() === "Battery" && (readF(`${base}/${n}/scope`) || "").trim() !== "Device");
  if (!bats.length) return null;
  return bats.map((n) => {
    const r = (k) => Number(readF(`${base}/${n}/${k}`)) || null;
    const full = r("energy_full") || r("charge_full"), design = r("energy_full_design") || r("charge_full_design");
    return { name: [readF(`${base}/${n}/manufacturer`), readF(`${base}/${n}/model_name`)].map((x) => (x || "").trim()).filter(Boolean).join(" ") || n,
      health: full && design ? Math.round((full / design) * 100) : null, cycles: r("cycle_count"), level: r("capacity"), status: (readF(`${base}/${n}/status`) || "").trim() || null };
  });
}
async function powerTools() {
  const active = async (u) => (await sh.tryExec("systemctl", ["is-active", u])).trim() === "active";
  const [tlp, ppd, tuned] = await Promise.all([active("tlp"), active("power-profiles-daemon"), active("tuned-ppd")]);
  return { tlp, ppd: ppd || tuned };
}

// ------------------------------------------------- santé des disques ---
// udisks2 (comme l'outil Disques de GNOME), sans droits administrateur.
async function diskHealth() {
  if (!sh.which("gdbus")) return null;
  const out = await sh.tryExec("gdbus", ["call", "--system", "--dest", "org.freedesktop.UDisks2", "--object-path", "/org/freedesktop/UDisks2",
    "--method", "org.freedesktop.DBus.ObjectManager.GetManagedObjects"], { timeout: 15000 });
  if (!out) return null;
  const keys = [...out.matchAll(/objectpath '(\/org\/freedesktop\/UDisks2\/drives\/[^']+)': \{/g)];
  const res = [];
  for (let i = 0; i < keys.length; i++) {
    // Chaque objet commence par « objectpath '… » : on s'arrête au suivant.
    const end = out.indexOf("objectpath '", keys[i].index + 12);
    const chunk = out.slice(keys[i].index, end < 0 ? out.length : end);
    const g = (re) => re.exec(chunk)?.[1];
    if (g(/'Removable': <(true)>/) || g(/'MediaRemovable': <(true)>/)) continue;
    const d = { path: keys[i][1], model: g(/'Model': <'([^']*)'>/) || "Disque", size: Number(g(/'Size': <uint64 (\d+)>/)) || null,
      rotational: g(/'RotationRate': <(-?\d+)>/) ? Number(g(/'RotationRate': <(-?\d+)>/)) !== 0 : null, state: "unknown", temp: null, hours: null, wear: null, notes: [] };
    if (/NVMe\.Controller/.test(chunk)) {
      d.kind = "SSD NVMe";
      const warn = g(/'SmartCriticalWarning': <(?:@as )?\[([^\]]*)\]>/);
      d.hours = Number(g(/'SmartPowerOnHours': <uint64 (\d+)>/)) || null;
      const k = Number(g(/'SmartTemperature': <uint16 (\d+)>/));
      if (k) d.temp = Math.round(k - 273.15);
      d.state = warn == null ? "unknown" : warn.trim() ? "bad" : "good";
      if (warn?.trim()) d.notes.push(`alerte du disque : ${warn.replace(/'/g, "")}`);
      const attrs = await sh.tryExec("gdbus", ["call", "--system", "--dest", "org.freedesktop.UDisks2", "--object-path", d.path,
        "--method", "org.freedesktop.UDisks2.NVMe.Controller.SmartGetAttributes", "{}"], { timeout: 8000 });
      const pu = /'percent_used': <(?:byte|uint8) (0x[0-9a-f]+|\d+)>/.exec(attrs)?.[1];
      if (pu != null) { d.wear = Number(pu); if (d.wear >= 90) { d.state = d.state === "bad" ? "bad" : "warn"; d.notes.push("usure presque atteinte"); } }
    } else if (/Drive\.Ata/.test(chunk) && g(/'SmartSupported': <(true)>/)) {
      d.kind = d.rotational ? "Disque dur" : "SSD";
      const failing = g(/'SmartFailing': <(true|false)>/);
      const bad = Number(g(/'SmartNumBadSectors': <int64 (\d+)>/)) || 0;
      const attrFail = Number(g(/'SmartNumAttributesFailing': <int32 (\d+)>/)) || 0;
      d.hours = Math.round((Number(g(/'SmartPowerOnSeconds': <uint64 (\d+)>/)) || 0) / 3600) || null;
      const k = Number(g(/'SmartTemperature': <([\d.]+)>/));
      if (k) d.temp = Math.round(k - 273.15);
      d.state = failing === "true" || attrFail ? "bad" : bad ? "warn" : failing === "false" ? "good" : "unknown";
      if (bad) d.notes.push(`${bad} secteur(s) défectueux`);
      if (failing === "true") d.notes.push("le disque annonce une panne prochaine");
    } else continue;
    res.push(d);
  }
  return res;
}

module.exports = (ctx) => {
  let updates = null;
  ctx.reverters["drivers-apt"] = ({ remove, restore, sourcesBackup, sourcesAdded }) => {
    // Remet les paquets et les dépôts comme avant (liste fermée de cas).
    const parts = ["export DEBIAN_FRONTEND=noninteractive"];
    if (restore?.length) parts.push(`apt-get install -y -q --allow-downgrades ${restore.map((p) => `'${p.pkg}=${p.version}'`).join(" ")}`);
    if (remove?.length) parts.push(`apt-get remove -y -q ${remove.map((p) => `'${p}'`).join(" ")}`);
    if (sourcesAdded) parts.push("rm -f /etc/apt/sources.list.d/debian-backports-sonde.sources");
    for (const f of sourcesBackup || []) parts.push(`[ -f '${f}.sonde-bak' ] && mv -f '${f}.sonde-bak' '${f}'`);
    parts.push("apt-get update -q || true");
    if ([...(restore || []), ...(remove || [])].some((x) => !/^[a-z0-9.+:=~-]+$/i.test(typeof x === "string" ? x : `${x.pkg}=${x.version}`))) throw new Error("Paquet refusé.");
    if ((sourcesBackup || []).some((f) => !/^\/etc\/apt\/sources\.list(\.d\/[\w.-]+)?$/.test(f))) throw new Error("Fichier refusé.");
    return sh.runElevated(parts.join("\n"), [], { timeout: 60 * 60000 });
  };

  return {
    "GET /api/drivers": async () => {
      const txt = sh.which("lspci") ? await sh.tryExec("lspci", ["-vmmk"]) : "";
      const recs = lspciRecords(txt);
      const kdate = kernelDate();
      const errors = [];
      const drivers = [];
      let mesa = null;
      for (const r of recs) {
        const c = CLASSES.find(([re]) => re.test(r.Class || ""));
        const name = [r.Vendor, r.Device].filter(Boolean).join(" ").replace(/\s*\[AMD\/ATI\]|Corporation|Co\., Ltd\.?/g, "").replace(/\s+/g, " ").trim();
        if (!r.Driver) {
          // Pont PCI, contrôleurs internes… : sans pilote, c'est normal.
          if (c) errors.push({ name, cls: c[2], status: "Error", code: 28, meaning: "aucun pilote chargé", id: r.Slot,
            hint: `Le noyau n'a pas de pilote actif pour ce périphérique${r.Module ? ` (module disponible : ${r.Module})` : ""}.` });
          continue;
        }
        if (!c) continue;
        let version = `pilote ${r.Driver} (noyau ${os.release()})`;
        if (c[1] === "DISPLAY") {
          if (/nvidia/i.test(r.Driver)) {
            const v = (fs.existsSync("/proc/driver/nvidia/version") ? fs.readFileSync("/proc/driver/nvidia/version", "utf8") : "").match(/Kernel Module\s+(?:for \S+\s+)?([\d.]+)/)?.[1];
            if (v) version = `NVIDIA ${v}`;
          } else {
            mesa ??= await pkgVersion("libgl1-mesa-dri");
            if (mesa) version = `${r.Driver} + Mesa ${mesa.replace(/-.*$/, "")}`;
          }
        }
        const age = kdate ? (Date.now() - Date.parse(kdate)) / (365 * 864e5) : null;
        drivers.push({ name, cls: c[1], family: c[2], version, maker: r.Vendor || "", date: kdate, inf: r.Driver, ageYears: age, old: age != null && age > 2 });
      }
      // Firmwares manquants : le périphérique marche mal ou pas du tout.
      const fw = await missingFirmware();
      const missingPkgs = new Map();
      for (const f of fw.files) {
        const pkg = firmwarePkg(f);
        if (!(await pkgVersion(pkg))) (missingPkgs.get(pkg) || missingPkgs.set(pkg, []).get(pkg)).push(f);
      }
      for (const [pkg, files] of missingPkgs) {
        errors.push({ name: `Firmware manquant : ${files.slice(0, 2).join(", ")}${files.length > 2 ? "…" : ""}`, cls: "Firmware", status: "Error", code: 18,
          meaning: "firmware manquant", id: pkg, pkg, hint: `Installe le paquet ${pkg} (dépôt non-free-firmware), puis redémarre.` });
      }
      // Microcode du processeur : corrige des failles et des bugs du CPU.
      const cpu = (fs.existsSync("/proc/cpuinfo") ? fs.readFileSync("/proc/cpuinfo", "utf8") : "").match(/vendor_id\s*:\s*(\S+)/)?.[1];
      const ucode = cpu === "GenuineIntel" ? "intel-microcode" : cpu === "AuthenticAMD" ? "amd64-microcode" : null;
      if (ucode && !(await pkgVersion(ucode)) && !fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")) {
        errors.push({ name: `Microcode du processeur (${ucode})`, cls: "Processeur", status: "Error", code: 18, meaning: "non installé", id: ucode, pkg: ucode,
          hint: "Le microcode corrige des failles de sécurité et des bugs du processeur. Paquet du dépôt non-free-firmware." });
      }
      const sorted = drivers.sort((a, b) => a.family.localeCompare(b.family, "fr"));
      const displays = recs.filter((r) => /VGA|3D controller|Display controller/i.test(r.Class || ""));
      const bat = battery();
      const [gpu, disks, power] = await Promise.all([gpuAssist(displays).catch(() => []), diskHealth().catch(() => null), bat ? powerTools() : null]);
      return { errors, drivers: sorted, updates, platform: "linux", logReadable: fw.readable, gpuAssist: gpu, disks, battery: bat, power };
    },

    // Pilote graphique pour jouer : dépôts contrib/non-free, pilote NVIDIA,
    // Mesa des rétroportages. Chaque cas est fixe ; l'annulation remet l'état d'avant.
    "POST /api/drivers/gpu": async (req) => {
      const { id } = await ctx.body(req);
      const code = codename();
      if (id === "nonfree") {
        const files = ["/etc/apt/sources.list", ...(() => { try { return fs.readdirSync("/etc/apt/sources.list.d").map((n) => `/etc/apt/sources.list.d/${n}`); } catch { return []; } })()]
          .filter((f) => /\.(list|sources)$/.test(f) && /debian\.org\/debian\/?(\s|$)/m.test(readF(f) || ""));
        if (!files.length) throw new Error("Dépôts Debian introuvables : active contrib et non-free dans Logiciels › Sources.");
        await sh.runElevated(NONFREE_SCRIPT, files);
        ctx.journal.add({ kind: "system", title: "Dépôts contrib et non-free activés", revert: { type: "drivers-apt", args: { sourcesBackup: files } } });
        return { ok: true };
      }
      if (id === "nvidia") {
        const pkgs = ["nvidia-driver", "firmware-misc-nonfree", "linux-headers-amd64"];
        const sim = await sh.tryExec("apt-get", ["-s", "-o", "Debug::NoLocking=1", "install", ...pkgs], { timeout: 120000 });
        const added = [...sim.matchAll(/^Inst (\S+) \(/gm)].map((m) => m[1]);
        if (!added.length && !/0 newly installed/.test(sim)) throw new Error("apt ne trouve pas le pilote NVIDIA : vérifie les dépôts contrib et non-free.");
        await sh.runElevated(`DEBIAN_FRONTEND=noninteractive apt-get install -y -q ${pkgs.join(" ")}`, [], { timeout: 60 * 60000 });
        ctx.journal.add({ kind: "system", title: "Pilote NVIDIA installé", detail: "Redémarre pour l'utiliser.", revert: added.length ? { type: "drivers-apt", args: { remove: added } } : undefined });
        return { ok: true, reboot: true };
      }
      if (id === "mesa") {
        if (!code || !/^[a-z]+$/.test(code)) throw new Error("Version de Debian inconnue.");
        const before = (await mesaPackages()).filter((m) => /^[a-z0-9.+-]+(:[a-z0-9]+)?$/.test(m.pkg));
        if (!before.length) throw new Error("Mesa n'est pas installé.");
        const enabled = await sh.tryExec("grep", ["-rlE", `\\b${code}-backports\\b`, "/etc/apt/sources.list", "/etc/apt/sources.list.d"]);
        const add = enabled.trim() ? "0" : "1";
        const out = await sh.runElevated(MESA_SCRIPT, [code, add, ...before.map((m) => m.pkg)], { timeout: 60 * 60000 });
        if (/SONDE_UNCHANGED/.test(out)) return { ok: true, unchanged: true };
        ctx.journal.add({ kind: "system", title: "Mesa des rétroportages installé", detail: `${before.length} paquet(s) mis à jour. L'annulation remet les versions d'avant.`,
          revert: { type: "drivers-apt", args: { restore: before, sourcesAdded: add === "1" } } });
        return { ok: true };
      }
      throw new Error("Action inconnue.");
    },

    // Installe les paquets de firmware ou de microcode manquants (liste fermée).
    "POST /api/drivers/install": async (req) => {
      const { pkg } = await ctx.body(req);
      const allowed = new Set([...FIRMWARE_PKG.map(([, p]) => p), "firmware-misc-nonfree", "intel-microcode", "amd64-microcode"]);
      if (!allowed.has(pkg)) throw new Error("Paquet refusé.");
      await sh.runElevated('DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$1"', [pkg]);
      ctx.journal.add({ kind: "system", title: `Installé : ${pkg}`, detail: "Redémarre pour en profiter." });
      return { ok: true };
    },

    // Mises à jour en attente qui touchent au matériel : noyau, firmwares,
    // Mesa, NVIDIA, microcode (apt), et firmware des appareils (fwupd).
    "POST /api/drivers/updates": async (req) => {
      const { force } = await ctx.body(req);
      if (updates && !force && Date.now() - updates.at < 3600000) return updates;
      const items = (await upgradable()).filter((u) => /^(linux-(image|headers)|firmware-|nvidia-|.*mesa|libdrm|amd64-microcode|intel-microcode)/.test(u.pkg))
        .map((u) => ({ title: `${u.pkg} ${u.version}`, maker: u.security ? "mise à jour de sécurité" : u.suite, model: `installé : ${u.from}`, date: null, size: 0 }));
      if (sh.which("fwupdmgr")) {
        const out = await sh.tryExec("fwupdmgr", ["get-updates", "--json", "--no-unreported-check", "--no-metadata-check"], { timeout: 60000 });
        try {
          for (const d of JSON.parse(out).Devices || []) {
            for (const r of d.Releases || []) items.push({ title: `${d.Name} ${r.Version}`, maker: d.Vendor || "fwupd", model: "firmware de l'appareil", date: r.Created ? new Date(r.Created * 1000).toISOString().slice(0, 10) : null, size: r.Size || 0 });
          }
        } catch {}
      }
      updates = { at: Date.now(), items };
      return updates;
    },
  };
};
