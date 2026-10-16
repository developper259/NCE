$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot '..\release') -Filter '*.exe' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $installer) { throw 'No NSIS installer was produced in release/.' }

$installDirectory = Join-Path $env:RUNNER_TEMP 'NCE NSIS smoke - été'
$fileMenu = 'Registry::HKEY_CURRENT_USER\Software\Classes\*\shell\NCE.OpenWith'
$folderMenu = 'Registry::HKEY_CURRENT_USER\Software\Classes\Directory\shell\NCE.OpenWith'
$unrelatedMenu = 'Registry::HKEY_CURRENT_USER\Software\Classes\*\shell\NCE.UnrelatedSmokeEntry'
$menus = @($fileMenu, $folderMenu)

New-Item -LiteralPath $unrelatedMenu -Force | Out-Null

function Invoke-Installer([string] $path, [string[]] $arguments) {
  $process = Start-Process -FilePath $path -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer process failed with exit code $($process.ExitCode)." }
}

function Assert-MenuEntries {
  foreach ($menu in $menus) {
    if (-not (Test-Path -LiteralPath $menu)) { throw "Missing context menu key: $menu" }
    $label = (Get-Item -LiteralPath $menu).GetValue('')
    if ($label -ne 'Open with NCE') { throw "Unexpected menu label '$label' at $menu." }
    $commandKey = Join-Path $menu 'command'
    $command = (Get-Item -LiteralPath $commandKey).GetValue('')
    if ($command -notmatch '^".*NCE\.exe" "%1"$') { throw "Unexpected open command: $command" }
    if ($command -notmatch [regex]::Escape($installDirectory)) {
      throw "The open command does not point to the Unicode install path: $command"
    }
  }
}

Invoke-Installer $installer.FullName @('/S', "/D=$installDirectory")
Assert-MenuEntries

# Re-running the installer exercises the upgrade path and confirms each value is replaced cleanly.
Invoke-Installer $installer.FullName @('/S', "/D=$installDirectory")
Assert-MenuEntries

$uninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter '*Uninstall*.exe' |
  Select-Object -First 1
if (-not $uninstaller) { throw "No uninstaller found in $installDirectory." }
Invoke-Installer $uninstaller.FullName @('/S', "_?=$installDirectory")
foreach ($menu in $menus) {
  if (Test-Path -LiteralPath $menu) { throw "Uninstall left an NCE context menu key behind: $menu" }
}
if (-not (Test-Path -LiteralPath $unrelatedMenu)) {
  throw 'Uninstall removed an unrelated context menu entry.'
}
Remove-Item -LiteralPath $unrelatedMenu -Recurse -Force
