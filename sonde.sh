#!/bin/sh
# Lance Sonde depuis les sources (Linux) et ouvre l'interface dans le navigateur.
# Pour l'application de bureau, installe plutôt le paquet .deb.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js est introuvable. Installe-le : sudo apt install nodejs npm"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installation des dépendances..."
  npm install --no-fund --no-audit --omit=dev || exit 1
fi

# Ollama doit tourner pour que GPT-OSS réponde.
if command -v ollama >/dev/null 2>&1 && ! curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Démarrage d'Ollama..."
  (ollama serve >/dev/null 2>&1 &)
fi

echo "Sonde démarre sur http://127.0.0.1:4777 (Ctrl+C pour l'arrêter)"
exec node server.js --open
