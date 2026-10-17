@echo off
title AirChat - put launchers on your Desktop
cd /d "%~dp0"

echo.
echo  Putting the AirChat launchers on your Desktop...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make-desktop-shortcuts.ps1"

echo.
echo  You can close this window now.
echo.
pause
