# Put AirChat's launchers on the Desktop as shortcuts.
#
# Shortcuts are used rather than copies on purpose: every launcher starts with
# `cd /d "%~dp0"`, which means "run from the folder this file lives in". A copy
# on the Desktop would look for the server folder on the Desktop and fail, while
# a shortcut still points at the real AirChat folder.

$ErrorActionPreference = 'Stop'

# This script lives in <AirChat>\tools, so its parent is the AirChat folder.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')

$launchers = @(
  @{ Name = 'Start AirChat in Tray';          Target = 'Start AirChat in Tray.bat' },
  @{ Name = 'Start AirChat + Public Link';    Target = 'Start AirChat + Public Link.bat' },
  @{ Name = 'Start AirChat';                  Target = 'Start AirChat.bat' },
  @{ Name = 'Check AirChat';                  Target = 'Check AirChat.bat' },
  @{ Name = 'Install Cloudflared (one time)'; Target = 'Install Cloudflared (one time).bat' }
)

$shell = New-Object -ComObject WScript.Shell

Write-Host ''
Write-Host "  AirChat folder: $root"
Write-Host "  Desktop:        $desktop"
Write-Host ''

foreach ($item in $launchers) {
  $target = Join-Path $root $item.Target

  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "  ! skipped (not found): $($item.Target)"
    continue
  }

  $linkPath = Join-Path $desktop ($item.Name + '.lnk')
  $link = $shell.CreateShortcut($linkPath)
  $link.TargetPath = $target
  $link.WorkingDirectory = $root
  $link.Description = 'AirChat'
  $link.Save()

  Write-Host "  + $($item.Name).lnk"
}

Write-Host ''
Write-Host '  Done. Your Desktop now has the AirChat icons.'
