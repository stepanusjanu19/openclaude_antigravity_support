@echo off
rem session-end.bat - OpenClaude SessionEnd hook wrapper.
rem Spawns the detached Watchdog-Stop.ps1 which stops the Antigravity proxy
rem once no openclaude process remains alive.
rem
rem IMPORTANT: OpenClaude aborts SessionEnd hooks after ~1.5s
rem (SESSION_END_HOOK_TIMEOUT_MS_DEFAULT). This wrapper therefore spawns the
rem watchdog as FAST as possible: wmic first (no PowerShell cold-start,
rem ~0.4s), PowerShell+WMI as fallback when wmic is unavailable.
rem The watchdog itself is created by the WMI service, fully detached from
rem this process tree, so it survives this hook being cancelled.

set "WATCHDOG=%~dp0Watchdog-Stop.ps1"

where wmic >nul 2>&1
if %errorlevel%==0 (
    wmic process call create "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File %WATCHDOG%" >nul 2>&1
    exit /b 0
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $null = Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList ('powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + [char]34 + '%WATCHDOG%' + [char]34) } catch {}"
exit /b 0
