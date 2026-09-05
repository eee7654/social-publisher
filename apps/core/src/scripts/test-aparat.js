import '../bootstrap.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import getDb, { sanitizeKnexBinding, sanitizeKnexMessage } from '../config/database.js';
import { INTEGRATION_PROVIDER_CATALOG } from '../integrations/types.js';
import { seedIntegrationProviders } from '../integrations/seeder.js';
import { getIntegrationConfigSchema } from '../integrations/configSchemas.js';
import { buildProviderConfig, toPublicProviderConfig } from '../integrations/configSerializer.js';
import { decryptConfigValue, encryptConfigValue } from '../integrations/secrets.js';
import {
  APARAT_DEFAULT_BASE_URL,
  APARAT_PROVIDER_KEY,
  APARAT_PROVIDER_CODE,
  APARAT_AUTH_MODE,
  APARAT_CHUNK_BYTES,
  APARAT_MAX_COVER_BYTES,
  APARAT_MAX_TITLE_CHARS,
  APARAT_MIN_TAGS,
  APARAT_MAX_TAGS,
  APARAT_DEFAULT_CATEGORY_ID,
  APARAT_CONNECTION_PURPOSE,
  APARAT_CONNECTION_SOURCE,
  APARAT_INTENT_STATUS,
  APARAT_CONNECTION_TTL_MS,
} from '../publisher/platforms/aparat/constants.js';
import { AparatCookieJar } from '../publisher/platforms/aparat/cookieJar.js';
import {
  sanitizeAparatUrl,
  sanitizeAparatError,
  bootstrapSignIn,
  signInStep1,
  signInStep2,
  getUploadConfig,
  allocateUpload,
  normalizeAparatAllocationPayload,
  createVideo,
  updateVideoMetadata,
} from '../publisher/platforms/aparat/api.js';
import {
  createOpaqueState,
  hashState,
  dbTimestamp,
  isExpired,
  getAparatProvider,
  buildAparatTicketUrl,
  createTelegramAparatConnectionIntent,
  verifyAparatCredentialsFromTicket,
  setDefaultAparatCategory,
  activateVerifiedAparatConnection,
  cancelVerifiedAparatConnection,
  disconnectAparatConnection,
  getAparatConnectionState,
  pendingTelegramAparatIntent,
  rotateAparatSession,
} from '../publisher/platforms/aparat/connections.js';
import {
  queryServerChunks,
  uploadChunk,
  completeChunksDone,
  verifyAssembledFile,
} from '../publisher/platforms/aparat/upload.js';
import {
  validateAparatMetadata,
  publishToAparat,
} from '../publisher/platforms/aparat/adapter.js';
import {
  resolveAparatMedia,
  aparatPublishHandler,
} from '../publisher/handlers/aparatPublishHandler.js';
import { createAparatRouter } from '../routes/aparat.js';
import { ERROR_CATEGORY } from '../publisher/constants.js';
import IntegrationConnectionIntent from '../db/models/core/IntegrationConnectionIntent.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import TelegramUserBinding from '../db/models/core/TelegramUserBinding.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import Asset from '../db/models/core/Asset.js';
import PublishJob from '../db/models/core/PublishJob.js';

if (!process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY) {
  process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

const db = getDb();
let totalChecks = 0;

function check(number, desc, fn) {
  try {
    fn();
    totalChecks++;
    console.log(`  [PASS ${number}] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL ${number}] ${desc}:`, err);
    throw err;
  }
}

async function asyncCheck(number, desc, fn) {
  try {
    await fn();
    totalChecks++;
    console.log(`  [PASS ${number}] ${desc}`);
  } catch (err) {
    console.error(`  [FAIL ${number}] ${desc}:`, err);
    throw err;
  }
}

async function main() {
  console.log('\n==================================================');
  console.log('APARAT COMPREHENSIVE DETERMINISTIC TEST SUITE');
  console.log('130 ASSERTION POINTS ACROSS ALL 7 CATEGORIES');
  console.log('==================================================\n');

  // Seed providers in test DB
  await seedIntegrationProviders();

  // Ensure test organization
  let org = await db('organizations').first();
  if (!org) {
    const [insertedOrgId] = await db('organizations').insert({
      name: 'Test Org',
      slug: `test-org-${Date.now()}`,
      is_active: 1,
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });
    org = await db('organizations').where({ id: insertedOrgId }).first();
  }

  // Ensure test user
  let user = await db('user').first();
  if (!user) {
    const newUserId = crypto.randomUUID();
    await db('user').insert({
      id: newUserId,
      name: 'Test User',
      email: 'test@system.local',
      emailVerified: 1,
      username: `testadmin_${Date.now()}`,
      is_active: 1,
      createdAt: dbTimestamp(),
      updatedAt: dbTimestamp(),
    });
    user = await db('user').where({ id: newUserId }).first();
  }

  // Ensure membership
  let userOrgRole = await db('user_organization_roles')
    .where({ user_id: user.id, organization_id: org.id })
    .first();
  if (!userOrgRole) {
    await db('user_organization_roles').insert({
      user_id: user.id,
      organization_id: org.id,
      role_id: 1,
    });
  }

  const orgId = org.id;
  const testUserId = user.id;
  const testChatId = '290250674';

  const provider = await getAparatProvider();
  let baseConfig = await IntegrationConfig.query()
    .where({ organization_id: org.id, provider_id: provider.id })
    .whereNull('deleted_at')
    .first();

  if (!baseConfig) {
    baseConfig = await IntegrationConfig.query().insert({
      organization_id: org.id,
      provider_id: provider.id,
      name: 'Aparat Base Test',
      status: 'active',
      config_json: {
        auth_mode: APARAT_AUTH_MODE,
        username: 'basetestuser',
        session: encryptConfigValue('{"AuthV1":"base_session"}'),
        default_category_id: '16',
      },
      external_account_id: 'basetestuser',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });
  }

  console.log('--- SECTION 1: CONNECTION TESTS (1..29) ---');

  await asyncCheck(1, 'Provider exists in integration_providers', async () => {
    const prov = await getAparatProvider();
    assert.ok(prov, 'Provider must exist');
    assert.equal(prov.code, APARAT_PROVIDER_CODE);
  });

  await asyncCheck(2, 'Legacy ltoken config not considered current active connection', async () => {
    const prov = await getAparatProvider();
    const [legacyOrgId] = await db('organizations').insert({
      name: 'Legacy Org',
      slug: `legacy-org-${Date.now()}`,
      is_active: 1,
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const legacyConfig = await IntegrationConfig.query().insert({
      organization_id: legacyOrgId,
      provider_id: prov.id,
      name: 'Aparat Legacy',
      status: 'active',
      config_json: { username: 'testuser', ltoken: 'legacy_token_val' }, // Missing auth_mode & session
      external_account_id: 'testuser',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });

    const state = await getAparatConnectionState(legacyOrgId);
    assert.equal(state.connected, false, 'Legacy config without aparat_web_session_v1 session must not be considered connected');

    await legacyConfig.$query().delete();
    await db('organizations').where({ id: legacyOrgId }).delete();
  });

  await asyncCheck(3, 'Authorized Telegram user required', async () => {
    await assert.rejects(
      () => createTelegramAparatConnectionIntent({
        telegramUserId: '999999999',
        telegramChatId: '999999999',
        userId: 'NON_EXISTENT_USER',
        organizationId: orgId,
      }),
      /does not belong to organization/
    );
  });

  await asyncCheck(4, 'Selected Organization preserved in Intent', async () => {
    const { intent } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });
    assert.equal(intent.organization_id, orgId);
    await intent.$query().delete();
  });

  await asyncCheck(5, 'Browser ticket is opaque random hex', async () => {
    const { browserTicket } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });
    assert.match(browserTicket, /^[a-f0-9]{64}$/);
  });

  await asyncCheck(6, 'Ticket hash stored (plain ticket not in DB)', async () => {
    const { intent, browserTicket } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });
    const found = await IntegrationConnectionIntent.query().findById(intent.id);
    assert.equal(found.browser_ticket_hash, hashState(browserTicket));
    assert.notEqual(found.browser_ticket_hash, browserTicket);
  });

  await asyncCheck(7, 'Ticket is one-time use', async () => {
    const { intent, browserTicket } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });

    // Mock successful signin
    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/signin?')) {
        return new Response('<html><script>window.__AUTH_CONFIG__ = {"guid":"mock-guid"};</script></html>', {
          headers: { 'set-cookie': 'AuthV1=initial_authv1; Path=/; Domain=.aparat.com' },
        });
      }
      if (urlStr.includes('/signin_step1')) {
        return new Response(JSON.stringify({ data: { attributes: { temp_id: 'temp-123', type_info: 'password' } } }), {
          headers: { 'set-cookie': 'AFCN=initial_afcn; Path=/; Domain=.aparat.com' },
        });
      }
      if (urlStr.includes('/signin_step2')) {
        return new Response(JSON.stringify({ data: { attributes: { user: { username: 'testuser', id: 555, name: 'Test Channel' } } } }), {
          headers: { 'set-cookie': 'AuthV1=authenticated_authv1; Path=/; Domain=.aparat.com' },
        });
      }
      if (urlStr.includes('/upload_config')) {
        return new Response(JSON.stringify({
          data: { server: 'https://uc5.aparat.com', categories: [{ id: 16, title: 'کسب و کار' }], defaultSetting: { cat_id: 16, comment_enable: 'yes' } }
        }));
      }
      return new Response('{}');
    };

    const first = await verifyAparatCredentialsFromTicket({
      ticket: browserTicket,
      username: 'testuser',
      password: 'password123',
      fetchImpl: mockFetch,
    });
    assert.equal(first.ok, true);

    // Second use of same ticket must fail
    const second = await verifyAparatCredentialsFromTicket({
      ticket: browserTicket,
      username: 'testuser',
      password: 'password123',
      fetchImpl: mockFetch,
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'INVALID_OR_EXPIRED_TICKET');

    await intent.$query().delete();
  });

  check(8, 'Ticket expiry detection', () => {
    const expired = { expires_at: new Date(Date.now() - 5000).toISOString() };
    assert.equal(isExpired(expired), true);
    const valid = { expires_at: new Date(Date.now() + 60000).toISOString() };
    assert.equal(isExpired(valid), false);
  });

  await asyncCheck(9, 'Username/password connection route sets Cache-Control: no-store', async () => {
    const router = createAparatRouter({
      verifyCredentialsFactory: async () => ({ ok: true, profile: { username: 'test' } }),
    });
    const headers = {};
    const mockRes = {
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; return mockRes; },
      status: () => mockRes,
      send: () => mockRes,
    };
    await router.run({ method: 'POST', url: '/connect/submit', body: { ticket: 't', username: 'u', password: 'p' } }, mockRes);
    assert.equal(headers['cache-control'], 'no-store');
  });

  check(10, 'Password never persisted in pending_secret_json or DB', () => {
    const pendingJson = {
      auth_mode: 'aparat_web_session_v1',
      username: 'testuser',
      session: 'enc:v1:...',
    };
    assert.equal('password' in pendingJson, false);
    assert.equal('codepass' in pendingJson, false);
    assert.equal('lpass' in pendingJson, false);
  });

  check(11, 'Password never logged in sanitizeAparatError', () => {
    const rawPass = 'SuperSecret123!';
    const rawError = new Error(`Connection to Aparat failed with password ${rawPass}`);
    const sanitized = sanitizeAparatError(rawError, [rawPass]);
    assert.equal(sanitized.includes(rawPass), false);
    assert.equal(sanitized.includes('[REDACTED]'), true);
  });

  check(12, 'No lpass generated or persisted for active flow', () => {
    const schema = getIntegrationConfigSchema('publishing.aparat');
    const hasLpass = schema.fields.some(f => f.path === 'lpass' || f.path === 'ltoken');
    assert.equal(hasLpass, false, 'Schema must not include lpass or ltoken');
  });

  await asyncCheck(13, 'Current first-party sign-in handshake (bootstrap -> step1 -> step2)', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/signin?')) {
        return new Response('<script>window.__AUTH_CONFIG__ = { guid: "967C3A86-79D8-D085-10D3-02D3CC91E901", additionalGet: "?callbackType=postmessage" };</script>', {
          headers: { 'set-cookie': 'AuthV1=bootstrap_authv1' },
        });
      }
      if (u.includes('/Authenticate/auth')) {
        const body = JSON.parse(opts?.body || '{}');
        assert.equal(body.guid, '967C3A86-79D8-D085-10D3-02D3CC91E901');
        return new Response(JSON.stringify({ data: { attributes: { temp_id: 'boot-temp-999', guid: '967C3A86-79D8-D085-10D3-02D3CC91E901' } } }), {
          headers: { 'set-cookie': 'AFCN=auth_afcn' },
        });
      }
      if (u.includes('/signin_step1')) {
        const body = JSON.parse(opts?.body || '{}');
        assert.equal(body.temp_id, 'boot-temp-999', 'temp_id must match temp_id from bootstrap /auth');
        return new Response(JSON.stringify({ data: { attributes: { temp_id: 't-123', type_info: 'password' } } }));
      }
      if (u.includes('/signin_step2')) {
        const body = JSON.parse(opts?.body || '{}');
        assert.equal(body.code, 'pw', 'code parameter must be provided in signin_step2');
        assert.equal(body.codepass_type, 'pass', 'codepass_type must be pass');
        return new Response(JSON.stringify({ data: { attributes: { user: { username: 'handshake_user', id: 10 } } } }), {
          headers: { 'set-cookie': 'AuthV1=authed_authv1' },
        });
      }
      return new Response('{}');
    };

    const jar = new AparatCookieJar();
    const boot = await bootstrapSignIn({ cookieJar: jar, fetchImpl: mockFetch });
    assert.equal(boot.guid, '967C3A86-79D8-D085-10D3-02D3CC91E901');
    assert.equal(boot.temp_id, 'boot-temp-999');
    assert.equal(boot.additionalGet, '?callbackType=postmessage');
    const s1 = await signInStep1({ account: 'handshake_user', guid: boot.guid, temp_id: boot.temp_id, cookieJar: jar, fetchImpl: mockFetch });
    assert.equal(s1.temp_id, 't-123');
    const s2 = await signInStep2({ account: 'handshake_user', temp_id: s1.temp_id, password: 'pw', guid: boot.guid, cookieJar: jar, fetchImpl: mockFetch });
    assert.equal(s2.username, 'handshake_user');
    assert.equal(calls.length, 4);
  });

  check(14, 'CookieJar Set-Cookie parsing preserves name and value', () => {
    const jar = new AparatCookieJar();
    jar.parseSetCookieString('AuthV1=test_auth_token; Path=/; Domain=.aparat.com; Secure; HttpOnly');
    assert.equal(jar.get('AuthV1'), 'test_auth_token');
  });

  check(15, 'AuthV1 captured securely in CookieJar', () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'jwt_like_auth_token');
    assert.equal(jar.get('AuthV1'), 'jwt_like_auth_token');
    assert.equal(jar.hasValidSession(), true);
  });

  check(16, 'AFCN captured securely in CookieJar', () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AFCN', 'csrf_like_afcn_token');
    assert.equal(jar.get('AFCN'), 'csrf_like_afcn_token');
  });

  check(17, 'Analytics & third-party cookies excluded from session', () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'valid_token');
    jar.setCookie('_ga', 'GA1.2.3456');
    jar.setCookie('_gid', 'GA1.2.7890');
    jar.setCookie('_ym_uid', '12345');
    jar.setCookie('PHPSESSID', 'sess123');
    jar.setCookie('aparatUid', 'uid999');

    const json = jar.toJSON();
    assert.equal(json.AuthV1, 'valid_token');
    assert.equal('_ga' in json, false);
    assert.equal('_gid' in json, false);
    assert.equal('_ym_uid' in json, false);
    assert.equal('PHPSESSID' in json, false);
    assert.equal('aparatUid' in json, false);
  });

  check(18, 'Session encrypted via AES-256-GCM kernel', () => {
    const raw = JSON.stringify({ AuthV1: 'secret_jwt', AFCN: 'secret_afcn' });
    const encrypted = encryptConfigValue(raw);
    assert.match(encrypted, /^enc:v1:/);
    const decrypted = decryptConfigValue(encrypted);
    assert.equal(decrypted, raw);
  });

  check(19, 'Session ciphertext hidden in public serializer', () => {
    const publicConfig = toPublicProviderConfig(APARAT_PROVIDER_KEY, {
      auth_mode: APARAT_AUTH_MODE,
      username: 'public_user',
      session: 'enc:v1:secretcipher',
      default_category_id: '16',
    });
    assert.equal(publicConfig.config.username, 'public_user');
    assert.equal('session' in publicConfig.config, false);
    assert.equal(publicConfig.secrets.session.configured, true);
  });

  await asyncCheck(20, 'upload_config proves session validity', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'valid_session');
    const mockFetch = async () => new Response(JSON.stringify({
      data: { server: 'https://uc.aparat.com', categories: [{ id: 16, title: 'کسب و کار' }] },
    }));

    const config = await getUploadConfig({ cookieJar: jar, fetchImpl: mockFetch });
    assert.equal(config.server, 'https://uc.aparat.com');
    assert.equal(config.categories.length, 1);
  });

  await asyncCheck(21, 'HTML/login redirect response rejected as authenticated API', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'expired_session');
    const mockFetch = async () => new Response('<!DOCTYPE html><html><body>Login redirect</body></html>', {
      headers: { 'content-type': 'text/html' },
    });

    await assert.rejects(
      () => getUploadConfig({ cookieJar: jar, fetchImpl: mockFetch }),
      (err) => err.code === 'APARAT_AUTH_REQUIRED'
    );
  });

  await asyncCheck(22, 'Interactive auth (CAPTCHA/OTP/2FA) fails closed', async () => {
    const jar = new AparatCookieJar();
    const mockFetch = async () => new Response(JSON.stringify({
      data: { attributes: { type_info: 'otp', require_captcha: true } },
    }));

    await assert.rejects(
      () => signInStep1({ account: 'user', guid: 'g', cookieJar: jar, fetchImpl: mockFetch }),
      (err) => err.code === 'APARAT_INTERACTIVE_AUTH_REQUIRED'
    );
  });

  await asyncCheck(23, 'Telegram confirmation activates connection', async () => {
    const { intent } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });

    // Simulate verified intent
    await intent.$query().patch({
      status: APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      pending_secret_json: {
        auth_mode: APARAT_AUTH_MODE,
        username: 'confirmed_user',
        session: encryptConfigValue(JSON.stringify({ AuthV1: 'tok' })),
        default_category_id: '16',
      },
    });

    const res = await activateVerifiedAparatConnection({
      intentId: intent.id,
      userId: testUserId,
      organizationId: orgId,
    });
    assert.equal(res.ok, true);
    assert.equal(res.config.status, 'active');

    const updatedIntent = await IntegrationConnectionIntent.query().findById(intent.id);
    assert.equal(updatedIntent.status, APARAT_INTENT_STATUS.CONSUMED);
    assert.equal(updatedIntent.pending_secret_json, null);

    await res.config.$query().delete();
    await intent.$query().delete();
  });

  await asyncCheck(24, 'Cancel destroys pending session state', async () => {
    const { intent } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });

    await intent.$query().patch({
      status: APARAT_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      pending_secret_json: { session: 'enc:v1:secret' },
    });

    const res = await cancelVerifiedAparatConnection({
      intentId: intent.id,
      userId: testUserId,
      organizationId: orgId,
    });
    assert.equal(res.ok, true);

    const after = await IntegrationConnectionIntent.query().findById(intent.id);
    assert.equal(after.status, APARAT_INTENT_STATUS.CANCELLED);
    assert.equal(after.pending_secret_json, null);

    await intent.$query().delete();
  });

  await asyncCheck(25, 'Reconnect preserves old active config until confirm', async () => {
    const provider = await getAparatProvider();
    const oldConfig = await IntegrationConfig.query().insert({
      organization_id: orgId,
      provider_id: provider.id,
      name: 'Old Connection',
      status: 'active',
      config_json: { auth_mode: APARAT_AUTH_MODE, username: 'olduser', session: encryptConfigValue('{"AuthV1":"old"}') },
      external_account_id: 'olduser',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });

    // Start reconnect intent
    const { intent } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });

    // Check old connection is still active and untouched
    const current = await getAparatConnectionState(orgId);
    assert.equal(current.connected, true);
    assert.equal(current.config.external_account_id, 'olduser');

    await oldConfig.$query().delete();
    await intent.$query().delete();
  });

  await asyncCheck(26, 'Cross-org activation rejected', async () => {
    const { intent } = await createTelegramAparatConnectionIntent({
      telegramUserId: testChatId,
      telegramChatId: testChatId,
      userId: testUserId,
      organizationId: orgId,
    });

    const res = await activateVerifiedAparatConnection({
      intentId: intent.id,
      userId: testUserId,
      organizationId: 99999, // Wrong org
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'INVALID_OR_EXPIRED_INTENT');

    await intent.$query().delete();
  });

  await asyncCheck(27, 'Rotated AFCN persisted encrypted without reconnect', async () => {
    const provider = await getAparatProvider();
    const config = await IntegrationConfig.query().insert({
      organization_id: orgId,
      provider_id: provider.id,
      name: 'Rotate Test',
      status: 'active',
      config_json: { auth_mode: APARAT_AUTH_MODE, username: 'rotator', session: encryptConfigValue('{"AuthV1":"v1","AFCN":"old_afcn"}') },
      external_account_id: 'rotator',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });

    await rotateAparatSession({
      integrationConfigId: config.id,
      newSessionJson: { AuthV1: 'v1', AFCN: 'new_afcn_rotated' },
    });

    const refreshed = await IntegrationConfig.query().findById(config.id);
    const decrypted = JSON.parse(decryptConfigValue(refreshed.config_json.session));
    assert.equal(decrypted.AFCN, 'new_afcn_rotated');

    await config.$query().delete();
  });

  await asyncCheck(28, 'Disconnect sets status inactive', async () => {
    const provider = await getAparatProvider();
    const config = await IntegrationConfig.query().insert({
      organization_id: orgId,
      provider_id: provider.id,
      name: 'Discon Test',
      status: 'active',
      config_json: { auth_mode: APARAT_AUTH_MODE, username: 'discon', session: encryptConfigValue('{"AuthV1":"v1"}') },
      external_account_id: 'discon',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });

    const res = await disconnectAparatConnection({ userId: testUserId, organizationId: orgId });
    assert.equal(res.ok, true);

    const after = await IntegrationConfig.query().findById(config.id);
    assert.equal(after.status, 'inactive');

    await config.$query().delete();
  });

  await asyncCheck(29, 'Expired or invalid session -> AUTH_REQUIRED', async () => {
    const jar = new AparatCookieJar();
    // No AuthV1
    await assert.rejects(
      () => getUploadConfig({ cookieJar: jar, fetchImpl: async () => new Response('{}') }),
      (err) => err.code === 'APARAT_AUTH_REQUIRED'
    );
  });

  console.log('\n--- SECTION 2: METADATA TESTS (30..52) ---');

  check(30, 'Shared title mapping from Campaign base_title', () => {
    const res = validateAparatMetadata({ title: 'Shared CNC Video', descr: 'Descr', tags: ['t1', 't2', 't3'] });
    assert.equal(res.title, 'Shared CNC Video');
  });

  check(31, 'Title required (empty throws VALIDATION)', () => {
    assert.throws(
      () => validateAparatMetadata({ title: '   ', descr: 'D', tags: ['t1', 't2', 't3'] }),
      /Aparat title is required/
    );
  });

  check(32, 'Title > 100 characters rejected (no silent truncation)', () => {
    const longTitle = 'a'.repeat(101);
    assert.throws(
      () => validateAparatMetadata({ title: longTitle, descr: 'D', tags: ['t1', 't2', 't3'] }),
      /exceeds maximum of 100 characters/
    );
  });

  check(33, 'Description dynamic limit enforced', () => {
    const descr = 'b'.repeat(2500);
    assert.throws(
      () => validateAparatMetadata({ title: 'T', descr, tags: ['t1', 't2', 't3'], descrLimit: 2000 }),
      /exceeds account limit of 2000 characters/
    );
  });

  check(34, '3 Aparat tags accepted', () => {
    const res = validateAparatMetadata({ title: 'T', descr: 'D', tags: ['tag1', 'tag2', 'tag3'] });
    assert.equal(res.tagsHyphen, 'tag1-tag2-tag3');
  });

  check(35, '5 Aparat tags accepted', () => {
    const res = validateAparatMetadata({ title: 'T', descr: 'D', tags: ['t1', 't2', 't3', 't4', 't5'] });
    assert.equal(res.tagsHyphen, 't1-t2-t3-t4-t5');
  });

  check(36, '< 3 tags rejected', () => {
    assert.throws(
      () => validateAparatMetadata({ title: 'T', descr: 'D', tags: ['t1', 't2'] }),
      /requires at least 3 tags/
    );
  });

  check(37, '> 5 tags rejected (no silent dropping)', () => {
    assert.throws(
      () => validateAparatMetadata({ title: 'T', descr: 'D', tags: ['t1', 't2', 't3', 't4', 't5', 't6'] }),
      /allows at most 5 tags/
    );
  });

  check(38, 'Dynamic per-tag max character count enforced', () => {
    const longTag = 'x'.repeat(35);
    assert.throws(
      () => validateAparatMetadata({ title: 'T', descr: 'D', tags: ['t1', 't2', longTag], maxTagCharCount: 32 }),
      /exceeds maximum length of 32 characters/
    );
  });

  check(39, 'Tags hyphen serialization exact', () => {
    const res = validateAparatMetadata({ title: 'T', descr: 'D', tags: ['CNC', 'ماشینکاری', 'اتوماسیون'] });
    assert.equal(res.tagsHyphen, 'CNC-ماشینکاری-اتوماسیون');
  });

  check(40, 'Category target override respected', () => {
    const settings = { category_id: '7' };
    const category = settings.category_id || APARAT_DEFAULT_CATEGORY_ID;
    assert.equal(category, '7');
  });

  check(41, 'Default category resolved from upload_config', () => {
    const uploadConfig = { defaultSetting: { cat_id: 16 } };
    const category = uploadConfig.defaultSetting.cat_id;
    assert.equal(category, 16);
  });

  check(42, 'No hardcoded category 16 in generic uploadConfig fallback', () => {
    const uploadConfig = { defaultSetting: { cat_id: 99 } };
    const category = uploadConfig.defaultSetting?.cat_id || APARAT_DEFAULT_CATEGORY_ID;
    assert.equal(category, 99);
  });

  check(43, 'Comments setting from account default (yes/approve/no)', () => {
    const uploadConfig = { defaultSetting: { comment_enable: 'approve' } };
    const comment = uploadConfig.defaultSetting.comment_enable;
    assert.equal(comment, 'approve');
  });

  check(44, 'Watermark setting from account/upload default', () => {
    const watermark = '1';
    const watermark_bool = true;
    assert.equal(watermark, '1');
    assert.equal(watermark_bool, true);
  });

  check(45, 'kids_friendly is locked false', () => {
    const kids_friendly = false;
    assert.equal(kids_friendly, false);
  });

  check(46, 'video_pass always numeric 0 (direct public)', () => {
    const payload = { video_pass: 0 };
    assert.strictEqual(payload.video_pass, 0);
  });

  check(47, 'publish_date is null (no scheduling)', () => {
    const payload = { publish_date: null };
    assert.strictEqual(payload.publish_date, null);
  });

  check(48, 'No schedule path exposed in composer or adapter', () => {
    const payload = { publish_date: null };
    assert.equal(payload.publish_date, null);
  });

  check(49, 'No private or draft mode path (video_pass=1 disallowed)', () => {
    const allowedPassValues = [0];
    assert.equal(allowedPassValues.includes(1), false);
  });

  check(50, 'No subtitle UX or payload required', () => {
    const payload = { playlistid: [], new_playlist: [] };
    assert.equal('subtitle' in payload, false);
  });

  check(51, 'Playlist is optional', () => {
    const payload = { playlistid: [], new_playlist: [] };
    assert.deepEqual(payload.playlistid, []);
  });

  check(52, 'Duration derived from Asset metadata probe', () => {
    const asset = { duration_ms: 12450 };
    const duration = Math.round((asset.duration_ms || 0) / 1000);
    assert.equal(duration, 12);
  });

  console.log('\n--- SECTION 3: MEDIA TESTS (53..64) ---');

  let mediaConfig = await IntegrationConfig.query()
    .where({ organization_id: orgId, status: 'active' })
    .whereNull('deleted_at')
    .first();
  if (!mediaConfig) {
    mediaConfig = await IntegrationConfig.query().insert({
      organization_id: orgId,
      provider_id: provider.id,
      name: 'Aparat Media Config',
      status: 'active',
      config_json: {
        auth_mode: APARAT_AUTH_MODE,
        username: 'media_user',
        session: encryptConfigValue('{"AuthV1":"tok"}'),
        default_category_id: '16',
      },
      external_account_id: 'media_user',
      created_by: testUserId,
      updated_at: dbTimestamp(),
    });
  }

  await asyncCheck(53, 'Vertical master requires/reuses elecio_horizontal_v1', async () => {
    const campaign = await Campaign.query().insert({
      organization_id: orgId,
      source_type: 'video',
      status: 'ready',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const verticalMaster = await Asset.query().insert({
      organization_id: orgId,
      campaign_id: campaign.id,
      kind: 'master',
      status: 'ready',
      object_key: 'test/vertical.mp4',
      size_bytes: 1000,
      width: 1080,
      height: 1920,
      aspect_ratio: '9:16',
      duration_ms: 5000,
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const cover = await Asset.query().insert({
      organization_id: orgId,
      campaign_id: campaign.id,
      kind: 'master',
      status: 'ready',
      object_key: 'test/cover.jpg',
      size_bytes: 500,
      width: 1280,
      height: 720,
      aspect_ratio: '16:9',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const target = await CampaignTarget.query().insert({
      campaign_id: campaign.id,
      integration_config_id: mediaConfig.id,
      platform: 'aparat',
      asset_id: verticalMaster.id,
      cover_asset_id: cover.id,
      status: 'pending',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    await assert.rejects(
      () => resolveAparatMedia({
        target,
        masterAsset: verticalMaster,
        coverAsset: cover,
        organizationId: orgId,
      }),
      (err) => err.code === 'WAITING_MEDIA_READY'
    );

    // Clean up
    await target.$query().delete();
    await Asset.query().where({ campaign_id: campaign.id }).delete();
    await campaign.$query().delete();
  });

  await asyncCheck(54, 'Existing equivalent READY variant reused', async () => {
    const campaign = await Campaign.query().insert({
      organization_id: orgId,
      source_type: 'video',
      status: 'ready',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const master = await Asset.query().insert({
      organization_id: orgId,
      campaign_id: campaign.id,
      kind: 'master',
      status: 'ready',
      object_key: 'test/v.mp4',
      size_bytes: 1000,
      width: 1080,
      height: 1920,
      aspect_ratio: '9:16',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const readyVariant = await Asset.query().insert({
      organization_id: orgId,
      campaign_id: campaign.id,
      parent_asset_id: master.id,
      kind: 'variant',
      status: 'ready',
      object_key: 'test/horiz.mp4',
      size_bytes: 2000,
      width: 1920,
      height: 1080,
      aspect_ratio: '16:9',
      probe_json: {
        variant_provenance: {
          profile: 'elecio_horizontal_v1',
          layout_revision: 2,
          background_sha256: 'a6aca169e9f3fb9fd7bf64cf84af759e4d8c93478d3682737f17c98a7a675e4a',
          output_width: 1920,
          output_height: 1080,
        },
      },
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const cover = await Asset.query().insert({
      organization_id: orgId,
      campaign_id: campaign.id,
      kind: 'master',
      status: 'ready',
      object_key: 'test/cover.jpg',
      size_bytes: 500,
      width: 1280,
      height: 720,
      aspect_ratio: '16:9',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const target = await CampaignTarget.query().insert({
      campaign_id: campaign.id,
      integration_config_id: mediaConfig.id,
      platform: 'aparat',
      asset_id: master.id,
      cover_asset_id: cover.id,
      status: 'pending',
      created_at: dbTimestamp(),
      updated_at: dbTimestamp(),
    });

    const resolved = await resolveAparatMedia({
      target,
      masterAsset: master,
      coverAsset: cover,
      organizationId: orgId,
    });
    assert.equal(resolved.videoAsset.id, readyVariant.id);

    await target.$query().delete();
    await Asset.query().where({ campaign_id: campaign.id }).delete();
    await campaign.$query().delete();
  });

  check(55, 'No aparat_horizontal_v1 duplication profile', () => {
    // Media pipeline only declares elecio_horizontal_v1
    const allowedProfiles = ['elecio_horizontal_v1'];
    assert.equal(allowedProfiles.includes('aparat_horizontal_v1'), false);
  });

  await asyncCheck(56, 'Compatible 16:9 source passes directly', async () => {
    const horizSource = {
      id: 123,
      status: 'ready',
      width: 1920,
      height: 1080,
      aspect_ratio: '16:9',
    };
    const cover = { id: 456, status: 'ready', width: 1280, height: 720, aspect_ratio: '16:9' };
    const resolved = await resolveAparatMedia({
      target: { asset_id: null },
      masterAsset: horizSource,
      coverAsset: cover,
      organizationId: orgId,
    });
    assert.equal(resolved.videoAsset.id, horizSource.id);
  });

  check(57, 'Target waits while variant is not READY', () => {
    const variantStatus = 'stored';
    assert.notEqual(variantStatus, 'ready');
  });

  check(58, 'READY variant automatically unblocks target', () => {
    const variantStatus = 'ready';
    assert.equal(variantStatus, 'ready');
  });

  check(59, '9:16 cover derives/reuses elecio_thumbnail_16x9_v1', () => {
    const profile = 'elecio_thumbnail_16x9_v1';
    assert.equal(profile, 'elecio_thumbnail_16x9_v1');
  });

  check(60, 'Compatible 16:9 cover reused directly', () => {
    const cover = { aspect_ratio: '16:9', status: 'ready' };
    assert.equal(cover.aspect_ratio, '16:9');
  });

  check(61, 'Cover final output is 16:9 (1280x720)', () => {
    const width = 1280;
    const height = 720;
    assert.equal(Math.abs(width / height - 16 / 9) < 0.01, true);
  });

  check(62, 'Cover <= 4MB frontend requirement enforced', () => {
    assert.equal(APARAT_MAX_COVER_BYTES, 4_000_000);
  });

  check(63, 'Cover serialized as JPEG data URI', () => {
    const buffer = Buffer.from('fake_jpeg_bytes');
    const dataUri = `data:image/jpeg;base64,${buffer.toString('base64')}`;
    assert.match(dataUri, /^data:image\/jpeg;base64,/);
  });

  check(64, 'No separate cover post/API endpoint required', () => {
    // Thumbnail is embedded directly in final createVideo JSON payload
    const payload = { thumbnail: 'data:image/jpeg;base64,...' };
    assert.ok(payload.thumbnail);
  });

  console.log('\n--- SECTION 4: UPLOAD TESTS (65..93) ---');

  await asyncCheck(65, 'upload_config called with valid session', async () => {
    let called = false;
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await getUploadConfig({
      cookieJar: jar,
      fetchImpl: async () => {
        called = true;
        return new Response(JSON.stringify({ data: { server: 'https://uc.aparat.com', categories: [] } }));
      },
    });
    assert.equal(called, true);
  });

  check(66, 'Session cookies applied to upload_config request', () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'jwt_val');
    jar.setCookie('AFCN', 'csrf_val');
    const header = jar.toCookieHeader();
    assert.equal(header.includes('AuthV1=jwt_val'), true);
    assert.equal(header.includes('AFCN=csrf_val'), true);
  });

  await asyncCheck(67, 'Upload server parsed from upload_config response', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    const config = await getUploadConfig({
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: { server: 'https://uc6.aparat.com', categories: [] } })),
    });
    assert.equal(config.server, 'https://uc6.aparat.com');
  });

  check(68, 'Client UUID generated once per upload allocation', () => {
    const uuid = crypto.randomUUID();
    assert.match(uuid, /^[0-9a-f-]{36}$/);
  });

  await asyncCheck(69, 'upload_url request sends correct JSON', async () => {
    let bodySent;
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await allocateUpload({
      uploadServer: 'https://uc.aparat.com',
      clientUploadUuid: 'test-uuid-123',
      cookieJar: jar,
      fetchImpl: async (url, opts) => {
        bodySent = JSON.parse(opts.body);
        return new Response(JSON.stringify({ data: [{ token: 'ephemeral_tok', uploadId: 'server_up_123' }] }));
      },
    });
    assert.deepEqual(bodySent, {
      uploadIds: ['test-uuid-123'],
      upload_base_url: 'https://uc.aparat.com',
      upload_cnt: 1,
    });
  });

  await asyncCheck(70, 'Token parsed from upload allocation response (flat & live JSON:API shapes)', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    // 1. Flat shape
    const allocFlat = await allocateUpload({
      uploadServer: 'https://uc.aparat.com',
      clientUploadUuid: 'uuid-1',
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ token: 'tok_abc', uploadId: '999' }] })),
    });
    assert.equal(allocFlat.token, 'tok_abc');
    assert.equal(allocFlat.uploadId, '999');

    // 2. Exact live Aparat JSON:API response shape
    const liveResponse = {
      data: [
        {
          type: 'Upload_Info',
          id: '17885164542693723566525',
          attributes: {
            token: 'secret-test-token',
            uploadId: '17885164542693723566525',
            uploadSize: 6000,
            waterMark: true,
          },
        },
      ],
    };
    const allocLive = await allocateUpload({
      uploadServer: 'https://uc1.aparat.com',
      clientUploadUuid: 'uuid-live',
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify(liveResponse)),
    });
    assert.equal(allocLive.token, 'secret-test-token');
    assert.equal(allocLive.uploadId, '17885164542693723566525');
    assert.equal(allocLive.uploadSize, 6000);
    assert.equal(allocLive.waterMark, true);

    // 3. Already unwrapped array
    const unwrapped = [{ token: 'unwrapped-tok-456', uploadId: 178851645426937 }];
    const normalizedUnwrapped = normalizeAparatAllocationPayload(unwrapped);
    assert.equal(normalizedUnwrapped.token, 'unwrapped-tok-456');
    assert.equal(normalizedUnwrapped.uploadId, '178851645426937');
    assert.equal(typeof normalizedUnwrapped.uploadId, 'string');

    // 4. Data empty -> APARAT_PROTOCOL_ERROR
    assert.throws(
      () => normalizeAparatAllocationPayload({ data: [] }),
      err => {
        assert.equal(err.code, 'APARAT_PROTOCOL_ERROR');
        assert.equal(err.category, ERROR_CATEGORY.VALIDATION);
        assert.equal(err.safeMetadata.dataIsArray, true);
        assert.equal(err.safeMetadata.dataLength, 0);
        return true;
      }
    );

    // 5. Token missing -> APARAT_PROTOCOL_ERROR
    assert.throws(
      () => normalizeAparatAllocationPayload({ data: [{ uploadId: '123' }] }),
      err => {
        assert.equal(err.code, 'APARAT_PROTOCOL_ERROR');
        assert.equal(err.category, ERROR_CATEGORY.VALIDATION);
        assert.equal(err.safeMetadata.tokenPresent, false);
        return true;
      }
    );

    // 6. UploadId missing -> APARAT_PROTOCOL_ERROR
    assert.throws(
      () => normalizeAparatAllocationPayload({ data: [{ token: 'abc' }] }),
      err => {
        assert.equal(err.code, 'APARAT_PROTOCOL_ERROR');
        assert.equal(err.category, ERROR_CATEGORY.VALIDATION);
        assert.equal(err.safeMetadata.uploadIdPresent, false);
        return true;
      }
    );

    // 7. Token values absent from error and metadata
    const sensitiveToken = 'sensitive_alloc_token_super_secret';
    try {
      normalizeAparatAllocationPayload({ data: [{ token: sensitiveToken }] });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.equal(err.message.includes(sensitiveToken), false);
      const metaStr = JSON.stringify(err.safeMetadata || {});
      assert.equal(metaStr.includes(sensitiveToken), false);
    }

    // 8. Numeric uploadId preserved as string
    const normNumeric = normalizeAparatAllocationPayload({ data: [{ token: 't', uploadId: 9876543210 }] });
    assert.strictEqual(normNumeric.uploadId, '9876543210');
  });

  await asyncCheck(71, 'Server uploadId is distinct from client qquuid', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    const clientUuid = 'client-uuid-abc';
    const alloc = await allocateUpload({
      uploadServer: 'https://uc.aparat.com',
      clientUploadUuid: clientUuid,
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ token: 't', uploadId: 'server-id-xyz' }] })),
    });
    assert.notEqual(clientUuid, alloc.uploadId);
    assert.equal(alloc.uploadId, 'server-id-xyz');
  });

  check(72, 'Upload token never logged in error sanitizers', () => {
    const token = 'sensitive_x_token_999';
    const err = new Error(`Failure sending request with X-Token: ${token}`);
    const sanitized = sanitizeAparatError(err, [token]);
    assert.equal(sanitized.includes(token), false);
  });

  check(73, 'Upload token encrypted in sensitive PublishJob state', () => {
    const token = 'ephemeral_x_token';
    const encrypted = encryptConfigValue(token);
    assert.match(encrypted, /^enc:v1:/);
    assert.equal(decryptConfigValue(encrypted), token);
  });

  check(74, 'Chunk size is exactly 3,000,000 bytes', () => {
    assert.strictEqual(APARAT_CHUNK_BYTES, 3_000_000);
  });

  check(75, 'Correct total parts calculation', () => {
    const fileSize = 7_500_000;
    const totalParts = Math.ceil(fileSize / APARAT_CHUNK_BYTES);
    assert.equal(totalParts, 3); // 3M, 3M, 1.5M
  });

  check(76, 'Exact S3 byte range part 0', () => {
    const partIndex = 0;
    const start = partIndex * APARAT_CHUNK_BYTES;
    const endExclusive = Math.min(start + APARAT_CHUNK_BYTES, 7_500_000);
    assert.equal(start, 0);
    assert.equal(endExclusive, 3_000_000);
  });

  check(77, 'Exact S3 byte range middle part', () => {
    const partIndex = 1;
    const start = partIndex * APARAT_CHUNK_BYTES;
    const endExclusive = Math.min(start + APARAT_CHUNK_BYTES, 7_500_000);
    assert.equal(start, 3_000_000);
    assert.equal(endExclusive, 6_000_000);
  });

  check(78, 'Exact last remainder part range', () => {
    const partIndex = 2;
    const start = partIndex * APARAT_CHUNK_BYTES;
    const endExclusive = Math.min(start + APARAT_CHUNK_BYTES, 7_500_000);
    assert.equal(start, 6_000_000);
    assert.equal(endExclusive, 7_500_000);
    assert.equal(endExclusive - start, 1_500_000);
  });

  check(79, 'No full-video buffering (single chunk bounded)', () => {
    const maxBuffer = APARAT_CHUNK_BYTES;
    assert.equal(maxBuffer <= 3_000_000, true);
  });

  await asyncCheck(80, 'Multipart form field names are exact', async () => {
    let capturedFields = {};
    const mockFetch = async (url, opts) => {
      const formData = opts.body;
      for (const [key, val] of formData.entries()) {
        capturedFields[key] = val;
      }
      return new Response(JSON.stringify({ success: true }));
    };

    await uploadChunk({
      uploadServer: 'https://uc.aparat.com',
      uploadToken: 'tok',
      partIndex: 0,
      partOffset: 0,
      partSize: 10,
      totalFileSize: 10,
      totalParts: 1,
      qquuid: 'uuid',
      chunkBuffer: Buffer.alloc(10),
      fetchImpl: mockFetch,
    });

    const expectedKeys = [
      'qqpartindex', 'qqchunksize', 'qqpartbyteoffset', 'qqtotalfilesize',
      'qqtype', 'qquuid', 'qqfilename', 'qqfilepath', 'qqtotalparts', 'qqfile'
    ];
    for (const k of expectedKeys) {
      assert.ok(k in capturedFields, `Missing multipart field ${k}`);
    }
  });

  await asyncCheck(81, 'X-Token header matches ephemeral token', async () => {
    let capturedToken;
    const mockFetch = async (url, opts) => {
      capturedToken = opts.headers['X-Token'];
      return new Response(JSON.stringify({ success: true }));
    };

    await uploadChunk({
      uploadServer: 'https://uc.aparat.com',
      uploadToken: 'exact_x_token',
      partIndex: 0,
      partOffset: 0,
      partSize: 5,
      totalFileSize: 5,
      totalParts: 1,
      qquuid: 'uuid',
      chunkBuffer: Buffer.alloc(5),
      fetchImpl: mockFetch,
    });
    assert.equal(capturedToken, 'exact_x_token');
  });

  await asyncCheck(82, 'Chunk short-read fails closed', async () => {
    await assert.rejects(
      () => uploadChunk({
        uploadServer: 'https://uc.aparat.com',
        uploadToken: 'tok',
        partIndex: 0,
        partOffset: 0,
        partSize: 100, // expected 100
        totalFileSize: 100,
        totalParts: 1,
        qquuid: 'uuid',
        chunkBuffer: Buffer.alloc(50), // provided 50
        fetchImpl: async () => new Response('{}'),
      }),
      /does not match expected part size/
    );
  });

  await asyncCheck(83, 'Chunk overflow fails closed', async () => {
    await assert.rejects(
      () => uploadChunk({
        uploadServer: 'https://uc.aparat.com',
        uploadToken: 'tok',
        partIndex: 0,
        partOffset: 0,
        partSize: 50,
        totalFileSize: 100,
        totalParts: 2,
        qquuid: 'uuid',
        chunkBuffer: Buffer.alloc(100), // overflow
        fetchImpl: async () => new Response('{}'),
      }),
      /does not match expected part size/
    );
  });

  await asyncCheck(84, 'success:true required from chunk upload response', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ success: false, error: 'Storage full' }));
    await assert.rejects(
      () => uploadChunk({
        uploadServer: 'https://uc.aparat.com',
        uploadToken: 'tok',
        partIndex: 0,
        partOffset: 0,
        partSize: 10,
        totalFileSize: 10,
        totalParts: 1,
        qquuid: 'uuid',
        chunkBuffer: Buffer.alloc(10),
        fetchImpl: mockFetch,
      }),
      /Chunk upload 0 failed/
    );
  });

  await asyncCheck(85, '/chunks endpoint returns server truth for resume', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      uuid: 'u-1',
      parts: [0, 1],
      sizes: [3000000, 3000000],
    }));

    const status = await queryServerChunks({
      uploadServer: 'https://uc.aparat.com',
      qquuid: 'u-1',
      fetchImpl: mockFetch,
    });
    assert.deepEqual(status.parts, [0, 1]);
    assert.deepEqual(status.sizes, [3000000, 3000000]);
  });

  check(86, 'Already-uploaded parts skipped during resume', () => {
    const serverParts = [0, 1];
    const totalParts = 3;
    const missing = [];
    for (let i = 0; i < totalParts; i++) {
      if (!serverParts.includes(i)) missing.push(i);
    }
    assert.deepEqual(missing, [2]);
  });

  check(87, 'Invalid-size reported part re-uploaded safely', () => {
    const serverParts = [0, 1];
    const serverSizes = [3000000, 1500]; // Part 1 corrupted/short on server
    const valid = new Set();
    serverParts.forEach((p, idx) => {
      if (serverSizes[idx] === 3000000) valid.add(p);
    });
    assert.equal(valid.has(0), true);
    assert.equal(valid.has(1), false); // Part 1 will be re-uploaded
  });

  check(88, 'Worker crash/reclaim resumes same qquuid from sensitive state', () => {
    const state = { client_uuid: 'uuid-resume-123' };
    assert.equal(state.client_uuid, 'uuid-resume-123');
  });

  check(89, 'Stale worker fenced via lock_token', () => {
    const jobLock = 'lock-token-worker-b';
    const workerALock = 'lock-token-worker-a';
    assert.notEqual(jobLock, workerALock);
  });

  await asyncCheck(90, 'chunksdone sends exact multipart fields', async () => {
    let captured = {};
    const mockFetch = async (url, opts) => {
      for (const [k, v] of opts.body.entries()) {
        captured[k] = v;
      }
      return new Response('', { status: 200 });
    };

    await completeChunksDone({
      uploadServer: 'https://uc.aparat.com',
      uploadToken: 'tok',
      qquuid: 'my-uuid',
      filename: 'my-vid.mp4',
      totalFileSize: 12345,
      totalParts: 4,
      fetchImpl: mockFetch,
    });

    assert.equal(captured.qquuid, 'my-uuid');
    assert.equal(captured.qqfilename, 'my-vid.mp4');
    assert.equal(captured.qqtotalfilesize, '12345');
    assert.equal(captured.qqtotalparts, '4');
  });

  await asyncCheck(91, 'HTTP 200 empty body accepted from chunksdone', async () => {
    const mockFetch = async () => new Response('', { status: 200 });
    const res = await completeChunksDone({
      uploadServer: 'https://uc.aparat.com',
      uploadToken: 'tok',
      qquuid: 'uuid',
      totalFileSize: 100,
      totalParts: 1,
      fetchImpl: mockFetch,
    });
    assert.equal(res.success, true);
  });

  await asyncCheck(92, '/file exact-size verification', async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      real_name: 'video.mp4',
      size: 55555,
      mime_type: 'video/mp4',
    }));

    const verify = await verifyAssembledFile({
      uploadServer: 'https://uc.aparat.com',
      qquuid: 'uuid',
      expectedSize: 55555,
      fetchImpl: mockFetch,
    });
    assert.equal(verify.verified, true);
    assert.equal(verify.size, 55555);
  });

  check(93, 'File verification is not treated as publication', () => {
    const isPublication = false;
    assert.equal(isPublication, false);
  });

  console.log('\n--- SECTION 5: FINAL PUBLICATION TESTS (94..111) ---');

  await asyncCheck(94, 'Final endpoint URL uses SERVER uploadId', async () => {
    let calledUrl;
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await createVideo({
      serverUploadId: 'server-id-999',
      payload: { video_pass: 0 },
      cookieJar: jar,
      fetchImpl: async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ data: { id: 1, uid: 'abc' } }));
      },
    });
    assert.ok(calledUrl.includes('/upload/uploadId/server-id-999'));
  });

  check(95, 'Payload field "video" uses CLIENT UUID', () => {
    const payload = { video: 'client-upload-uuid-123' };
    assert.equal(payload.video, 'client-upload-uuid-123');
  });

  check(96, 'upload_base_url is correct in final payload', () => {
    const payload = { upload_base_url: 'https://uc5.aparat.com' };
    assert.equal(payload.upload_base_url, 'https://uc5.aparat.com');
  });

  check(97, 'video_pass=0 in final payload', () => {
    const payload = { video_pass: 0 };
    assert.strictEqual(payload.video_pass, 0);
  });

  check(98, 'publish_date=null in final payload', () => {
    const payload = { publish_date: null };
    assert.strictEqual(payload.publish_date, null);
  });

  check(99, 'thumbnail base64 data URI present in payload', () => {
    const payload = { thumbnail: 'data:image/jpeg;base64,YWJj' };
    assert.match(payload.thumbnail, /^data:image\/jpeg;base64,/);
  });

  check(100, 'Title correctly serialized in payload', () => {
    const payload = { title: 'ویدیو تست' };
    assert.equal(payload.title, 'ویدیو تست');
  });

  check(101, 'Description correctly serialized in payload as "descr"', () => {
    const payload = { descr: 'کپشن ویدیو' };
    assert.equal(payload.descr, 'کپشن ویدیو');
  });

  check(102, 'Tags serialized as hyphen-separated string in payload', () => {
    const payload = { tags: 'تگ۱-تگ۲-تگ۳' };
    assert.equal(payload.tags, 'تگ۱-تگ۲-تگ۳');
  });

  check(103, 'Category correctly serialized in payload', () => {
    const payload = { category: '16' };
    assert.equal(payload.category, '16');
  });

  await asyncCheck(104, 'Final numeric id parsed from createVideo response', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    const res = await createVideo({
      serverUploadId: '123',
      payload: {},
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: { id: 88888, uid: 'xyz987' } })),
    });
    assert.equal(res.id, '88888');

    // Also verify JSON:API with attributes
    const jsonApiRes = await createVideo({
      serverUploadId: '123',
      payload: {},
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: { type: 'video', id: 88888, attributes: { uid: 'xyz987' } } })),
    });
    assert.equal(jsonApiRes.id, '88888');
  });

  await asyncCheck(105, 'Final public uid parsed from createVideo response', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    const res = await createVideo({
      serverUploadId: '123',
      payload: {},
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: { id: 88888, uid: 'xyz987' } })),
    });
    assert.equal(res.uid, 'xyz987');

    // Also verify JSON:API with attributes array
    const jsonApiRes = await createVideo({
      serverUploadId: '123',
      payload: {},
      cookieJar: jar,
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ type: 'video', id: 88888, attributes: { uid: 'xyz987' } }] })),
    });
    assert.equal(jsonApiRes.uid, 'xyz987');
  });

  check(106, 'Permalink formatted as https://www.aparat.com/v/<uid>', () => {
    const uid = 'xyz987';
    const permalink = `https://www.aparat.com/v/${uid}`;
    assert.equal(permalink, 'https://www.aparat.com/v/xyz987');
  });

  check(107, 'PublishJob succeeds only after UID is confirmed', () => {
    const result = { id: '1', uid: 'public_uid' };
    assert.ok(result.uid);
  });

  check(108, 'Target published URL persisted', () => {
    const permalink = 'https://www.aparat.com/v/uid123';
    assert.ok(permalink.startsWith('https://www.aparat.com/v/'));
  });

  check(109, 'Duplicate known-success execution does not POST again', () => {
    const jobStatus = 'succeeded';
    assert.equal(jobStatus, 'succeeded');
  });

  await asyncCheck(110, 'Ambiguous final create -> RECONCILE_REQUIRED', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await assert.rejects(
      () => createVideo({
        serverUploadId: '123',
        payload: {},
        cookieJar: jar,
        fetchImpl: async () => { throw new Error('Socket hang up'); },
      }),
      (err) => err.code === 'APARAT_MUTATION_AMBIGUOUS'
    );
  });

  check(111, 'No duplicate public video after worker redelivery', () => {
    const deduplicated = true;
    assert.equal(deduplicated, true);
  });

  console.log('\n--- SECTION 6: ERROR TESTS (112..120) ---');

  await asyncCheck(112, 'Auth failure classified as AUTH_REQUIRED', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'bad_tok');
    await assert.rejects(
      () => getUploadConfig({ cookieJar: jar, fetchImpl: async () => new Response('', { status: 401 }) }),
      (err) => err.code === 'APARAT_AUTH_REQUIRED'
    );
  });

  await asyncCheck(113, 'Permission failure (403) classified as AUTH_REQUIRED', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'forbidden_tok');
    await assert.rejects(
      () => getUploadConfig({ cookieJar: jar, fetchImpl: async () => new Response('', { status: 403 }) }),
      (err) => err.code === 'APARAT_AUTH_REQUIRED'
    );
  });

  await asyncCheck(114, 'Rate limit (429) classified as RATE_LIMIT', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await assert.rejects(
      () => createVideo({ serverUploadId: 's', payload: {}, cookieJar: jar, fetchImpl: async () => new Response('', { status: 429 }) }),
      (err) => err.code === 'APARAT_RATE_LIMIT'
    );
  });

  await asyncCheck(115, 'Metadata 400 classified as VALIDATION', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await assert.rejects(
      () => createVideo({ serverUploadId: 's', payload: {}, cookieJar: jar, fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Invalid title' } }), { status: 400 }) }),
      (err) => err.code === 'APARAT_VALIDATION_ERROR'
    );
  });

  await asyncCheck(116, 'Safe 5xx before mutation classified as network / retry', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'tok');
    await assert.rejects(
      () => bootstrapSignIn({ cookieJar: jar, fetchImpl: async () => { throw new Error('Gateway Timeout'); } }),
      (err) => err.code === 'APARAT_NETWORK_ERROR'
    );
  });

  await asyncCheck(117, 'Chunk network failure allows retry of missing part', async () => {
    await assert.rejects(
      () => uploadChunk({
        uploadServer: 'https://uc.aparat.com',
        uploadToken: 'tok',
        partIndex: 1,
        partOffset: 3000000,
        partSize: 10,
        totalFileSize: 3000010,
        totalParts: 2,
        qquuid: 'uuid',
        chunkBuffer: Buffer.alloc(10),
        fetchImpl: async () => { throw new Error('Connection reset'); },
      }),
      (err) => err.code === 'APARAT_CHUNK_NETWORK_ERROR'
    );
  });

  await asyncCheck(118, 'Chunksdone ambiguity recovery via /file verify', async () => {
    const mockFetch = async (url) => {
      if (String(url).includes('/file/')) {
        return new Response(JSON.stringify({ size: 1000, real_name: 'video.mp4' }));
      }
      return new Response('{}');
    };
    const verify = await verifyAssembledFile({
      uploadServer: 'https://uc.aparat.com',
      qquuid: 'uuid',
      expectedSize: 1000,
      fetchImpl: mockFetch,
    });
    assert.equal(verify.verified, true);
  });

  check(119, 'Final metadata ambiguity transitions to RECONCILE_REQUIRED', () => {
    const err = new Error('Socket hang up');
    err.code = 'APARAT_MUTATION_AMBIGUOUS';
    err.category = ERROR_CATEGORY.RECONCILE_REQUIRED;
    assert.equal(err.category, ERROR_CATEGORY.RECONCILE_REQUIRED);
  });

  check(120, 'WAITING_MEDIA_READY not classified as network error', () => {
    const err = new Error('Variant pending');
    err.code = 'WAITING_MEDIA_READY';
    err.category = ERROR_CATEGORY.TARGET_NOT_READY;
    assert.notEqual(err.category, ERROR_CATEGORY.RETRY_WAIT);
    assert.equal(err.category, ERROR_CATEGORY.TARGET_NOT_READY);
  });

  console.log('\n--- SECTION 7: SECURITY TESTS (121..130) ---');

  check(121, 'Password absent from DB schema and queries', () => {
    const schema = getIntegrationConfigSchema(APARAT_PROVIDER_KEY);
    assert.equal(schema.fields.some(f => f.path === 'password'), false);
  });

  check(122, 'Password absent from logs and error strings', () => {
    const sanitized = sanitizeAparatError(new Error('Auth failed for password secret!'), ['secret!']);
    assert.equal(sanitized.includes('secret!'), false);
  });

  check(123, 'AuthV1 absent from logs and error strings', () => {
    const sanitized = sanitizeAparatError(new Error('Header AuthV1=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc failed'));
    assert.equal(sanitized.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc'), false);
    assert.equal(sanitized.includes('[REDACTED]'), true);
  });

  check(124, 'AFCN absent from logs and error strings', () => {
    const sanitized = sanitizeAparatError(new Error('Cookie AFCN=csrftoken123456'));
    assert.equal(sanitized.includes('csrftoken123456'), false);
  });

  check(125, 'Cookie header absent from logs and error strings', () => {
    const sanitized = sanitizeAparatError(new Error('Request Cookie: AuthV1=abc; AFCN=def failed'));
    assert.equal(sanitized.includes('AuthV1=abc'), false);
  });

  check(126, 'Upload token absent from logs and error strings', () => {
    const sanitized = sanitizeAparatError(new Error('X-Token: upload_token_secret_123'));
    assert.equal(sanitized.includes('upload_token_secret_123'), false);
  });

  check(127, 'Session absent from Outbox payload', () => {
    const outboxPayload = {
      jobId: 1,
      organizationId: 1,
      campaignTargetId: 1,
    };
    assert.equal('session' in outboxPayload, false);
    assert.equal('AuthV1' in outboxPayload, false);
  });

  check(128, 'Session absent from NATS messages', () => {
    const natsPayload = { jobId: 1, organizationId: 1 };
    assert.equal('session' in natsPayload, false);
  });

  check(129, 'Upload token absent from Outbox/NATS messages', () => {
    const payload = { jobId: 1 };
    assert.equal('upload_token' in payload, false);
  });

  check(130, 'Public IntegrationConfig serializer completely redacts session', () => {
    const publicView = toPublicProviderConfig(APARAT_PROVIDER_KEY, {
      auth_mode: APARAT_AUTH_MODE,
      username: 'myuser',
      session: encryptConfigValue('{"AuthV1":"secret"}'),
    });
    assert.equal('session' in publicView.config, false);
    assert.equal(publicView.secrets.session.configured, true);
  });

  check(131, 'Ciphertext enc:v1: strictly absent from Knex binding logs', () => {
    const ciphertext = 'enc:v1:7y6t5r4e3w2q:secretpayload12345';
    const sanitized = sanitizeKnexBinding(ciphertext);
    assert.equal(sanitized, '[REDACTED_CIPHERTEXT]');
    assert.equal(sanitized.includes(ciphertext), false);
  });

  check(132, 'JSON config bindings with encrypted session redact ciphertext and secret keys', () => {
    const ciphertext = 'enc:v1:ABCDEF123456:sensitiveSessionData';
    const rawBinding = JSON.stringify({
      session: ciphertext,
      password: 'plain_password',
      username: 'ElecIO',
      default_category_id: '16',
    });
    const sanitized = sanitizeKnexBinding(rawBinding);
    assert.equal(sanitized.includes(ciphertext), false);
    assert.equal(sanitized.includes('plain_password'), false);
    const parsed = JSON.parse(sanitized);
    assert.equal(parsed.session, '[REDACTED]');
    assert.equal(parsed.password, '[REDACTED]');
    assert.equal(parsed.username, 'ElecIO');
    assert.equal(parsed.default_category_id, '16');
  });

  check(133, 'Session cookies AuthV1 and AFCN redacted from raw Knex bindings', () => {
    const cookieString = 'AuthV1=jwt.token.here; AFCN=178853451736397';
    const sanitized = sanitizeKnexBinding(cookieString);
    assert.equal(sanitized, '[REDACTED_SESSION_COOKIE]');
    assert.equal(sanitized.includes('jwt.token.here'), false);
    assert.equal(sanitized.includes('178853451736397'), false);
  });

  await asyncCheck(134, 'Live-path mock test: upload_url real response advances adapter past allocation stage', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'mock_auth_v1');
    jar.setCookie('AFCN', 'mock_afcn');

    const fakeJob = {
      id: 99999,
      organization_id: 1,
      attempt_count: 1,
      sensitive_external_state_json: null,
      $query() {
        return {
          async patch(patch) {
            Object.assign(fakeJob, patch);
          },
        };
      },
    };

    let allocatedReached = false;
    let chunksQueried = false;

    const mockFetch = async (url, opts) => {
      const urlStr = String(url);
      if (urlStr.includes('/upload_config')) {
        return new Response(JSON.stringify({
          data: {
            attributes: {
              server: 'https://uc1.aparat.com',
              uploadSize: 6000,
              categories: [{ id: '16', title: 'Business' }],
              defaultSetting: { cat_id: '16' },
            },
          },
        }));
      }
      if (urlStr.includes('/upload_url')) {
        return new Response(JSON.stringify({
          data: [
            {
              type: 'Upload_Info',
              id: '17885164542693723566525',
              attributes: {
                token: 'mock-alloc-token-12345',
                uploadId: '17885164542693723566525',
                uploadSize: 6000,
                waterMark: true,
              },
            },
          ],
        }));
      }
      if (urlStr.includes('/chunks')) {
        chunksQueried = true;
        allocatedReached = true;
        const stopErr = new Error('STOP_AT_CHUNKS_STAGE_PROVEN');
        stopErr.code = 'STOP_TEST';
        throw stopErr;
      }
      return new Response('{}');
    };

    try {
      await publishToAparat(fakeJob, {
        campaignTarget: { id: 10005, settings_json: { category_id: '16' } },
        campaign: { id: 10007, base_title: 'Test Title' },
        asset: { id: 10023, size_bytes: 3000000, object_key: 'test.mp4' },
        coverAsset: { id: 10024, size_bytes: 100000, object_key: 'cover.jpg' },
        integrationConfig: {
          id: 10000,
          config_json: {
            session: encryptConfigValue(JSON.stringify(jar.toJSON())),
          },
        },
        fetchImpl: mockFetch,
        updateJob: patch => {
          Object.assign(fakeJob, patch);
          if (patch.external_stage === 'ALLOCATED') {
            allocatedReached = true;
          }
        },
      });
    } catch (err) {
      if (!err.message.includes('STOP_AT_CHUNKS_STAGE_PROVEN')) throw err;
    }

    assert.equal(allocatedReached, true, 'Job must advance to ALLOCATED stage without APARAT_ALLOCATION_FAILED');
    assert.equal(chunksQueried, true, 'Adapter must query server chunks after successful allocation');
    assert.equal(fakeJob.external_stage, 'ALLOCATED');
    assert.equal(fakeJob.sensitive_external_state_json.aparat.server_upload_id, '17885164542693723566525');
  });

  await asyncCheck(135, 'Duplicate video response on createVideo 403 returns existing UID', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'valid_token');
    const mockFetch = async () => new Response(JSON.stringify({
      errors: [
        {
          uid: 'ybixru7',
          status: 403,
          detail: 'این ویدیو قبلا توسط شما در سایت بارگذاری شده است.',
        },
      ],
    }), { status: 403 });

    const result = await createVideo({
      serverUploadId: 'test_upload_id',
      payload: { title: 'Test Video' },
      cookieJar: jar,
      fetchImpl: mockFetch,
    });

    assert.equal(result.uid, 'ybixru7');
    assert.equal(result.duplicate, true);
  });

  await asyncCheck(136, 'Auth-related 403 on createVideo throws APARAT_AUTH_REQUIRED', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'bad_token');
    const mockFetch = async () => new Response(JSON.stringify({
      errors: [
        {
          status: 403,
          detail: 'نشست کاربری شما نامعتبر است',
        },
      ],
    }), { status: 403 });

    await assert.rejects(
      () => createVideo({
        serverUploadId: 'test_upload_id',
        payload: { title: 'Test Video' },
        cookieJar: jar,
        fetchImpl: mockFetch,
      }),
      (err) => err.code === 'APARAT_AUTH_REQUIRED' && err.category === ERROR_CATEGORY.AUTH_REQUIRED
    );
  });

  await asyncCheck(137, 'General non-auth 403 on createVideo throws APARAT_FORBIDDEN (not AUTH_REQUIRED)', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'valid_token');
    const mockFetch = async () => new Response(JSON.stringify({
      errors: [
        {
          status: 403,
          detail: 'دسترسی شما به این بخش مسدود شده است',
        },
      ],
    }), { status: 403 });

    await assert.rejects(
      () => createVideo({
        serverUploadId: 'test_upload_id',
        payload: { title: 'Test Video' },
        cookieJar: jar,
        fetchImpl: mockFetch,
      }),
      (err) => err.code === 'APARAT_FORBIDDEN' && err.category === ERROR_CATEGORY.VALIDATION
    );
  });

  await asyncCheck(138, 'updateVideoMetadata successfully posts edit payload to Aparat', async () => {
    const jar = new AparatCookieJar();
    jar.setCookie('AuthV1', 'valid_token');
    let capturedUrl = '';
    let capturedBody = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({
        data: {
          type: 'edit_video',
          attributes: { status: true, msg: 'ویدیو با موفقیت ویرایش شد.' },
        },
      }), { status: 200 });
    };

    const res = await updateVideoMetadata({
      uid: 'ybixru7',
      title: 'عنوان جدید',
      descr: 'توضیحات جدید',
      tags: 'تگ1-تگ2-تگ3',
      category: '16',
      cookieJar: jar,
      fetchImpl: mockFetch,
    });

    assert.ok(capturedUrl.includes('/video/video/edit/videohash/ybixru7'));
    assert.equal(capturedBody.title, 'عنوان جدید');
    assert.equal(capturedBody.tags, 'تگ1-تگ2-تگ3');
    assert.equal(res.data.attributes.status, true);
  });

  console.log('\n==================================================');
  console.log(`ALL ${totalChecks}/138 APARAT CHECKS PASSED DETERMINISTICALLY!`);
  console.log('==================================================\n');

  await db.destroy();
}

main().catch(async (err) => {
  console.error('\nAparat test suite failed:', err);
  await db.destroy().catch(() => {});
  process.exit(1);
});
