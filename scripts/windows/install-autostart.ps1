<#
.SYNOPSIS
  Registers the Digital ANDON supervisor as a Windows scheduled task so the server
  starts automatically and is restarted by Windows if the supervisor itself dies.

.PARAMETER AtStartup
  Start at computer boot, before anyone logs in, as SYSTEM. Recommended for the plant server.
  Requires an elevated (Administrator) PowerShell.
  Without this switch the task starts when the current user logs on (no admin needed).

.PARAMETER DryRun
  Show what would be registered without changing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -AtStartup
#>
param(
  [switch]$AtStartup,
  [switch]$DryRun,
  [string]$TaskName = "Digital ANDON"
)
$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path (Join-Path $root "scripts\supervisor.ts"))) { throw "supervisor.ts not found under $root" }

# Hidden PowerShell wrapper: no console window that someone could close by accident.
# The exit code of the supervisor is passed through so Windows can restart it on failure.
$command = "Set-Location -LiteralPath '$root'; & '$node' 'scripts\supervisor.ts'; exit `$LASTEXITCODE"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$command`"" `
  -WorkingDirectory $root

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $mode = "at computer startup (SYSTEM)"
} else {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $mode = "at log-on of $user"
}

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable

Write-Host "Task      : $TaskName"
Write-Host "Starts    : $mode"
Write-Host "Folder    : $root"
Write-Host "Node      : $node"
Write-Host "Command   : powershell.exe (hidden) -> node scripts\supervisor.ts"
Write-Host "On failure: restart every 1 minute"

if ($DryRun) { Write-Host "`nDry run - nothing registered."; return }

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Digital ANDON server supervisor ($root). Logs: $root\data\logs" -Force | Out-Null
Write-Host "`nRegistered. Start now with:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Check with:                 npm run status"
