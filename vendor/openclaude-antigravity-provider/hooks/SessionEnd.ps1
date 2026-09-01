# SessionEnd.ps1
# OpenClaude SessionEnd hook: hands proxy shutdown to a DETACHED watchdog.
#
# Why a watchdog: OpenClaude cancels SessionEnd hooks ~2s into its shutdown
# teardown, so this script must do as little as possible. Its ONLY job is to
# spawn Watchdog-Stop.ps1 via WMI (fully detached — survives both this
# script's death AND OpenClaude's cancellation). The watchdog then polls and
# stops the proxy once no openclaude process remains alive (protecting
# interactive/background sessions and even its own slow teardown).
#
# Always exits 0. Compatible with PowerShell 5.1+

$Watchdog = Join-Path (Split-Path -Parent $PSScriptRoot) "hooks\Watchdog-Stop.ps1"

if (Test-Path -LiteralPath $Watchdog) {
    $psExe = (Get-Command powershell -ErrorAction SilentlyContinue).Source
    if (-not $psExe) { $psExe = "powershell" }
    $cmdLine = "`"$psExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`""
    $null = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList $cmdLine
}

exit 0
