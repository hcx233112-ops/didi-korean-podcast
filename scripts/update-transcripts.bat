@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo [%date% %time%] 拉取最新字幕（CI 已生成的韩文字幕）...
git pull --no-edit
echo [%date% %time%] 补翻译未翻译字幕...
python scripts\retranslate.py
if errorlevel 1 (
    echo [%date% %time%] 翻译脚本异常退出
    exit /b 1
)
echo [%date% %time%] 提交并推送字幕...
git add public\data\transcripts\
git diff --staged --quiet && (echo 无新翻译，跳过推送 & exit /b 0)
for /f "tokens=*" %%d in ('git log -1 --format^=%%ad --date^=format:%%Y-%%m-%%d') do set TODAY=%%d
git commit -m "chore: retranslate transcripts %TODAY%"
git pull --rebase --no-edit
git push
echo [%date% %time%] 完成
