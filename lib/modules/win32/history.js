// Suivi dans le temps : évolution de l'espace, ce qui a grossi, scan
// hebdomadaire planifié et alerte quand l'espace libre devient trop bas.

const path = require("path");
const ps = require("../../ps");

const TASK = "Sonde - scan hebdomadaire";

// Notification Windows (toast), sans module externe.
function notify(title, text) {
  return ps.run(`
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $n = $t.GetElementsByTagName('text')
    $n.Item(0).AppendChild($t.CreateTextNode($A.title)) > $null
    $n.Item(1).AppendChild($t.CreateTextNode($A.text)) > $null
    $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))
    $true`, { args: { title, text } });
}

module.exports = (ctx) => ({
  "GET /api/history": async () => ({ snapshots: ctx.history.list(), alertFreeGB: ctx.settings.alertFreeGB }),

  "GET /api/history/diff": async (req, res, url) => {
    const list = ctx.history.list();
    const to = url.searchParams.get("to") || list[0]?.id;
    const from = url.searchParams.get("from") || list[1]?.id;
    if (!from || !to) return { none: true, reason: "Il faut au moins deux scans pour comparer." };
    return ctx.history.diff(from, to) || { none: true, reason: "Instantané introuvable." };
  },

  "GET /api/schedule": async () => {
    const r = await ps.run(`
      $t = Get-ScheduledTask -TaskName $A.name -ErrorAction SilentlyContinue
      if (-not $t) { return @{ enabled = $false } }
      $i = Get-ScheduledTaskInfo -TaskName $A.name
      @{ enabled = $true; state = "$($t.State)"; next = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null };
         last = if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null } }`, { args: { name: TASK } });
    return r;
  },

  // Crée ou supprime la tâche planifiée (au nom de l'utilisateur, sans droits
  // administrateur). Application installée : « Sonde.exe --scan », sans fenêtre.
  // Depuis les sources : « node server.js --scan », console masquée par conhost --headless.
  "POST /api/schedule": async (req) => {
    const { enable, day = "Sunday", hour = 12 } = await ctx.body(req);
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    if (!days.includes(day) || !(hour >= 0 && hour <= 23)) throw new Error("Jour ou heure invalide.");
    // Les disques du dernier scan (« C:/ G:/ ») : la tâche scanne les mêmes.
    const root = (ctx.getScan()?.roots || ["C:\\"]).filter((r) => /^[A-Z]:\\$/i.test(r)).map((r) => r.slice(0, 2) + "/").join(" ") || "C:/";
    const electron = !!process.versions.electron;
    const exe = electron ? process.execPath : "conhost.exe";
    const arg = electron ? `--scan ${root}` : `--headless "${process.execPath}" "${path.join(ctx.ROOT, "server.js")}" --scan ${root}`;
    const dir = electron ? path.dirname(process.execPath) : ctx.ROOT;
    await ps.run(enable ? `
      $act = New-ScheduledTaskAction -Execute $A.exe -Argument $A.arg -WorkingDirectory $A.dir
      $trg = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $A.day -At ([datetime]::Today.AddHours($A.hour))
      $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
      Register-ScheduledTask -TaskName $A.name -Action $act -Trigger $trg -Settings $set -Description 'Scan du disque par Sonde, et alerte si l''espace libre devient trop bas.' -Force > $null
      $true` : `
      Unregister-ScheduledTask -TaskName $A.name -Confirm:$false -ErrorAction SilentlyContinue
      $true`, { args: { name: TASK, exe, arg, dir, day, hour } });
    return { ok: true };
  },

  "POST /api/notify/test": async () => {
    await notify("Sonde", "Les notifications fonctionnent.");
    return { ok: true };
  },
});

module.exports.notify = notify;
