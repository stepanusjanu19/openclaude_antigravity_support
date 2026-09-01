# start-proxy-service.ps1
# Logon launcher (invoked via Startup folder shortcut).
# Keeps the Antigravity proxy alive; prefers the compiled exe, falls back to bun.

$ProjectRoot  = "C:\file_my\code\plugins\openclaude-antigravity\openclaude-antigravity-provider"
$ServerScript = Join-Path $ProjectRoot "src\server.ts"
$ServerExe    = Join-Path $ProjectRoot "bin\antigravity-proxy.exe"
$HealthUrl    = "http://127.0.0.1:51122/health"
$PidFile      = "$env:USERPROFILE\.openclaude\antigravity-proxy.pid"

# Skip if already running
try {
    $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 2 -ErrorAction Stop
    if ($r.status -eq "ok") { exit 0 }
} catch {}

# Resolve launcher (exe first, bun fallback)
$cmdLine = $null
if (Test-Path -LiteralPath $ServerExe) {
    $cmdLine = "`"$ServerExe`""
} else {
    $bunExe = $null
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd) {
        $bunExe = $bunCmd.Source
    } else {
        $fallback = Join-Path $env:LOCALAPPDATA "Kiro-Cli\bun.exe"
        if (Test-Path -LiteralPath $fallback) { $bunExe = $fallback }
    }
    if ($bunExe -and (Test-Path -LiteralPath $ServerScript)) {
        $cmdLine = "`"$bunExe`" run `"$ServerScript`""
    }
}
if (-not $cmdLine) { exit 0 }

# Spawn via WMI — fully detached
$result = Invoke-WmiMethod -Class Win32_Process -Name Create `
               -ArgumentList $cmdLine, $ProjectRoot
$result.ProcessId | Out-File -FilePath $PidFile -Encoding utf8 -Force
