import { defineConfig } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  entry: [
    'src/server.js',
    'src/scripts/publisher-telegram-bot.js',
    'src/scripts/publisher-outbox.js',
    'src/scripts/publisher-scheduler.js',
    'src/scripts/publisher-media-worker.js',
    'src/scripts/publisher-cleanup-worker.js',
    'src/scripts/publisher-youtube-worker.js',
    'src/scripts/publisher-linkedin-worker.js',
    'src/scripts/publisher-telegram-worker.js',
    'src/scripts/publisher-aparat-worker.js',
  ],
  format: ['esm'],
  clean: true,
  minify: true,
  onSuccess: async () => {
    const srcDir = path.resolve('src/publisher/media/layouts');
    const destDir = path.resolve('dist/layouts');
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, destDir, { recursive: true });
    }
  },
});
