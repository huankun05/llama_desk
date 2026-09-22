@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  MiniCPM5-2B (Q4_K_M) —— 长文档档：128K 上下文 / 单会话 / q8_0 KV
rem  模型原生上下文就是 131072，这个档位用于长文档、整仓库代码分析。
rem  128K + f16 KV 约需 5.5GB 显存，8GB 卡容易 OOM，故用 q8_0（约 2.8GB）。
rem ============================================================

set "MODEL=D:\llama\models\MiniCPM5-2B-Q4_K_M.gguf"
set "ALIAS=minicpm5-2b-128k"

rem ---- 上下文与显存 ----
set "CTX=131072"
set "KV=q8_0"          rem 长上下文必须量化 KV，否则 8GB 显存放不下
set "SLOTS=1"          rem 单槽：KV 池全给一个会话

set "NGL=99"
set "THREADS=8"

set "TEMP=0.6"
set "TOPP=0.90"
set "MINP=0.05"
set "REPPEN=1.05"

rem 长上下文下思考链更占地方，默认不保留历史思考链
set "REASONING=--no-reasoning-preserve"

rem ---- 注意：本档不要开投机解码 ----
rem   实测 128K + 1B 草稿：120K prompt 的 prefill 从 2821 t/s 掉到 1130 t/s（耗时 43s -> 107s，慢 2.5 倍），
rem   而投机只带来 8% 的生成提速，长文本场景完全不划算。需要开就自己加 -md ... -ngld 99。

set "HOST=127.0.0.1"
set "PORT=8082"

rem ---- 静态 WebUI 目录（汉化改版 UI 的构建产物）----
set "WEBUI=D:\llama\webui"

echo.
echo   模型     : %MODEL%
echo   上下文   : %CTX% tokens (原生上限)   KV: %KV%   并发槽: %SLOTS%
echo   WebUI    : http://%HOST%:%PORT%/
echo   提示     : 长上下文首次 prompt 处理较慢（128K 全量预填充约需数十秒），属正常
echo.

"D:\llama\bin\llama-server.exe" ^
  -m "%MODEL%" -a "%ALIAS%" ^
  -c %CTX% -ctk %KV% -ctv %KV% -np %SLOTS% -kvu ^
  -ngl %NGL% -fa on -t %THREADS% -b 1024 -ub 256 ^
  --temp %TEMP% --top-p %TOPP% --min-p %MINP% --repeat-penalty %REPPEN% ^
  -n 4096 %REASONING% ^
  --host %HOST% --port %PORT% --path "%WEBUI%"

endlocal
