@echo off
rem ============================================================
rem  llama-desk startup diagnostic - double click to run
rem  Collects: white-screen timeline, UI language state (CDP +
rem            localStorage forensics), per-resource HTTP/timing
rem  Output:   D:\llama\diag\<timestamp>\
rem ============================================================
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diag.ps1"
echo.
echo ============================================================
echo   Done. Send the "report dir" path back to me.
echo ============================================================
pause
