@echo off
rem 重启 DeepSeek Harness，让 dsh-mini-window 的 Host 半边与 bundle patch 生效。
rem 用法：把本文件里的 HARNESS_EXE 改成你的安装路径，或保留自动探测。
setlocal

set "HARNESS_EXE=%DSH_HARNESS_EXE%"
if not defined HARNESS_EXE set "HARNESS_EXE=D:\dsh\DeepSeek Harness.exe"
if not exist "%HARNESS_EXE%" (
  echo [x] 找不到 Harness 可执行文件：%HARNESS_EXE%
  echo     请设置环境变量 DSH_HARNESS_EXE 指向 "DeepSeek Harness.exe"。
  pause
  exit /b 1
)

echo [*] 正在关闭 Harness...
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>nul
timeout /t 3 /nobreak >nul

echo [*] 正在启动：%HARNESS_EXE%
start "" "%HARNESS_EXE%"
echo [ok] 完成。重启后右下角会出现蓝色悬浮球；点它即可把小窗置顶常驻。
endlocal