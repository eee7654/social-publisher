import os from 'os';

export const MAX_MEDIA_BYTES = parseInt(process.env.MAX_MEDIA_BYTES || String(300 * 1024 * 1024), 10);
export const MAX_COVER_BYTES = parseInt(process.env.MAX_COVER_BYTES || String(10 * 1024 * 1024), 10);

export const ASSET_STATUS = Object.freeze({
  UPLOADING: 'uploading',
  STORED: 'stored',
  PROBING: 'probing',
  READY: 'ready',
  FAILED: 'failed',
  DELETED: 'deleted',
  EXPIRED: 'expired',
});

export const ASSET_KIND = Object.freeze({
  MASTER: 'master',
  COVER: 'cover',
  VARIANT: 'variant',
});

export const COMPATIBILITY_STATUS = Object.freeze({
  COMPATIBLE: 'COMPATIBLE',
  NEEDS_TECHNICAL_NORMALIZATION: 'NEEDS_TECHNICAL_NORMALIZATION',
  NEEDS_CREATIVE_VARIANT: 'NEEDS_CREATIVE_VARIANT',
  INCOMPATIBLE: 'INCOMPATIBLE',
});

export const ALLOWED_COVER_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const FORBIDDEN_COVER_EXTENSIONS = Object.freeze([
  '.svg',
  '.html',
  '.htm',
  '.xml',
  '.php',
  '.js',
  '.sh',
]);

export const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
export const PUBLISHER_MEDIA_TEMP_DIR = process.env.PUBLISHER_MEDIA_TEMP_DIR || os.tmpdir();
export const FFPROBE_TIMEOUT_MS = parseInt(process.env.FFPROBE_TIMEOUT_MS || '15000', 10);
export const PROBE_LEASE_TIMEOUT_SECONDS = 60;
export const PUBLISHER_MEDIA_RETENTION_MS = parseInt(
  process.env.PUBLISHER_MEDIA_RETENTION_MS || String(24 * 60 * 60 * 1000),
  10,
);
