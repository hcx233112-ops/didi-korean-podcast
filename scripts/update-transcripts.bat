@echo off
chcp 65001 >nul
cd /d "%~dp0.."
call :run >> transcript-log.txt 2>&1
exit /b %errorlevel%

:run
echo [%date% %time%] ===== update-transcripts 开始 =====
git pull --no-edit
if errorlevel 1 exit /b 1
echo [%date% %time%] 生成新视频字幕（yt-dlp）...
python scripts\generate-transcripts.py
set GENERATION_EXIT=%errorlevel%
echo [%date% %time%] 补翻译未翻译字幕...
python scripts\retranslate.py
if errorlevel 1 (
    echo [%date% %time%] 翻译脚本异常退出
    exit /b 1
)
if not "%GENERATION_EXIT%"=="0" exit /b %GENERATION_EXIT%
echo [%date% %time%] 提交并推送字幕...
git add public\data\transcripts\
if errorlevel 1 exit /b 1
git diff --staged --quiet && (echo 无新变化，跳过推送 & exit /b 0)
if errorlevel 2 exit /b 1
for /f "tokens=*" %%d in ('git log -1 --format^=%%ad --date^=format:%%Y-%%m-%%d') do set TODAY=%%d
git commit -m "chore: retranslate transcripts %TODAY%"
if errorlevel 1 exit /b 1
git pull --rebase --autostash --no-edit
if errorlevel 1 exit /b 1
git push
if errorlevel 1 exit /b 1
echo [%date% %time%] 完成
exit /b 0
