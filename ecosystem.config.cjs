const coreCwd = './apps/core';
const panelCwd = './apps/panel';

const common = {
  namespace: 'elecio-publisher',
  instances: 1,
  exec_mode: 'fork',
  autorestart: true,
  watch: false,
  time: true,
  min_uptime: '10s',
  max_restarts: 8,
  restart_delay: 5000,
  kill_timeout: 15000,
  env_production: {
    NODE_ENV: 'production',
  },
};

function coreNodeApp(name, script, overrides = {}) {
  return {
    ...common,
    name,
    cwd: coreCwd,
    script,
    interpreter: 'node',
    ...overrides,
    env_production: {
      ...common.env_production,
      ...(overrides.env_production || {}),
    },
  };
}

module.exports = {
  apps: [
    coreNodeApp('elecio-api', 'dist/server.js', {
      max_memory_restart: '512M',
      kill_timeout: 20000,
      env_production: {
        WORKER_COUNT: process.env.WORKER_COUNT || '1',
        PORT: '4100',
      },
    }),
    {
      ...common,
      name: 'elecio-panel',
      cwd: panelCwd,
      script: 'pnpm',
      args: 'start -p 3100',
      max_memory_restart: '512M',
      kill_timeout: 20000,
      env_production: {
        ...common.env_production,
        PORT: '3100',
      },
    },
    coreNodeApp('elecio-telegram-bot', 'dist/scripts/publisher-telegram-bot.js', {
      max_memory_restart: '256M',
    }),
    coreNodeApp('elecio-outbox', 'dist/scripts/publisher-outbox.js', {
      max_memory_restart: '256M',
    }),
    coreNodeApp('elecio-retry', 'dist/scripts/publisher-scheduler.js', {
      max_memory_restart: '192M',
      restart_delay: 10000,
    }),
    coreNodeApp('elecio-media', 'dist/scripts/publisher-media-worker.js', {
      max_memory_restart: '768M',
      kill_timeout: 60000,
      max_restarts: 5,
    }),
    coreNodeApp('elecio-cleanup', 'dist/scripts/publisher-cleanup-worker.js', {
      max_memory_restart: '256M',
      restart_delay: 10000,
    }),
    coreNodeApp('elecio-youtube', 'dist/scripts/publisher-youtube-worker.js', {
      max_memory_restart: '512M',
      kill_timeout: 60000,
      max_restarts: 5,
    }),
    coreNodeApp('elecio-linkedin', 'dist/scripts/publisher-linkedin-worker.js', {
      max_memory_restart: '384M',
      kill_timeout: 45000,
      max_restarts: 5,
    }),
    coreNodeApp('elecio-telegram-publisher', 'dist/scripts/publisher-telegram-worker.js', {
      max_memory_restart: '384M',
      kill_timeout: 45000,
      max_restarts: 5,
    }),
    coreNodeApp('elecio-aparat', 'dist/scripts/publisher-aparat-worker.js', {
      max_memory_restart: '512M',
      kill_timeout: 60000,
      max_restarts: 5,
    }),
  ],
};

