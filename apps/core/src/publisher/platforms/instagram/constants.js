/**
 * Instagram platform adapter constants and configuration resolvers.
 */

export const DEFAULT_META_GRAPH_VERSION = 'v26.0';
export const DEFAULT_MEDIA_URL_TTL_SECONDS = 3600; // 1 hour for async Meta container download
export const DEFAULT_CONTAINER_POLL_INTERVAL_MS = 3000;
export const DEFAULT_CONTAINER_MAX_WAIT_MS = 300000; // 5 minutes

export function getMetaGraphVersion() {
  return process.env.META_GRAPH_API_VERSION || DEFAULT_META_GRAPH_VERSION;
}

export function getMetaGraphBaseUrl() {
  const version = getMetaGraphVersion();
  return `https://graph.facebook.com/${version}`;
}

export function getMediaUrlTtlSeconds() {
  const parsed = parseInt(process.env.INSTAGRAM_MEDIA_URL_TTL_SECONDS, 10);
  return Number.isFinite(parsed) && parsed >= 300 ? parsed : DEFAULT_MEDIA_URL_TTL_SECONDS;
}

export const INSTAGRAM_STAGE = Object.freeze({
  CONTAINER_CREATED: 'container_created',
  PROCESSING: 'processing',
  READY_TO_PUBLISH: 'ready_to_publish',
  PUBLISH_REQUESTED: 'publish_requested',
  PUBLISHED: 'published',
});

export const INSTAGRAM_CONTAINER_STATUS = Object.freeze({
  FINISHED: 'FINISHED',
  IN_PROGRESS: 'IN_PROGRESS',
  ERROR: 'ERROR',
  EXPIRED: 'EXPIRED',
  PUBLISHED: 'PUBLISHED',
});

export const INSTAGRAM_MEDIA_TYPE = Object.freeze({
  REELS: 'REELS',
});
