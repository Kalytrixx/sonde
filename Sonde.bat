@echo off
rem Lance Sonde et ouvre l'interface dans le navigateur.
title Sonde
cd /d "%~dp0"

where node >nul 2>nul || (
  echo Node.js est introuvable. Installe-le depuis https://nodejs.org puis relance.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installation des dependances...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)

rem Ollama doit tourner pour que GPT-OSS reponde.
curl -s http://127.0.0.1:11434/api/tags >nul 2>nul || (
  echo Demarrage d'Ollama...
  start "" /min ollama serve
)

echo Sonde demarre sur http://127.0.0.1:4777  (ferme cette fenetre pour l'arreter)
node server.js --open
pause
