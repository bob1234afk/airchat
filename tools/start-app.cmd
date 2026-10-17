@echo off
setlocal
rem ---------------------------------------------------------------------------
rem The one way AirChat starts.
rem
rem Every launcher in this folder calls this file, so whichever icon somebody
rem double-clicks, the same thing happens: AirChat's window opens, its server
rem starts inside it, and its public link comes up by itself.
rem
rem That is the point. There used to be a launcher for a server with no window, a
rem launcher for a window, and a launcher for the tunnel - three different
rem half-AirChats that could hold the same port and hand out different links. Now
rem there is one program, and these files are just doors to it.
rem
rem Arguments are passed through, which is how the tray launcher asks for
rem --background (run everything, show no window).
rem ---------------------------------------------------------------------------

set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "ROOT=%%~fI"

rem Working on the code: run the Electron in this folder against the code in this
rem folder, so changes are visible immediately.
set "DEV=%ROOT%\node_modules\electron\dist\electron.exe"
if exist "%DEV%" (
  start "" "%DEV%" "%ROOT%" %*
  exit /b 0
)

rem Installed: the app the installer put here. Per-user install, so no admin.
set "INSTALLED=%LOCALAPPDATA%\Programs\AirChat\AirChat.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%" %*
  exit /b 0
)

echo.
echo   AirChat is not installed on this PC yet.
echo.
echo   Either install it with  AirChat-Setup-0.1.0-electron.exe  ^(the download^),
echo   or, if you are working on the code, run  npm install  in this folder once.
echo.
pause
exit /b 1
