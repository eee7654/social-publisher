import { COMPATIBILITY_STATUS } from './constants.js';
import { PLATFORM_RULES } from './platformRules.js';

/**
 * Pure function evaluating an Asset's metadata against a platform's technical rules.
 */
export function evaluateCompatibility(assetMetadata, platformKey, options = {}) {
  const normPlatform = (platformKey || '').toLowerCase();
  const rule = PLATFORM_RULES[normPlatform];

  if (!rule) {
    // Unknown platforms should not produce false hard failure; provide neutral compatible evaluation with warning
    return {
      platform: normPlatform,
      eligible: true,
      status: COMPATIBILITY_STATUS.COMPATIBLE,
      reasons: [],
      warnings: [`Platform '${platformKey}' has no registered technical rules; evaluated as permissive`],
      requiredVariant: null,
    };
  }

  const reasons = [];
  const warnings = [];
  let status = COMPATIBILITY_STATUS.COMPATIBLE;
  let requiredVariant = null;

  const size = assetMetadata.size_bytes;
  const duration = assetMetadata.duration_ms;
  const aspectRatio = assetMetadata.aspect_ratio;
  const videoCodec = (assetMetadata.video_codec || '').toLowerCase();
  const audioCodec = (assetMetadata.audio_codec || '').toLowerCase();
  const formatName = (assetMetadata.format_name || '').toLowerCase();
  const hasVideo = assetMetadata.has_video !== false;
  const hasAudio = !!assetMetadata.has_audio;

  // 1. Mandatory Video Stream Check
  if (!hasVideo) {
    return {
      platform: normPlatform,
      eligible: false,
      status: COMPATIBILITY_STATUS.INCOMPATIBLE,
      reasons: ['Media has no video stream'],
      warnings,
      requiredVariant: null,
    };
  }

  // 2. File Size Check
  if (size && rule.maxSizeBytes && size > rule.maxSizeBytes) {
    const sizeMb = Math.round(size / (1024 * 1024));
    const maxMb = Math.round(rule.maxSizeBytes / (1024 * 1024));
    reasons.push(`File size (${sizeMb} MB) exceeds platform limit (${maxMb} MB)`);
    status = COMPATIBILITY_STATUS.INCOMPATIBLE;
  }

  // 3. Duration Limits Check
  if (duration) {
    if (rule.maxDurationMs && duration > rule.maxDurationMs) {
      const durSec = Math.round(duration / 1000);
      const maxSec = Math.round(rule.maxDurationMs / 1000);
      reasons.push(`Duration (${durSec}s) exceeds maximum allowed duration of ${maxSec}s`);
      status = COMPATIBILITY_STATUS.INCOMPATIBLE;
    }
    if (rule.minDurationMs && duration < rule.minDurationMs) {
      reasons.push(`Duration (${duration}ms) is below minimum allowed duration of ${rule.minDurationMs}ms`);
      status = COMPATIBILITY_STATUS.INCOMPATIBLE;
    }
  }

  // 4. Codec & Format Compatibility (Technical Normalization)
  let needsTechNorm = false;
  if (videoCodec && rule.supportedVideoCodecs && !rule.supportedVideoCodecs.includes(videoCodec)) {
    needsTechNorm = true;
    reasons.push(`Video codec '${videoCodec}' is not directly supported (supported: ${rule.supportedVideoCodecs.join(', ')})`);
  }

  if (hasAudio && audioCodec && rule.supportedAudioCodecs && !rule.supportedAudioCodecs.includes(audioCodec)) {
    needsTechNorm = true;
    reasons.push(`Audio codec '${audioCodec}' is not directly supported (supported: ${rule.supportedAudioCodecs.join(', ')})`);
  }

  if (formatName && rule.supportedContainers) {
    const isContainerSupported = rule.supportedContainers.some(c => formatName.includes(c));
    if (!isContainerSupported) {
      needsTechNorm = true;
      reasons.push(`Container format '${formatName}' is not directly supported (supported: ${rule.supportedContainers.join(', ')})`);
    }
  }

  // 5. Aspect Ratio & Creative Framing (Creative Variant)
  let needsCreativeVariant = false;
  if (aspectRatio && rule.supportedAspectRatios) {
    if (!rule.supportedAspectRatios.includes(aspectRatio)) {
      needsCreativeVariant = true;
      reasons.push(`Aspect ratio '${aspectRatio}' is not supported (supported: ${rule.supportedAspectRatios.join(', ')})`);
    }
  }

  // Check silent video
  if (!hasAudio) {
    warnings.push('Video has no audio stream (silent video)');
  }

  // Prioritize status
  if (status === COMPATIBILITY_STATUS.INCOMPATIBLE) {
    return {
      platform: normPlatform,
      eligible: false,
      status: COMPATIBILITY_STATUS.INCOMPATIBLE,
      reasons,
      warnings,
      requiredVariant: null,
    };
  }

  if (needsCreativeVariant) {
    return {
      platform: normPlatform,
      eligible: true,
      status: COMPATIBILITY_STATUS.NEEDS_CREATIVE_VARIANT,
      reasons,
      warnings,
      requiredVariant: {
        type: 'creative_framing',
        currentAspectRatio: aspectRatio,
        supportedAspectRatios: rule.supportedAspectRatios,
        preferredAspectRatios: rule.preferredAspectRatios,
      },
    };
  }

  if (needsTechNorm) {
    return {
      platform: normPlatform,
      eligible: true,
      status: COMPATIBILITY_STATUS.NEEDS_TECHNICAL_NORMALIZATION,
      reasons,
      warnings,
      requiredVariant: {
        type: 'technical_normalization',
        targetVideoCodec: rule.supportedVideoCodecs?.[0] || 'h264',
        targetAudioCodec: rule.supportedAudioCodecs?.[0] || 'aac',
        targetContainer: rule.supportedContainers?.[0] || 'mp4',
      },
    };
  }

  return {
    platform: normPlatform,
    eligible: true,
    status: COMPATIBILITY_STATUS.COMPATIBLE,
    reasons: [],
    warnings,
    requiredVariant: null,
  };
}

/**
 * Evaluates an Asset across multiple candidate platforms.
 */
export function evaluateAssetForTargets(asset, availablePlatforms = []) {
  if (!asset) return {};

  const probeData = typeof asset.probe_json === 'string'
    ? (() => { try { return JSON.parse(asset.probe_json) || {}; } catch (e) { return {}; } })()
    : (asset.probe_json || {});

  const metadata = {
    size_bytes: asset.size_bytes,
    duration_ms: asset.duration_ms,
    width: asset.width,
    height: asset.height,
    fps: asset.fps,
    aspect_ratio: asset.aspect_ratio,
    video_codec: asset.video_codec,
    audio_codec: asset.audio_codec,
    has_video: probeData?.video != null || asset.video_codec != null,
    has_audio: probeData?.audio != null || asset.audio_codec != null,
    format_name: probeData?.format?.format_name,
  };

  const results = {};
  for (const platform of availablePlatforms) {
    results[platform] = evaluateCompatibility(metadata, platform);
  }

  return results;
}
