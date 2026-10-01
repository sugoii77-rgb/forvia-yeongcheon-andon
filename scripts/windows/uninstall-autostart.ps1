<#
.SYNOPSIS
  Removes the Digital ANDON scheduled task and stops the server.
#>
param([string]$TaskName = "Digital ANDON")
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Scheduled task '$TaskName' removed."
} else {
  Write-Host "Scheduled task '$TaskName' not found."
}
Push-Location $root
try { node scripts\stop.ts } finally { Pop-Location }
