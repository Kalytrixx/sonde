// Services et vie privée : services Windows (mémoire, réseau), fiche
// explicative pour ceux qui touchent à la télémétrie ou aux performances,
// tâches planifiées de télémétrie, réglages de confidentialité du compte.

const ps = require("../../ps");

// Connaissances sur les services qui reviennent dans les « optimiseurs ».
// reco : mode conseillé pour un PC personnel ; risk : ce qu'on perd.
const KB = {
  DiagTrack: { cat: "telemetrie", reco: "Disabled", risk: "faible", what: "Envoie des données de diagnostic et d'usage à Microsoft.", lose: "Rien d'utile au quotidien." },
  dmwappushservice: { cat: "telemetrie", reco: "Disabled", risk: "faible", what: "Relaie des messages de gestion et de télémétrie.", lose: "Rien, hors PC géré par une entreprise." },
  "diagnosticshub.standardcollector.service": { cat: "telemetrie", reco: "Disabled", risk: "faible", what: "Collecte des traces de diagnostic (outils de développement).", lose: "Le profilage dans Visual Studio." },
  WerSvc: { cat: "telemetrie", reco: "Manual", risk: "faible", what: "Envoie les rapports de plantage à Microsoft.", lose: "Les rapports d'erreurs." },
  PcaSvc: { cat: "telemetrie", reco: "Manual", risk: "faible", what: "Assistant de compatibilité : surveille les vieux programmes et remonte des données.", lose: "Les alertes de compatibilité." },
  lfsvc: { cat: "vieprivee", reco: "Manual", risk: "moyen", what: "Géolocalisation du PC.", lose: "Météo locale, fuseau horaire automatique, « Localiser mon appareil »." },
  MapsBroker: { cat: "optionnel", reco: "Disabled", risk: "faible", what: "Télécharge les cartes hors ligne.", lose: "Les cartes hors ligne de l'appli Cartes." },
  RetailDemo: { cat: "optionnel", reco: "Disabled", risk: "faible", what: "Mode démonstration des magasins.", lose: "Rien." },
  Fax: { cat: "optionnel", reco: "Disabled", risk: "faible", what: "Envoi et réception de fax.", lose: "Le fax." },
  WMPNetworkSvc: { cat: "optionnel", reco: "Disabled", risk: "faible", what: "Partage de la bibliothèque Windows Media Player sur le réseau.", lose: "Ce partage." },
  RemoteRegistry: { cat: "securite", reco: "Disabled", risk: "faible", what: "Permet de modifier le registre à distance.", lose: "Rien pour un PC personnel ; c'est même plus sûr." },
  wisvc: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Programme Windows Insider.", lose: "Les versions de test de Windows." },
  WpcMonSvc: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Contrôle parental.", lose: "Le contrôle parental." },
  SysMain: { cat: "performance", reco: "Automatic", risk: "moyen", what: "Précharge en mémoire les programmes que tu utilises souvent.", lose: "Si désactivé : moins de RAM « occupée », mais lancements un peu plus lents. Utile à garder sur la plupart des PC." },
  WSearch: { cat: "performance", reco: "Automatic", risk: "moyen", what: "Indexe les fichiers pour la recherche Windows.", lose: "Si désactivé : recherche du menu Démarrer et de l'Explorateur beaucoup plus lente." },
  XblAuthManager: { cat: "jeux", reco: "Manual", risk: "moyen", what: "Connexion aux services Xbox Live.", lose: "Les jeux Xbox et Game Pass installés sur le PC." },
  XblGameSave: { cat: "jeux", reco: "Manual", risk: "moyen", what: "Synchronisation des sauvegardes Xbox.", lose: "Les sauvegardes en ligne des jeux Game Pass." },
  XboxNetApiSvc: { cat: "jeux", reco: "Manual", risk: "moyen", what: "Réseau Xbox Live.", lose: "Le multijoueur des jeux Xbox." },
  Spooler: { cat: "optionnel", reco: "Automatic", risk: "moyen", what: "File d'impression.", lose: "L'impression, y compris « Imprimer en PDF »." },
  TrkWks: { cat: "optionnel", reco: "Manual", risk: "faible", what: "Suit les raccourcis vers des fichiers déplacés sur le réseau.", lose: "Presque rien sur un PC seul." },
};

// Tâches planifiées de télémétrie connues.
const TASKS = [
  { path: "\\Microsoft\\Windows\\Application Experience\\", name: "Microsoft Compatibility Appraiser", what: "Inventaire de compatibilité envoyé à Microsoft" },
  { path: "\\Microsoft\\Windows\\Application Experience\\", name: "ProgramDataUpdater", what: "Collecte d'usage des programmes" },
  { path: "\\Microsoft\\Windows\\Customer Experience Improvement Program\\", name: "Consolidator", what: "Programme d'amélioration de l'expérience client" },
  { path: "\\Microsoft\\Windows\\Customer Experience Improvement Program\\", name: "UsbCeip", what: "Télémétrie USB" },
  { path: "\\Microsoft\\Windows\\Feedback\\Siuf\\", name: "DmClient", what: "Demandes de commentaires" },
  { path: "\\Microsoft\\Windows\\Feedback\\Siuf\\", name: "DmClientOnScenarioDownload", what: "Demandes de commentaires" },
  { path: "\\Microsoft\\Windows\\Windows Error Reporting\\", name: "QueueReporting", what: "Envoi des rapports d'erreurs en attente" },
];

// Réglages de confidentialité du compte (sans droits administrateur).
const PRIVACY = [
  { id: "adid", label: "Identifiant publicitaire", desc: "Permet aux applications de te suivre pour la publicité.",
    key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AdvertisingInfo", name: "Enabled", off: 0, on: 1 },
  { id: "tailored", label: "Expériences personnalisées", desc: "Microsoft utilise tes données de diagnostic pour des conseils et publicités.",
    key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Privacy", name: "TailoredExperiencesWithDiagnosticDataEnabled", off: 0, on: 1 },
  { id: "suggestions", label: "Suggestions et applis installées sans demander", desc: "Publicités dans le menu Démarrer et applis promues installées automatiquement.",
    key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SilentInstalledAppsEnabled", off: 0, on: 1 },
  { id: "tips", label: "Astuces et suggestions de Windows", desc: "Notifications de conseils et de promotions.",
    key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338389Enabled", off: 0, on: 1 },
  { id: "trackprogs", label: "Suivi des programmes lancés", desc: "Windows mémorise les programmes que tu lances pour le menu Démarrer.",
    key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Start_TrackProgs", off: 0, on: 1 },
  { id: "feedback", label: "Demandes de commentaires", desc: "Windows te demande régulièrement ton avis.",
    key: "HKCU:\\Software\\Microsoft\\Siuf\\Rules", name: "NumberOfSIUFInPeriod", off: 0, on: null },

  // --- Publicités et IA de Windows 11. Un réglage peut toucher plusieurs
  // valeurs (regs) ; son état est lu sur la première. `admin` : réglage machine.
  { id: "startreco", group: "ads", label: "Recommandations du menu Démarrer", desc: "Applis « recommandées », astuces et raccourcis mis en avant dans le menu Démarrer.",
    regs: [{ key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Start_IrisRecommendations", off: 0, on: 1 },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "Start_AccountNotifications", off: 0, on: 1 },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338388Enabled", off: 0, on: 1 }] },
  { id: "settingsads", group: "ads", label: "Promotions dans les Paramètres", desc: "Encarts OneDrive, Microsoft 365 ou Game Pass sur l'accueil des Paramètres.",
    regs: [{ key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338393Enabled", off: 0, on: 1 },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-353694Enabled", off: 0, on: 1 },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-353696Enabled", off: 0, on: 1 }] },
  { id: "explorerads", group: "ads", label: "Suggestions OneDrive dans l'Explorateur", desc: "Bandeaux qui proposent OneDrive ou Microsoft 365 dans l'Explorateur de fichiers.",
    regs: [{ key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "ShowSyncProviderNotifications", off: 0, on: 1 }] },
  { id: "lockads", group: "ads", label: "Astuces sur l'écran de verrouillage", desc: "Anecdotes, astuces et publicités affichées sur l'image de l'écran de verrouillage.",
    regs: [{ key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "RotatingLockScreenOverlayEnabled", off: 0, on: 1 },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager", name: "SubscribedContent-338387Enabled", off: 0, on: 1 }] },
  { id: "bing", group: "ads", label: "Recherches Bing dans le menu Démarrer", desc: "La recherche du menu Démarrer envoie ce que tu tapes à Bing et mélange des résultats web aux fichiers et applis.",
    regs: [{ key: "HKCU:\\Software\\Policies\\Microsoft\\Windows\\Explorer", name: "DisableSearchBoxSuggestions", off: 1, on: null },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Search", name: "BingSearchEnabled", off: 0, on: null }] },
  { id: "widgets", group: "ads", admin: true, label: "Actualités et Widgets", desc: "Le panneau Widgets et ses actualités sponsorisées (réglage machine : fenêtre administrateur).",
    regs: [{ key: "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Dsh", name: "AllowNewsAndInterests", off: 0, on: null }] },
  { id: "copilot", group: "ads", label: "Copilot", desc: "L'assistant Copilot intégré à Windows et son bouton dans la barre des tâches. L'application Copilot, elle, se désinstalle depuis Programmes installés.",
    regs: [{ key: "HKCU:\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot", name: "TurnOffWindowsCopilot", off: 1, on: null },
      { key: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced", name: "ShowCopilotButton", off: 0, on: null }] },
  { id: "recall", group: "ads", label: "Recall (PC Copilot+)", desc: "Recall photographie régulièrement l'écran pour pouvoir « retrouver » ce que tu as vu. N'existe que sur les PC Copilot+ ; sans effet ailleurs.",
    regs: [{ key: "HKCU:\\Software\\Policies\\Microsoft\\Windows\\WindowsAI", name: "DisableAIDataAnalysis", off: 1, on: null }] },
];
// Un réglage = une ou plusieurs valeurs du registre.
const regsOf = (p) => p.regs || [{ key: p.key, name: p.name, off: p.off, on: p.on }];

const MODES = { Auto: "Automatic", Manual: "Manual", Disabled: "Disabled", Boot: "Boot", System: "System" };
const NAME_RE = /^[A-Za-z0-9_.\-]{1,80}$/;

module.exports = (ctx) => {
  let last = null;

  const setServices = (changes) => ps.runElevated(`
    foreach ($c in $A.changes) {
      Set-Service -Name $c.name -StartupType $c.mode
      if ($c.mode -eq 'Disabled') { Stop-Service -Name $c.name -Force -ErrorAction SilentlyContinue }
      elseif ($c.running) { Start-Service -Name $c.name -ErrorAction SilentlyContinue }
    }
    $true`, { args: { changes } });

  const setTasks = (tasks) => ps.runElevated(`
    foreach ($t in $A.tasks) {
      if ($t.enable) { Enable-ScheduledTask -TaskPath $t.path -TaskName $t.name | Out-Null }
      else { Disable-ScheduledTask -TaskPath $t.path -TaskName $t.name | Out-Null }
    }
    $true`, { args: { tasks } });

  // Les valeurs de HKLM (réglages machine) passent par une fenêtre administrateur.
  const PRIV_SCRIPT = `
    foreach ($i in $A.items) {
      if (-not (Test-Path $i.key)) { New-Item -Path $i.key -Force | Out-Null }
      if ($null -eq $i.value) { Remove-ItemProperty -Path $i.key -Name $i.name -ErrorAction SilentlyContinue }
      else { Set-ItemProperty -Path $i.key -Name $i.name -Value $i.value -Type DWord }
    }
    $true`;
  const setPrivacy = async (items) => {
    const machine = items.filter((i) => /^HKLM:/.test(i.key)), user = items.filter((i) => !/^HKLM:/.test(i.key));
    if (user.length) await ps.run(PRIV_SCRIPT, { args: { items: user } });
    if (machine.length) await ps.runElevated(PRIV_SCRIPT, { args: { items: machine } });
    return true;
  };

  ctx.reverters.service = ({ changes }) => setServices(changes);
  ctx.reverters.tasks = ({ tasks }) => setTasks(tasks);
  ctx.reverters.privacy = ({ items }) => setPrivacy(items);

  return {
    "GET /api/services": async () => {
      const r = await ps.run(`
        $mem = @{}; foreach ($p in Get-Process) { $mem[$p.Id] = $p.WorkingSet64 }
        $conn = @{}
        Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | ForEach-Object { $conn[[int]$_.OwningProcess] = 1 + [int]$conn[[int]$_.OwningProcess] }
        $share = @{}
        $all = Get-CimInstance Win32_Service
        foreach ($s in $all) { if ($s.ProcessId) { $share[[int]$s.ProcessId] = 1 + [int]$share[[int]$s.ProcessId] } }
        $svc = foreach ($s in $all) {
          $pid0 = [int]$s.ProcessId
          @{ name = $s.Name; display = $s.DisplayName; desc = $s.Description; state = $s.State; mode = $s.StartMode
             pid = $pid0; mem = if ($pid0) { [int64]$mem[$pid0] } else { 0 }; shared = if ($pid0) { [int]$share[$pid0] } else { 0 }
             conn = if ($pid0) { [int]$conn[$pid0] } else { 0 }; windows = ("$($s.PathName)" -match '\\\\Windows\\\\') }
        }
        $tasks = foreach ($t in $A.tasks) {
          $x = Get-ScheduledTask -TaskPath $t.path -TaskName $t.name -ErrorAction SilentlyContinue
          if ($x) { @{ path = $t.path; name = $t.name; state = "$($x.State)" } }
        }
        $priv = foreach ($p in $A.priv) {
          $v = (Get-ItemProperty -Path $p.key -Name $p.name -ErrorAction SilentlyContinue).($p.name)
          @{ id = $p.id; value = $v }
        }
        $tel = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\DataCollection' -Name AllowTelemetry -ErrorAction SilentlyContinue).AllowTelemetry
        @{ services = @($svc); tasks = @($tasks); privacy = @($priv); telemetryPolicy = $tel }`,
      { args: { tasks: TASKS, priv: PRIVACY.map((p) => ({ id: p.id, key: regsOf(p)[0].key, name: regsOf(p)[0].name })) }, timeout: 60000 });

      const services = (r.services || []).map((s) => {
        const kb = KB[s.name];
        const mode = MODES[s.mode] || s.mode;
        return { ...s, mode, kb: kb || null,
          // Un service qui partage son processus : la mémoire affichée est celle du groupe.
          advice: kb && kb.reco !== mode && !(kb.reco === "Manual" && mode === "Disabled") ? kb.reco : null };
      }).sort((a, b) => b.mem - a.mem);
      last = services;
      const tasks = TASKS.map((t) => ({ ...t, state: (r.tasks || []).find((x) => x.name === t.name)?.state || "Absente" }))
        .filter((t) => t.state !== "Absente");
      const privacy = PRIVACY.map((p) => {
        const v = (r.privacy || []).find((x) => x.id === p.id)?.value;
        // Valeur absente = réglage par défaut de Windows, c'est-à-dire activé.
        const on = v == null ? true : v !== regsOf(p)[0].off;
        return { id: p.id, label: p.label, desc: p.desc, on, group: p.group || "privacy", admin: !!p.admin };
      });
      return { services, tasks, privacy, telemetryPolicy: r.telemetryPolicy ?? null };
    },

    // Change le mode de démarrage de services (droits administrateur).
    "POST /api/services/set": async (req) => {
      const { changes } = await ctx.body(req);
      if (!last) throw new Error("Actualise d'abord la liste des services.");
      const valid = [];
      const revert = [];
      for (const c of changes || []) {
        const s = last.find((x) => x.name === c.name);
        if (!s || !NAME_RE.test(c.name) || !["Automatic", "Manual", "Disabled"].includes(c.mode)) throw new Error(`Changement refusé : ${c.name}`);
        if (s.mode === "Boot" || s.mode === "System") throw new Error(`${s.display} est un service de démarrage du noyau : on n'y touche pas.`);
        valid.push({ name: s.name, mode: c.mode, running: false });
        revert.push({ name: s.name, mode: s.mode, running: s.state === "Running" });
      }
      if (!valid.length) throw new Error("Aucun changement.");
      await setServices(valid);
      ctx.journal.add({ kind: "system", title: valid.length === 1
        ? `Service ${last.find((x) => x.name === valid[0].name).display} : ${valid[0].mode}` : `${valid.length} services modifiés`,
        detail: valid.map((v) => `${v.name} → ${v.mode}`).join(", "), revert: { type: "service", args: { changes: revert } } });
      return { ok: true };
    },

    "POST /api/tasks/set": async (req) => {
      const { names, enable } = await ctx.body(req);
      const tasks = TASKS.filter((t) => (names || []).includes(t.name)).map((t) => ({ path: t.path, name: t.name, enable: !!enable }));
      if (!tasks.length) throw new Error("Aucune tâche connue.");
      await setTasks(tasks);
      ctx.journal.add({ kind: "system", title: `${tasks.length} tâche(s) de télémétrie ${enable ? "réactivée(s)" : "désactivée(s)"}`,
        revert: { type: "tasks", args: { tasks: tasks.map((t) => ({ ...t, enable: !enable })) } } });
      return { ok: true };
    },

    "POST /api/privacy/set": async (req) => {
      const { ids, on } = await ctx.body(req);
      const items = PRIVACY.filter((p) => (ids || []).includes(p.id));
      if (!items.length) throw new Error("Réglage inconnu.");
      const vals = (state) => items.flatMap((p) => regsOf(p).map((r) => ({ key: r.key, name: r.name, value: state ? r.on : r.off })));
      await setPrivacy(vals(!!on));
      ctx.journal.add({ kind: "system", title: `Confidentialité : ${items.map((p) => p.label).join(", ")} ${on ? "activé" : "désactivé"}`,
        detail: "Certains changements s'appliquent après redémarrage de l'Explorateur ou de la session.",
        revert: { type: "privacy", args: { items: vals(!on) } } });
      return { ok: true };
    },
  };
};
