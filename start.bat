@echo off
chcp 65001 >nul
title Mod Drop
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js не встановлено. Завантаж з https://nodejs.org & pause & exit /b)
if not exist node_modules\adm-zip (
  echo Встановлюю залежності, зачекай хвилинку...
  call npm install --no-audit --no-fund
)
node launcher.js
pause
