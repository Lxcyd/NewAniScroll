#!/usr/bin/env bash
# Deploiement sur la VM : ./infra/vm/deploy.sh [branche]   (depuis la racine du depot)
# Le nouveau conteneur est construit pendant que l'ancien sert ; la bascule
# dure quelques secondes, couvertes par le cache nginx (proxy_cache_use_stale).
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${1:-main}"
git -C ../.. fetch -q origin "$BRANCH"
git -C ../.. checkout -q "$BRANCH"
git -C ../.. reset -q --hard "origin/$BRANCH"
docker compose build web
docker compose up -d
docker image prune -f >/dev/null
docker compose ps
