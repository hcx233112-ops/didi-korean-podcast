# 注册所有 DidiPodcast 任务计划
# 用法：右键 → 以管理员身份运行

$ProjectDir = Split-Path -Parent $PSScriptRoot
# 优先用 pythonw.exe（无控制台窗口），找不到再退回 python.exe
$PythonExe = $null
$PythonDir = (Get-Command python -ErrorAction SilentlyContinue).Source
if ($PythonDir) {
    $PythonwPath = Join-Path (Split-Path $PythonDir) "pythonw.exe"
    if (Test-Path $PythonwPath) { $PythonExe = $PythonwPath }
    else { $PythonExe = $PythonDir }
}
if (-not $PythonExe) {
    $PyDir = (Get-Command py -ErrorAction SilentlyContinue).Source
    if ($PyDir) { $PythonExe = $PyDir }
}
if (-not $PythonExe) {
    Write-Error "找不到 python"
    exit 1
}
Write-Host "  使用解释器: $PythonExe"

function Register-DidiTask {
    param($Name, $Script, $IntervalHours, $TimeoutMinutes, $Desc)
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    $Action   = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$ProjectDir\scripts\$Script`"" -WorkingDirectory $ProjectDir
    $Trigger  = New-ScheduledTaskTrigger -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) -Once -At (Get-Date)
    $Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes $TimeoutMinutes) -StartWhenAvailable -RunOnlyIfNetworkAvailable -Hidden
    Register-ScheduledTask -TaskName $Name -Action $Action -Trigger $Trigger -Settings $Settings -Description $Desc -RunLevel Highest -Force | Out-Null
    Write-Host "  已注册: $Name（每 $IntervalHours 小时）"
}

Write-Host "注册 DidiPodcast 任务计划..."
Register-DidiTask "DidiPodcast-SyncAudio" "sync-audio.py"  4  120 "每4小时拉取新视频并下载音频"
Register-DidiTask "DidiPodcast-Watchdog"  "watchdog.py"    1   10 "每小时巡检流程，自动修复异常"

Write-Host ""
Write-Host "完成。日志文件："
Write-Host "  音频同步: $ProjectDir\audio-log.txt"
Write-Host "  巡检记录: $ProjectDir\watchdog-log.txt"
Write-Host ""
Write-Host "立即测试巡检："
Write-Host "  Start-ScheduledTask -TaskName 'DidiPodcast-Watchdog'"