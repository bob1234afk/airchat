@echo off
setlocal
title AirChat setup

rem What the self-extracting .exe runs once it has unpacked itself.
rem
rem This runs from a temporary folder, so everything here copies nothing: the
rem app goes to %LOCALAPPDATA%\AirChat, which is the one place a normal user can
rem always write, and where an upgrade will not lose their messages.

set "SRC=%~dp0"
set "DEST=%LOCALAPPDATA%\AirChat"

echo.
echo   AirChat
echo   One conversation, every network. Runs on this PC.
echo.

rem --- 1. Unpack -----------------------------------------------------------

echo   Installing to %DEST%
echo.

if not exist "%DEST%" mkdir "%DEST%" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Expand-Archive -LiteralPath '%SRC%app.zip' -DestinationPath '%DEST%' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"

if errorlevel 1 (
  echo.
  echo   Could not unpack the files into:
  echo     %DEST%
  echo.
  echo   Check that you have permission to write there, then run this again.
  echo.
  pause
  exit /b 1
)

rem Nothing of the user's is ever overwritten by an install: the messages and
rem the settings live in files the app creates, and upgrading must not touch them.
del "%SRC%app.zip" >nul 2>nul

rem --- 2. Is Node.js here? --------------------------------------------------

echo   Checking for Node.js...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found, and AirChat needs it to run.
  echo.
  echo   This will open nodejs.org: download the LTS version, install it with
  echo   the default options, then run this setup again. Everything else is
  echo   already in place.
  echo.
  pause
  start "" "https://nodejs.org/en/download"
  exit /b 1
)

for /f "delims=" %%v in ('node --version 2^>nul') do echo   Found Node.js %%v

rem --- 3. A way in ----------------------------------------------------------

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$shell = New-Object -ComObject WScript.Shell;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$link = $shell.CreateShortcut((Join-Path $desktop 'AirChat.lnk'));" ^
  "$link.TargetPath = Join-Path $env:DEST 'Start AirChat in Tray.bat';" ^
  "$link.WorkingDirectory = $env:DEST;" ^
  "$link.Description = 'AirChat';" ^
  "$link.IconLocation = (Join-Path $env:DEST 'airchat.ico');" ^
  "$link.Save()" >nul 2>nul

rem --- 4. Start -------------------------------------------------------------

echo.
echo   Starting AirChat. Look for its icon next to the clock.
echo.
echo   - Double-click that icon to open AirChat.
echo   - Right-click it to stop AirChat, copy your friend links, or read the log.
echo   - For a link that works away from home, use the tray icon's Public Link
echo     launcher, or "Start AirChat + Public Link.bat" in the folder below.
echo.
echo   Installed in: %DEST%
echo.

start "" "%DEST%\Start AirChat in Tray.bat"

timeout /t 3 >nul
exit /b 0
