import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { getObjectStream, putObject } from '../../services/storage/s3.js';
import { FFMPEG_BIN, PUBLISHER_MEDIA_TEMP_DIR } from './constants.js';
import { buildVariantObjectKey } from './objectKeys.js';
import { probeS3Object } from './probe.js';

export const ELECIO_HORIZONTAL_PROFILE = 'elecio_horizontal_v1';
export const ELECIO_HORIZONTAL_LAYOUT_REVISION = 2;
export const ELECIO_HORIZONTAL_SPEC = Object.freeze({
  width: 1920,
  height: 1080,
  kind: 'technical_layout',
  layout_revision: ELECIO_HORIZONTAL_LAYOUT_REVISION,
});

export const ELECIO_HORIZONTAL_VIDEO_SLOT = Object.freeze({
  x: 1170,
  y: 60,
  width: 540,
  height: 960,
  radius: 75,
});

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ELECIO_HORIZONTAL_BACKGROUND_PATH = path.resolve(CURRENT_DIR, 'layouts/elecio_horizontal_v1/background.png');
export const ELECIO_HORIZONTAL_MASK_PATH = path.resolve(CURRENT_DIR, 'layouts/elecio_horizontal_v1/mask.png');
export const ELECIO_HORIZONTAL_BACKGROUND_SHA256 = 'a6aca169e9f3fb9fd7bf64cf84af759e4d8c93478d3682737f17c98a7a675e4a';

export function layoutProvenance(sourceAssetId) {
  return {
    variant_kind: ELECIO_HORIZONTAL_SPEC.kind,
    profile: ELECIO_HORIZONTAL_PROFILE,
    layout_revision: ELECIO_HORIZONTAL_LAYOUT_REVISION,
    background_sha256: ELECIO_HORIZONTAL_BACKGROUND_SHA256,
    source_asset_id: sourceAssetId,
    output_width: ELECIO_HORIZONTAL_SPEC.width,
    output_height: ELECIO_HORIZONTAL_SPEC.height,
    video_slot: ELECIO_HORIZONTAL_VIDEO_SLOT,
  };
}

/**
 * Pure FFmpeg filter:
 * Scale source to fit 540x960, pad/center if not exactly 9:16 with neutral dark background,
 * apply rounded-corner mask (radius 75), then overlay onto static background at x=1170, y=60.
 */
export function buildElecioHorizontalFilter() {
  return '[1:v]scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(540-iw)/2:(960-ih)/2:color=0x101820,format=rgba[v];[v][2:v]alphamerge[masked_v];[0:v][masked_v]overlay=1170:60:shortest=1,format=yuv420p[outv]';
}

export async function renderElecioHorizontalLocal(inputPath, outputPath, {
  ffmpegBin = FFMPEG_BIN,
  backgroundPath = ELECIO_HORIZONTAL_BACKGROUND_PATH,
  maskPath = ELECIO_HORIZONTAL_MASK_PATH,
} = {}) {
  await new Promise((resolve, reject) => execFile(ffmpegBin, [
    '-y',
    '-loop', '1', '-i', backgroundPath,
    '-i', inputPath,
    '-loop', '1', '-i', maskPath,
    '-filter_complex', buildElecioHorizontalFilter(),
    '-map', '[outv]',
    '-map', '1:a?',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-shortest',
    outputPath,
  ], { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }, (err) => (err ? reject(err) : resolve())));
}

/**
 * Worker-only renderer. Provenance deliberately lives in probe_json so no new
 * schema field is needed; Asset.parent_asset_id and kind=variant carry lineage.
 */
export async function renderElecioHorizontalVariant({ sourceAsset, variantAsset, organizationId }) {
  const tempDir = PUBLISHER_MEDIA_TEMP_DIR;
  await fs.mkdir(tempDir, { recursive: true });
  const token = crypto.randomUUID();
  const input = path.join(tempDir, `layout-in-${token}.mp4`);
  const output = path.join(tempDir, `layout-out-${token}.mp4`);
  try {
    await pipeline(await getObjectStream(sourceAsset.object_key), (await import('fs')).createWriteStream(input));
    await renderElecioHorizontalLocal(input, output);
    await putObject(variantAsset.object_key, (await import('fs')).createReadStream(output), 'video/mp4');
    return await probeS3Object(variantAsset.object_key, 'variant');
  } finally {
    await Promise.all([fs.rm(input, { force: true }), fs.rm(output, { force: true })]);
  }
}

export function newElecioHorizontalObjectKey(sourceAsset) {
  return buildVariantObjectKey(sourceAsset.organization_id, sourceAsset.campaign_id, crypto.randomUUID(), ELECIO_HORIZONTAL_PROFILE, 'mp4');
}
