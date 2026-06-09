@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo [%date% %time%] 拉取最新视频列表（CI 已抓好的新视频）...
git pull --no-edit
echo [%date% %time%] 增量下载新音频（已存在的自动跳过）...
python scripts\extract-audio.py
echo [%date% %time%] 完成
