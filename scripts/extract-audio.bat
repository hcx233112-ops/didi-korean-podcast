@echo off
powershell -WindowStyle Hidden -Command "cd '%~dp0..'; python scripts\extract-audio.py *>> logs\extract-audio.log 2>&1"
