import { APARAT_DEFAULT_BASE_URL, APARAT_DEFAULT_USER_AGENT } from './constants.js';
import { AparatCookieJar } from './cookieJar.js';
import { ERROR_CATEGORY } from '../../constants.js';

/**
 * Returns standard Aparat API headers matching browser calls.
 */
export function getAparatApiHeaders(cookieJar, extra = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': APARAT_DEFAULT_USER_AGENT,
    Origin: 'https://www.aparat.com',
    Referer: 'https://www.aparat.com/upload',
    'Accept-Language': 'fa,en;q=0.9',
    ...extra,
  };
  if (cookieJar && typeof cookieJar.toCookieHeader === 'function') {
    const cookie = cookieJar.toCookieHeader();
    if (cookie) {
      headers.Cookie = cookie;
    }
  }
  return headers;
}

/**
 * Redacts sensitive credentials, tokens, and cookies from URLs.
 */
export function sanitizeAparatUrl(url) {
  if (!url) return '';
  let str = String(url);
  str = str.replace(/(lpass\/)[a-fA-F0-9]+/g, '$1[REDACTED_LPASS]');
  str = str.replace(/(ltoken\/)[a-zA-Z0-9_-]+/g, '$1[REDACTED_LTOKEN]');
  str = str.replace(/([?&]ltoken=)[^&]+/g, '$1[REDACTED_LTOKEN]');
  str = str.replace(/([?&]token=)[^&]+/g, '$1[REDACTED_TOKEN]');
  str = str.replace(/(AuthV1=)[^;]+/g, '$1[REDACTED]');
  str = str.replace(/(AFCN=)[^;]+/g, '$1[REDACTED]');
  return str;
}

/**
 * Redacts sensitive credentials, tokens, cookies, and passwords from error messages.
 */
export function sanitizeAparatError(error, sensitiveValues = []) {
  if (!error) return 'Unknown error';
  let message = error.message || String(error);
  message = sanitizeAparatUrl(message);

  for (const val of sensitiveValues) {
    if (val && typeof val === 'string' && val.length > 2) {
      message = message.split(val).join('[REDACTED]');
    }
  }

  // Redact potential AuthV1 JWT-like signatures or tokens
  message = message.replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_TOKEN]');
  // Redact Cookie headers
  message = message.replace(/(Cookie:\s*)([^\r\n]+)/gi, '$1[REDACTED_COOKIES]');
  // Redact X-Token headers
  message = message.replace(/(X-Token:\s*)([^\r\n]+)/gi, '$1[REDACTED_TOKEN]');

  return message;
}

/**
 * Step 0: GET bootstrap sign-in page to capture initial AuthV1 cookie and auth config.
 */
export async function bootstrapSignIn({
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar = new AparatCookieJar(),
  fetchImpl = fetch,
} = {}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/signin?callbackType=postmessage`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during signin bootstrap: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  const html = await res.text();
  let guid = null;
  const guidMatch =
    html.match(/(?:["']?guid["']?)\s*:\s*["']([^"']+)["']/i) ||
    html.match(/\bguid\s*[:=]\s*["']([^"']+)["']/i) ||
    html.match(/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})/i);
  if (guidMatch) {
    guid = guidMatch[1];
  }

  let additionalGet = null;
  const addMatch = html.match(/(?:["']?additionalGet["']?)\s*:\s*["']([^"']+)["']/i);
  if (addMatch) {
    additionalGet = addMatch[1];
  }

  const resolvedGuid = guid || 'fe3812fa-30a2-466d-a1ae-472ef9ae6fa6';
  const resolvedAdditionalGet = additionalGet || '?callbackType=postmessage';

  let authTempId = null;
  let finalGuid = resolvedGuid;
  try {
    const authResult = await authenticateAuth({
      guid: resolvedGuid,
      additionalGet: resolvedAdditionalGet,
      baseUrl,
      cookieJar,
      fetchImpl,
    });
    if (authResult?.temp_id) {
      authTempId = authResult.temp_id;
    }
    if (authResult?.guid) {
      finalGuid = authResult.guid;
    }
  } catch {
    // Keep resolvedGuid if /auth endpoint is not available or mocked
  }

  return {
    guid: finalGuid,
    temp_id: authTempId,
    additionalGet: resolvedAdditionalGet,
    cookieJar,
  };
}

/**
 * Step 0b: POST guid to /api/fa/v1/user/Authenticate/auth to register bootstrap session and receive initial temp_id.
 */
export async function authenticateAuth({
  guid,
  additionalGet = '?callbackType=postmessage',
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar = new AparatCookieJar(),
  fetchImpl = fetch,
} = {}) {
  if (!guid) {
    throw new Error('guid is required for Authenticate/auth');
  }

  const cleanBase = baseUrl.replace(/\/+$/, '');
  const query = additionalGet ? (additionalGet.startsWith('?') ? additionalGet : `?${additionalGet}`) : '?callbackType=postmessage';
  const url = `${cleanBase}/api/fa/v1/user/Authenticate/auth${query}`;

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Referer: `${cleanBase}/signin${query}`,
    Origin: cleanBase,
  };
  const cookieHeader = cookieJar.toCookieHeader();
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ guid }),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during Authenticate/auth: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON response
  }

  const attributes = data?.data?.attributes || data?.attributes || data?.data || data;
  const tempId = attributes?.temp_id || null;
  const returnedGuid = attributes?.guid || guid;

  return {
    guid: returnedGuid,
    temp_id: tempId,
    attributes,
    data,
  };
}

/**
 * Step 1: POST account (username/mobile/email) to check user status and obtain temp_id.
 */
export async function signInStep1({
  account,
  guid,
  temp_id,
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar = new AparatCookieJar(),
  fetchImpl = fetch,
} = {}) {
  if (!account || typeof account !== 'string') {
    throw new Error('Account username is required for Aparat sign in');
  }

  const cleanAccount = account.trim().replace(/^@/, '');
  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/user/Authenticate/signin_step1?callbackType=postmessage`;

  // Generate random 6-digit ID if not explicitly provided
  const resolvedTempId =
    temp_id !== undefined && temp_id !== null
      ? temp_id
      : Math.floor(100000 + Math.random() * 900000);

  let res;
  try {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    const cookieHeader = cookieJar.toCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account: cleanAccount,
        guid: guid || '',
        temp_id: resolvedTempId,
      }),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during signin step 1: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatAPI] Invalid JSON in signin step 1 (status ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  const attributes = data?.data?.attributes || data?.attributes || data;
  const typeInfo = (attributes?.type || '').toLowerCase();

  // Fail closed on human-only challenges (CAPTCHA, OTP, device verification)
  if (
    typeInfo === 'otp' ||
    typeInfo === 'captcha' ||
    attributes?.require_captcha ||
    attributes?.challenge ||
    data?.error?.code === 'CAPTCHA_REQUIRED'
  ) {
    const err = new Error('Aparat requires interactive authentication (CAPTCHA, OTP, or 2FA)');
    err.code = 'APARAT_INTERACTIVE_AUTH_REQUIRED';
    throw err;
  }

  if (!res.ok || data?.error) {
    const reason = data?.error?.message || data?.error?.value || `HTTP ${res.status}`;
    const err = new Error(`[AparatAPI] Signin step 1 failed for '${cleanAccount}': ${reason}`);
    err.code = 'APARAT_INVALID_CREDENTIALS';
    throw err;
  }

  const tempId = attributes?.temp_id || resolvedTempId || null;
  return {
    temp_id: tempId,
    type_info: typeInfo,
    attributes,
  };
}

/**
 * Step 2: POST password to complete authentication and receive authenticated AuthV1 and AFCN cookies.
 */
export async function signInStep2({
  account,
  temp_id,
  password,
  guid,
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar = new AparatCookieJar(),
  fetchImpl = fetch,
} = {}) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required for Aparat sign in');
  }

  const cleanAccount = (account || '').trim().replace(/^@/, '');
  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/user/Authenticate/signin_step2?callbackType=postmessage`;

  let res;
  try {
    const headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    const cookieHeader = cookieJar.toCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        account: cleanAccount,
        temp_id: temp_id || null,
        codepass_type: 'pass',
        code: password,
        codepass: password,
        guid: guid || '',
      }),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during signin step 2: ${sanitizeAparatError(netErr, [password])}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatAPI] Invalid JSON in signin step 2 (status ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  const attributes = data?.data?.attributes || data?.attributes || data;
  const typeInfo = (attributes?.type || '').toLowerCase();

  // Fail closed on human-only challenges
  if (
    typeInfo === 'otp' ||
    typeInfo === 'captcha' ||
    attributes?.require_captcha ||
    attributes?.challenge ||
    data?.error?.code === 'CAPTCHA_REQUIRED'
  ) {
    const err = new Error('Aparat requires interactive authentication (CAPTCHA, OTP, or 2FA)');
    err.code = 'APARAT_INTERACTIVE_AUTH_REQUIRED';
    throw err;
  }
  if (!res.ok || data?.error || data?.errors || (Array.isArray(data) && data.length > 0)) {
    let reason = '';
    if (Array.isArray(data)) {
      reason = data.map(String).join(', ');
    } else if (Array.isArray(data?.errors)) {
      reason = data.errors.map(e => (typeof e === 'string' ? e : e?.detail || e?.message || JSON.stringify(e))).join(', ');
    } else {
      reason = data?.error?.message || data?.error?.value || `HTTP ${res.status}`;
    }
  }

  const user = attributes?.user || data?.data?.user || attributes || {};
  return {
    username: user.username || cleanAccount,
    id: user.id != null ? String(user.id) : null,
    name: user.name || user.username || cleanAccount,
    cookieJar,
  };
}

/**
 * Authoritative session verification:
 * GET /api/fa/v1/video/upload/upload_config
 *
 * Proves that the candidate session credentials (AuthV1 / AFCN) can authenticate and publish.
 */
export async function getUploadConfig({
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar,
  fetchImpl = fetch,
} = {}) {
  if (!cookieJar || typeof cookieJar.toCookieHeader !== 'function') {
    const err = new Error('Aparat cookie jar is required to fetch upload_config');
    err.code = 'APARAT_AUTH_REQUIRED';
    throw err;
  }

  const cookieHeader = cookieJar.toCookieHeader();
  if (!cookieHeader || !cookieJar.get('AuthV1')) {
    const err = new Error('Missing AuthV1 session cookie');
    err.code = 'APARAT_AUTH_REQUIRED';
    throw err;
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/video/upload/upload_config`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: getAparatApiHeaders(cookieJar),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure fetching upload_config: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  // If 401, 403, or redirected to signin -> AUTH_REQUIRED
  if (res.status === 401 || res.status === 403) {
    const err = new Error(`[AparatAPI] Unauthorized session in upload_config (HTTP ${res.status})`);
    err.code = 'APARAT_AUTH_REQUIRED';
    throw err;
  }

  let data;
  try {
    const text = await res.text();
    // Reject HTML sign-in redirect bodies
    if (text.includes('<!DOCTYPE') || text.includes('<html') || text.includes('signin?callbackType')) {
      const err = new Error('[AparatAPI] Unauthenticated HTML redirect response received from upload_config');
      err.code = 'APARAT_AUTH_REQUIRED';
      throw err;
    }
    data = JSON.parse(text);
  } catch (jsonErr) {
    if (jsonErr.code === 'APARAT_AUTH_REQUIRED') throw jsonErr;
    const err = new Error(`[AparatAPI] Invalid JSON response from upload_config (HTTP ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    throw err;
  }

  const payload = data?.data?.attributes || data?.data || data;
  if (!res.ok || !payload?.server || !Array.isArray(payload?.categories)) {
    const err = new Error('[AparatAPI] upload_config missing server or categories (unauthenticated)');
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  const accountId = data?.data?.id != null ? String(data.data.id) : (payload?.id != null ? String(payload.id) : null);

  return {
    accountId,
    server: payload.server,
    uploadSize: payload.uploadSize,
    defaultSetting: payload.defaultSetting || {},
    categories: (payload.categories || []).map(cat => ({
      id: String(cat.id != null ? cat.id : cat.cat_id),
      title: String(cat.title || cat.name || `Category ${cat.id}`).trim(),
    })),
    playlist: payload.playlist || [],
    uploadLimit: payload.uploadLimit,
    descr_limit: Number(payload.descr_limit || 2000),
    max_tag_character_cnt: Number(data?.meta?.max_tag_character_cnt || 32),
  };
}

/**
 * Canonical normalizer for Aparat upload allocation response.
 * Handles JSON:API ({ data: [{ type, id, attributes: { token, uploadId } }] }),
 * flat data array ({ data: [{ token, uploadId }] }), and unwrapped arrays ([{ token, uploadId }]).
 */
export function normalizeAparatAllocationPayload(payload) {
  const list =
    Array.isArray(payload) ? payload :
    Array.isArray(payload?.data) ? payload.data :
    (payload?.data && typeof payload.data === 'object' ? [payload.data] : null);

  const rawFirst = list?.[0] || (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null);
  const first = rawFirst?.attributes || rawFirst;

  const token = first?.token || null;
  const rawUploadId = first?.uploadId != null ? first.uploadId : (rawFirst?.id != null ? rawFirst.id : null);
  const uploadId = rawUploadId != null ? String(rawUploadId) : null;

  if (!token || !uploadId) {
    const safeStructuralMetadata = {
      bodyType: typeof payload,
      topLevelKeys: payload && typeof payload === 'object' ? (Array.isArray(payload) ? ['ARRAY'] : Object.keys(payload)) : [],
      dataIsArray: Array.isArray(payload?.data),
      dataLength: Array.isArray(payload?.data) ? payload.data.length : (Array.isArray(payload) ? payload.length : null),
      firstItemKeys: rawFirst && typeof rawFirst === 'object' ? Object.keys(rawFirst) : [],
      attributesKeys: rawFirst?.attributes && typeof rawFirst.attributes === 'object' ? Object.keys(rawFirst.attributes) : [],
      tokenPresent: Boolean(token),
      uploadIdPresent: Boolean(uploadId),
    };
    const err = new Error('[AparatAPI] Failed to allocate upload slot: missing token or uploadId');
    err.code = 'APARAT_PROTOCOL_ERROR';
    err.category = ERROR_CATEGORY.VALIDATION;
    err.safeMetadata = safeStructuralMetadata;
    throw err;
  }

  return {
    token,
    uploadId: String(uploadId),
    uploadSize: first.uploadSize ?? null,
    waterMark: first.waterMark ?? null,
  };
}

/**
 * Step 1 of upload: Allocates an upload slot on Aparat and receives the ephemeral X-Token
 * and server uploadId.
 *
 * POST /api/fa/v1/video/upload/upload_url
 */
export async function allocateUpload({
  uploadServer,
  clientUploadUuid,
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar,
  fetchImpl = fetch,
} = {}) {
  if (!uploadServer) throw new Error('uploadServer is required for allocateUpload');
  if (!clientUploadUuid) throw new Error('clientUploadUuid is required for allocateUpload');
  if (!cookieJar) throw new Error('cookieJar is required for allocateUpload');

  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/video/upload/upload_url`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: getAparatApiHeaders(cookieJar, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        uploadIds: [clientUploadUuid],
        upload_base_url: uploadServer,
        upload_cnt: 1,
      }),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during upload allocation: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    err.category = ERROR_CATEGORY.TRANSIENT_NETWORK;
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  if (res.status === 401 || res.status === 403) {
    const err = new Error(`[AparatAPI] Unauthorized session during upload allocation (HTTP ${res.status})`);
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  let data;
  try {
    data = await res.json();
  } catch {
    const err = new Error(`[AparatAPI] Invalid JSON in upload allocation (HTTP ${res.status})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    err.category = ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`[AparatAPI] Upload allocation failed with HTTP ${res.status}`);
    err.code = 'APARAT_ALLOCATION_FAILED';
    err.category = res.status >= 500 ? ERROR_CATEGORY.PLATFORM_5XX : ERROR_CATEGORY.VALIDATION;
    throw err;
  }

  return normalizeAparatAllocationPayload(data);
}

/**
 * Normalizes final createVideo response:
 * Handles JSON:API ({ data: { id, attributes: { uid } } } or { data: [{ id, attributes: { uid } }] }),
 * flat objects ({ data: { id, uid } }), and unwrapped objects ({ id, uid }).
 */
export function normalizeAparatCreateVideoPayload(payload) {
  const list =
    Array.isArray(payload) ? payload :
    Array.isArray(payload?.data) ? payload.data :
    (payload?.data && typeof payload.data === 'object' ? [payload.data] : null);

  const rawFirst = list?.[0] || (payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null);
  const attributes = rawFirst?.attributes || {};

  const id = rawFirst?.id != null
    ? rawFirst.id
    : (attributes?.id != null ? attributes.id : (payload?.id != null ? payload.id : null));

  const uid = attributes?.uid || rawFirst?.uid || payload?.uid || null;
  const should_log = attributes?.should_log ?? rawFirst?.should_log ?? payload?.should_log ?? null;

  if (!id || !uid) {
    console.error('[AparatAPI] Final createVideo response unexpected structure:', JSON.stringify(payload).slice(0, 1000));
    const err = new Error(`[AparatAPI] Final createVideo response missing id or uid (received keys: ${Object.keys(payload || {}).join(',')})`);
    err.code = 'APARAT_INVALID_RESPONSE';
    err.safeMetadata = {
      keys: Object.keys(payload || {}),
      dataKeys: payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data) ? Object.keys(payload.data) : [],
      attributesKeys: Object.keys(attributes || {}),
      rawSample: JSON.stringify(payload).slice(0, 500),
    };
    throw err;
  }

  return {
    id: String(id),
    uid: String(uid),
    should_log: should_log ?? null,
  };
}

/**
 * Step 5 of publish: Final metadata creation endpoint that publishes the video.
 *
 * POST /api/fa/v1/video/upload/upload/uploadId/<SERVER_UPLOAD_ID>
 */
export async function createVideo({
  serverUploadId,
  payload,
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar,
  fetchImpl = fetch,
} = {}) {
  if (!serverUploadId) throw new Error('serverUploadId is required for createVideo');
  if (!payload) throw new Error('payload is required for createVideo');
  if (!cookieJar) throw new Error('cookieJar is required for createVideo');

  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/video/upload/upload/uploadId/${encodeURIComponent(serverUploadId)}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: getAparatApiHeaders(cookieJar, {
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(payload),
    });
  } catch (netErr) {
    // If request was sent and network failed, outcome is ambiguous
    const err = new Error(`[AparatAPI] Network failure during final video create: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_MUTATION_AMBIGUOUS';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  let bodyText = '';
  let data = null;
  try {
    bodyText = await res.text();
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Non-JSON response
  }

  if (res.status === 401) {
    const detail = data?.errors?.[0]?.detail || data?.error?.message || `HTTP ${res.status}`;
    const err = new Error(`[AparatAPI] Unauthorized session in final createVideo (${detail})`);
    err.code = 'APARAT_AUTH_REQUIRED';
    err.category = ERROR_CATEGORY.AUTH_REQUIRED;
    throw err;
  }

  if (res.status === 403) {
    const errorItem = Array.isArray(data?.errors) ? data.errors[0] : null;
    const isDuplicate =
      errorItem?.uid != null ||
      (typeof errorItem?.detail === 'string' &&
        (errorItem.detail.includes('قبلا') ||
         errorItem.detail.includes('بارگذاری شده است') ||
         errorItem.detail.toLowerCase().includes('duplicate')));

    if (isDuplicate && errorItem?.uid) {
      // Aparat detected identical video already exists on user's account and returned existing UID.
      return {
        id: String(errorItem.id || errorItem.uid),
        uid: String(errorItem.uid),
        duplicate: true,
        should_log: false,
      };
    }

    const detail = errorItem?.detail || data?.error?.message || (bodyText ? bodyText.slice(0, 300) : `HTTP 403`);
    const isAuthRelated =
      detail.includes('نشست') ||
      detail.includes('ورود') ||
      detail.includes('expire_auth_token') ||
      detail.toLowerCase().includes('unauthorized');

    const err = new Error(`[AparatAPI] Forbidden in final createVideo: ${detail}`);
    err.code = isAuthRelated ? 'APARAT_AUTH_REQUIRED' : 'APARAT_FORBIDDEN';
    err.category = isAuthRelated ? ERROR_CATEGORY.AUTH_REQUIRED : ERROR_CATEGORY.VALIDATION;
    err.safeMetadata = {
      status: 403,
      detail: detail.slice(0, 300),
    };
    throw err;
  }

  if (res.status === 429) {
    const err = new Error('[AparatAPI] Rate limited during video create');
    err.code = 'APARAT_RATE_LIMIT';
    err.category = ERROR_CATEGORY.RATE_LIMIT;
    throw err;
  }

  if (!data) {
    const err = new Error(`[AparatAPI] Invalid JSON in createVideo response (HTTP ${res.status}): ${bodyText.slice(0, 300)}`);
    err.code = 'APARAT_MUTATION_AMBIGUOUS';
    throw err;
  }

  if (!res.ok || data?.error || data?.errors) {
    const errorDetail =
      data?.errors?.[0]?.detail ||
      data?.error?.message ||
      data?.error?.value ||
      bodyText.slice(0, 300) ||
      `HTTP ${res.status}`;
    const err = new Error(`[AparatAPI] Failed to create video: ${errorDetail}`);
    err.code = res.status === 400 ? 'APARAT_VALIDATION_ERROR' : 'APARAT_CREATE_FAILED';
    err.category = ERROR_CATEGORY.VALIDATION;
    err.status = res.status;
    throw err;
  }

  return normalizeAparatCreateVideoPayload(data);
}

/**
 * Step 5b: Updates metadata of an existing Aparat video by its videohash / UID.
 * POST /api/fa/v1/video/video/edit/videohash/<uid>
 */
export async function updateVideoMetadata({
  uid,
  title,
  descr,
  tags,
  category,
  comment = 'yes',
  baseUrl = process.env.APARAT_API_BASE_URL || APARAT_DEFAULT_BASE_URL,
  cookieJar,
  fetchImpl = fetch,
} = {}) {
  if (!uid) throw new Error('uid is required for updateVideoMetadata');
  if (!cookieJar) throw new Error('cookieJar is required for updateVideoMetadata');

  const url = `${baseUrl.replace(/\/+$/, '')}/api/fa/v1/video/video/edit/videohash/${encodeURIComponent(uid)}`;

  const body = {
    title,
    descr,
    tags,
    category: String(category),
    comment: String(comment),
  };

  const headers = getAparatApiHeaders(cookieJar, {
    'Content-Type': 'application/json',
    Referer: `https://www.aparat.com/video/video/edit/videohash/${encodeURIComponent(uid)}`,
  });

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    const err = new Error(`[AparatAPI] Network failure during video update: ${sanitizeAparatError(netErr)}`);
    err.code = 'APARAT_NETWORK_ERROR';
    throw err;
  }

  cookieJar.parseResponseHeaders(res.headers);

  let data = null;
  try {
    data = await res.json();
  } catch {
    // ignore
  }

  if (!res.ok) {
    const errorMsg = data?.errors?.title?.[0] || data?.errors?.[0]?.detail || `HTTP ${res.status}`;
    const err = new Error(`[AparatAPI] Failed to update video metadata: ${errorMsg}`);
    err.code = 'APARAT_UPDATE_FAILED';
    err.status = res.status;
    throw err;
  }

  return data;
}
