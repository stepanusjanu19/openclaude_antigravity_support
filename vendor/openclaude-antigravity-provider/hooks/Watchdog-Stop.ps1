# Watchdog-Stop.ps1
# Detached shutdown watchdog for the Antigravity proxy.
# Spawned via WMI by SessionEnd.ps1 (fully detached — survives OpenClaude's
# shutdown even when the SessionEnd hook itself gets cancelled during teardown).
#
# Polls up to 20 times (3s apart, ~60s total) so that even a slow OpenClaude
# teardown is outlived. At each poll, if NO openclaude process is still alive,
# the proxy is stopped. If any openclaude session survives (interactive,
# background, or teardown in progress), the proxy stays.
#
# Identity-verified kill: only processes named "antigravity-proxy" or "bun"
# are ever stopped, so nothing else can be harmed.
# Compatible with PowerShell 5.1+

$ProxyPort   = 51122
$PidFile     = Join-Path $env:USERPROFILE ".openclaude\antigravity-proxy.pid"

function Get-ProxyPid {
    try {
        if (Test-Path -LiteralPath $PidFile) {
            return [int]((Get-Content $PidFile -Raw).Trim())
        }
    } catch {}
    return 0
}

function Stop-Proxy {
    $killed = $false
    $proxyPid = Get-ProxyPid
    if ($proxyPid -gt 0) {
        $p = Get-Process -Id $proxyPid -ErrorAction SilentlyContinue
        if ($p -and ($p.Name -eq "antigravity-proxy" -or $p.Name -eq "bun")) {
            Stop-Process -Id $proxyPid -Force -ErrorAction SilentlyContinue
            $killed = $true
        }
    }
    if (-not $killed) {
        try {
            $line = netstat -ano | Select-String ":$ProxyPort\s.*LISTENING" | Select-Object -First 1
            if ($line) {
                $ownerPid = [int](($line.ToString().Trim() -split "\s+")[-1])
                $p = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
                if ($p -and ($p.Name -eq "antigravity-proxy" -or $p.Name -eq "bun")) {
                    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
                    $killed = $true
                }
            }
        } catch {}
    }
    if ($killed -and (Test-Path -LiteralPath $PidFile)) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
    return $killed
}

for ($poll = 1; $poll -le 20; $poll++) {
    Start-Sleep -Seconds 3

    # Any live openclaude process? (node/bun with "openclaude" on its command
    # line — covers interactive, --resume, and --bg sessions. The proxy itself
    # is "antigravity-proxy.exe" or "bun ... server.ts" and never matches.)
    $alive = $false
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'bun.exe'" -ErrorAction Stop
        foreach ($proc in $procs) {
            if ($proc.CommandLine -and $proc.CommandLine -match "openclaude") {
                $alive = $true
                break
            }
        }
    } catch {
        # WMI query failed — fail-safe: do not kill
        $alive = $true
    }

    if (-not $alive) {
        $null = Stop-Proxy
        break
    }
}

exit 0
