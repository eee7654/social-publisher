import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import getDb from '../../config/database.js';
import Asset from '../../db/models/core/Asset.js';
import { getObjectStream, putObject } from '../../services/storage/s3.js';
import { FFMPEG_BIN, PUBLISHER_MEDIA_TEMP_DIR, ASSET_KIND, ASSET_STATUS } from './constants.js';
import { buildVariantObjectKey } from './objectKeys.js';

export const YOUTUBE_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024; // 2 MB

// Platform-neutral 16:9 ElecIO landscape thumbnail profile
export const ELECIO_THUMBNAIL_16X9_PROFILE = 'elecio_thumbnail_16x9_v1';
export const YOUTUBE_THUMBNAIL_REGULAR_PROFILE = ELECIO_THUMBNAIL_16X9_PROFILE;
export const ELECIO_THUMBNAIL_16X9_SPEC = Object.freeze({
  width: 1280,
  height: 720,
  aspect_ratio: '16:9',
});
export const ELECIO_THUMBNAIL_16X9_SLOT = Object.freeze({
  x: 780,
  y: 40,
  width: 360,
  height: 640,
  radius: 48,
});

// Technical 9:16 Short thumbnail normalization profile
export const YOUTUBE_THUMBNAIL_SHORT_PROFILE = 'youtube_thumbnail_short_v1';
export const YOUTUBE_THUMBNAIL_SHORT_SPEC = Object.freeze({
  width: 1080,
  height: 1920,
  aspect_ratio: '9:16',
});

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ELECIO_THUMBNAIL_BACKGROUND_PATH = path.resolve(CURRENT_DIR, 'layouts/elecio_horizontal_v1/background_1280x720.png');
export const ELECIO_THUMBNAIL_MASK_PATH = path.resolve(CURRENT_DIR, 'layouts/elecio_horizontal_v1/mask_360x640.png');
export const ELECIO_THUMBNAIL_BACKGROUND_SHA256 = '908950faf5787b45936789f53bf10e81e343037a4514b794f99bf8f7361c70e1';

const db = getDb();

function provenanceOf(asset) {
  const value = typeof asset?.probe_json === 'string' ? JSON.parse(asset.probe_json || '{}') : (asset?.probe_json || {});
  return value?.variant_provenance || null;
}

export function isElecioThumbnail16x9Variant(asset) {
  const p = provenanceOf(asset);
  return (
    asset?.status === ASSET_STATUS.READY &&
    p?.variant_kind === 'elecio_thumbnail' &&
    p?.profile === ELECIO_THUMBNAIL_16X9_PROFILE &&
    p?.background_sha256 === ELECIO_THUMBNAIL_BACKGROUND_SHA256 &&
    p?.output_width === ELECIO_THUMBNAIL_16X9_SPEC.width &&
    p?.output_height === ELECIO_THUMBNAIL_16X9_SPEC.height &&
    Number(asset.size_bytes || 0) <= YOUTUBE_MAX_THUMBNAIL_BYTES
  );
}

export function isYouTubeThumbnailShortVariant(asset) {
  const p = provenanceOf(asset);
  return (
    asset?.status === ASSET_STATUS.READY &&
    p?.profile === YOUTUBE_THUMBNAIL_SHORT_PROFILE &&
    Number(asset.size_bytes || 0) <= YOUTUBE_MAX_THUMBNAIL_BYTES
  );
}

/**
 * Filter for 1280x720 ElecIO landscape thumbnail:
 * - Scale 9:16 cover proportionally into 360x640 with dark padding (no stretch, no crop).
 * - Apply 48px rounded-corner alpha mask.
 * - Overlay onto 1280x720 static background at x=780, y=40.
 */
export function buildElecioThumbnail16x9Filter() {
  const { x, y, width, height } = ELECIO_THUMBNAIL_16X9_SLOT;
  return `[1:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(${width}-iw)/2:(${height}-ih)/2:color=0x101820,format=rgba[img];[img][2:v]alphamerge[masked_img];[0:v][masked_img]overlay=${x}:${y}:shortest=1,format=yuv420p[outv]`;
}

/**
 * Filter for 9:16 Short thumbnail normalization:
 * - Scale proportionally into 1080x1920 with dark padding (no stretch, no crop).
 */
export function buildYouTubeThumbnailShortFilter() {
  const { width, height } = YOUTUBE_THUMBNAIL_SHORT_SPEC;
  return `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(${width}-iw)/2:(${height}-ih)/2:color=0x101820,format=yuv420p[outv]`;
}

/**
 * Renders thumbnail locally with progressive JPEG quality reduction if > 2 MB.
 */
export async function renderThumbnailWithQualitySteps({
  inputArgs,
  outputPath,
  ffmpegBin = FFMPEG_BIN,
  qualitySteps = ['2', '4', '6', '8'],
}) {
  for (const q of qualitySteps) {
    await new Promise((resolve, reject) => {
      execFile(ffmpegBin, [
        '-y',
        ...inputArgs,
        '-frames:v', '1',
        '-q:v', q,
        outputPath,
      ], { windowsHide: true, timeout: 60 * 1000 }, (err) => (err ? reject(err) : resolve()));
    });

    const stat = await fs.stat(outputPath);
    if (stat.size <= YOUTUBE_MAX_THUMBNAIL_BYTES) {
      return stat.size;
    }
  }

  throw new Error(`Thumbnail rendered exceeds maximum API limit of ${YOUTUBE_MAX_THUMBNAIL_BYTES} bytes after progressive compression`);
}

export async function renderElecioThumbnail16x9Local(inputPath, outputPath, { ffmpegBin = FFMPEG_BIN } = {}) {
  const filter = buildElecioThumbnail16x9Filter();
  return await renderThumbnailWithQualitySteps({
    inputArgs: [
      '-i', ELECIO_THUMBNAIL_BACKGROUND_PATH,
      '-i', inputPath,
      '-i', ELECIO_THUMBNAIL_MASK_PATH,
      '-filter_complex', filter,
      '-map', '[outv]',
    ],
    outputPath,
    ffmpegBin,
  });
}

export async function renderYouTubeThumbnailShortLocal(inputPath, outputPath, { ffmpegBin = FFMPEG_BIN } = {}) {
  const filter = buildYouTubeThumbnailShortFilter();
  return await renderThumbnailWithQualitySteps({
    inputArgs: [
      '-i', inputPath,
      '-filter_complex', filter,
      '-map', '[outv]',
    ],
    outputPath,
    ffmpegBin,
  });
}

export async function renderYouTubeThumbnailLocal(inputPath, outputPath, { profile = YOUTUBE_THUMBNAIL_SHORT_PROFILE, ffmpegBin = FFMPEG_BIN } = {}) {
  if (profile === ELECIO_THUMBNAIL_16X9_PROFILE || profile === YOUTUBE_THUMBNAIL_REGULAR_PROFILE) {
    return await renderElecioThumbnail16x9Local(inputPath, outputPath, { ffmpegBin });
  }
  return await renderYouTubeThumbnailShortLocal(inputPath, outputPath, { ffmpegBin });
}

/**
 * Target-aware cover resolver and thumbnail variant generator.
 * Supports caller's active database transaction `trx` to prevent deadlocks.
 */
export async function ensureYouTubeThumbnailVariant(coverAsset, { mode = 'SHORT', trx } = {}) {
  const queryTrx = trx || db;
  const isRegular = mode === 'REGULAR';
  const profile = isRegular ? ELECIO_THUMBNAIL_16X9_PROFILE : YOUTUBE_THUMBNAIL_SHORT_PROFILE;
  const spec = isRegular ? ELECIO_THUMBNAIL_16X9_SPEC : YOUTUBE_THUMBNAIL_SHORT_SPEC;

  // 1. Check for existing reusable READY variant
  const existing = await Asset.query(queryTrx)
    .where({
      organization_id: coverAsset.organization_id,
      parent_asset_id: coverAsset.id,
      kind: ASSET_KIND.VARIANT,
      status: ASSET_STATUS.READY,
    });

  const reusable = isRegular
    ? existing.find(isElecioThumbnail16x9Variant)
    : existing.find(isYouTubeThumbnailShortVariant);

  if (reusable) {
    return { asset: reusable, reused: true };
  }

  // 2. Render variant locally and upload to S3
  const tempDir = PUBLISHER_MEDIA_TEMP_DIR;
  await fs.mkdir(tempDir, { recursive: true });
  const token = crypto.randomUUID();
  const inputExt = coverAsset.mime_type === 'image/png' ? 'png' : 'jpg';
  const inputPath = path.join(tempDir, `thumb-in-${token}.${inputExt}`);
  const outputPath = path.join(tempDir, `thumb-out-${token}.jpg`);

  try {
    const stream = await getObjectStream(coverAsset.object_key);
    await pipeline(stream, (await import('fs')).createWriteStream(inputPath));

    const finalSizeBytes = isRegular
      ? await renderElecioThumbnail16x9Local(inputPath, outputPath)
      : await renderYouTubeThumbnailShortLocal(inputPath, outputPath);

    const objectKey = buildVariantObjectKey(
      coverAsset.organization_id,
      coverAsset.campaign_id,
      crypto.randomUUID(),
      profile,
      'jpg'
    );

    await putObject(objectKey, (await import('fs')).createReadStream(outputPath), 'image/jpeg');

    const provenance = isRegular
      ? {
          variant_kind: 'elecio_thumbnail',
          profile: ELECIO_THUMBNAIL_16X9_PROFILE,
          source_cover_asset_id: coverAsset.id,
          output_width: spec.width,
          output_height: spec.height,
          mime_type: 'image/jpeg',
          video_slot: ELECIO_THUMBNAIL_16X9_SLOT,
          background_sha256: ELECIO_THUMBNAIL_BACKGROUND_SHA256,
        }
      : {
          variant_kind: 'technical_thumbnail',
          profile: YOUTUBE_THUMBNAIL_SHORT_PROFILE,
          source_cover_asset_id: coverAsset.id,
          output_width: spec.width,
          output_height: spec.height,
          mime_type: 'image/jpeg',
        };

    const variantAsset = await Asset.query(queryTrx).insertAndFetch({
      organization_id: coverAsset.organization_id,
      campaign_id: coverAsset.campaign_id,
      parent_asset_id: coverAsset.id,
      kind: ASSET_KIND.VARIANT,
      status: ASSET_STATUS.READY,
      object_key: objectKey,
      original_filename: `${profile}.jpg`,
      mime_type: 'image/jpeg',
      size_bytes: finalSizeBytes,
      width: spec.width,
      height: spec.height,
      aspect_ratio: spec.aspect_ratio,
      probe_json: { variant_provenance: provenance },
    });

    return { asset: variantAsset, reused: false };
  } finally {
    await Promise.all([
      fs.rm(inputPath, { force: true }),
      fs.rm(outputPath, { force: true }),
    ]);
  }
}

export async function ensureElecioThumbnail16x9Variant(coverAsset, options = {}) {
  return ensureYouTubeThumbnailVariant(coverAsset, { ...options, mode: 'REGULAR' });
}
