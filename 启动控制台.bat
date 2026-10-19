@echo off
REM ASCII-only on purpose: cmd.exe mis-decodes UTF-8 .bat files.
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 pause
