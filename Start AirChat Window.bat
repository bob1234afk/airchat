@echo off
title AirChat
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe echo Electron is not set up yet. In this folder run:  npm install
if not exist node_modules\electron\dist\electron.exe pause
if not exist node_modules\electron\dist\electron.exe exit /b 1
node_modules\electron\dist\electron.exe .
