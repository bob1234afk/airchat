@echo off
rem Opens AirChat. The app starts its own server and public link, so there is
rem nothing else to launch - this file is only a door.
call "%~dp0tools\start-app.cmd" %*
