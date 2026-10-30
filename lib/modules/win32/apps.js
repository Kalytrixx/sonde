// Désinstallateur : programmes installés (registre + Microsoft Store), taille
// et dernière utilisation, lancement du désinstalleur officiel, restes.

const fs = require("fs");
const path = require("path");
const ps = require("../../ps");
const { isProtected } = require("../../rules");

const LIST = `
$keys = @(
  @{ p = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; scope = 'machine' },
  @{ p = 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; scope = 'machine' },
  @{ p = 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; scope = 'user' })
$apps = foreach ($k in $keys) {
  Get-ItemProperty $k.p -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and -not $_.ParentKeyName -and $_.ReleaseType -notmatch 'Update|Hotfix' -and $_.UninstallString } |
    ForEach-Object {
      [pscustomobject]@{
        key = ($_.PSPath -replace '^.*::', ''); kind = 'win32'; scope = $k.scope
        name = $_.DisplayName; publisher = $_.Publisher; version = $_.DisplayVersion
        sizeKB = [int64]$_.EstimatedSize; installDate = $_.InstallDate
        location = $_.InstallLocation; icon = $_.DisplayIcon
        uninstall = $_.UninstallString; quiet = $_.QuietUninstallString
      }
    }
}
$store = Get-AppxPackage -ErrorAction SilentlyContinue |
  Where-Object { -not $_.IsFramework -and $_.SignatureKind -eq 'Store' -and -not $_.NonRemovable } |
  ForEach-Object {
    [pscustomobject]@{
      key = 'appx:' + $_.PackageFullName; kind = 'store'; scope = 'user'
      name = $_.Name; publisher = ($_.Publisher -replace '^CN=([^,]+).*$', '$1'); version = "$($_.Version)"
      sizeKB = 0; installDate = $null; location = $_.InstallLocation; icon = $null
      uninstall = $null; quiet = $null
    }
  }
@($apps) + @($store)`;

// Icônes : extraites une fois, puis gardées dans data\icons. Un fichier
// « .none » retient qu'un programme n'en a pas, pour ne pas réessayer à chaque fois.
const ICONS = `
Add-Type -AssemblyName System.Drawing
$done = 0
# Raccourcis du menu Démarrer, pour les programmes MSI qui ne déclarent pas d'icône.
$norm = { param($s) ("$s".ToLower() -replace '[^a-z0-9]', '') }
$sh = New-Object -ComObject WScript.Shell
$lnks = @(foreach ($d in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))) {
  Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -notmatch 'unins|uninstall|désinstaller|readme|help|aide|website' } |
    ForEach-Object { @{ n = (& $norm $_.BaseName); f = $_.FullName } }
})
foreach ($i in $A.items) {
  $out = Join-Path $A.dir ($i.hash + '.png')
  try {
    if ($i.kind -eq 'store') {
      # Logo déclaré dans le manifeste ; le fichier réel porte un suffixe d'échelle.
      $m = Get-AppxPackageManifest -Package $i.pkg -ErrorAction Stop
      $logo = "$($m.Package.Properties.Logo)"
      if ($logo) {
        $dir = Join-Path $i.location (Split-Path $logo -Parent)
        $base = [IO.Path]::GetFileNameWithoutExtension($logo)
        $f = Get-ChildItem -LiteralPath $dir -Filter "$base*.png" -ErrorAction Stop |
          Sort-Object { if ($_.Name -match 'scale-100') { 0 } elseif ($_.Name -match 'scale-200') { 1 } else { 2 } } | Select-Object -First 1
        if ($f) { Copy-Item -LiteralPath $f.FullName -Destination $out; $done++; continue }
      }
    } else {
      $src = $null
      if ($i.icon) {
        $p = [Environment]::ExpandEnvironmentVariables(("$($i.icon)" -replace '"', '')) -replace ',\\s*-?\\d+\\s*$', ''
        if ((Test-Path -LiteralPath $p -PathType Leaf) -and $p -notmatch 'msiexec\\.exe$') { $src = $p }
      }
      # Sinon : le plus gros programme du dossier d'installation (hors désinstalleur).
      if (-not $src -and $i.location -and (Test-Path -LiteralPath $i.location)) {
        $src = (Get-ChildItem -LiteralPath $i.location -Filter *.exe -File -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -notmatch 'unins|uninstall|setup|update|crash|helper|elevate' } |
          Sort-Object Length -Descending | Select-Object -First 1).FullName
      }
      # Dernier recours : le raccourci du menu Démarrer qui porte son nom.
      if (-not $src) {
        $n = & $norm $i.name
        $l = $lnks | Where-Object { $_.n.Length -ge 3 -and ($_.n -eq $n -or ($n.Length -ge 5 -and ($_.n.StartsWith($n) -or $n.StartsWith($_.n)))) } | Select-Object -First 1
        if ($l) {
          $t = $sh.CreateShortcut($l.f).TargetPath
          if ($t -and (Test-Path -LiteralPath $t -PathType Leaf)) { $src = $t }
        }
      }
      if ($src) {
        if ($src -match '\\.ico$') { $ico = New-Object System.Drawing.Icon $src, 48, 48 }
        else { $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($src) }
        if ($ico) { $ico.ToBitmap().Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $done++; continue }
      }
    }
  } catch {}
  Set-Content -LiteralPath (Join-Path $A.dir ($i.hash + '.none')) -Value ''
}
$done`;

// « Microsoft.WindowsCalculator » -> « Windows Calculator »
function prettyStore(name) {
  return name.replace(/^[^.]+\./, "").replace(/\./g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

// Normalise un nom pour comparer « Epic Games Launcher » et « EpicGamesLauncher ».
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\b(v?\d+([.\-_]\d+)*|x64|x86|64-bit|32-bit|version|inc|ltd|llc|corporation|corp|gmbh|sa|sas)\b/g, "")
  .replace(/[^a-z0-9]/g, "");

// Applications préinstallées inutiles pour la plupart des gens (nom du paquet,
// explication, cochée d'office ou non). Elles se réinstallent depuis le Store.
const BLOAT = [
  [/^Microsoft\.BingNews_/, "Actualités Microsoft : un fil d'actualités, doublon du navigateur."],
  [/^Microsoft\.BingWeather_/, "Météo Microsoft : utile à certains, donc pas cochée.", false],
  [/^Microsoft\.BingSearch_/, "Recherche Bing intégrée."],
  [/^Microsoft\.GetHelp_/, "Obtenir de l'aide : redirige vers le support en ligne de Microsoft."],
  [/^Microsoft\.Getstarted_/, "Astuces : présentation de Windows pour les nouveaux utilisateurs."],
  [/^Microsoft\.MicrosoftSolitaireCollection_/, "Jeux de cartes avec publicités (abonnement pour les retirer)."],
  [/^Microsoft\.People_/, "Contacts : peu utilisé hors d'Outlook."],
  [/^Clipchamp\.Clipchamp_/, "Clipchamp : montage vidéo en ligne, avec abonnement pour l'essentiel."],
  [/^Microsoft\.MicrosoftOfficeHub_/, "Microsoft 365 (Office) : vitrine de l'abonnement, pas la suite Office elle-même."],
  [/^Microsoft\.PowerAutomateDesktop_/, "Power Automate : automatisation pour les entreprises."],
  [/^Microsoft\.WindowsFeedbackHub_/, "Hub de commentaires : envoyer des avis à Microsoft."],
  [/^Microsoft\.549981C3F5F10_/, "Cortana : ancien assistant vocal, abandonné par Microsoft."],
  [/^Microsoft\.Copilot_/, "Copilot : l'assistant IA de Microsoft (en ligne)."],
  [/^Microsoft\.MixedReality\.Portal_/, "Portail de réalité mixte : seulement pour les casques Windows Mixed Reality."],
  [/^Microsoft\.SkypeApp_/, "Skype : service arrêté par Microsoft."],
  [/^MicrosoftTeams_/, "Teams (personnel) : messagerie de Microsoft, rarement utilisée hors travail."],
  [/^Microsoft\.Windows\.DevHome_/, "Dev Home : outil pour développeurs, abandonné par Microsoft."],
  [/^Microsoft\.WindowsMaps_/, "Cartes : peu utilisé sur un PC fixe.", false],
  [/^Microsoft\.ZuneVideo_/, "Films et TV : remplacé par le Lecteur multimédia.", false],
  [/^Microsoft\.Todos_/, "Microsoft To Do : listes de tâches, utile à certains.", false],
  [/^(king\.com\.|SpotifyAB\.|Disney\.|Facebook\.|BytedancePte\.|Instagram|AmazonVideo\.|4DF9E0F8\.Netflix|7EE7776C\.LinkedIn)/i, "Application tierce installée d'office par promotion."],
];

module.exports = (ctx) => {
  let cache = null;

  async function list(force = false) {
    if (cache && !force && Date.now() - cache.at < 60000) return cache.items;
    const raw = [].concat(await ps.run(LIST, { timeout: 60000 }) || []);
    const scan = ctx.getScan();
    const seen = new Set();
    const items = [];
    for (const a of raw) {
      if (a.kind === "store") a.name = prettyStore(a.name);
      const dedupe = norm(a.name) + "|" + (a.version || "");
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // Taille et dernière utilisation réelles, si le dossier est dans le scan.
      const loc = a.location && a.location.replace(/\//g, "\\").replace(/\\+$/, "");
      const d = loc && scan && scan.get(loc);
      const date = /^\d{8}$/.test(a.installDate || "")
        ? Date.UTC(+a.installDate.slice(0, 4), +a.installDate.slice(4, 6) - 1, +a.installDate.slice(6, 8)) : null;
      items.push({
        key: a.key, kind: a.kind, name: a.name, publisher: a.publisher || "", version: a.version || "",
        size: d ? d.size : (a.sizeKB || 0) * 1024, sizeSource: d ? "scan" : a.sizeKB ? "registre" : null,
        lastUsed: d ? d.atime : null, installed: date, location: loc || null,
        canUninstall: a.kind === "store" || !!a.uninstall,
        _uninstall: a.uninstall, _quiet: a.quiet, _icon: a.icon, _hash: iconHash(a.key),
      });
    }
    items.sort((x, y) => y.size - x.size);
    await ensureIcons(items);
    for (const it of items) it.icon = fs.existsSync(path.join(iconDir, it._hash + ".png")) ? `/icons/${it._hash}.png` : null;
    cache = { at: Date.now(), items };
    return items;
  }

  const iconDir = path.join(ctx.DATA, "icons");
  const iconHash = (key) => require("crypto").createHash("sha1").update(key).digest("hex").slice(0, 16);

  // Extrait en une fois les icônes qui manquent (quelques secondes au premier
  // affichage, instantané ensuite).
  async function ensureIcons(items) {
    fs.mkdirSync(iconDir, { recursive: true });
    const missing = items.filter((a) => !fs.existsSync(path.join(iconDir, a._hash + ".png")) && !fs.existsSync(path.join(iconDir, a._hash + ".none")));
    if (!missing.length) return;
    await ps.run(ICONS, { timeout: 180000, args: { dir: iconDir, items: missing.map((a) => ({
      hash: a._hash, kind: a.kind, name: a.name, icon: a._icon || null, location: a.location, pkg: a.kind === "store" ? a.key.slice(5) : null })) } })
      .catch(() => {});
  }

  const pub = (a) => { const { _uninstall, _quiet, _icon, _hash, ...rest } = a; return rest; };
  // Pour l'assistant : les programmes de tous les disques, même hors du scan.
  ctx.listApps = async () => (await list()).map(pub);

  return {
    "GET /api/apps": async (req, res, url) => (await list(url.searchParams.get("refresh") === "1")).map(pub),

    // Applications installées d'office (Microsoft Store) qu'on peut retirer
    // sans risque. Jamais : Calculatrice, Photos, Store, Paint, Bloc-notes,
    // Terminal, Appareil photo, Capture d'écran, Xbox et composants de jeu.
    "GET /api/apps/bloat": async () => (await list()).filter((a) => a.kind === "store").map((a) => {
      const pkg = a.key.slice(5);
      const b = BLOAT.find(([re]) => re.test(pkg));
      return b ? { key: a.key, name: a.name, why: b[1], preset: b[2] !== false, size: a.size } : null;
    }).filter(Boolean),

    // Lance le désinstalleur officiel. La commande vient du registre, jamais
    // de la page : la page n'envoie que la clé du programme.
    "POST /api/apps/uninstall": async (req) => {
      const { key } = await ctx.body(req);
      const app = (await list()).find((a) => a.key === key);
      if (!app) throw new Error("Programme introuvable.");
      if (app.kind === "store") {
        await ps.run("Remove-AppxPackage -Package $A.pkg; $true", { args: { pkg: key.slice(5) }, timeout: 300000 });
      } else {
        let cmd = app._uninstall.trim();
        // Certains programmes MSI déclarent /I (modifier) au lieu de /X (désinstaller).
        cmd = cmd.replace(/^(msiexec(\.exe)?\s+)\/I/i, "$1/X");
        let exe, args;
        if (cmd.startsWith('"')) { const end = cmd.indexOf('"', 1); exe = cmd.slice(1, end); args = cmd.slice(end + 1).trim(); }
        else { const m = cmd.match(/^(.*?\.exe)\s*(.*)$/i); exe = m ? m[1] : cmd; args = m ? m[2] : ""; }
        // Le désinstalleur demande lui-même les droits administrateur s'il en a besoin.
        await ps.run(`
          if ($A.args) { Start-Process -FilePath $A.exe -ArgumentList $A.args } else { Start-Process -FilePath $A.exe }
          $true`, { args: { exe, args } });
      }
      ctx.journal.add({ kind: "system", title: `Désinstallation lancée : ${app.name}`, detail: app.publisher });
      cache = null;
      return { ok: true, name: app.name };
    },

    // Restes d'un programme désinstallé : dossiers à son nom dans AppData et
    // ProgramData. Refusé tant que le programme est encore installé.
    "POST /api/apps/leftovers": async (req) => {
      const { name, publisher } = await ctx.body(req);
      const apps = await list(true);
      if (apps.some((a) => a.name === name)) return { stillInstalled: true, items: [] };
      const scan = ctx.getScan();
      if (!scan) return { items: [] };
      const n = norm(name);
      const firstWord = norm(String(name).split(/\s+/)[0]);
      const pubWord = norm(String(publisher || "").split(/[\s,]+/)[0]);
      const installedNames = apps.map((a) => norm(a.name));
      const roots = [];
      for (const d of scan.index.values()) {
        if (/^[A-Z]:\\Users\\[^\\]+\\AppData\\(Local|Roaming|LocalLow)$|^[A-Z]:\\ProgramData$/i.test(d.path)) roots.push(d);
      }
      const hits = [];
      const consider = (d) => {
        const dn = norm(d.name);
        if (dn.length < 4) return;
        const match = dn === n || (n.length >= 5 && (dn.includes(n) || n.includes(dn))) || (firstWord.length >= 5 && dn === firstWord);
        // Un dossier qui correspond aussi à un programme encore installé n'est pas un reste.
        if (match && !installedNames.some((i) => i && (i === dn || i.includes(dn))) && !isProtected(d.path)) {
          hits.push({ path: d.path, name: d.name, size: d.size, mtime: d.mtime, atime: d.atime, type: "dir", cat: "apps" });
        }
      };
      for (const r of roots) {
        for (const c of r.children) {
          consider(c);
          // Dossier de l'éditeur : AppData\Local\<Éditeur>\<Programme>
          if (pubWord.length >= 4 && norm(c.name) === pubWord) c.children.forEach(consider);
        }
      }
      return { items: hits.sort((a, b) => b.size - a.size) };
    },
  };
};
