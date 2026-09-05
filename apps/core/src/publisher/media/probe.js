import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { getObjectStream } from '../../services/storage/s3.js';
import {
  FFPROBE_BIN,
  FFPROBE_TIMEOUT_MS,
  PUBLISHER_MEDIA_TEMP_DIR,
  ASSET_KIND,
  ALLOWED_COVER_MIME_TYPES,
  FORBIDDEN_COVER_EXTENSIONS,
} from './constants.js';

/**
 * Parses rational FPS string (e.g. "30000/1001", "30/1", "25/1") to numeric float.
 */
export function parseFps(fpsStr) {
  if (!fpsStr || typeof fpsStr !== 'string') return null;
  if (!fpsStr.includes('/')) {
    const val = parseFloat(fpsStr);
    return isNaN(val) || val <= 0 ? null : Math.round(val * 100) / 100;
  }
  const [numStr, denStr] = fpsStr.split('/');
  const num = parseFloat(numStr);
  const den = parseFloat(denStr);
  if (isNaN(num) || isNaN(den) || den === 0 || num <= 0) return null;
  const fps = num / den;
  return Math.round(fps * 100) / 100;
}

/**
 * Computes aspect ratio string (e.g. "16:9", "9:16", "1:1", "4:5") from width and height.
 */
export function computeAspectRatio(width, height) {
  if (!width || !height || width <= 0 || height <= 0) return null;

  const ratio = width / height;

  // Check standard aspect ratios within a 2% tolerance
  const standardRatios = [
    { name: '16:9', val: 16 / 9 },
    { name: '9:16', val: 9 / 16 },
    { name: '1:1', val: 1 / 1 },
    { name: '4:5', val: 4 / 5 },
    { name: '4:3', val: 4 / 3 },
    { name: '3:4', val: 3 / 4 },
    { name: '21:9', val: 21 / 9 },
  ];

  for (const std of standardRatios) {
    if (Math.abs(ratio - std.val) / std.val < 0.02) {
      return std.name;
    }
  }

  // Greatest common divisor fallback
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(Math.round(width), Math.round(height));
  if (divisor > 0) {
    const w = Math.round(width / divisor);
    const h = Math.round(height / divisor);
    if (w < 100 && h < 100) {
      return `${w}:${h}`;
    }
  }

  return `${Math.round(ratio * 100) / 100}:1`;
}

/**
 * Runs ffprobe on a local file with timeout and bounded buffers.
 */
export async function runFfprobe(filePath, timeoutMs = FFPROBE_TIMEOUT_MS, signal = null) {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_error',
    filePath,
  ];

  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFile(
      FFPROBE_BIN,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10 MB max buffer
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) {
          if (err.killed || err.signal === 'SIGTERM' || err.signal === 'SIGKILL') {
            return reject(new Error(`FFPROBE_TIMEOUT: process timed out after ${timeoutMs}ms`));
          }
          if (err.code === 'ENOENT') {
            return reject(new Error('FFPROBE_EXECUTION_TRANSIENT: binary unavailable'));
          }
          // ffprobe exits non-zero for malformed/corrupt input. Keep that
          // distinct from a timeout or missing executable so the worker can
          // ACK an invalid Asset without retrying it forever.
          return reject(new Error(`FFPROBE_MEDIA_INVALID: ${stderr || err.message}`));
        }

        try {
          const parsed = JSON.parse(stdout);
          if (parsed.error) {
            return reject(new Error(`FFprobe reported media error: ${parsed.error.string || 'Unknown media error'}`));
          }
          resolve(parsed);
        } catch (parseErr) {
          reject(new Error(`Failed to parse ffprobe JSON output: ${parseErr.message}`));
        }
      }
    );
    if (signal) {
      const abort = () => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('FFprobe aborted because probe lease ownership was lost'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

/**
 * Normalizes raw ffprobe JSON output into clean, structured metadata.
 */
export function normalizeProbeMetadata(probeData, kind = ASSET_KIND.MASTER) {
  if (!probeData || typeof probeData !== 'object') {
    throw new Error('Invalid probe data: output is empty or not an object');
  }

  const format = probeData.format || {};
  const streams = Array.isArray(probeData.streams) ? probeData.streams : [];

  const videoStream = streams.find(s => s.codec_type === 'video');
  const audioStream = streams.find(s => s.codec_type === 'audio');

  const sizeBytes = format.size ? parseInt(format.size, 10) : null;
  const durationSec = format.duration
    ? parseFloat(format.duration)
    : (videoStream?.duration ? parseFloat(videoStream.duration) : null);
  const durationMs = durationSec && !isNaN(durationSec) ? Math.round(durationSec * 1000) : null;

  let width = videoStream?.width ? parseInt(videoStream.width, 10) : null;
  let height = videoStream?.height ? parseInt(videoStream.height, 10) : null;

  // Handle rotation / display matrix
  const rotationTag = videoStream?.tags?.rotate || videoStream?.side_data_list?.find(sd => sd.rotation)?.rotation;
  const rotation = rotationTag ? parseInt(rotationTag, 10) : 0;
  if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
    // Swap width and height if rotated
    if (width && height) {
      const tmp = width;
      width = height;
      height = tmp;
    }
  }

  const fps = videoStream ? parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate) : null;
  const aspectRatio = width && height ? computeAspectRatio(width, height) : null;
  const videoCodec = videoStream?.codec_name || null;
  const audioCodec = audioStream?.codec_name || null;
  const formatName = format.format_name || null;

  // Bounded/sanitized probe_json
  const sanitizedProbeJson = {
    format: {
      format_name: format.format_name,
      format_long_name: format.format_long_name,
      duration: format.duration,
      size: format.size,
      bit_rate: format.bit_rate,
    },
    video: videoStream ? {
      codec_name: videoStream.codec_name,
      profile: videoStream.profile,
      width: videoStream.width,
      height: videoStream.height,
      r_frame_rate: videoStream.r_frame_rate,
      avg_frame_rate: videoStream.avg_frame_rate,
      pix_fmt: videoStream.pix_fmt,
      rotation,
    } : null,
    audio: audioStream ? {
      codec_name: audioStream.codec_name,
      sample_rate: audioStream.sample_rate,
      channels: audioStream.channels,
      bit_rate: audioStream.bit_rate,
    } : null,
  };

  // Validation rules by asset kind
  if (kind === ASSET_KIND.COVER) {
    if (!videoStream) {
      throw new Error('Cover image has no valid image/video stream');
    }
    if (!width || !height || width <= 0 || height <= 0) {
      throw new Error(`Cover image has invalid dimensions: ${width}x${height}`);
    }
    const validImageCodecs = ['mjpeg', 'png', 'webp', 'jpeg'];
    if (!validImageCodecs.includes(videoCodec?.toLowerCase())) {
      throw new Error(`Cover image format ${videoCodec} is not an allowed image format (JPEG, PNG, WebP)`);
    }
  } else {
    // Master or Variant video
    if (!videoStream) {
      throw new Error('Media file contains no video stream');
    }
    if (!width || !height || width <= 0 || height <= 0) {
      throw new Error(`Video file has invalid dimensions: ${width}x${height}`);
    }
    if (!durationMs || durationMs <= 0) {
      throw new Error(`Video file has invalid duration: ${durationMs}ms`);
    }
  }

  return {
    width,
    height,
    duration_ms: durationMs,
    fps,
    aspect_ratio: aspectRatio,
    video_codec: videoCodec,
    audio_codec: audioCodec,
    has_video: !!videoStream,
    has_audio: !!audioStream,
    size_bytes: sizeBytes,
    rotation,
    format_name: formatName,
    probe_json: sanitizedProbeJson,
  };
}

/**
 * Probes an S3 object by downloading to a safe temp file, executing ffprobe, and cleaning up.
 */
export async function probeS3Object(objectKey, kind = ASSET_KIND.MASTER, options = {}) {
  const tempDir = options.tempDir || PUBLISHER_MEDIA_TEMP_DIR;
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const ext = path.extname(objectKey) || '.tmp';
  const tempFilePath = path.join(tempDir, `probe-${crypto.randomUUID()}${ext}`);

  try {
    const s3Stream = await getObjectStream(objectKey);
    if (!s3Stream) {
      throw new Error(`S3 object stream for key ${objectKey} is null or unavailable`);
    }

    const fileWriteStream = fs.createWriteStream(tempFilePath);
    await pipeline(s3Stream, fileWriteStream, { signal: options.signal });

    const stats = fs.statSync(tempFilePath);
    if (stats.size === 0) {
      throw new Error('Downloaded media file is empty (0 bytes)');
    }

    const rawProbe = await runFfprobe(tempFilePath, options.timeoutMs, options.signal);
    const normalized = normalizeProbeMetadata(rawProbe, kind);

    if (!normalized.size_bytes) {
      normalized.size_bytes = stats.size;
    }

    return normalized;
  } finally {
    // Ensure temp file cleanup in all cases
    if (fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch (cleanupErr) {
        console.warn(`Failed to clean temp probe file ${tempFilePath}:`, cleanupErr.message);
      }
    }
  }
}
