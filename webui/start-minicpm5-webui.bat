@echo off
rem 用改进版 WebUI 顶替官方页：在 8080 启动 MiniCPM5-2B，并用 --path 指向 D:/llama/webui
rem 打开 http://127.0.0.1:8080/ 即是新版控制台（中文 + 性能 + 参数）
"D:/llama/bin/llama-server.exe" -m "D:/llama/models/MiniCPM5-2B-Q4_K_M.gguf" -a minicpm5-2b -c 32768 -ctk f16 -ctv f16 -np 4 -kvu -ngl 99 -fa on -t 8 -b 2048 -ub 512 --temp 0.6 --top-p 0.9 --min-p 0.05 --repeat-penalty 1.05 -n 2048 --no-reasoning-preserve --host 127.0.0.1 --port 8080 --path "D:/llama/webui"
