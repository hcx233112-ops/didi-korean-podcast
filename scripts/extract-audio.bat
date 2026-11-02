@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
python scripts\extract-audio.py >> logs\extract-audio.log 2>&1
exit /b %errorlevel%
