// Nettoyage Windows : les opérations que seul un administrateur peut faire.
// Chaque opération est un script fixe ; la page ne choisit que lesquelles.

const ps = require("../../ps");

const ITEMS = [
  { id: "winupdate", label: "Téléchargements de Windows Update",
    desc: "Fichiers de mises à jour déjà installées. Windows les retélécharge si besoin.",
    paths: ["C:\\Windows\\SoftwareDistribution\\Download"], admin: true, risk: "faible",
    script: `Stop-Service wuauserv, bits -Force -ErrorAction SilentlyContinue
      Get-ChildItem 'C:\\Windows\\SoftwareDistribution\\Download' -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
      Start-Service wuauserv, bits -ErrorAction SilentlyContinue` },
  { id: "deliveryopt", label: "Cache d'optimisation de distribution",
    desc: "Morceaux de mises à jour partagés avec d'autres PC. Se reconstitue tout seul.",
    paths: ["C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Local\\Microsoft\\Windows\\DeliveryOptimization\\Cache"], admin: true, risk: "faible",
    script: `Delete-DeliveryOptimizationCache -Force -ErrorAction SilentlyContinue` },
  { id: "wintemp", label: "Temporaires de Windows",
    desc: "C:\\Windows\\Temp, en épargnant ce qui a moins d'un jour.",
    paths: ["C:\\Windows\\Temp"], admin: true, risk: "faible",
    script: `$c = (Get-Date).AddDays(-1)
      Get-ChildItem 'C:\\Windows\\Temp' -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $c } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue` },
  { id: "wer", label: "Rapports d'erreurs Windows",
    desc: "Rapports de plantage déjà envoyés ou en attente d'envoi à Microsoft.",
    paths: ["C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportArchive", "C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue", "C:\\ProgramData\\Microsoft\\Windows\\WER\\Temp"], admin: true, risk: "faible",
    script: `foreach ($d in 'ReportArchive','ReportQueue','Temp') { Get-ChildItem "C:\\ProgramData\\Microsoft\\Windows\\WER\\$d" -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }` },
  { id: "dumps", label: "Vidages mémoire après écran bleu",
    desc: "MEMORY.DMP et minidumps : utiles seulement pour diagnostiquer un écran bleu passé.",
    paths: ["C:\\Windows\\MEMORY.DMP", "C:\\Windows\\Minidump", "C:\\Windows\\LiveKernelReports"], admin: true, risk: "faible",
    script: `Remove-Item 'C:\\Windows\\MEMORY.DMP' -Force -ErrorAction SilentlyContinue
      foreach ($d in 'C:\\Windows\\Minidump','C:\\Windows\\LiveKernelReports') { Get-ChildItem $d -Force -Recurse -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }` },
  { id: "components", label: "Anciens composants Windows (WinSxS)",
    desc: "Versions remplacées par les mises à jour. Peut prendre 5 à 20 minutes. Les mises à jour déjà installées ne pourront plus être désinstallées.",
    paths: [], estimate: "souvent 1 à 5 Go", admin: true, risk: "moyen", slow: true,
    script: `& dism.exe /Online /Cleanup-Image /StartComponentCleanup /Quiet /NoRestart | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "DISM a échoué (code $LASTEXITCODE)." }` },
  { id: "hibernate", label: "Désactiver l'hibernation",
    desc: "Supprime hiberfil.sys. Tu perds la veille prolongée et le démarrage rapide (le PC démarre un peu plus lentement à froid). Réversible depuis le journal.",
    paths: ["C:\\hiberfil.sys"], admin: true, risk: "moyen", revert: "hibernate",
    script: `& powercfg.exe /hibernate off
      if ($LASTEXITCODE -ne 0) { throw "powercfg a échoué." }` },
  { id: "recyclebin", label: "Vider la corbeille",
    desc: "Suppression DÉFINITIVE de tout ce qui est dans la corbeille. Plus aucune restauration possible, y compris depuis le journal de Sonde.",
    paths: [], admin: false, risk: "définitif",
    script: `Clear-RecycleBin -Force -ErrorAction SilentlyContinue` },
];

module.exports = (ctx) => {
  ctx.reverters.hibernate = () => ps.runElevated("& powercfg.exe /hibernate on; $true");

  function sizeOf(item) {
    const scan = ctx.getScan();
    if (!scan) return null;
    let total = 0, known = false;
    for (const p of item.paths) {
      const d = scan.get(p);
      if (d) { total += d.size; known = true; continue; }
      const f = scan.getFile(p);
      if (f) { total += f.file.size; known = true; }
    }
    return known ? total : null;
  }

  return {
    "GET /api/cleanup": async () => {
      const state = await ps.run(`
        @{ hibernate = [bool](Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power' -Name HibernateEnabled -ErrorAction SilentlyContinue).HibernateEnabled
           windowsOld = (Test-Path 'C:\\Windows.old') }`).catch(() => ({}));
      let bin = null;
      try {
        const { binItems } = require("../../trash");
        const items = binItems();
        bin = { count: items.length, size: items.reduce((a, i) => a + i.size, 0) };
      } catch {}
      return {
        windowsOld: state.windowsOld,
        items: ITEMS.filter((i) => i.id !== "hibernate" || state.hibernate !== false).map((i) => ({
          id: i.id, label: i.label, desc: i.desc, admin: i.admin, risk: i.risk, slow: !!i.slow, estimate: i.estimate,
          size: i.id === "recyclebin" ? bin?.size ?? null : sizeOf(i),
        })),
      };
    },

    // Exécute les opérations choisies. Une seule demande UAC pour toutes
    // celles qui demandent les droits administrateur.
    "POST /api/cleanup/run": async (req) => {
      const { ids } = await ctx.body(req);
      const chosen = ITEMS.filter((i) => (ids || []).includes(i.id));
      if (!chosen.length) throw new Error("Rien de sélectionné.");
      const before = await ctx.freeSpace("C:\\");
      const results = [];
      const admin = chosen.filter((i) => i.admin);
      if (admin.length) {
        // Chaque opération est isolée : l'échec de l'une n'empêche pas les autres.
        const script = admin.map((i) => `
          try { ${i.script}
            $res += @{ id = '${i.id}'; ok = $true } }
          catch { $res += @{ id = '${i.id}'; ok = $false; error = "$_" } }`).join("\n");
        const r = await ps.runElevated(`$res = @()\n${script}\n$res`);
        results.push(...[].concat(r || []));
      }
      for (const i of chosen.filter((i) => !i.admin)) {
        try { await ps.run(i.script + "\n$true"); results.push({ id: i.id, ok: true }); }
        catch (e) { results.push({ id: i.id, ok: false, error: e.message }); }
      }
      const after = await ctx.freeSpace("C:\\");
      const freed = before.free != null && after.free != null ? after.free - before.free : null;
      for (const r of results.filter((r) => r.ok)) {
        const item = ITEMS.find((i) => i.id === r.id);
        ctx.journal.add({ kind: "system", title: `Nettoyage Windows : ${item.label}`,
          revert: item.revert ? { type: item.revert, args: {} } : undefined });
      }
      return { results, freed };
    },
  };
};
