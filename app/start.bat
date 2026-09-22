@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 直接跑已经编译好的 exe（最快，不需要 cargo）。
rem 改了 Rust 代码后再用 run.bat（它会重新编译）。
set "EXE=%~dp0src-tauri\target\debug\llama-desk.exe"

if not exist "%EXE%" (
  echo [提示] 还没编译过，请先双击 run.bat。
  pause
  exit /b 1
)

start "" "%EXE%"
