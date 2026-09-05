export function sanitizeMediaError(error) {
  return String(error?.message || error || 'Media operation failed')
    .replace(/https?:\/\/\S+/gi, '[url-redacted]')
    .replace(/(x-amz-(signature|credential|security-token)|access_token|authorization)=?[^\s&]*/gi, '$1=[redacted]')
    .slice(0, 1000);
}
