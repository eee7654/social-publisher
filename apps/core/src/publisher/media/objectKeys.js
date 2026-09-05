import path from 'path';

/**
 * Sanitizes a file extension.
 * Strips leading dots, spaces, path traversal sequences, and special characters.
 * Defaults to 'bin' if invalid or empty.
 */
export function sanitizeExtension(ext) {
  if (!ext || typeof ext !== 'string') return 'bin';
  // Remove leading dot
  let cleaned = ext.trim().toLowerCase().replace(/^\.+/, '');
  // Remove any non-alphanumeric characters
  cleaned = cleaned.replace(/[^a-z0-9]/g, '');
  if (!cleaned || cleaned.length > 10) return 'bin';
  return cleaned;
}

/**
 * Extracts and sanitizes extension from a filename.
 */
export function extractExtension(filename) {
  if (!filename || typeof filename !== 'string') return 'bin';
  // Strip null bytes and path components
  const base = path.basename(filename.replace(/\0/g, ''));
  const dotIndex = base.lastIndexOf('.');
  if (dotIndex === -1 || dotIndex === base.length - 1) return 'bin';
  return sanitizeExtension(base.slice(dotIndex + 1));
}

/**
 * Sanitizes variant names (alphanumeric and dashes only).
 */
export function sanitizeVariantName(name) {
  if (!name || typeof name !== 'string') return 'variant';
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return cleaned || 'variant';
}

/**
 * Builds deterministic S3 object key for master media asset.
 */
export function buildMasterObjectKey(organizationId, campaignId, assetUuid, extension) {
  const ext = sanitizeExtension(extension);
  const campId = campaignId ? String(campaignId) : 'unattached';
  return `organizations/${organizationId}/campaigns/${campId}/assets/${assetUuid}/original.${ext}`;
}

/**
 * Builds deterministic S3 object key for cover asset.
 */
export function buildCoverObjectKey(organizationId, campaignId, assetUuid, extension) {
  const ext = sanitizeExtension(extension);
  const campId = campaignId ? String(campaignId) : 'unattached';
  return `organizations/${organizationId}/campaigns/${campId}/assets/${assetUuid}/cover.${ext}`;
}

/**
 * Builds deterministic S3 object key for media variant.
 */
export function buildVariantObjectKey(organizationId, campaignId, assetUuid, variantName, extension) {
  const ext = sanitizeExtension(extension);
  const vName = sanitizeVariantName(variantName);
  const campId = campaignId ? String(campaignId) : 'unattached';
  return `organizations/${organizationId}/campaigns/${campId}/assets/${assetUuid}/variants/${vName}.${ext}`;
}

/**
 * Validates that an object key belongs to the specified organization and has no traversal sequences.
 */
export function isObjectKeyOwnedByOrg(objectKey, organizationId) {
  if (!objectKey || typeof objectKey !== 'string') return false;
  if (objectKey.includes('..') || objectKey.includes('\\') || objectKey.includes('\0')) return false;
  const prefix = `organizations/${organizationId}/`;
  return objectKey.startsWith(prefix);
}
