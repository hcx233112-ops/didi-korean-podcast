# Update tasks in place. Run as administrator; existing valid triggers are retained.
$ErrorActionPreference = 'Stop'
$ProjectDir = Split-Path -Parent $PSScriptRoot
try {
    $PythonExe = (Get-Command python -ErrorAction Stop).Source
    $Pythonw = Join-Path (Split-Path $PythonExe) 'pythonw.exe'
    if (Test-Path -LiteralPath $Pythonw) { $PythonExe = $Pythonw }

    function Register-DidiTask {
        param($Name, $Script, $IntervalHours, $DailyTime, $TimeoutMinutes, $Description, [switch]$AtLogon)
        $Old = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
        if ($Old -and $Old.Triggers -and @($Old.Triggers | Where-Object { $_.Enabled }).Count -gt 0) {
            $Triggers = $Old.Triggers
        } elseif ($AtLogon) {
            $Triggers = New-ScheduledTaskTrigger -AtLogOn
        } elseif ($DailyTime) {
            $Triggers = New-ScheduledTaskTrigger -Daily -At $DailyTime
        } else {
            $Triggers = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
        }
        $Action = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$ProjectDir\scripts\$Script`"" -WorkingDirectory $ProjectDir
        $SettingArguments = @{
            ExecutionTimeLimit = (New-TimeSpan -Minutes $TimeoutMinutes)
            StartWhenAvailable = $true
            Hidden = $true
            MultipleInstances = 'IgnoreNew'
        }
        if ($Name -notin @('DidiPodcast-Watchdog', 'DidiPodcast-AudioServer')) {
            $SettingArguments.RunOnlyIfNetworkAvailable = $true
        }
        $Settings = New-ScheduledTaskSettingsSet @SettingArguments
        Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Triggers -Settings $Settings -Description $Description -RunLevel Highest -Force | Out-Null
        Enable-ScheduledTask -TaskName $Name | Out-Null
        $Registered = Get-ScheduledTask -TaskName $Name
        if ($Registered.State -eq 'Disabled') { throw "Task remains disabled: $Name" }
        Write-Host "Updated: $Name"
    }

    Register-DidiTask -Name 'DidiPodcast-SyncAudio' -Script 'sync-audio.py' -IntervalHours 4 -TimeoutMinutes 120 -Description 'Audio sync every 4 hours'
    Register-DidiTask -Name 'DidiPodcast-Watchdog' -Script 'watchdog.py' -IntervalHours 1 -TimeoutMinutes 10 -Description 'Hourly task and audio delivery checks'
    Register-DidiTask -Name 'DidiPodcast-AudioServer' -Script 'start-audio-server.py' -AtLogon -TimeoutMinutes 2 -Description 'Start local audio services at logon'
    Register-DidiTask -Name 'podcast-audio-update' -Script 'sync-audio.py' -DailyTime '03:00' -TimeoutMinutes 120 -Description 'Daily audio sync'
    Register-DidiTask -Name 'podcast-transcript-update' -Script 'run-transcripts.py' -DailyTime '05:00' -TimeoutMinutes 190 -Description 'Daily subtitle generation and translation'
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
