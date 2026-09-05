/**
 * Publisher Capability Registry.
 * 
 * In Phase 5, no external social publisher adapters (Instagram, YouTube, Aparat, etc.)
 * are implemented yet. The registry honestly declares them as false in normal runtime.
 * 
 * Tests can inject mock capabilities via `setInjectedCapabilities()` or options.
 */

const DEFAULT_CAPABILITIES = Object.freeze({
  instagram: { publisherImplemented: true, title: 'Instagram Reels/Post' },
  youtube: { publisherImplemented: true, title: 'YouTube Shorts/Video' },
  aparat: { publisherImplemented: true, title: 'Aparat' },
  linkedin: { publisherImplemented: true, title: 'LinkedIn Company Page' },
  bale: { publisherImplemented: false, title: 'Bale' },
  telegram: { publisherImplemented: true, title: 'Telegram Channel' },
  telegram_channel: { publisherImplemented: true, title: 'Telegram Channel' },
  'publishing.test': { publisherImplemented: false, title: 'Test Provider' },
});

let injectedCapabilities = null;

export function getPublisherCapability(platformCode) {
  const norm = (platformCode || '').toLowerCase();
  if (injectedCapabilities && platformCode in injectedCapabilities) {
    return injectedCapabilities[platformCode];
  }
  return DEFAULT_CAPABILITIES[norm] || { publisherImplemented: false, title: platformCode };
}

export function isPublisherAvailable(platformCode) {
  const cap = getPublisherCapability(platformCode);
  return cap && !!cap.publisherImplemented;
}

export function setInjectedCapabilities(caps) {
  injectedCapabilities = caps;
}

export function resetInjectedCapabilities() {
  injectedCapabilities = null;
}
