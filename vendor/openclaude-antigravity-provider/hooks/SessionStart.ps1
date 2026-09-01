# SessionStart.ps1
# OpenClaude hook: ensures the Antigravity proxy is running BEFORE OpenClaude
# sends its first request, and ensures OpenClaude's provider config points at
# the proxy (idempotent — injects only on fresh setups).
#
# Prefers the compiled exe (no bun dependency, fast start); falls back to
# `bun run src/server.ts` if the exe is missing.
#
# Path resolution is fully relative to this script, so the hook works from:
#   - the npm-installed package (node_modules/@xkei/openclaude/vendor/...)
#   - OpenClaude's versioned plugin cache (~/.openclaude/plugins/cache/...)
#   - any source checkout
# Compatible with PowerShell 5.1+

$ProxyPort        = 51122
$HealthUrl        = "http://127.0.0.1:$ProxyPort/health"
$ProjectRoot      = Split-Path -Parent $PSScriptRoot
$ServerScript     = Join-Path $ProjectRoot "src\server.ts"
$ServerExe        = Join-Path $ProjectRoot "bin\antigravity-proxy.exe"
$PidFile          = Join-Path $env:USERPROFILE ".openclaude\antigravity-proxy.pid"

# ── 1. Is the proxy already healthy? ─────────────────────────────────────────
$healthy = $false
try {
    $r = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1 -ErrorAction Stop
    if ($r.status -eq "ok") { $healthy = $true }
} catch {}

# ── 2. Not healthy → resolve launcher and spawn ──────────────────────────────
if (-not $healthy) {
    $cmdLine = $null
    if (Test-Path -LiteralPath $ServerExe) {
        $cmdLine = "`"$ServerExe`""
    } else {
        # Fallback: run from source via bun (absolute path incl. Kiro-CLI fallback)
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
    if (-not $cmdLine) {
        Write-Warning "[antigravity-provider] No launcher found. Build with: bun run build"
    } else {
        # Spawn proxy via WMI (fully detached)
        $result = Invoke-WmiMethod -Class Win32_Process -Name Create `
                      -ArgumentList $cmdLine, $ProjectRoot
        if ($result.ReturnValue -ne 0) {
            Write-Warning "[antigravity-provider] Failed to spawn proxy (WMI code $($result.ReturnValue))"
        } else {
            $result.ProcessId | Out-File -FilePath $PidFile -Encoding utf8 -Force

            # Wait until healthy so the port is OPEN before OpenClaude proceeds.
            # Blocks briefly to prevent the ECONNREFUSED race; exits as soon as
            # healthy (typically < 2s).
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 400
                try {
                    $check = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1 -ErrorAction Stop
                    if ($check.status -eq "ok") { $healthy = $true; break }
                } catch {}
            }
        }
    }
}

if ($healthy) {
    Write-Host "[antigravity-provider] Proxy ready -> http://127.0.0.1:$ProxyPort/v1"
} else {
    Write-Warning "[antigravity-provider] Proxy not healthy yet (slow AV scan?). It may come up shortly."
}

# ── 3. Ensure OpenClaude's provider config points at the proxy ───────────────
# Idempotent no-op when already configured; injects on fresh setups so /model
# auto-discovers the Antigravity/Gemini models via the /v1/models endpoint.
$Injector = Join-Path $ProjectRoot "hooks\inject-provider.js"
if (Test-Path -LiteralPath $Injector) {
    $jsExe = $null
    $bunCmd2 = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunCmd2) {
        $jsExe = $bunCmd2.Source
    } else {
        $k = Join-Path $env:LOCALAPPDATA "Kiro-Cli\bun.exe"
        if (Test-Path -LiteralPath $k) { $jsExe = $k }
        else {
            $n = Get-Command node -ErrorAction SilentlyContinue
            if ($n) { $jsExe = $n.Source }
        }
    }
    if ($jsExe) {
        try {
            $injectOut = & $jsExe $Injector 2>&1
            if ($injectOut) { Write-Host "$injectOut" }
        } catch {}
    }
}

# ── 4. Pre-warm /v1/models so model discovery is instant ─────────────────────
if ($healthy) {
    try {
        $null = Invoke-RestMethod -Uri "http://127.0.0.1:$ProxyPort/v1/models" -TimeoutSec 3 -ErrorAction Stop
    } catch {}
}

exit 0
