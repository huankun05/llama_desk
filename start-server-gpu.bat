@echo off
chcp 65001 >nul
setlocal

rem 用法：把任意 .gguf 拖到本文件上启动；直接双击则用下面 DEFAULT 指定的模型。
set "DEFAULT=D:\llama\models\from-ollama\qwen3-4b-latest.gguf"
set "MODEL=%~1"
if "%MODEL%"=="" set "MODEL=%DEFAULT%"

rem 静态 WebUI 目录（汉化改版 UI）；删掉 --path 即用 llama.cpp 内置 WebUI
set "WEBUI=D:\llama\webui"

echo 模型: %MODEL%
echo 显存卸载: 全部层 (-ngl 99)
echo 服务地址: http://127.0.0.1:8080   (静态目录 %WEBUI%)
echo.

"D:\llama\bin\llama-server.exe" -m "%MODEL%" -c 8192 -ngl 99 --host 127.0.0.1 --port 8080 --path "%WEBUI%"

endlocal
