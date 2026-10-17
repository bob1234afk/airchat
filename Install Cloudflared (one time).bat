@echo off
title AirChat - install the free public-link tool
cd /d "%~dp0"

echo.
echo  This installs cloudflared, the free tool that gives AirChat a public link.
echo  It needs no account and costs nothing.
echo.

winget install --id Cloudflare.cloudflared --exact --accept-source-agreements --accept-package-agreements

echo.
echo  ---------------------------------------------------------------------
echo  If the command above did not work, do this instead:
echo.
echo    1. Open this page in your browser:
echo       https://github.com/cloudflare/cloudflared/releases/latest
echo    2. Download the file named  cloudflared-windows-amd64.exe
echo    3. Rename it to  cloudflared.exe
echo    4. Move it into this AirChat folder (next to this file)
echo.
echo  AirChat will use a cloudflared.exe in this folder automatically.
echo  ---------------------------------------------------------------------
echo.
pause
