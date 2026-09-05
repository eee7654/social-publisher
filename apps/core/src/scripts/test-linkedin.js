import '../bootstrap.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import getDb from '../config/database.js';
import { INTEGRATION_PROVIDER_CATALOG } from '../integrations/types.js';
import { seedIntegrationProviders } from '../integrations/seeder.js';
import { getIntegrationConfigSchema } from '../integrations/configSchemas.js';
import { buildProviderConfig } from '../integrations/configSerializer.js';
import { decryptConfigValue, encryptConfigValue } from '../integrations/secrets.js';
import {
  LINKEDIN_API_VERSION,
  RESTLI_PROTOCOL_VERSION,
  LINKEDIN_SCOPES,
  LINKEDIN_CONNECTION_PURPOSE,
  LINKEDIN_CONNECTION_SOURCE,
  LINKEDIN_INTENT_STATUS,
  LINKEDIN_SUBJECT,
  LINKEDIN_WORKER_NAME,
} from '../publisher/platforms/linkedin/constants.js';
import {
  buildLinkedInAuthorizationUrl,
  buildLinkedInTicketUrl,
  createOpaqueState,
  exchangeLinkedInCodeForToken,
  hashState,
} from '../publisher/platforms/linkedin/oauth.js';
import {
  checkOrganizationAuthorization,
  createPost,
  finalizeVideoUpload,
  getOrganization,
  getOrganizationAcls,
  getStandardHeaders,
  getVideoStatus,
  initializeImageUpload,
  initializeVideoUpload,
  uploadImageBinary,
  uploadVideoPart,
} from '../publisher/platforms/linkedin/api.js';
import {
  activateVerifiedLinkedInConnection,
  cancelVerifiedLinkedInConnection,
  createTelegramLinkedInConnectionIntent,
  disconnectLinkedInConnection,
  getLinkedInConnectionState,
  getLinkedInProvider,
  startLinkedInOAuthFromTelegramTicket,
  reserveLinkedInCallbackIntent,
} from '../publisher/platforms/linkedin/connections.js';
import {
  CONNECTION_CALLBACKS,
  handleTelegramConnectionCallback,
  notifyTelegramLinkedInVerified,
  sendTelegramConnectionsMenu,
} from '../publisher/telegram/connections.js';
import { normalizeLinkedInError } from '../publisher/platforms/linkedin/errors.js';
import { reconcileLinkedInPost } from '../publisher/platforms/linkedin/reconciliation.js';
import { publishToLinkedIn } from '../publisher/platforms/linkedin/adapter.js';
import { linkedinPublishHandler } from '../publisher/handlers/linkedinPublishHandler.js';
import { ERROR_CATEGORY, JOB_STATUS } from '../publisher/constants.js';

const db = getDb();
let checksPassed = 0;

function check(desc, fn) {
  try {
    fn();
    checksPassed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    throw err;
  }
}

async function asyncCheck(desc, fn) {
  try {
    await fn();
    checksPassed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    throw err;
  }
}

async function run() {
  console.log('=== LinkedIn Real Publisher Test Suite (Phase 8) ===\n');

  // Ensure test database
  const [{ name: currentDb }] = (await db.raw('SELECT DATABASE() AS name'))[0];
  if (!currentDb?.endsWith('_test')) {
    throw new Error(`Refusing to run tests on non-test database: ${currentDb}`);
  }

  // --- SECTION 1: Catalog, Provider & Schema ---
  console.log('--- 1. Provider Catalog & Schema ---');
  check('1. Provider catalog includes publishing.linkedin', () => {
    const item = INTEGRATION_PROVIDER_CATALOG.find(p => p.code === 'linkedin' && p.domain === 'publishing');
    assert(item, 'LinkedIn provider not in catalog');
    assert.equal(item.adapter_key, 'publishing.linkedin');
  });

  await asyncCheck('2. seedIntegrationProviders seeds linkedin provider idempotently', async () => {
    await seedIntegrationProviders(db);
    const provider = await getLinkedInProvider(db);
    assert(provider, 'Provider not seeded');
    assert.equal(provider.code, 'linkedin');
    assert.equal(provider.adapter_key, 'publishing.linkedin');
  });

  check('3. Config schema declares all required secret and metadata fields', () => {
    const schema = getIntegrationConfigSchema('publishing.linkedin');
    assert(schema, 'Schema missing for publishing.linkedin');
    const fieldPaths = schema.fields.map(f => f.path);
    assert(fieldPaths.includes('access_token'));
    assert(fieldPaths.includes('refresh_token'));
    assert(fieldPaths.includes('expires_at'));
    assert(fieldPaths.includes('organization_urn'));
    assert(fieldPaths.includes('organization_id'));
    assert(fieldPaths.includes('organization_name'));
    assert(fieldPaths.includes('vanity_name'));
  });

  check('4. Config serializer encrypts access_token and refresh_token with enc:v1:', () => {
    const raw = {
      access_token: 'test_access_token_123',
      refresh_token: 'test_refresh_token_456',
      organization_urn: 'urn:li:organization:12345',
      organization_id: '12345',
      organization_name: 'ElecIO Test',
    };
    const built = buildProviderConfig({
      adapterKey: 'publishing.linkedin',
      submitted: raw,
      isCreate: true,
    });
    assert(built.access_token.startsWith('enc:v1:'));
    assert(built.refresh_token.startsWith('enc:v1:'));
    assert.equal(decryptConfigValue(built.access_token), 'test_access_token_123');
    assert.equal(decryptConfigValue(built.refresh_token), 'test_refresh_token_456');
  });

  check('5. Config serializer stores safe non-secret metadata in plaintext', () => {
    const raw = {
      access_token: 'test_token',
      organization_urn: 'urn:li:organization:9876',
      organization_id: '9876',
      organization_name: 'ElecIO',
      vanity_name: 'elecio',
    };
    const built = buildProviderConfig({
      adapterKey: 'publishing.linkedin',
      submitted: raw,
      isCreate: true,
    });
    assert.equal(built.organization_urn, 'urn:li:organization:9876');
    assert.equal(built.organization_id, '9876');
    assert.equal(built.organization_name, 'ElecIO');
    assert.equal(built.vanity_name, 'elecio');
  });

  check('6. Config serializer drops undeclared keys', () => {
    const raw = {
      access_token: 'test_token',
      unauthorized_secret: 'evil_key',
    };
    const built = buildProviderConfig({
      adapterKey: 'publishing.linkedin',
      submitted: raw,
      isCreate: true,
    });
    assert.equal(built.unauthorized_secret, undefined);
  });

  // --- SECTION 2: Constants & OAuth Helpers ---
  console.log('\n--- 2. Constants & OAuth URL / Token Helpers ---');
  check('7. LinkedIn API version is pinned to 202608', () => {
    assert.equal(LINKEDIN_API_VERSION, '202608');
  });

  check('8. Restli protocol version is pinned to 2.0.0', () => {
    assert.equal(RESTLI_PROTOCOL_VERSION, '2.0.0');
  });

  check('9. LinkedIn scopes contain only provisioned company page scopes', () => {
    assert.deepEqual([...LINKEDIN_SCOPES], ['rw_organization_admin', 'w_organization_social', 'r_organization_social']);
  });

  check('10. getStandardHeaders outputs required version and auth headers', () => {
    const headers = getStandardHeaders('my_token');
    assert.equal(headers['Authorization'], 'Bearer my_token');
    assert.equal(headers['LinkedIn-Version'], '202608');
    assert.equal(headers['X-Restli-Protocol-Version'], '2.0.0');
  });

  check('11. buildLinkedInAuthorizationUrl formats authorization endpoint and query params', () => {
    const urlStr = buildLinkedInAuthorizationUrl({
      clientId: 'mock_client_id',
      redirectUri: 'https://app.elecio.ir/callback',
      state: 'mock_state_123',
    });
    const url = new URL(urlStr);
    assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
    assert.equal(url.searchParams.get('client_id'), 'mock_client_id');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.elecio.ir/callback');
    assert.equal(url.searchParams.get('state'), 'mock_state_123');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('scope'), LINKEDIN_SCOPES.join(' '));
  });

  check('12. State generation and hashing works as expected', () => {
    const state = createOpaqueState();
    assert.equal(typeof state, 'string');
    assert(state.length > 20);
    const hash = hashState(state);
    assert.equal(hash.length, 64);
    assert.equal(hash, hashState(state));
  });

  check('13. buildLinkedInTicketUrl formats local or configured connect URL', () => {
    const ticketUrl = buildLinkedInTicketUrl('test_ticket_abc');
    const parsed = new URL(ticketUrl);
    assert.equal(parsed.searchParams.get('t'), 'test_ticket_abc');
    assert(parsed.pathname.endsWith('/api/linkedin/connect'));
  });

  await asyncCheck('14. exchangeLinkedInCodeForToken handles full token payload', async () => {
    const mockFetch = async (url, opts) => {
      assert.equal(url, 'https://www.linkedin.com/oauth/v2/accessToken');
      assert.equal(opts.method, 'POST');
      assert(opts.body.includes('grant_type=authorization_code'));
      return {
        ok: true,
        json: async () => ({
          access_token: 'mock_access_token',
          expires_in: 5184000,
          refresh_token: 'mock_refresh_token',
          refresh_token_expires_in: 31536000,
          scope: 'rw_organization_admin w_organization_social r_organization_social',
        }),
      };
    };

    const tokens = await exchangeLinkedInCodeForToken({
      code: 'test_code',
      clientId: 'id',
      clientSecret: 'sec',
      redirectUri: 'uri',
      fetchImpl: mockFetch,
    });
    assert.equal(tokens.accessToken, 'mock_access_token');
    assert.equal(tokens.expiresIn, 5184000);
    assert.equal(tokens.refreshToken, 'mock_refresh_token');
  });

  await asyncCheck('15. exchangeLinkedInCodeForToken handles payload without optional refresh_token', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        access_token: 'mock_access_token_only',
        expires_in: 5184000,
      }),
    });

    const tokens = await exchangeLinkedInCodeForToken({
      code: 'test_code',
      clientId: 'id',
      clientSecret: 'sec',
      redirectUri: 'uri',
      fetchImpl: mockFetch,
    });
    assert.equal(tokens.accessToken, 'mock_access_token_only');
    assert.equal(tokens.refreshToken, null);
  });

  await asyncCheck('16. exchangeLinkedInCodeForToken throws descriptive error on non-200', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Authorization code has expired',
      }),
    });

    await assert.rejects(
      () => exchangeLinkedInCodeForToken({ code: 'c', clientId: 'i', clientSecret: 's', redirectUri: 'u', fetchImpl: mockFetch }),
      /Authorization code has expired/
    );
  });

  // --- SECTION 3: Organization Discovery & API ---
  console.log('\n--- 3. Organization ACLs & Discovery ---');
  await asyncCheck('17. getOrganizationAcls queries rest/organizationAcls with version headers', async () => {
    const mockFetch = async (url, opts) => {
      assert(url.includes('/rest/organizationAcls?q=roleAssignee'));
      assert.equal(opts.headers['LinkedIn-Version'], '202608');
      return {
        ok: true,
        json: async () => ({
          elements: [
            { role: 'ADMINISTRATOR', organization: 'urn:li:organization:12345', state: 'APPROVED' },
          ],
        }),
      };
    };

    const acls = await getOrganizationAcls('token', { fetchImpl: mockFetch });
    assert.equal(acls.length, 1);
    assert.equal(acls[0].organization, 'urn:li:organization:12345');
    assert.equal(acls[0].role, 'ADMINISTRATOR');
  });

  await asyncCheck('18. getOrganization resolves organization details', async () => {
    const mockFetch = async (url) => {
      assert(url.includes('/rest/organizations/12345'));
      return {
        ok: true,
        json: async () => ({
          id: 12345,
          localizedName: 'ElecIO Official',
          vanityName: 'elecio-iran',
        }),
      };
    };

    const org = await getOrganization('token', 'urn:li:organization:12345', { fetchImpl: mockFetch });
    assert.equal(org.id, '12345');
    assert.equal(org.urn, 'urn:li:organization:12345');
    assert.equal(org.localizedName, 'ElecIO Official');
    assert.equal(org.vanityName, 'elecio-iran');
  });

  await asyncCheck('19. checkOrganizationAuthorization approves ADMINISTRATOR role via ACL', async () => {
    const mockFetch = async (url) => {
      if (url.includes('organizationAuthorizations')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return {
        ok: true,
        json: async () => ({
          elements: [
            { role: 'ADMINISTRATOR', organization: 'urn:li:organization:12345', state: 'APPROVED' },
          ],
        }),
      };
    };

    const authResult = await checkOrganizationAuthorization('token', 'urn:li:organization:12345', { fetchImpl: mockFetch });
    assert.equal(authResult.authorized, true);
    assert.equal(authResult.role, 'ADMINISTRATOR');
  });

  await asyncCheck('20. checkOrganizationAuthorization rejects unapproved or missing role', async () => {
    const mockFetch = async (url) => {
      if (url.includes('organizationAuthorizations')) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          elements: [
            { role: 'VIEWER', organization: 'urn:li:organization:12345', state: 'APPROVED' },
          ],
        }),
      };
    };

    const authResult = await checkOrganizationAuthorization('token', 'urn:li:organization:12345', { fetchImpl: mockFetch });
    assert.equal(authResult.authorized, false);
  });

  // --- SECTION 4: Database Intent Lifecycle & Telegram Flow ---
  console.log('\n--- 4. Intent Lifecycle & Telegram /connections ---');
  let testUserId;
  let testOrgId;

  await asyncCheck('21. Set up test tenant organization and user membership in test DB', async () => {
    const slug = `li-test-${Date.now()}`;
    const [orgId] = await db('organizations').insert({
      name: `LinkedIn Test Org ${Date.now()}`,
      slug,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    testOrgId = orgId;

    const admin = await db('roles').where({ name: 'admin' }).first();
    testUserId = crypto.randomUUID();
    await db('user').insert({
      id: testUserId,
      name: 'LinkedIn Test User',
      email: `li_test_${Date.now()}@example.com`,
      emailVerified: false,
      role_id: admin ? admin.id : 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const roleRow = await db('roles').first();
    await db('user_organization_roles').insert({
      user_id: testUserId,
      organization_id: testOrgId,
      role_id: roleRow ? roleRow.id : 1,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  });

  let telegramTicket;
  let intentId;

  await asyncCheck('22. createTelegramLinkedInConnectionIntent creates pending intent', async () => {
    const result = await createTelegramLinkedInConnectionIntent({
      telegramUserId: 'tg_12345',
      telegramChatId: 'tg_chat_12345',
      userId: testUserId,
      organizationId: testOrgId,
    });
    assert(result.intent);
    assert(result.browserTicket);
    assert(result.browserUrl);
    telegramTicket = result.browserTicket;
    intentId = result.intent.id;

    const saved = await db('integration_connection_intents').where({ id: intentId }).first();
    assert.equal(saved.status, LINKEDIN_INTENT_STATUS.PENDING);
    assert.equal(saved.source, LINKEDIN_CONNECTION_SOURCE.TELEGRAM);
  });

  await asyncCheck('23. startLinkedInOAuthFromTelegramTicket consumes ticket and yields auth URL', async () => {
    const started = await startLinkedInOAuthFromTelegramTicket({
      ticket: telegramTicket,
      oauthConfig: { clientId: 'client_id', redirectUri: 'https://test/cb' },
    });
    assert.equal(started.ok, true);
    assert(started.authorizationUrl);

    const saved = await db('integration_connection_intents').where({ id: intentId }).first();
    assert.equal(saved.browser_ticket_hash, null);
    assert(saved.browser_ticket_reserved_at);
  });

  await asyncCheck('24. startLinkedInOAuthFromTelegramTicket refuses replay of same ticket', async () => {
    const replay = await startLinkedInOAuthFromTelegramTicket({
      ticket: telegramTicket,
      oauthConfig: { clientId: 'client_id', redirectUri: 'https://test/cb' },
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'INVALID_OR_EXPIRED_TICKET');
  });

  await asyncCheck('25. reserveLinkedInCallbackIntent validates state and reserves intent', async () => {
    const testState = createOpaqueState();
    const saved = await db('integration_connection_intents').where({ id: intentId }).first();
    await db('integration_connection_intents').where({ id: intentId }).update({
      nonce_hash: hashState(testState),
    });

    const reservation = await reserveLinkedInCallbackIntent({ state: testState });
    assert.equal(reservation.ok, true);
    assert.equal(reservation.intent.id, intentId);

    const updated = await db('integration_connection_intents').where({ id: intentId }).first();
    assert.equal(updated.status, LINKEDIN_INTENT_STATUS.RESERVED);
    assert(updated.reserved_at);
  });

  await asyncCheck('26. reserveLinkedInCallbackIntent rejects used state', async () => {
    const replayState = 'invalid_state';
    const reservation = await reserveLinkedInCallbackIntent({ state: replayState });
    assert.equal(reservation.ok, false);
  });

  await asyncCheck('27. activateVerifiedLinkedInConnection activates IntegrationConfig with encrypted tokens', async () => {
    const orgUrn = 'urn:li:organization:77777';
    await db('integration_connection_intents').where({ id: intentId }).update({
      status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: orgUrn,
      verified_channel_title: 'ElecIO Active Company Page',
      pending_secret_json: JSON.stringify({
        access_token: encryptConfigValue('live_token_secret_123'),
        refresh_token: encryptConfigValue('live_refresh_secret_456'),
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        organization_id: '77777',
        vanity_name: 'elecio-live',
      }),
    });

    const activated = await activateVerifiedLinkedInConnection({
      intentId,
      userId: testUserId,
      organizationId: testOrgId,
      organizationUrn: orgUrn,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    });
    assert.equal(activated.ok, true);
    assert(activated.config);

    const config = await db('integration_configs').where({ id: activated.config.id }).first();
    assert.equal(config.status, 'active');
    assert.equal(config.external_account_id, orgUrn);
    assert.equal(config.external_account_name, 'ElecIO Active Company Page');

    const configJson = typeof config.config_json === 'string' ? JSON.parse(config.config_json) : config.config_json;
    assert(configJson.access_token.startsWith('enc:v1:'));
    assert.equal(decryptConfigValue(configJson.access_token), 'live_token_secret_123');
  });

  await asyncCheck('28. activateVerifiedLinkedInConnection prevents cross-tenant activation', async () => {
    const fraudIntentId = crypto.randomUUID();
    const [otherOrgId] = await db('organizations').insert({
      name: `Other Tenant ${Date.now()}`,
      slug: `other-tenant-${Date.now()}`,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    const provider = await getLinkedInProvider(db);

    await db('integration_connection_intents').insert({
      id: fraudIntentId,
      nonce_hash: hashState(createOpaqueState()),
      user_id: testUserId,
      organization_id: otherOrgId,
      provider_id: provider.id,
      purpose: LINKEDIN_CONNECTION_PURPOSE,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
      status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: 'urn:li:organization:88888',
      expires_at: new Date(Date.now() + 1000000).toISOString().slice(0, 19).replace('T', ' '),
    });

    const crossTenantAttempt = await activateVerifiedLinkedInConnection({
      intentId: fraudIntentId,
      userId: testUserId,
      organizationId: testOrgId, // Mismatched org
      organizationUrn: 'urn:li:organization:88888',
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    });
    assert.equal(crossTenantAttempt.ok, false);
  });

  await asyncCheck('29. getLinkedInConnectionState reports connected: true for active config', async () => {
    const state = await getLinkedInConnectionState(testOrgId);
    assert.equal(state.connected, true);
    assert.equal(state.isExpired, false);
    assert(state.config);
  });

  await asyncCheck('30. getLinkedInConnectionState reports connected: false when expired', async () => {
    const provider = await getLinkedInProvider(db);
    await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id })
      .update({
        expires_at: new Date(Date.now() - 10000).toISOString().slice(0, 19).replace('T', ' '),
      });

    const state = await getLinkedInConnectionState(testOrgId);
    assert.equal(state.connected, false);
    assert.equal(state.isExpired, true);

    // Restore for subsequent tests
    await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id })
      .update({
        expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 19).replace('T', ' '),
      });
  });

  await asyncCheck('31. disconnectLinkedInConnection marks config inactive', async () => {
    const result = await disconnectLinkedInConnection({ organizationId: testOrgId, userId: testUserId });
    assert.equal(result.ok, true);

    const state = await getLinkedInConnectionState(testOrgId);
    assert.equal(state.connected, false);

    // Reactivate for worker tests
    const provider = await getLinkedInProvider(db);
    await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id })
      .update({ status: 'active', deleted_at: null });
  });

  await asyncCheck('32. cancelVerifiedLinkedInConnection wipes secrets and marks cancelled', async () => {
    const cancelIntentId = crypto.randomUUID();
    const provider = await getLinkedInProvider(db);

    await db('integration_connection_intents').insert({
      id: cancelIntentId,
      nonce_hash: hashState(createOpaqueState()),
      user_id: testUserId,
      organization_id: testOrgId,
      provider_id: provider.id,
      purpose: LINKEDIN_CONNECTION_PURPOSE,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
      status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: 'urn:li:organization:99999',
      pending_secret_json: JSON.stringify({ access_token: 'secret' }),
      expires_at: new Date(Date.now() + 1000000).toISOString().slice(0, 19).replace('T', ' '),
    });

    const res = await cancelVerifiedLinkedInConnection({
      intentId: cancelIntentId,
      userId: testUserId,
      organizationId: testOrgId,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
    });
    assert.equal(res.ok, true);

    const saved = await db('integration_connection_intents').where({ id: cancelIntentId }).first();
    assert.equal(saved.status, LINKEDIN_INTENT_STATUS.CANCELLED);
    assert.equal(saved.pending_secret_json, null);
  });

  // --- SECTION 5: Telegram Menu & Message Rendering ---
  console.log('\n--- 5. Telegram Menu & Notifications ---');
  await asyncCheck('33. sendTelegramConnectionsMenu displays LinkedIn disconnected and Connect button', async () => {
    const messages = [];
    const mockTelegram = {
      sendMessage: async (msg) => { messages.push(msg); return { ok: true }; },
    };

    // Temporarily deactivate config
    const provider = await getLinkedInProvider(db);
    await db('integration_configs').where({ organization_id: testOrgId, provider_id: provider.id }).update({ status: 'inactive' });

    await sendTelegramConnectionsMenu({
      telegramClient: mockTelegram,
      chatId: '123',
      binding: { organization_id: testOrgId, user_id: testUserId, telegram_user_id: 'tg_1' },
    });

    assert(messages.length > 0);
    assert(messages[0].text.includes('LinkedIn: disconnected'));
    const buttons = messages[0].reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.text === 'Connect LinkedIn'));

    // Reactivate
    await db('integration_configs').where({ organization_id: testOrgId, provider_id: provider.id }).update({ status: 'active' });
  });

  await asyncCheck('34. sendTelegramConnectionsMenu displays LinkedIn connected and Reconnect/Disconnect buttons', async () => {
    const messages = [];
    const mockTelegram = {
      sendMessage: async (msg) => { messages.push(msg); return { ok: true }; },
    };

    await sendTelegramConnectionsMenu({
      telegramClient: mockTelegram,
      chatId: '123',
      binding: { organization_id: testOrgId, user_id: testUserId, telegram_user_id: 'tg_1' },
    });

    assert(messages.length > 0);
    assert(messages[0].text.includes('LinkedIn: connected'));
    const buttons = messages[0].reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.text === 'Reconnect LinkedIn'));
    assert(buttons.some(b => b.text === 'Disconnect LinkedIn'));
  });

  await asyncCheck('35. sendTelegramConnectionsMenu displays pending confirmation when intent is ready', async () => {
    const pendingId = crypto.randomUUID();
    const provider = await getLinkedInProvider(db);
    await db('integration_connection_intents').insert({
      id: pendingId,
      nonce_hash: hashState(createOpaqueState()),
      user_id: testUserId,
      organization_id: testOrgId,
      provider_id: provider.id,
      purpose: LINKEDIN_CONNECTION_PURPOSE,
      source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
      status: LINKEDIN_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: 'urn:li:organization:123',
      verified_channel_title: 'Pending ElecIO Page',
      expires_at: new Date(Date.now() + 1000000).toISOString().slice(0, 19).replace('T', ' '),
    });

    const messages = [];
    const mockTelegram = {
      sendMessage: async (msg) => { messages.push(msg); return { ok: true }; },
    };

    await sendTelegramConnectionsMenu({
      telegramClient: mockTelegram,
      chatId: '123',
      binding: { organization_id: testOrgId, user_id: testUserId, telegram_user_id: 'tg_1' },
    });

    assert(messages[0].text.includes('LinkedIn: pending confirmation'));
    const buttons = messages[0].reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.text === 'Confirm LinkedIn'));
    assert(buttons.some(b => b.text === 'Cancel LinkedIn'));

    // Clean up
    await db('integration_connection_intents').where({ id: pendingId }).delete();
  });

  await asyncCheck('36. notifyTelegramLinkedInVerified sends card with confirm/cancel buttons', async () => {
    const messages = [];
    const mockTelegram = {
      sendMessage: async (msg) => { messages.push(msg); return { ok: true }; },
    };

    await notifyTelegramLinkedInVerified({
      intent: {
        id: 'test_intent',
        telegram_chat_id: 'chat_999',
        verified_channel_id: 'urn:li:organization:55555',
        verified_channel_title: 'ElecIO Verified',
        organization_id: testOrgId,
        source: LINKEDIN_CONNECTION_SOURCE.TELEGRAM,
      },
      telegramClient: mockTelegram,
    });

    assert.equal(messages.length, 1);
    assert(messages[0].text.includes('LinkedIn Company Page verified'));
    assert(messages[0].text.includes('Page: ElecIO Verified'));
    assert(messages[0].text.includes('URN: urn:li:organization:55555'));
    const buttons = messages[0].reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.text === 'Confirm connection'));
    assert(buttons.some(b => b.text === 'Cancel'));
  });

  // --- SECTION 6: Posts API & Single-Image Upload ---
  console.log('\n--- 6. Posts API & Image Upload ---');
  await asyncCheck('37. createPost sends correct REST body and version headers for text post', async () => {
    let capturedReq = null;
    const mockFetch = async (url, opts) => {
      capturedReq = { url, opts };
      return {
        status: 201,
        headers: new Map([['x-restli-id', 'urn:li:share:123456789']]),
        json: async () => ({}),
      };
    };

    const res = await createPost('test_token', {
      authorUrn: 'urn:li:organization:999',
      commentary: 'Hello LinkedIn world from ElecIO!',
    }, { fetchImpl: mockFetch });

    assert.equal(res.status, 201);
    assert.equal(res.postId, 'urn:li:share:123456789');
    assert.equal(capturedReq.opts.headers['LinkedIn-Version'], '202608');
    assert.equal(capturedReq.opts.headers['X-Restli-Protocol-Version'], '2.0.0');

    const body = JSON.parse(capturedReq.opts.body);
    assert.equal(body.author, 'urn:li:organization:999');
    assert.equal(body.commentary, 'Hello LinkedIn world from ElecIO!');
    assert.equal(body.visibility, 'PUBLIC');
    assert.equal(body.distribution.feedDistribution, 'MAIN_FEED');
    assert.equal(body.content, undefined);
  });

  await asyncCheck('38. createPost attaches media URN when provided', async () => {
    let capturedReq = null;
    const mockFetch = async (url, opts) => {
      capturedReq = { url, opts };
      return {
        status: 201,
        headers: new Map([['x-restli-id', 'urn:li:share:987654321']]),
        json: async () => ({}),
      };
    };

    const res = await createPost('test_token', {
      authorUrn: 'urn:li:organization:999',
      commentary: 'Look at this product!',
      mediaUrn: 'urn:li:image:D4E10AQHxxx',
      title: 'ElecIO Product Image',
    }, { fetchImpl: mockFetch });

    assert.equal(res.status, 201);
    assert.equal(res.postId, 'urn:li:share:987654321');
    const body = JSON.parse(capturedReq.opts.body);
    assert.equal(body.content.media.id, 'urn:li:image:D4E10AQHxxx');
    assert.equal(body.content.media.title, 'ElecIO Product Image');
  });

  await asyncCheck('39. createPost throws on non-201 response with safe message', async () => {
    const mockFetch = async () => ({
      status: 400,
      json: async () => ({ message: 'Invalid commentary format' }),
    });

    await assert.rejects(
      () => createPost('token', { authorUrn: 'urn:li:org:1', commentary: '' }, { fetchImpl: mockFetch }),
      /Invalid commentary format/
    );
  });

  await asyncCheck('40. initializeImageUpload requests upload URL for organization', async () => {
    let capturedReq = null;
    const mockFetch = async (url, opts) => {
      capturedReq = { url, opts };
      return {
        ok: true,
        json: async () => ({
          value: {
            uploadUrl: 'https://api.linkedin.com/mediaUpload/123',
            image: 'urn:li:image:IMAGE_URN_123',
            uploadUrlExpiresAt: 1756900000000,
          },
        }),
      };
    };

    const result = await initializeImageUpload('token', 'urn:li:organization:123', { fetchImpl: mockFetch });
    assert.equal(result.uploadUrl, 'https://api.linkedin.com/mediaUpload/123');
    assert.equal(result.imageUrn, 'urn:li:image:IMAGE_URN_123');

    const body = JSON.parse(capturedReq.opts.body);
    assert.equal(body.initializeUploadRequest.owner, 'urn:li:organization:123');
  });

  await asyncCheck('41. uploadImageBinary streams binary with duplex: half', async () => {
    let capturedOpts = null;
    const mockFetch = async (url, opts) => {
      capturedOpts = opts;
      return { ok: true, status: 201 };
    };

    const stream = Readable.from(['image_binary_data']);
    const res = await uploadImageBinary('https://upload.url', stream, 'image/jpeg', 17, { fetchImpl: mockFetch });
    assert.equal(res.ok, true);
    assert.equal(capturedOpts.method, 'PUT');
    assert.equal(capturedOpts.headers['Content-Type'], 'image/jpeg');
    assert.equal(capturedOpts.headers['Content-Length'], '17');
    assert.equal(capturedOpts.duplex, 'half');
  });

  // --- SECTION 7: Error Classification & Reconciliation ---
  console.log('\n--- 7. Error Classification & Reconciliation ---');
  check('42. normalizeLinkedInError maps 401 to AUTH_REQUIRED', () => {
    const err = normalizeLinkedInError({ status: 401, message: 'Expired' });
    assert.equal(err.category, ERROR_CATEGORY.AUTH_REQUIRED);
    assert.equal(err.code, 'LINKEDIN_AUTH_REQUIRED');
  });

  check('43. normalizeLinkedInError maps 403 to AUTH_REQUIRED (permission denied)', () => {
    const err = normalizeLinkedInError({ status: 403, message: 'Not an administrator' });
    assert.equal(err.category, ERROR_CATEGORY.AUTH_REQUIRED);
    assert.equal(err.code, 'LINKEDIN_PERMISSION_DENIED');
  });

  check('44. normalizeLinkedInError maps 429 to RATE_LIMIT with retryAfterMs parsed', () => {
    const err = normalizeLinkedInError({
      status: 429,
      headers: new Map([['retry-after', '120']]),
    });
    assert.equal(err.category, ERROR_CATEGORY.RATE_LIMIT);
    assert.equal(err.code, 'LINKEDIN_RATE_LIMIT');
    assert.equal(err.retryAfterMs, 120000);
  });

  check('45. normalizeLinkedInError maps 400 to VALIDATION', () => {
    const err = normalizeLinkedInError({ status: 400, message: 'Duplicate content' });
    assert.equal(err.category, ERROR_CATEGORY.VALIDATION);
    assert.equal(err.code, 'LINKEDIN_VALIDATION_ERROR');
  });

  check('46. normalizeLinkedInError maps 500 to PLATFORM_5XX', () => {
    const err = normalizeLinkedInError({ status: 503, message: 'Service Unavailable' });
    assert.equal(err.category, ERROR_CATEGORY.PLATFORM_5XX);
    assert.equal(err.code, 'LINKEDIN_SERVER_ERROR');
  });

  check('47. normalizeLinkedInError maps transient network abort to TRANSIENT_NETWORK', () => {
    const raw = new Error('Socket closed');
    raw.code = 'ECONNRESET';
    const err = normalizeLinkedInError(raw);
    assert.equal(err.category, ERROR_CATEGORY.TRANSIENT_NETWORK);
    assert.equal(err.code, 'LINKEDIN_NETWORK_TRANSIENT');
  });

  check('48. normalizeLinkedInError maps ambiguous network outcome to AMBIGUOUS_EXTERNAL_STATE', () => {
    const raw = new Error('Timeout waiting for response');
    const err = normalizeLinkedInError(raw, { isAmbiguous: true });
    assert.equal(err.category, ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE);
    assert.equal(err.code, 'LINKEDIN_AMBIGUOUS_STATE');
  });

  await asyncCheck('49. reconcileLinkedInPost discovers matching post by commentary and recovers ID', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        elements: [
          { id: 'urn:li:share:MATCHED_POST_ID', author: 'urn:li:organization:123', commentary: 'Specific live promo text' },
          { id: 'urn:li:share:OTHER_POST_ID', author: 'urn:li:organization:123', commentary: 'Other promo text' },
        ],
      }),
    });

    const res = await reconcileLinkedInPost({
      accessToken: 'token',
      organizationUrn: 'urn:li:organization:123',
      expectedCommentary: 'Specific live promo text',
    }, { fetchImpl: mockFetch });

    assert.equal(res.reconciled, true);
    assert.equal(res.postId, 'urn:li:share:MATCHED_POST_ID');
  });

  await asyncCheck('50. reconcileLinkedInPost returns reconciled: false when not found', async () => {
    const mockFetch = async () => ({
      ok: true,
      json: async () => ({
        elements: [
          { id: 'urn:li:share:OTHER_POST_ID', author: 'urn:li:organization:123', commentary: 'Different text' },
        ],
      }),
    });

    const res = await reconcileLinkedInPost({
      accessToken: 'token',
      organizationUrn: 'urn:li:organization:123',
      expectedCommentary: 'Missing text',
    }, { fetchImpl: mockFetch });

    assert.equal(res.reconciled, false);
  });

  // --- SECTION 8: Adapter & Worker Handler ---
  console.log('\n--- 8. Adapter & Worker Handler Execution ---');
  let configRow;
  await asyncCheck('51. Fetch active integration config for worker tests', async () => {
    const provider = await getLinkedInProvider(db);
    configRow = await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id, status: 'active' })
      .first();
    assert(configRow);
  });

  await asyncCheck('52. publishToLinkedIn successfully publishes text post', async () => {
    const mockJob = { id: 101, external_media_id: null };
    const patches = [];
    const mockFetch = async (url, opts) => {
      return {
        status: 201,
        headers: new Map([['x-restli-id', 'urn:li:share:POST_101']]),
        json: async () => ({}),
      };
    };

    const result = await publishToLinkedIn(mockJob, {
      campaignTarget: { title_override: 'Test Title', caption_override: 'My post caption' },
      campaign: { title: 'Camp', caption: 'Camp caption' },
      integrationConfig: configRow,
      updateJob: async (patch) => { patches.push(patch); },
      fetchImpl: mockFetch,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.external_media_id, 'urn:li:share:POST_101');
    assert(patches.some(p => p.external_stage === 'PUBLISHING_POST'));
    assert(patches.some(p => p.external_media_id === 'urn:li:share:POST_101'));
  });

  await asyncCheck('53. publishToLinkedIn successfully publishes single-image post', async () => {
    const mockJob = { id: 102, external_media_id: null };
    const patches = [];
    const mockFetch = async (url, opts) => {
      if (url.includes('/images?action=initializeUpload')) {
        return {
          ok: true,
          json: async () => ({
            value: {
              uploadUrl: 'https://upload.url/img102',
              image: 'urn:li:image:IMG_102',
            },
          }),
        };
      }
      if (url.includes('https://upload.url/img102')) {
        return { ok: true, status: 201 };
      }
      if (url.includes('/rest/posts')) {
        const body = JSON.parse(opts.body);
        assert.equal(body.content.media.id, 'urn:li:image:IMG_102');
        return {
          status: 201,
          headers: new Map([['x-restli-id', 'urn:li:share:POST_IMG_102']]),
          json: async () => ({}),
        };
      }
      throw new Error(`Unexpected url ${url}`);
    };

    const mockS3Stream = async () => Readable.from(['fake_image_bytes']);

    const result = await publishToLinkedIn(mockJob, {
      campaignTarget: { title_override: 'Image Post', caption_override: 'Check this image!' },
      campaign: { title: 'Camp' },
      asset: { mime_type: 'image/jpeg', size_bytes: 1234, object_key: 'test/img.jpg' },
      integrationConfig: configRow,
      updateJob: async (patch) => { patches.push(patch); },
      fetchImpl: mockFetch,
      s3StreamFactory: mockS3Stream,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.external_media_id, 'urn:li:share:POST_IMG_102');
  });

  await asyncCheck('54. publishToLinkedIn reconciles and succeeds on ambiguous network drop after submission', async () => {
    const mockJob = { id: 103, external_media_id: null };
    const patches = [];

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/posts') && opts.method === 'POST') {
        const abortErr = new Error('Connection reset by peer');
        abortErr.code = 'ECONNRESET';
        throw abortErr;
      }
      if (url.includes('/rest/posts?') && opts.method === 'GET') {
        // Reconciliation search returns the created post
        return {
          ok: true,
          json: async () => ({
            elements: [
              { id: 'urn:li:share:RECONCILED_103', author: configRow.external_account_id, commentary: 'Network dropped but succeeded' },
            ],
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    };

    const result = await publishToLinkedIn(mockJob, {
      campaignTarget: { caption_override: 'Network dropped but succeeded' },
      campaign: { title: 'Camp' },
      integrationConfig: configRow,
      updateJob: async (patch) => { patches.push(patch); },
      fetchImpl: mockFetch,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.external_media_id, 'urn:li:share:RECONCILED_103');
  });

  await asyncCheck('55. publishToLinkedIn idempotency skips publication if external_media_id is already set', async () => {
    const alreadyPublishedJob = { id: 104, external_media_id: 'urn:li:share:ALREADY_EXISTS' };
    let fetchCalled = false;
    const mockFetch = async () => { fetchCalled = true; };

    const res = await publishToLinkedIn(alreadyPublishedJob, {
      campaignTarget: { caption_override: 'Test' },
      campaign: { title: 'C' },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(res.external_media_id, 'urn:li:share:ALREADY_EXISTS');
    assert.equal(fetchCalled, false);
  });

  await asyncCheck('56. linkedinPublishHandler validates tenant isolation and executes publish', async () => {
    // Insert campaign, target, job
    const [cId] = await db('campaigns').insert({
      organization_id: testOrgId,
      source_type: 'manual',
      base_title: 'Handler Title',
      base_caption: 'Handler Caption',
      status: 'ready',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [tId] = await db('campaign_targets').insert({
      campaign_id: cId,
      platform: 'linkedin',
      integration_config_id: configRow.id,
      status: 'ready',
      caption_override: 'Handler test post',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [jId] = await db('publish_jobs').insert({
      organization_id: testOrgId,
      campaign_target_id: tId,
      idempotency_key: `test-li-handler-${Date.now()}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const mockFetch = async (url) => {
      return {
        status: 201,
        headers: new Map([['x-restli-id', 'urn:li:share:HANDLER_SUCCESS_ID']]),
        json: async () => ({}),
      };
    };

    const res = await linkedinPublishHandler({
      jobId: jId,
      organizationId: testOrgId,
      campaignTargetId: tId,
      signal: new AbortController().signal,
      fetchImpl: mockFetch,
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(res.external_media_id, 'urn:li:share:HANDLER_SUCCESS_ID');
  });

  await asyncCheck('57. linkedinPublishHandler rejects target belonging to different organization', async () => {
    const [otherOrgId] = await db('organizations').insert({
      name: `Other Tenant 2 ${Date.now()}`,
      slug: `other-tenant-2-${Date.now()}`,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [otherCampId] = await db('campaigns').insert({
      organization_id: otherOrgId,
      source_type: 'manual',
      base_title: 'Other Title',
      status: 'ready',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [tId] = await db('campaign_targets').insert({
      campaign_id: otherCampId,
      platform: 'linkedin',
      integration_config_id: configRow.id,
      status: 'ready',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [jId] = await db('publish_jobs').insert({
      organization_id: otherOrgId,
      campaign_target_id: tId,
      idempotency_key: `fraud-job-${Date.now()}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    await assert.rejects(
      () => linkedinPublishHandler({
        jobId: jId,
        organizationId: testOrgId, // Mismatched tenant
        campaignTargetId: tId,
      }),
      /target was not found/
    );
  });

  // --- SECTION 9: Operator CLI Safety Guard ---
  console.log('\n--- 9. Operator CLI Safety Guard ---');
  await asyncCheck('58. operator-linkedin-live-test CLI refuses execution without LINKEDIN_LIVE_TEST=true', async () => {
    const originalEnv = process.env.LINKEDIN_LIVE_TEST;
    delete process.env.LINKEDIN_LIVE_TEST;

    // Check script contents have safety guard
    const fs = await import('node:fs/promises');
    const cliSource = await fs.readFile(new URL('./operator-linkedin-live-test.js', import.meta.url), 'utf8');
    assert(cliSource.includes("process.env.LINKEDIN_LIVE_TEST !== 'true'"));
    assert(cliSource.includes('Refusing: set LINKEDIN_LIVE_TEST=true'));
    assert(cliSource.includes("target.platform !== 'linkedin'"));
    assert(cliSource.includes("eventType: LINKEDIN_SUBJECT"));

    if (originalEnv) process.env.LINKEDIN_LIVE_TEST = originalEnv;
  });

  // --- SECTION 10: Real Video Publishing Pipeline (27 Deterministic Tests) ---
  console.log('\n--- 10. LinkedIn Video Publishing Pipeline ---');

  const testVideoAsset = {
    id: 99101,
    organization_id: testOrgId,
    campaign_id: 10003,
    kind: 'master',
    status: 'ready',
    mime_type: 'video/mp4',
    size_bytes: 19135539,
    object_key: 'test/video.mp4',
    width: 1080,
    height: 1920,
    aspect_ratio: '9:16',
    video_codec: 'h264',
    audio_codec: 'aac',
  };

  const testCoverAsset = {
    id: 99102,
    organization_id: testOrgId,
    campaign_id: 10003,
    kind: 'cover',
    status: 'ready',
    mime_type: 'image/jpeg',
    size_bytes: 135865,
    object_key: 'test/cover.jpg',
  };

  await asyncCheck('59. video Campaign routes to VIDEO', async () => {
    let initializedVideo = false;
    let initializedImage = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        initializedVideo = true;
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:TEST_ROUTE',
              uploadToken: 'tok',
              uploadUrlsExpireAt: Date.now() + 60000,
              uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://upload.test/0' }],
            },
          }),
        };
      }
      if (url.includes('/rest/images?action=initializeUpload')) {
        initializedImage = true;
        return { status: 200, json: async () => ({ value: { uploadUrl: 'https://u', image: 'urn:li:image:1' } }) };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        return { status: 200, json: async () => ({}) };
      }
      if (url.includes('/rest/videos/')) {
        return { status: 200, json: async () => ({ status: 'AVAILABLE', id: 'urn:li:video:TEST_ROUTE' }) };
      }
      if (url.includes('/rest/posts')) {
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:ROUTE_POST']]), json: async () => ({}) };
      }
      return { status: 200, headers: new Map([['etag', '"etag-0"']]), text: async () => '' };
    };

    const dummyJob = {
      $query: () => ({ patch: async () => {} }),
    };

    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Video route test' },
      campaign: { organization_id: testOrgId },
      asset: testVideoAsset,
      coverAsset: testCoverAsset,
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.from('0123456789')]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(initializedVideo, true, 'Video upload must be initialized');
    assert.equal(initializedImage, false, 'Image upload must NOT be initialized');
  });

  await asyncCheck('60. cover cannot convert VIDEO target into IMAGE', async () => {
    let calledImage = false;
    let calledVideo = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/images')) calledImage = true;
      if (url.includes('/rest/videos?action=initializeUpload')) {
        calledVideo = true;
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:NO_CONVERT',
              uploadToken: '',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://upload.test/1' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:P1']]), json: async () => ({}) };
      return { status: 200, headers: new Map([['etag', '"etag-1"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };

    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Cover presence test' },
      campaign: { organization_id: testOrgId },
      asset: testVideoAsset,
      coverAsset: testCoverAsset, // Cover image provided alongside video
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.from('hello')]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(calledVideo, true);
    assert.equal(calledImage, false);
  });

  await asyncCheck('61. correct master video selected', async () => {
    // Insert campaign with master video and cover asset
    const [campId] = await db('campaigns').insert({
      organization_id: testOrgId,
      source_type: 'manual',
      base_title: 'Master Selection Title',
      base_caption: 'Master Selection Caption',
      status: 'ready',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [vAssetId] = await db('assets').insert({
      organization_id: testOrgId,
      campaign_id: campId,
      parent_asset_id: null,
      kind: 'master',
      status: 'ready',
      mime_type: 'video/mp4',
      size_bytes: 19135539,
      object_key: 'orig.mp4',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [cAssetId] = await db('assets').insert({
      organization_id: testOrgId,
      campaign_id: campId,
      parent_asset_id: null,
      kind: 'cover',
      status: 'ready',
      mime_type: 'image/jpeg',
      size_bytes: 135865,
      object_key: 'cover.jpg',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    await db('campaigns').where({ id: campId }).update({ cover_asset_id: cAssetId });

    // Target with NO explicit asset_id
    const [tId] = await db('campaign_targets').insert({
      campaign_id: campId,
      platform: 'linkedin',
      integration_config_id: configRow.id,
      status: 'ready',
      asset_id: null,
      cover_asset_id: cAssetId,
      caption_override: 'Master selection test',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const [jId] = await db('publish_jobs').insert({
      organization_id: testOrgId,
      campaign_target_id: tId,
      idempotency_key: `test-li-sel-${Date.now()}`,
      status: 'queued',
      attempt_count: 0,
      max_attempts: 3,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    let recordedSize = null;
    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        const body = JSON.parse(opts.body);
        recordedSize = body.initializeUploadRequest.fileSizeBytes;
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:SEL_VIDEO',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:SEL']]), json: async () => ({}) };
      return { status: 200, headers: new Map([['etag', '"etag-s"']]), text: async () => '' };
    };

    await linkedinPublishHandler({
      jobId: jId,
      organizationId: testOrgId,
      campaignTargetId: tId,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.from('hello')]),
    });

    assert.equal(recordedSize, 19135539, 'Master video size must be resolved from campaign master');
  });

  await asyncCheck('62. initializeUpload called', async () => {
    let capturedHeaders = null;
    let capturedUrl = null;

    const mockFetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        status: 200,
        json: async () => ({
          value: {
            video: 'urn:li:video:INIT_TEST',
            uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://upload.init' }],
          },
        }),
      };
    };

    const res = await initializeVideoUpload('test-token', 'urn:li:organization:123', 1000, { fetchImpl: mockFetch });
    assert.equal(capturedUrl, 'https://api.linkedin.com/rest/videos?action=initializeUpload');
    assert.equal(capturedHeaders['LinkedIn-Version'], LINKEDIN_API_VERSION);
    assert.equal(capturedHeaders['X-Restli-Protocol-Version'], RESTLI_PROTOCOL_VERSION);
    assert.equal(capturedHeaders['Authorization'], 'Bearer test-token');
    assert.equal(res.videoUrn, 'urn:li:video:INIT_TEST');
  });

  await asyncCheck('63. exact fileSizeBytes', async () => {
    let capturedBody = null;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        status: 200,
        json: async () => ({
          value: {
            video: 'urn:li:video:SIZE_TEST',
            uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://u' }],
          },
        }),
      };
    };

    await initializeVideoUpload('tok', 'urn:li:organization:123', 19135539, { fetchImpl: mockFetch });
    assert.equal(capturedBody.initializeUploadRequest.fileSizeBytes, 19135539);
    assert.equal(capturedBody.initializeUploadRequest.owner, 'urn:li:organization:123');
  });

  await asyncCheck('64. single-part upload', async () => {
    let partPuts = 0;
    let capturedLength = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:SINGLE_PART',
              uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://upload.part/0' }],
            },
          }),
        };
      }
      if (url === 'https://upload.part/0') {
        partPuts++;
        capturedLength = opts.headers['Content-Length'];
        return { status: 200, headers: new Map([['etag', '"etag-single"']]), text: async () => '' };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:SINGLE']]), json: async () => ({}) };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Single part' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 10 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.from('0123456789')]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(partPuts, 1);
    assert.equal(capturedLength, '10');
  });

  await asyncCheck('65. multi-part upload', async () => {
    const urlsCalled = [];
    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:MULTI_PART',
              uploadInstructions: [
                { firstByte: 0, lastByte: 9, uploadUrl: 'https://upload.part/0' },
                { firstByte: 10, lastByte: 19, uploadUrl: 'https://upload.part/1' },
                { firstByte: 20, lastByte: 29, uploadUrl: 'https://upload.part/2' },
              ],
            },
          }),
        };
      }
      if (url.startsWith('https://upload.part/')) {
        urlsCalled.push(url);
        return { status: 200, headers: new Map([['etag', `"etag-${urlsCalled.length}"`]]), text: async () => '' };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:MULTI']]), json: async () => ({}) };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Multi part' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 30 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.from('0123456789')]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(urlsCalled.length, 3);
    assert.deepEqual(urlsCalled, ['https://upload.part/0', 'https://upload.part/1', 'https://upload.part/2']);
  });

  await asyncCheck('66. exact firstByte/lastByte ranges', async () => {
    const requestedRanges = [];
    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:RANGES',
              uploadInstructions: [
                { firstByte: 0, lastByte: 99, uploadUrl: 'https://upload.part/0' },
                { firstByte: 100, lastByte: 199, uploadUrl: 'https://upload.part/1' },
              ],
            },
          }),
        };
      }
      if (url.startsWith('https://upload.part/')) {
        return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:RANGES']]), json: async () => ({}) };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Ranges' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 200 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async (key, start, end) => {
        requestedRanges.push({ start, end });
        return Readable.from([Buffer.alloc(end - start + 1)]);
      },
      sleepImpl: () => Promise.resolve(),
    });

    assert.deepEqual(requestedRanges, [{ start: 0, end: 99 }, { start: 100, end: 199 }]);
  });

  await asyncCheck('67. byte counts exact', async () => {
    const partLengths = [];
    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:EXACT_BYTES',
              uploadInstructions: [
                { firstByte: 0, lastByte: 49, uploadUrl: 'https://u0' },
                { firstByte: 50, lastByte: 99, uploadUrl: 'https://u1' },
              ],
            },
          }),
        };
      }
      if (url.startsWith('https://u')) {
        partLengths.push(Number(opts.headers['Content-Length']));
        return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:B']]), json: async () => ({}) };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Exact Bytes' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 100 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async (k, s, e) => Readable.from([Buffer.alloc(e - s + 1)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.deepEqual(partLengths, [50, 50]);
  });

  await asyncCheck('68. short S3 read fails closed', async () => {
    let postCreated = false;
    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:SHORT_READ',
              uploadInstructions: [{ firstByte: 0, lastByte: 99, uploadUrl: 'https://u.short' }],
            },
          }),
        };
      }
      if (url.includes('/rest/posts')) {
        postCreated = true;
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:FAIL']]), json: async () => ({}) };
      }
      if (opts?.body && typeof opts.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of opts.body) {
          // Consume stream to trigger Transform stream flush validation
        }
      }
      return { status: 200, headers: new Map([['etag', '"etag"']]), json: async () => ({}), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };

    // S3 stream only delivers 20 bytes instead of required 100
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: 'Short read test' },
        campaign: { organization_id: testOrgId },
        asset: { ...testVideoAsset, size_bytes: 100 },
        integrationConfig: configRow,
        fetchImpl: mockFetch,
        s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(20)]),
        sleepImpl: () => Promise.resolve(),
      }),
      /short read/
    );

    assert.equal(postCreated, false, 'No post must be created when S3 read is short');
  });

  await asyncCheck('69. upload identifiers captured', async () => {
    const mockFetch = async (url) => {
      return {
        status: 200,
        headers: new Map([['etag', '"clean-etag-12345"']]),
        text: async () => '',
      };
    };

    const res = await uploadVideoPart('https://upload.test', Readable.from([Buffer.from('test')]), 4, { fetchImpl: mockFetch });
    assert.equal(res.ok, true);
    assert.equal(res.etag, 'clean-etag-12345', 'Surrounding quotes must be stripped from ETag');
  });

  await asyncCheck('70. finalizeUpload required', async () => {
    let finalizedCalled = false;
    let postCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:FINALIZE_REQ',
              uploadToken: 'tok-req',
              uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        finalizedCalled = true;
        return { status: 200, json: async () => ({}) };
      }
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) {
        postCalled = true;
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:FIN']]), json: async () => ({}) };
      }
      return { status: 200, headers: new Map([['etag', '"etag-fin"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Finalize required' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 10 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(10)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(finalizedCalled, true);
    assert.equal(postCalled, true);
  });

  await asyncCheck('71. all uploadedPartIds included', async () => {
    let capturedFinalizeBody = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:ALL_PARTS',
              uploadToken: 't-parts',
              uploadInstructions: [
                { firstByte: 0, lastByte: 9, uploadUrl: 'https://u/0' },
                { firstByte: 10, lastByte: 19, uploadUrl: 'https://u/1' },
              ],
            },
          }),
        };
      }
      if (url === 'https://u/0') return { status: 200, headers: new Map([['etag', '"etag-zero"']]), text: async () => '' };
      if (url === 'https://u/1') return { status: 200, headers: new Map([['etag', '"etag-one"']]), text: async () => '' };
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        capturedFinalizeBody = JSON.parse(opts.body);
        return { status: 200, json: async () => ({}) };
      }
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:AP']]), json: async () => ({}) };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'All parts test' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 20 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(10)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.deepEqual(capturedFinalizeBody.finalizeUploadRequest.uploadedPartIds, ['etag-zero', 'etag-one']);
    assert.equal(capturedFinalizeBody.finalizeUploadRequest.uploadToken, 't-parts');
  });

  await asyncCheck('72. video readiness queried', async () => {
    let queriedUrl = null;
    const mockFetch = async (url) => {
      queriedUrl = url;
      return {
        status: 200,
        json: async () => ({ status: 'AVAILABLE', id: 'urn:li:video:QUERY_TEST' }),
      };
    };

    const res = await getVideoStatus('tok', 'urn:li:video:QUERY_TEST', { fetchImpl: mockFetch });
    assert.equal(queriedUrl, 'https://api.linkedin.com/rest/videos/urn%3Ali%3Avideo%3AQUERY_TEST');
    assert.equal(res.status, 'AVAILABLE');
  });

  await asyncCheck('73. bounded polling', async () => {
    let pollCount = 0;
    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:POLL',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) {
        pollCount++;
        // Available on 3rd poll
        return { status: 200, json: async () => ({ status: pollCount >= 3 ? 'AVAILABLE' : 'PROCESSING' }) };
      }
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:POLL']]), json: async () => ({}) };
      return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Polling test' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 5 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(5)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(pollCount, 3, 'Must poll until AVAILABLE');
  });

  await asyncCheck('74. Posts API media ID is urn:li:video', async () => {
    let postMediaId = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:VIDEO_ID_ASSERTION',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) {
        const body = JSON.parse(opts.body);
        postMediaId = body.content?.media?.id;
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:POSTED']]), json: async () => ({}) };
      }
      return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'Media ID test' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 5 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(5)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert(postMediaId?.startsWith('urn:li:video:'), `media ID must start with urn:li:video:, got: ${postMediaId}`);
    assert.equal(postMediaId, 'urn:li:video:VIDEO_ID_ASSERTION');
  });

  await asyncCheck('75. video title/commentary preserved', async () => {
    let capturedCommentary = null;
    let capturedTitle = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:PRESERVE_TXT',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts')) {
        const body = JSON.parse(opts.body);
        capturedCommentary = body.commentary;
        capturedTitle = body.content?.media?.title;
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:TXT']]), json: async () => ({}) };
      }
      return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await publishToLinkedIn(dummyJob, {
      campaignTarget: { caption_override: 'My Preserved Commentary', title_override: 'My Preserved Title' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 5 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(5)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(capturedCommentary, 'My Preserved Commentary');
    assert.equal(capturedTitle, 'My Preserved Title');
  });

  await asyncCheck('76. image URN rejected in VIDEO mode', async () => {
    await assert.rejects(
      () => createPost('tok', {
        authorUrn: 'urn:li:organization:123',
        commentary: 'Invalid video',
        mediaUrn: 'urn:li:image:FORBIDDEN_IN_VIDEO',
        mediaType: 'video',
      }),
      /content\.media\.id MUST start with urn:li:video:|Image URN rejected/
    );
  });

  await asyncCheck('77. video failure creates NO image fallback post', async () => {
    let imagesApiCalled = false;
    let postsApiCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return { status: 500, text: async () => 'Video init exploded' };
      }
      if (url.includes('/rest/images')) imagesApiCalled = true;
      if (url.includes('/rest/posts')) postsApiCalled = true;
      return { status: 200, text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };

    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: 'No fallback test' },
        campaign: { organization_id: testOrgId },
        asset: testVideoAsset,
        coverAsset: testCoverAsset,
        integrationConfig: configRow,
        fetchImpl: mockFetch,
        sleepImpl: () => Promise.resolve(),
      })
    );

    assert.equal(imagesApiCalled, false, 'Images API must NOT be called on video failure');
    assert.equal(postsApiCalled, false, 'Posts API must NOT be called on video failure');
  });

  await asyncCheck('78. duplicate delivery creates NO duplicate video post', async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return { status: 200 };
    };

    const existingJob = {
      external_media_id: 'urn:li:share:ALREADY_EXISTS_VIDEO',
      $query: () => ({ patch: async () => {} }),
    };

    const res = await publishToLinkedIn(existingJob, {
      campaignTarget: { caption_override: 'Dup delivery' },
      campaign: { organization_id: testOrgId },
      asset: testVideoAsset,
      integrationConfig: configRow,
      fetchImpl: mockFetch,
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(res.external_media_id, 'urn:li:share:ALREADY_EXISTS_VIDEO');
    assert.equal(fetchCalled, false, 'No API call when job already succeeded');
  });

  await asyncCheck('79. crash after initialize resumes safely', async () => {
    let initializeCalls = 0;
    let partsUploaded = 0;
    let finalized = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        initializeCalls++;
        return { status: 200, json: async () => ({}) };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        finalized = true;
        return { status: 200, json: async () => ({}) };
      }
      if (url.includes('/rest/videos/')) {
        // Before finalize it is waiting upload; after finalize it becomes available
        return { status: 200, json: async () => ({ status: finalized ? 'AVAILABLE' : 'WAITING_UPLOAD' }) };
      }
      if (url.startsWith('https://resume.part/')) {
        partsUploaded++;
        return { status: 200, headers: new Map([['etag', '"etag-resumed"']]), text: async () => '' };
      }
      if (url.includes('/rest/posts')) return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:RESUMED']]), json: async () => ({}) };
    };

    const crashedJob = {
      external_container_id: 'urn:li:video:CRASHED_SESSION',
      sensitive_external_state_json: {
        videoUrn: 'urn:li:video:CRASHED_SESSION',
        uploadUrlsExpireAt: Date.now() + 100000,
        uploadInstructions: [{ firstByte: 0, lastByte: 9, uploadUrl: 'https://resume.part/0' }],
        uploadedPartIds: [],
      },
      $query: () => ({ patch: async () => {} }),
    };

    const res = await publishToLinkedIn(crashedJob, {
      campaignTarget: { caption_override: 'Resume test' },
      campaign: { organization_id: testOrgId },
      asset: { ...testVideoAsset, size_bytes: 10 },
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(10)]),
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(initializeCalls, 0, 'initializeUpload must NOT be called again when resuming valid session');
    assert.equal(partsUploaded, 1, 'Remaining parts must be uploaded');
  });

  await asyncCheck('80. crash after finalize does not re-upload blindly', async () => {
    let uploadCalled = false;
    let initCalled = false;
    let finalizeCalled = false;

    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        initCalled = true;
        return { status: 200 };
      }
      if (url.includes('/rest/videos/')) {
        // Video is already processed and AVAILABLE!
        return { status: 200, json: async () => ({ status: 'AVAILABLE', id: 'urn:li:video:ALREADY_READY' }) };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) {
        finalizeCalled = true;
        return { status: 200 };
      }
      if (url.includes('/rest/posts')) {
        return { status: 201, headers: new Map([['x-restli-id', 'urn:li:share:RESUMED_POST']]), json: async () => ({}) };
      }
      uploadCalled = true;
      return { status: 200, text: async () => '' };
    };

    const finalizedJob = {
      external_container_id: 'urn:li:video:ALREADY_READY',
      $query: () => ({ patch: async () => {} }),
    };

    const res = await publishToLinkedIn(finalizedJob, {
      campaignTarget: { caption_override: 'No re-upload' },
      campaign: { organization_id: testOrgId },
      asset: testVideoAsset,
      integrationConfig: configRow,
      fetchImpl: mockFetch,
      sleepImpl: () => Promise.resolve(),
    });

    assert.equal(res.status, 'succeeded');
    assert.equal(initCalled, false);
    assert.equal(uploadCalled, false);
    assert.equal(finalizeCalled, false);
  });

  await asyncCheck('81. 401 mapped to AUTH_REQUIRED', async () => {
    const mockFetch = async () => ({
      status: 401,
      json: async () => ({ message: 'Token expired' }),
    });

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: '401 test' },
        campaign: { organization_id: testOrgId },
        asset: testVideoAsset,
        integrationConfig: configRow,
        fetchImpl: mockFetch,
      }),
      err => err.category === ERROR_CATEGORY.AUTH_REQUIRED
    );
  });

  await asyncCheck('82. 403 mapped to AUTH_REQUIRED (permission denied)', async () => {
    const mockFetch = async () => ({
      status: 403,
      json: async () => ({ message: 'Not an org admin' }),
    });

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: '403 test' },
        campaign: { organization_id: testOrgId },
        asset: testVideoAsset,
        integrationConfig: configRow,
        fetchImpl: mockFetch,
      }),
      err => err.category === ERROR_CATEGORY.AUTH_REQUIRED
    );
  });

  await asyncCheck('83. 429 mapped to RATE_LIMIT', async () => {
    const mockFetch = async () => ({
      status: 429,
      headers: new Map([['retry-after', '45']]),
      json: async () => ({ message: 'Rate limited' }),
    });

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: '429 test' },
        campaign: { organization_id: testOrgId },
        asset: testVideoAsset,
        integrationConfig: configRow,
        fetchImpl: mockFetch,
      }),
      err => err.category === ERROR_CATEGORY.RATE_LIMIT && err.retryAfterMs === 45000
    );
  });

  await asyncCheck('84. 5xx mapped to PLATFORM_5XX', async () => {
    const mockFetch = async () => ({
      status: 503,
      json: async () => ({ message: 'Service Unavailable' }),
    });

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: '5xx test' },
        campaign: { organization_id: testOrgId },
        asset: testVideoAsset,
        integrationConfig: configRow,
        fetchImpl: mockFetch,
      }),
      err => err.category === ERROR_CATEGORY.PLATFORM_5XX
    );
  });

  await asyncCheck('85. ambiguous final POST → RECONCILE_REQUIRED', async () => {
    const mockFetch = async (url) => {
      if (url.includes('/rest/videos?action=initializeUpload')) {
        return {
          status: 200,
          json: async () => ({
            value: {
              video: 'urn:li:video:AMBIGUOUS',
              uploadInstructions: [{ firstByte: 0, lastByte: 4, uploadUrl: 'https://u' }],
            },
          }),
        };
      }
      if (url.includes('/rest/videos?action=finalizeUpload')) return { status: 200, json: async () => ({}) };
      if (url.includes('/rest/videos/')) return { status: 200, json: async () => ({ status: 'AVAILABLE' }) };
      if (url.includes('/rest/posts?author=')) {
        // Reconciliation search returns empty
        return { status: 200, json: async () => ({ elements: [] }) };
      }
      if (url.includes('/rest/posts')) {
        const err = new Error('Socket timed out after submission');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return { status: 200, headers: new Map([['etag', '"etag"']]), text: async () => '' };
    };

    const dummyJob = { $query: () => ({ patch: async () => {} }) };
    await assert.rejects(
      () => publishToLinkedIn(dummyJob, {
        campaignTarget: { caption_override: 'Ambiguous timeout' },
        campaign: { organization_id: testOrgId },
        asset: { ...testVideoAsset, size_bytes: 5 },
        integrationConfig: configRow,
        fetchImpl: mockFetch,
        s3RangeStreamFactory: async () => Readable.from([Buffer.alloc(5)]),
        sleepImpl: () => Promise.resolve(),
      }),
      err => err.category === ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE
    );
  });

  console.log(`\n==============================================`);
  console.log(`ALL CHECKS PASSED: ${checksPassed}/85 checks OK`);
  console.log(`==============================================\n`);
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('LinkedIn Test Suite Failed:', err);
    process.exit(1);
  });

