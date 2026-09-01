@echo off
rem start.bat - OpenClaude SessionStart hook wrapper.
rem Simple entry point that OpenClaude's command runner can execute on Windows.
rem Delegates to SessionStart.ps1 which ensures the Antigravity proxy is running.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SessionStart.ps1"
exit /b 0
