@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-offline.ps1" %*
pause
