export const LINKEDIN_API_VERSION = '202608';
export const RESTLI_PROTOCOL_VERSION = '2.0.0';

export const LINKEDIN_OAUTH_AUTH_URL = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_OAUTH_TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
export const LINKEDIN_REST_BASE = 'https://api.linkedin.com/rest';

export const LINKEDIN_SCOPES = Object.freeze([
  'rw_organization_admin',
  'w_organization_social',
  'r_organization_social',
]);

export const LINKEDIN_SUBJECT = 'jobs.publish.linkedin';
export const LINKEDIN_WORKER_NAME = 'WORKER_PUBLISH_LINKEDIN';
export const LINKEDIN_PROVIDER_CODE = 'linkedin';
export const LINKEDIN_ADAPTER_KEY = 'publishing.linkedin';

export const LINKEDIN_CONNECTION_PURPOSE = 'publishing_connection';
export const LINKEDIN_CONNECTION_TTL_MS = 15 * 60 * 1000;

export const LINKEDIN_CONNECTION_SOURCE = Object.freeze({
  WEB: 'web',
  TELEGRAM: 'telegram',
});

export const LINKEDIN_INTENT_STATUS = Object.freeze({
  PENDING: 'pending',
  RESERVED: 'reserved',
  VERIFIED_PENDING_CONFIRMATION: 'verified_pending_confirmation',
  CONSUMED: 'consumed',
  CANCELLED: 'cancelled',
});

export const LINKEDIN_CALLBACK_STAGE = Object.freeze({
  BROWSER_TICKET_RESERVED: 'BROWSER_TICKET_RESERVED',
  STATE_VALIDATED: 'STATE_VALIDATED',
  INTENT_RESERVED: 'INTENT_RESERVED',
  TOKEN_EXCHANGE_STARTED: 'TOKEN_EXCHANGE_STARTED',
  TOKEN_EXCHANGE_SUCCEEDED: 'TOKEN_EXCHANGE_SUCCEEDED',
  PAGE_VERIFY_STARTED: 'PAGE_VERIFY_STARTED',
  PAGE_VERIFY_SUCCEEDED: 'PAGE_VERIFY_SUCCEEDED',
  PENDING_CONFIRMATION_CREATED: 'PENDING_CONFIRMATION_CREATED',
});
