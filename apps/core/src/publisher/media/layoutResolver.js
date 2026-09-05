import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Robustly resolves static layout assets (backgrounds, masks) across dev (tsx/src)
 * and production bundled builds (dist).
 *
 * @param {string} relativePath - Relative path inside the layouts folder, e.g. 'elecio_horizontal_v1/background.png'
 * @returns {string} Absolute path to the existing asset file
 */
export function resolveLayoutAssetPath(relativePath) {
  const cleanRelative = relativePath.replace(/^[/\\]+/, '');

  const candidates = [
    // 1. Direct dist/layouts or src/publisher/media/layouts relative to this file
    path.resolve(MODULE_DIR, 'layouts', cleanRelative),
    // 2. Relative from dist or dist/scripts to layouts
    path.resolve(MODULE_DIR, '../layouts', cleanRelative),
    // 3. Relative to src if executing from dist
    path.resolve(MODULE_DIR, '../src/publisher/media/layouts', cleanRelative),
    path.resolve(MODULE_DIR, '../../src/publisher/media/layouts', cleanRelative),
    path.resolve(MODULE_DIR, '../../../src/publisher/media/layouts', cleanRelative),
    // 4. Process working directory candidates
    path.resolve(process.cwd(), 'apps/core/dist/layouts', cleanRelative),
    path.resolve(process.cwd(), 'apps/core/src/publisher/media/layouts', cleanRelative),
    path.resolve(process.cwd(), 'dist/layouts', cleanRelative),
    path.resolve(process.cwd(), 'src/publisher/media/layouts', cleanRelative),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to primary candidate if none exist, so caller gets standard path
  return candidates[0];
}
