#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${PUBLISHER_ENV_FILE:-/etc/elecio/publisher.env}"

run() {
  echo "+ $*"
  "$@"
}

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
else
  echo "Missing ${ENV_FILE}"
  exit 1
fi

cd "${REPO_ROOT}"

echo "Preflight environment"
run node scripts/production/validate-production-config.mjs
run node scripts/production/preflight.mjs

echo "Install dependencies with frozen lockfile"
run corepack enable
run corepack prepare pnpm@9.0.0 --activate
run pnpm install --frozen-lockfile

echo "Build"
run pnpm run build
test -f apps/core/dist/server.js
test -f apps/core/dist/scripts/publisher-telegram-bot.js

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "Dry run complete. Skipped migrations, PM2 mutation, pm2 save, and Telegram cutover."
  exit 0
fi

echo "Run production migrations"
run pnpm --filter @esima/core db:setup db:migrate

echo "Start or restart PM2 ecosystem"
pm2 startOrRestart ecosystem.config.cjs --env production --update-env
node scripts/production/smoke-test.mjs
pm2 save

echo "Deployment completed."
