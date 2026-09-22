@echo off
rem ============================================================
rem  restart-manager.bat
rem  Restart the llama-desk model manager (manager.py, :8090).
rem
rem  WHY THIS EXISTS:
rem    The Tauri shell only spawns manager.py during its boot
rem    sequence. There is no runtime watchdog and no tray item for
rem    it, so once manager.py is edited on disk, the ALREADY
rem    RUNNING python process keeps executing the OLD code until it
rem    is restarted. Symptom: the WebUI gets "HTTP 404" from new
rem    manager endpoints (e.g. /api/switch).
rem    Double-click this file after editing manager.py.
rem
rem  SAFETY: only processes whose image name starts with "python"
rem  are killed. Anything else holding :8090 is reported and left
rem  alone.
rem ============================================================
setlocal
set "PORT=8090"
set "MGRDIR=D:\llama\webui"

echo.
echo [restart-manager] port :%PORT% - stopping old manager ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue;" ^
  "if (-not $c) { Write-Host '  nothing is listening'" ^
  "} else { foreach ($procId in ($c.OwningProcess ^| Sort-Object -Unique)) {" ^
  "  $pr = Get-Process -Id $procId -ErrorAction SilentlyContinue; if (-not $pr) { continue };" ^
  "  if ($pr.ProcessName -match '^python') { Write-Host ('  killing ' + $pr.ProcessName + ' PID ' + $procId); Stop-Process -Id $procId -Force }" ^
  "  else { Write-Host ('  WARNING: :%PORT% held by ' + $pr.ProcessName + ' (PID ' + $procId + '), NOT python - left alone') } } }"

echo [restart-manager] waiting for the socket to be released ...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "for ($i=0; $i -lt 20; $i++) { if (-not (Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }"

echo [restart-manager] starting manager.py (this window now serves the console) ...
echo [restart-manager] console: http://127.0.0.1:%PORT%/
echo.
cd /d "%MGRDIR%"
python manager.py

echo.
echo [restart-manager] manager.py exited. Press any key to close.
pause >nul
