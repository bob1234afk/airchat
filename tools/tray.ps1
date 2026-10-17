# AirChat, living in the notification area.
#
# Starts everything AirChat needs - the free public link (the tunnel) and the
# server - with no window of any kind, then shows a tray icon next to the clock.
# Nothing here depends on a console staying open, so AirChat keeps running after
# the launcher window that started it has gone. From the tray you can open
# AirChat, copy the friend links, open the log, or stop everything.
#
# It uses only what Windows already has (.NET WinForms through Windows
# PowerShell), so AirChat keeps its promise of needing nothing installed.
#
# If the tray cannot start, this deliberately makes a noise: it stops AirChat
# and shows a dialog saying why. A silent failure here would leave AirChat
# running with no icon and no obvious way to stop it.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $root 'airchat-tray.log'
$errPath = Join-Path $root 'airchat-tray.err.log'

# Hide and re-show this console window on demand.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AirChatConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$console = [AirChatConsole]::GetConsoleWindow()

# AirChat starts with no window of its own, so there is normally nothing to
# hide. This does nothing when Windows gave this process no console, which keeps
# the caller below honest without a special case.
function Hide-AirChatWindow {
  if ($console -ne [IntPtr]::Zero) { [void][AirChatConsole]::ShowWindow($console, 0) }
}

# Nothing is printed anywhere when there is no window, so anything the user has
# to know goes through a balloon tip or a dialog.
function Show-AirChatNotice([string]$text) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'AirChat')
}

try {
  $node = (Get-Command node -ErrorAction Stop).Source
} catch {
  Show-AirChatNotice("Node.js was not found, so AirChat cannot run.`r`n`r`n" +
    "Install Node.js from https://nodejs.org (the LTS button), restart the PC,`r`n" +
    'then run this again.')
  exit 1
}

# --no-browser: the tray icon is the way in, so do not also open a browser tab.
#
# The path is quoted by hand on purpose: Start-Process -ArgumentList does not
# reliably quote array elements on Windows PowerShell, and an AirChat folder
# whose path contains a space would then be split into two arguments.
$tunnelScript = Join-Path $root 'tools\tunnel.js'
$tunnelArgs = '"{0}" --no-browser' -f $tunnelScript

try {
  $proc = Start-Process -FilePath $node `
    -ArgumentList $tunnelArgs `
    -WorkingDirectory $root `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $logPath `
    -RedirectStandardError $errPath
} catch {
  Show-AirChatNotice("AirChat could not start.`r`n`r`n$($_.Exception.Message)`r`n`r`n" +
    'Run "Start AirChat + Public Link.bat" to see the whole story in a window.')
  exit 1
}

# Wait for the tunnel to print its address, so the tray tip can show it. If it
# never appears (no cloudflared, no internet) we still carry on to the tray.
$url = $null
$deadline = (Get-Date).AddSeconds(75)

while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500

  if (Test-Path -LiteralPath $logPath) {
    $text = Get-Content -LiteralPath $logPath -Raw
    $found = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($found.Success) {
      $url = $found.Value
      break
    }
  }

  if ($proc.HasExited) { break }
}

# It stopped while we were waiting for the link. With no window anywhere, the
# log is the only place the reason exists - so say it, instead of showing an
# icon for a server that is not there.
if ($proc.HasExited) {
  $detail = ''

  foreach ($file in @($errPath, $logPath)) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $text = Get-Content -LiteralPath $file -Raw
    if ($text) { $text = $text.Trim() }
    if ($text -and $text.Length -gt $detail.Length) { $detail = $text }
  }

  if (-not $detail) { $detail = 'It wrote nothing before it stopped.' }
  if ($detail.Length -gt 800) { $detail = $detail.Substring($detail.Length - 800) }

  Show-AirChatNotice("AirChat stopped right after starting (exit $($proc.ExitCode)).`r`n`r`n" +
    "$detail`r`n`r`n" +
    'Run "Start AirChat + Public Link.bat" to watch it start in a window.')
  exit 1
}

# AirChat draws its own icons, so borrow the real one for the tray rather than
# showing a generic Windows glyph. Falls back if the server is not answering.
function Get-AirChatIcon {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $client = New-Object System.Net.WebClient
      $bytes = $client.DownloadData('http://localhost:4000/icon-192.png')
      $stream = New-Object System.IO.MemoryStream(, $bytes)
      $bitmap = [System.Drawing.Bitmap]::FromStream($stream)
      return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  return [System.Drawing.SystemIcons]::Application
}

# Every guest invite, ready to paste into a message.
function Get-FriendLinks {
  try {
    $configPath = Join-Path $root 'config.json'
    $dbPath = Join-Path $root 'data\airchat.json'

    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    if (-not (Test-Path -LiteralPath $dbPath)) { return $null }

    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $cfg.publicUrl) { return $null }

    $db = Get-Content -LiteralPath $dbPath -Raw | ConvertFrom-Json
    $base = ([string]$cfg.publicUrl).TrimEnd('/')

    $out = ''
    foreach ($guest in @($db.guests)) {
      $title = [string]$guest.name

      $match = @($db.conversations | Where-Object { $_.id -eq $guest.conversationId })
      if ($match.Count -gt 0 -and $match[0].title) { $title = [string]$match[0].title }

      $out += "$title`r`n$base/?guest=$($guest.token)`r`n`r`n"
    }

    if (-not $out) { return $null }
    return $out.Trim()
  } catch {
    return $null
  }
}

try {
  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = Get-AirChatIcon

  $tip = if ($url) { "AirChat - $url" } else { 'AirChat (no public link)' }
  $notify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('Open AirChat')
  $linkItem = $menu.Items.Add('Copy friend links')
  # There is no window to show any more, so this shows what AirChat printed
  # instead - the reason a link or a start-up failed is in there.
  $logItem = $menu.Items.Add('Open the log')
  # Add(string) would create a menu item labelled "-"; a separator needs the type.
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $stopItem = $menu.Items.Add('Stop AirChat')
  $notify.ContextMenuStrip = $menu

  $openAirChat = { Start-Process 'http://localhost:4000' }
  $openItem.add_Click($openAirChat)
  $notify.add_DoubleClick($openAirChat)

  $linkItem.add_Click({
    $links = Get-FriendLinks

    if ($links) {
      Set-Clipboard -Value $links
      # These addresses carry no chat key: the key never leaves the browser that
      # made it. Saying so here stops a locked chat being shared with a link that
      # cannot open it.
      $notify.ShowBalloonTip(5000, 'AirChat', 'Friend links copied. For a locked chat, copy the link from Invite instead - that one carries the key.', 'Info')
    } else {
      $notify.ShowBalloonTip(5000, 'AirChat', 'No friend links to copy. Open AirChat, click Invite in a chat, and use Copy there.', 'Info')
    }
  })

  $logItem.add_Click({
    if (Test-Path -LiteralPath $logPath) { Start-Process notepad.exe $logPath }
    else { $notify.ShowBalloonTip(5000, 'AirChat', 'No log yet - nothing has been written.', 'Info') }
  })

  $script:stopping = $false
  $stopItem.add_Click({
    $script:stopping = $true
    [System.Windows.Forms.Application]::Exit()
  })

  # Make sure the icon is on before hiding the window behind it.
  $notify.Visible = $true

  Hide-AirChatWindow
  $notify.ShowBalloonTip(6000, 'AirChat is running', 'Double-click the tray icon to open AirChat. If you cannot see it, click the ^ arrow by the clock.', 'Info')

  # The icon must never outlive the server behind it. A second launcher stops an
  # old AirChat on purpose, and a crash does the same thing by accident; either
  # way an icon that still says "AirChat is running" and opens nothing is worse
  # than no icon at all. So watch the child and leave with it.
  $watchdog = New-Object System.Windows.Forms.Timer
  $watchdog.Interval = 2000
  $watchdog.add_Tick({
    if (-not $proc.HasExited) { return }

    $watchdog.Stop()

    # Stopping from the menu is meant; anything else is AirChat dying under its
    # own icon, and with no window that has to be said out loud or not at all.
    if (-not $script:stopping) {
      Show-AirChatNotice("AirChat stopped (exit $($proc.ExitCode)).`r`n`r`n" +
        "Run `"Start AirChat in Tray.bat`" to start it again.`r`n`r`n" +
        "If it keeps happening, use ``Open the log`` in the tray menu,`r`n" +
        "or run `"Start AirChat + Public Link.bat`" to watch it start.")
    }

    [System.Windows.Forms.Application]::Exit()
  })
  $watchdog.Start()

  [System.Windows.Forms.Application]::Run()

  $watchdog.Stop()
  $watchdog.Dispose()

  # Reached when Stop is chosen: take the server and the tunnel down with us.
  $notify.Visible = $false
  $notify.Dispose()

  if ($proc -and -not $proc.HasExited) {
    taskkill /PID $proc.Id /T /F | Out-Null
  }
} catch {
  # Never leave AirChat running headless just because the icon failed.
  if ($notify) { $notify.Visible = $false }

  if ($proc -and -not $proc.HasExited) {
    taskkill /PID $proc.Id /T /F | Out-Null
  }

  Show-AirChatNotice("AirChat could not move to the notification area:`r`n`r`n" +
    "$($_.Exception.Message)`r`n`r`n" +
    "It has been stopped. Run `"Start AirChat + Public Link.bat`" instead,`r`n" +
    'which keeps a window you can watch.')

  exit 1
}
