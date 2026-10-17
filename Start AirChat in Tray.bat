@echo off
setlocal
cd /d "%~dp0"

rem Starts everything AirChat needs - the server and its free public link - as a
rem background process with no window of its own, then waits here until AirChat
rem actually answers.
rem
rem The important part: this window owns nothing. Close it, or let it close
rem itself, and AirChat keeps running from the icon next to the clock. Use the
rem tray icon to open AirChat or to stop it.

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "ROOT=%~dp0"
set "SCRIPT=%~dp0tools\tray.ps1"
set "PORT=4000"

if not exist "%SCRIPT%" goto missing

rem A second launch replaces the first instead of fighting it for the port.
rem Only AirChat's own processes are stopped: the test is "this exact folder
rem appears in its command line", so nothing else on the PC is touched, and
rem never this helper. The old tunnel is stopped too, because it is holding the
rem log file this new copy needs to write.
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'node.exe') -and $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine.IndexOf('%ROOT%', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul

timeout /t 1 >nul

rem Start-Process, not a direct call: a child started by this window would be
rem closed along with it. This one belongs to Windows instead.
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%PS%' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','%SCRIPT%') -WindowStyle Hidden"

echo.
echo  Starting AirChat - the server and its public link.
echo  This takes a few seconds the first time.

set /a tries=0

:wait
"%PS%" -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',%PORT%); $c.Close(); exit 0 } catch { exit 1 }"
if not errorlevel 1 goto ready

set /a tries+=1
if %tries% GEQ 45 goto slow

timeout /t 1 >nul
goto wait

:ready
echo.
echo  AirChat is running. Look for its icon by the clock - if you cannot see it,
echo  click the small caret next to the clock to find it.
echo.
echo  Double-click the icon to open AirChat. Right-click it to stop AirChat,
echo  copy friend links, or read the log.
goto done

:slow
echo.
echo  AirChat has not answered on port %PORT% yet.
echo  Open the tray icon and choose "Open the log" to see why, or start
echo  "Start AirChat + Public Link.bat" to watch it happen in a window.
goto done

:missing
echo.
echo  tools\tray.ps1 is missing from this folder, so AirChat cannot start.
echo  Use "Start AirChat + Public Link.bat" instead.
echo.
pause
exit /b 1

:done
echo.
echo  This window closes itself. Nothing stops when it goes - AirChat keeps
echo  running until you stop it from the tray icon.
timeout /t 4 >nul

exit /b 0
