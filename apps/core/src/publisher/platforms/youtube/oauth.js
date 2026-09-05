import crypto from 'node:crypto';
import { google } from 'googleapis';

export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_OAUTH_SCOPES = Object.freeze([YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE]);

function requiredEnv(name, fallbackName) {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : null);
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

export function getYouTubeOAuthConfig() {
  const authBase = process.env.BETTER_AUTH_URL || 'http://localhost:4000/api/auth';
  return {
    clientId: requiredEnv('YOUTUBE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID'),
    clientSecret: requiredEnv('YOUTUBE_OAUTH_CLIENT_SECRET', 'GOOGLE_CLIENT_SECRET'),
    redirectUri: process.env.YOUTUBE_OAUTH_REDIRECT_URI || `${new URL(authBase).origin}/api/youtube/oauth/callback`,
  };
}

export function createYouTubeOAuthClient() {
  const config = getYouTubeOAuthConfig();
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

export function createPkcePair() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

export function createOpaqueState() { return crypto.randomBytes(32).toString('base64url'); }
export function hashState(state) { return crypto.createHash('sha256').update(String(state), 'utf8').digest('hex'); }

export function buildYouTubeAuthorizationUrl(client, { state, codeChallenge }) {
  return client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: true,
    scope: YOUTUBE_OAUTH_SCOPES, state, code_challenge: codeChallenge, code_challenge_method: 'S256',
  });
}

export function buildYouTubeTicketUrl(ticket) {
  const authBase = process.env.BETTER_AUTH_URL || 'http://localhost:4000/api/auth';
  const url = new URL(process.env.YOUTUBE_CONNECT_BASE_URL || `${new URL(authBase).origin}/api/youtube/connect`);
  url.searchParams.set('t', ticket);
  return url.toString();
}
