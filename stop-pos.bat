@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-pos.ps1" %*
pause
