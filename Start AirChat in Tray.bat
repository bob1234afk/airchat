@echo off
title AirChat - notification area
cd /d "%~dp0"

rem AirChat with no window: the same app, the same server, the same public link,
rem started quietly with an icon next to the clock. Double-click the icon (or the
rem AirChat shortcut) to get the window back.

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "SCRIPT=%~dp0tools\tray.ps1"

if not exist "%SCRIPT%" goto missing

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
exit /b 0

:missing
echo.
echo  tools\tray.ps1 is missing from this folder, so the tray icon cannot start.
echo  Use "Start AirChat.bat" instead.
echo.
pause
exit /b 1
