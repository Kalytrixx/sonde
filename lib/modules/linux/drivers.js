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

module.exports = (ctx) => {
  let updates = null;

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
      return { errors, drivers: sorted, updates, platform: "linux", logReadable: fw.readable };
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
