@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "boss_node="
for /f "usebackq delims=" %%N in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-node.ps1"`) do set "boss_node=%%N"
if not defined boss_node goto failed
"%boss_node%" "%~dp0scripts\install.js" %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo Startup failed. Read the error above before trying again.
pause
exit /b 1
