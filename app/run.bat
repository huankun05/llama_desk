@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 把 Rust 工具链加进 PATH（若你已全局安装可忽略）
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

echo ============================================
echo  llama-desk  开发模式启动 (cargo run)
echo  首次编译约 3-8 分钟，之后几秒
echo ============================================
echo.

cargo run --manifest-path "%~dp0src-tauri\Cargo.toml"
if errorlevel 1 (
  echo.
  echo [错误] 启动失败，请看上面的报错信息。
  pause
)
