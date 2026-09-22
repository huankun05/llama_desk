@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "CARGO=%USERPROFILE%\.cargo\bin\cargo.exe"
if exist "%CARGO%" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未找到 cargo。请先安装 Rust 工具链（https://rustup.rs），
  echo         或把 cargo.exe 所在目录加入系统 PATH，再重新运行本脚本。
  pause
  exit /b 1
)

echo ============================================
echo  llama-desk  Release 构建
echo ============================================
echo.

cargo build --release --manifest-path "%~dp0src-tauri\Cargo.toml"
if errorlevel 1 (
  echo.
  echo [错误] 构建失败。
  pause
  exit /b 1
)

rem 把配置文件复制到 exe 旁边，双击即可运行
copy /y "%~dp0config.json" "%~dp0src-tauri\target\release\config.json" >nul

echo.
echo [完成] %~dp0src-tauri\target\release\llama-desk.exe
echo       双击该 exe 即可启动（无需本窗口）。
pause
