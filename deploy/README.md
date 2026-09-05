# ElecIO Social Publisher Production Deployment

This deployment scaffold targets one native Linux host. It does not use Docker and it does not perform Telegram Cloud Bot API cutover automatically.

## Architecture

System services:

- MySQL
- NATS with persistent JetStream storage
- MinIO or another private S3-compatible object store
- `telegram-bot-api` bound to `127.0.0.1:8081` with `--local`

PM2 namespace: `elecio-publisher`

PM2 processes:

- `elecio-api`
- `elecio-panel`
- `elecio-telegram-bot`
- `elecio-outbox`
- `elecio-retry`
- `elecio-media`
- `elecio-cleanup`
- `elecio-youtube`
- `elecio-linkedin`
- `elecio-telegram-publisher`
- `elecio-aparat`

Instagram and Bale are intentionally absent from the default production ecosystem.

## Layout

Suggested host layout:

```text
/srv/elecio/social-publisher/current
/srv/elecio/social-publisher/releases
/srv/elecio/social-publisher/shared
/etc/elecio/publisher.env
/etc/elecio/telegram-bot-api.env
/var/lib/elecio/telegram-bot-api
/var/lib/elecio/telegram-bot-api/files
/var/lib/elecio/telegram-bot-api/tmp
/var/lib/elecio/minio
/var/lib/elecio/nats
```

Keep `/etc/elecio/*.env` root-owned. Use `chmod 600 /etc/elecio/telegram-bot-api.env` because it contains `TELEGRAM_API_HASH`.

## Environment

Copy `deploy/env/publisher.env.example` to `/etc/elecio/publisher.env` and fill values on the server. Do not commit real values.

Application env includes `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_API_MODE=local`, `TELEGRAM_BOT_API_BASE_URL=http://127.0.0.1:8081`, and `TELEGRAM_LOCAL_FILES_DIR`.

Daemon env is separate: copy `deploy/env/telegram-bot-api.env.example` to `/etc/elecio/telegram-bot-api.env` and fill only `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

`INTEGRATION_CONFIG_ENCRYPTION_KEY` is a deployment invariant. If an existing database is moved to production, use the same key or encrypted YouTube, LinkedIn, Aparat, and Telegram connection state becomes unreadable.

## Telegram Bot API

Build the official native server with:

```bash
sudo TELEGRAM_BOT_API_REF=<reviewed-tag-or-commit> scripts/production/install-telegram-bot-api.sh
```

Install the unit:

```bash
sudo cp deploy/systemd/telegram-bot-api.service /etc/systemd/system/telegram-bot-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot-api
sudo systemctl status telegram-bot-api
```

The unit binds only to `127.0.0.1:8081`. Do not expose port `8081` publicly and do not proxy it through nginx.

## First Deployment

From the checked-out release:

```bash
export PUBLISHER_ENV_FILE=/etc/elecio/publisher.env
scripts/production/deploy.sh --dry-run
scripts/production/deploy.sh
```

The deploy script uses the pinned package manager (`pnpm@9.0.0`), installs with a frozen lockfile, runs `pnpm run build`, runs production migrations through the existing core migration script, starts the PM2 ecosystem, runs smoke checks, then saves PM2 state.

## PM2 Boot

After a successful deployment:

```bash
pm2 startup
```

Run the exact command printed by PM2 for the server's Node install, then:

```bash
pm2 save
```

Do not hard-code the generated startup command in this repository.

## Health And Operations

```bash
pnpm production:preflight
pnpm production:status
pnpm production:smoke
pnpm production:logs
```

Core health endpoint: `/api/v1/health`

Health distinguishes MySQL, NATS, S3, Telegram local API reachability, and bot authentication. YouTube, LinkedIn, and Aparat external provider availability are not basic liveness checks.

Configure PM2 log rotation on the host:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 14
pm2 save
```

## Reverse Proxy

Use `deploy/nginx/elecio-publisher.conf.example` as a starting point after choosing the real domain. Keep only the API and panel public. Do not expose MySQL, NATS, MinIO admin, or Telegram Local Bot API.

Production must use stable HTTPS because YouTube OAuth, LinkedIn OAuth, Aparat browser connection, and Telegram one-time browser links depend on `PUBLIC_BASE_URL`.

After choosing `PUBLIC_BASE_URL`, update external provider consoles manually:

- Google / YouTube authorized redirect URI
- LinkedIn authorized redirect URI

## Cutover

Telegram Cloud to Local cutover is prepared but never automatic:

```bash
node scripts/production/telegram-cutover-local.mjs
```

The script verifies local mode, checks local health, shows the 10 minute Cloud re-login warning, requires typed confirmation, calls Cloud `logOut` exactly once, then verifies Local `getMe` matches the previously observed bot identity.

Do not run this until the server-local `telegram-bot-api` daemon is healthy and the operator explicitly approves moving the real bot.

## Rollback

Keep prior releases under `/srv/elecio/social-publisher/releases`. To roll back application code, repoint `current` to the prior release, source the same `/etc/elecio/publisher.env`, run `pnpm install --frozen-lockfile`, run `pnpm run build` if needed, and restart:

```bash
pm2 startOrRestart ecosystem.config.cjs --env production --update-env
pm2 save
```

Do not automatically roll back Telegram to Cloud after `logOut`; Cloud login is blocked for about 10 minutes.

## Secret Rotation

Rotate provider credentials through the application flow where possible. Rotate `INTEGRATION_CONFIG_ENCRYPTION_KEY` only with a planned decrypt/re-encrypt migration; replacing it alone breaks existing encrypted records.
