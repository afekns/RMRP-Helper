# Создаёт ярлык RMRP Helper на рабочем столе (Windows)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$client = Join-Path $root 'client-updated'
$vbs = Join-Path $client 'RMRP Helper.vbs'
$icon = Join-Path $client 'build\icons\icon.ico'
if (-not (Test-Path $icon)) { $icon = Join-Path $client 'app-icon.png' }

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'RMRP Helper.lnk'

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "`"$vbs`""
$sc.WorkingDirectory = $client
$sc.WindowStyle = 7
$sc.Description = 'RMRP Helper'
if (Test-Path $icon) { $sc.IconLocation = "$icon,0" }
$sc.Save()

Write-Host "Ярлык создан: $lnk"