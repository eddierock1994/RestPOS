@echo off
setlocal
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
"%NODE%" --disable-warning=ExperimentalWarning scripts\reset-pin.js
pause
