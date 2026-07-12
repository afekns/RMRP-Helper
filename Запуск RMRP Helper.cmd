@echo off
chcp 65001 >nul 2>&1
title RMRP Helper
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [ОШИБКА] Node.js не установлен.
  echo  Скачайте с https://nodejs.org
  echo.
  pause
  exit /b 1
)

node scripts\launcher.mjs
if errorlevel 1 pause
exit /b 0