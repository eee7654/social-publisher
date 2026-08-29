import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.js'],
  format: ['esm'],
  clean: true,
  minify: true,
});