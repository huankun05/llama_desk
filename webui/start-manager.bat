@echo off
rem llama.cpp 服务管理器（Ollama 式：列模型 / 启停 / 切换）
rem 启动后访问 http://127.0.0.1:8090/ 即为控制台（含服务管理）
rem 纯标准库，需本机有 python（3.8+ 均可）
cd /d D:/llama/webui
python manager.py
