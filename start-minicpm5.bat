@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  MiniCPM5-2B (Q4_K_M) —— 日常档：32K 上下文 / 4 并发 / f16 KV
rem  启动后浏览器打开 http://127.0.0.1:8080 使用内置 WebUI
rem ============================================================

rem ---- 模型 ----
set "MODEL=D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf"
set "ALIAS=minicpm5-2b"

rem ---- 上下文与显存 ----
set "CTX=32768"        rem 上下文长度：8192(轻) / 32768(推荐) / 65536 / 131072(见长文档档)
set "KV=f16"           rem KV 缓存精度：f16(质量最好) / q8_0(省一半显存)
set "SLOTS=4"          rem 并发会话槽位数

rem ---- GPU / CPU ----
set "NGL=99"           rem 卸载到显存的层数，99 = 全部（本模型 42 层）
set "THREADS=8"        rem CPU 线程数（i7-13700HX 8P 核）

rem ---- 采样（推理类模型推荐偏保守）----
set "TEMP=0.6"
set "TOPP=0.90"
set "MINP=0.05"
set "REPPEN=1.05"

rem ---- 思考模式（本模型是推理模型，会先输出 <think> 再作答）----
rem   --no-reasoning-preserve : 不把历史思考链塞回上下文（默认开启 preserve，多轮会快速吃满上下文）
rem   想限制思考长度        : 追加 --reasoning-budget 1024
rem   想完全关闭思考        : 追加 --reasoning off
set "REASONING=--no-reasoning-preserve"

rem ---- 投机解码（可选提速）----
rem   1 = 用 MiniCPM5-1B 当草稿模型，实测 115 -> 124 t/s（约 +8%），代价是多占约 0.7GB 显存
rem   0 = 关闭（跑长上下文、显存紧张时关掉）
set "SPEC_ON=1"
set "SPEC="
if "%SPEC_ON%"=="1" set "SPEC=-md D:\llama\models\MiniCPM5-1B-Q4_K_M.gguf -ngld 99 --spec-draft-n-max 8"

rem ---- 网络 ----
set "HOST=127.0.0.1"   rem 想让局域网/手机访问就改成 0.0.0.0
set "PORT=8080"

rem ---- 静态 WebUI 目录 ----
rem   --path 指定网页文件目录。我们的汉化改版 UI 构建产物在 D:\llama\webui
rem   想退回 llama.cpp 自带的官方 WebUI：把下面两行连同命令里的 --path "%WEBUI%" 一起删掉
set "WEBUI=D:\llama\webui"

echo.
echo   模型     : %MODEL%
echo   上下文   : %CTX% tokens   KV 精度: %KV%   并发槽: %SLOTS%
echo   采样     : temp=%TEMP%  top_p=%TOPP%  min_p=%MINP%  repeat=%REPPEN%
echo   WebUI    : http://%HOST%:%PORT%/   (静态目录 %WEBUI%)
echo   API      : http://%HOST%:%PORT%/v1/chat/completions
echo.

"D:\llama\bin\llama-server.exe" ^
  -m "%MODEL%" -a "%ALIAS%" ^
  -c %CTX% -ctk %KV% -ctv %KV% -np %SLOTS% -kvu ^
  -ngl %NGL% -fa on -t %THREADS% -b 2048 -ub 512 ^
  --temp %TEMP% --top-p %TOPP% --min-p %MINP% --repeat-penalty %REPPEN% ^
  -n 2048 %REASONING% %SPEC% ^
  --host %HOST% --port %PORT% --path "%WEBUI%"

endlocal
