# AirChat, living in the notification area.
#
# This used to start its own server and its own tunnel - a second AirChat, with
# its own folder of settings and its own idea of which port was its own. Two of
# those could not exist at once, and the failures looked like "AirChat does not
# work" instead of "two AirChats are fighting".
#
# Now it starts the app with --background. That is the same server, the same
# public link and the same chats as the window, only with no window: the icon by
# the clock is how to get back to one. Nothing here needs Node.js, because the
# app is the program.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot

# Where the app keeps everything the person owns. Both spellings, because a
# development run and an installed copy disagree about capitalisation.
$appData = Join-Path $env:APPDATA 'AirChat'
$appHome = Join-Path $appData 'home'
$configPath = Join-Path $appHome 'config.json'
$appLog = Join-Path $appData 'airchat-app.log'

$portFile = Join-Path $appData 'airchat-port'

# The port AirChat is really on.
#
# The saved config is where it would like to be, and that is where it is almost
# every time. When something else holds that port, the app moves to a free one
# rather than refusing to open - and then this script would look on the old port,
# find nothing, and tell the person AirChat had failed. The app writes the port it
# actually used, so the icon and the menu can look in the right place.
function Get-AirChatPort {
  if (Test-Path -LiteralPath $portFile) {
    $said = 0
    $text = [string](Get-Content -LiteralPath $portFile -Raw)
    if ([int]::TryParse($text.Trim(), [ref]$said) -and $said -gt 0) { return $said }
  }

  if (Test-Path -LiteralPath $configPath) {
    try {
      $saved = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
      if ($saved.port) { return [int]$saved.port }
    } catch {
      # A broken config is the server's error to report; the default will do.
    }
  }

  return 4000
}

function Update-AirChatPort {
  $script:port = Get-AirChatPort
  $script:healthUrl = "http://localhost:$($script:port)/api/health"
}

Update-AirChatPort

function Show-AirChatNotice([string]$text) {
  [void][System.Windows.Forms.MessageBox]::Show($text, 'AirChat')
}

function Test-AirChatRunning {
  try {
    $answer = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
    return [bool]($answer.app -eq 'AirChat')
  } catch {
    return $false
  }
}

# The program to start: this folder's copy if it is a checkout, otherwise the
# installed app. Mirrors tools/start-app.cmd, so both doors lead to one AirChat.
$devExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$installedExe = Join-Path $env:LOCALAPPDATA 'Programs\AirChat\AirChat.exe'

if (Test-Path -LiteralPath $devExe) {
  $exe = $devExe
  $exeArgs = @("`"$root`"", '--background')
} elseif (Test-Path -LiteralPath $installedExe) {
  $exe = $installedExe
  $exeArgs = @('--background')
} else {
  Show-AirChatNotice(
    "AirChat is not installed on this PC yet.`r`n`r`n" +
    "Install it with AirChat-Setup-0.1.0-electron.exe, or run  npm install  in`r`n" +
    "the AirChat folder if you are working on the code.`r`n`r`n" +
    "Then run  Start AirChat in Tray.bat  again."
  )
  exit 1
}

$alreadyRunning = Test-AirChatRunning
$proc = $null

if (-not $alreadyRunning) {
  try {
    # -WindowStyle Hidden keeps the console away; a GUI app has no console of its
    # own anyway. Start-Process means the app belongs to Windows, not to this
    # script, so hiding the launcher cannot close it.
    $proc = Start-Process -FilePath $exe -ArgumentList $exeArgs -WorkingDirectory $root -WindowStyle Hidden -PassThru
  } catch {
    Show-AirChatNotice(
      "AirChat could not start.`r`n`r`n$($_.Exception.Message)`r`n`r`n" +
      'Run "Start AirChat.bat" to see it start in a window instead.'
    )
    exit 1
  }

  # Wait for it to answer, so the icon can show the real address and so "it
  # started" is something this script knows rather than assumes.
  $deadline = (Get-Date).AddSeconds(45)
  while ((Get-Date) -lt $deadline) {
    # Re-read every time: the app may have had to move off the configured port
    # while this loop was waiting, and only it knows where it ended up.
    Update-AirChatPort
    if (Test-AirChatRunning) { break }
    Start-Sleep -Milliseconds 500
  }

  if (-not (Test-AirChatRunning)) {
    $detail = ''

    if (Test-Path -LiteralPath $appLog) {
      $detail = (Get-Content -LiteralPath $appLog -Tail 12 | Out-String).Trim()
    }

    if (-not $detail) { $detail = 'It wrote nothing to its log before stopping.' }
    if ($detail.Length -gt 900) { $detail = $detail.Substring($detail.Length - 900) }

    Show-AirChatNotice(
      "AirChat started but did not answer.`r`n`r`n$detail`r`n`r`n" +
      'Run "Start AirChat.bat" to watch it start in a window.'
    )

    if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F | Out-Null }
    exit 1
  }
}

# The address friends use, for the tooltip. Cosmetic: read from the file the
# tunnel writes, so it cannot be stale from a previous run.
function Get-AirChatLink {
  try {
    if (-not (Test-Path -LiteralPath $configPath)) { return '' }
    $cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    return [string]$cfg.publicUrl
  } catch {
    return ''
  }
}

function Get-AirChatIcon {
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    try {
      $client = New-Object System.Net.WebClient
      $bytes = $client.DownloadData("http://localhost:$port/icon-192.png")
      $stream = New-Object System.IO.MemoryStream(, $bytes)
      $bitmap = [System.Drawing.Bitmap]::FromStream($stream)
      return [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }

  return [System.Drawing.SystemIcons]::Application
}

try {
  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = Get-AirChatIcon

  $link = Get-AirChatLink
  $tip = if ($link) { "AirChat - $link" } else { 'AirChat is running' }
  $notify.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = $menu.Items.Add('Open AirChat')
  $logItem = $menu.Items.Add('Open the log')
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # The item says what it will actually do. When this script started AirChat it
  # can stop it; when AirChat was already open, it belongs to whoever opened it,
  # so the most this icon can do is get out of the way.
  $stopLabel = if ($proc) { 'Quit AirChat' } else { 'Hide this icon' }
  $stopItem = $menu.Items.Add($stopLabel)

  $notify.ContextMenuStrip = $menu

  # Starting the app again is how a window is requested: it already holds the
  # single-instance lock, and its second-instance handler shows the window. No
  # second server, no new port, no new folder.
  $showWindow = {
    try {
      if (Test-Path -LiteralPath $devExe -PathType Leaf) {
        Start-Process -FilePath $devExe -ArgumentList @("`"$root`"") | Out-Null
      } else {
        Start-Process -FilePath $exe | Out-Null
      }
    } catch {
      Show-AirChatNotice("AirChat could not open its window.`r`n`r`n$($_.Exception.Message)")
    }
  }

  $openItem.add_Click($showWindow)
  $notify.add_DoubleClick($showWindow)

  $logItem.add_Click({
    if (Test-Path -LiteralPath $appLog) { Start-Process notepad.exe $appLog }
    else { $notify.ShowBalloonTip(5000, 'AirChat', 'No log yet - nothing has been written.', 'Info') }
  })

  $script:stopping = $false
  $stopItem.add_Click({
    $script:stopping = $true
    [System.Windows.Forms.Application]::Exit()
  })

  $notify.Visible = $true
  $notify.ShowBalloonTip(
    6000,
    'AirChat is running',
    'Double-click the icon to open it. If you cannot see it, click the ^ arrow by the clock.',
    'Info'
  )

  # An icon that outlives its app is worse than no icon: it says AirChat is
  # running and opens nothing. So the icon leaves when the app does.
  $watchdog = New-Object System.Windows.Forms.Timer
  $watchdog.Interval = 2000
  $watchdog.add_Tick({
    $alive = if ($proc) { -not $proc.HasExited } else { Test-AirChatRunning }

    if ($alive) { return }

    $watchdog.Stop()

    if (-not $script:stopping) {
      Show-AirChatNotice(
        "AirChat stopped.`r`n`r`n" +
        "Run `"Start AirChat in Tray.bat`" to start it again, or`r`n" +
        "`"Start AirChat.bat`" to watch it start in a window.`r`n`r`n" +
        "The log is in the tray menu next time it is running."
      )
    }

    [System.Windows.Forms.Application]::Exit()
  })
  $watchdog.Start()

  [System.Windows.Forms.Application]::Run()

  $watchdog.Stop()
  $watchdog.Dispose()

  # Only the copy this script started is stopped. An AirChat that was already
  # open before the tray was asked for is somebody else's window to close.
  $notify.Visible = $false
  $notify.Dispose()

  if ($proc -and -not $proc.HasExited) {
    taskkill /PID $proc.Id /T /F | Out-Null
  }
} catch {
  if ($notify) { $notify.Visible = $false }

  if ($proc -and -not $proc.HasExited) {
    taskkill /PID $proc.Id /T /F | Out-Null
  }

  Show-AirChatNotice(
    "AirChat could not move to the notification area:`r`n`r`n" +
    "$($_.Exception.Message)`r`n`r`n" +
    "Run `"Start AirChat.bat`" instead, which keeps a window you can watch."
  )

  exit 1
}
