@echo off
cd /d "%~dp0"
start "" http://127.0.0.1:8877/
"C:\Users\dell\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" -m http.server 8877 --bind 127.0.0.1
pause
