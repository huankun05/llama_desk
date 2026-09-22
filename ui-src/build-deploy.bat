@echo off
chcp 65001 >nul
setlocal
rem ============================================================
rem  WebUI 一键「构建 + 部署」
rem    1) 在 D:\llama\ui-src\work 里 npm run build
rem    2) 用 deploy.ps1 把 dist 发布到 D:\llama\webui
rem       （并自动更新 overlay.js、把 <script src="./overlay.js?v=N"> 重新挂回 index.html）
rem  改完 Svelte 源码后双击本文件即可。
rem ============================================================

rem 按需把 Node 加进 PATH（已全局安装可忽略）
if exist "E:\software\Nodejs\node.exe" set "PATH=E:\software\Nodejs;E:\software\Nodejs\node_global;%PATH%"

cd /d D:\llama\ui-src\work
if errorlevel 1 (
  echo [错误] 找不到 D:\llama\ui-src\work
  pause
  exit /b 1
)

echo ============================================
echo  [1/2] 构建 WebUI（首次/大改约 1-3 分钟）
echo ============================================
call npm run build
if errorlevel 1 goto :err

echo.
echo ============================================
echo  [2/2] 部署到 D:\llama\webui
echo ============================================
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\llama\ui-src\deploy.ps1"
if errorlevel 1 goto :err

echo.
echo ============================================
echo  完成。浏览器硬刷（Ctrl+F5）：
echo    http://127.0.0.1:8080/#/performance
echo    http://127.0.0.1:8080/#/parameters
echo ============================================
pause
exit /b 0

:err
echo.
echo [错误] 构建或部署失败，请把上面的输出发给助手。
pause
exit /b 1
