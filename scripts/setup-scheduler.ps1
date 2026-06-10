# 注册 Windows 任务计划：每 4 小时自动同步音频
# 用法：右键 → 用 PowerShell 运行（需管理员）

$ProjectDir = Split-Path -Parent $PSScriptRoot
$PythonExe  = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $PythonExe) { $PythonExe = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $PythonExe) {
    Write-Error "找不到 python，请先安装 Python 并确保在 PATH 中"
    exit 1
}

$TaskName   = "DidiPodcast-SyncAudio"
$ScriptPath = Join-Path $ProjectDir "scripts\sync-audio.py"

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

$Action  = New-ScheduledTaskAction `
    -Execute $PythonExe `
    -Argument "`"$ScriptPath`"" `
    -WorkingDirectory $ProjectDir

$Trigger = New-ScheduledTaskTrigger `
    -RepetitionInterval (New-TimeSpan -Hours 4) `
    -Once -At (Get-Date)

$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2) `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Description "每 4 小时拉取新视频并下载音频" `
    -RunLevel Highest `
    -Force | Out-Null

Write-Host "任务已注册：$TaskName"
Write-Host "每 4 小时运行一次，日志：$ProjectDir\audio-log.txt"
Write-Host ""
Write-Host "常用命令："
Write-Host "  立即运行：Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  查看状态：Get-ScheduledTask  -TaskName '$TaskName'"
Write-Host "  删除任务：Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"