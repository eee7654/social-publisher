/**
 * Centralized Platform Media Compatibility Rule Registry with verified provenance.
 */

export const PLATFORM_RULES = Object.freeze({
  instagram: {
    displayName: 'Instagram',
    provenance: {
      source: 'Meta Graph API Instagram Video Publishing Docs',
      verifiedAt: '2026-08-31',
      apiVersion: 'v22.0',
    },
    maxSizeBytes: 300 * 1024 * 1024, // 300 MB MVP limit (Instagram supports up to 1GB for Reels)
    maxDurationMs: 15 * 60 * 1000,   // 15 minutes (Reels)
    minDurationMs: 3000,             // 3 seconds (Meta Reels minimum)
    supportedContainers: ['mp4', 'mov', 'quicktime'],
    supportedVideoCodecs: ['h264', 'hevc'],
    supportedAudioCodecs: ['aac', 'mp3'],
    allowSilent: true,
    supportedAspectRatios: ['9:16', '1:1', '4:5', '16:9'],
    preferredAspectRatios: ['9:16', '4:5', '1:1'],
    maxFps: 60,
    minFps: 23,
  },

  youtube: {
    displayName: 'YouTube',
    provenance: {
      source: 'YouTube Data API v3 & YouTube Help Center',
      verifiedAt: '2026-08-31',
      apiVersion: 'v3',
    },
    maxSizeBytes: 300 * 1024 * 1024,     // 300 MB MVP limit
    maxDurationMs: 12 * 60 * 60 * 1000,  // 12 hours for verified standard uploads
    minDurationMs: 1000,                 // 1 second
    supportedContainers: ['mp4', 'mov', 'avi', 'wmv', 'mkv', 'webm'],
    supportedVideoCodecs: ['h264', 'hevc', 'vp9', 'av01'],
    supportedAudioCodecs: ['aac', 'mp3', 'opus', 'pcm'],
    allowSilent: true,
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3'],
    preferredAspectRatios: ['16:9', '9:16'],
    maxFps: 60,
    minFps: 23,
    subtypes: {
      shorts: {
        maxDurationMs: 3 * 60 * 1000,    // 3 minutes (expanded late 2024)
        supportedAspectRatios: ['9:16', '1:1'],
      },
    },
  },

  aparat: {
    displayName: 'Aparat',
    provenance: {
      source: 'Aparat Developer API Documentation',
      verifiedAt: '2026-08-31',
      apiVersion: 'v1',
    },
    maxSizeBytes: 300 * 1024 * 1024,
    maxDurationMs: 4 * 60 * 60 * 1000, // 4 hours
    minDurationMs: 1000,
    supportedContainers: ['mp4', 'mov', 'mkv'],
    supportedVideoCodecs: ['h264', 'hevc'],
    supportedAudioCodecs: ['aac', 'mp3'],
    allowSilent: true,
    supportedAspectRatios: ['16:9', '4:3', '1:1', '9:16'],
    preferredAspectRatios: ['16:9'],
    maxFps: 60,
    minFps: 20,
  },

  linkedin: {
    displayName: 'LinkedIn',
    provenance: {
      source: 'LinkedIn Marketing Developer Platform API Guide',
      verifiedAt: '2026-08-31',
      apiVersion: 'v2',
    },
    maxSizeBytes: 300 * 1024 * 1024, // 300 MB (LinkedIn max is 5GB)
    maxDurationMs: 15 * 60 * 1000,   // 15 minutes (desktop standard)
    minDurationMs: 3000,             // 3 seconds
    supportedContainers: ['mp4', 'mov'],
    supportedVideoCodecs: ['h264'],
    supportedAudioCodecs: ['aac', 'mp3'],
    allowSilent: true,
    supportedAspectRatios: ['1:1', '16:9', '9:16', '4:5'],
    preferredAspectRatios: ['1:1', '16:9'],
    maxFps: 60,
    minFps: 10,
  },

  bale: {
    displayName: 'Bale',
    provenance: {
      source: 'Bale Bot Platform API Docs',
      verifiedAt: '2026-08-31',
      apiVersion: 'v2',
    },
    maxSizeBytes: 300 * 1024 * 1024,
    maxDurationMs: 2 * 60 * 60 * 1000,
    minDurationMs: 1000,
    supportedContainers: ['mp4'],
    supportedVideoCodecs: ['h264'],
    supportedAudioCodecs: ['aac', 'mp3'],
    allowSilent: true,
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '4:5'],
    preferredAspectRatios: ['16:9', '9:16'],
    maxFps: 60,
    minFps: 15,
  },

  telegram: {
    displayName: 'Telegram',
    provenance: {
      source: 'Telegram Bot API Documentation',
      verifiedAt: '2026-08-31',
      apiVersion: 'v7.11',
    },
    maxSizeBytes: 300 * 1024 * 1024, // 300 MB MVP limit (Bot API allows up to 2GB)
    maxDurationMs: 4 * 60 * 60 * 1000,
    minDurationMs: 1000,
    supportedContainers: ['mp4', 'mov', 'mkv'],
    supportedVideoCodecs: ['h264', 'hevc'],
    supportedAudioCodecs: ['aac', 'mp3', 'opus'],
    allowSilent: true,
    supportedAspectRatios: ['16:9', '9:16', '1:1', '4:3', '4:5', '21:9'],
    preferredAspectRatios: ['16:9', '9:16', '1:1'],
    maxFps: 60,
    minFps: 15,
  },
});
