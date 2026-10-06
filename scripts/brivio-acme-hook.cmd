@echo off
rem lego exec needs a directly executable program; this forwards to the .ps1.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0brivio-acme-hook.ps1" %*
exit /b %ERRORLEVEL%
