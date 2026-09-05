import crypto from 'node:crypto';
import { LINKEDIN_OAUTH_AUTH_URL, LINKEDIN_OAUTH_TOKEN_URL, LINKEDIN_SCOPES } from './constants.js';

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required server configuration: ${name}`);
  return value;
}

export function getLinkedInOAuthConfig() {
  const authBase = process.env.BETTER_AUTH_URL || 'http://localhost:4000/api/auth';
  return {
    clientId: requiredEnv('LINKEDIN_CLIENT_ID'),
    clientSecret: requiredEnv('LINKEDIN_CLIENT_SECRET'),
    redirectUri: process.env.LINKEDIN_OAUTH_REDIRECT_URI || `${new URL(authBase).origin}/api/linkedin/oauth/callback`,
  };
}

export function createOpaqueState() {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashState(state) {
  return crypto.createHash('sha256').update(String(state), 'utf8').digest('hex');
}

export function buildLinkedInAuthorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(LINKEDIN_OAUTH_AUTH_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', LINKEDIN_SCOPES.join(' '));
  return url.toString();
}

export function buildLinkedInTicketUrl(ticket) {
  const authBase = process.env.BETTER_AUTH_URL || 'http://localhost:4000/api/auth';
  const url = new URL(process.env.LINKEDIN_CONNECT_BASE_URL || `${new URL(authBase).origin}/api/linkedin/connect`);
  url.searchParams.set('t', ticket);
  return url.toString();
}

export async function exchangeLinkedInCodeForToken({ code, clientId, clientSecret, redirectUri, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const response = await fetchImpl(LINKEDIN_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || `LinkedIn token exchange failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (!data.access_token) {
    throw new Error('LinkedIn token exchange response missing access_token');
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    refreshToken: data.refresh_token || null,
    refreshTokenExpiresIn: data.refresh_token_expires_in || null,
    scope: data.scope || null,
  };
}
