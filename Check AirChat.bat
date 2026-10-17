@echo off
title AirChat - health check
cd /d "%~dp0"

echo.
echo  Checking AirChat...
echo.

node tools\doctor.js

echo.
echo  (If you see errors above, copy them and send them over.)
echo.
pause
