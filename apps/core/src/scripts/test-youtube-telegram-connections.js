import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

const runId = crypto.randomUUID();
const marker = `yt_tg_conn_${runId}`;
const tgUserId = `tg-${runId}`;
const tgOtherUserId = `tg-other-${runId}`;
const accessToken = `TEST_ACCESS_${runId}`;
const refreshToken = `TEST_REFRESH_${runId}`;
process.env.INTEGRATION_CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
if (!process.env.DB_NAME?.endsWith('_test')) throw new Error('FAIL CLOSED: Telegram connection tests require DB_NAME ending in _test');

dotenv.config({ path: new URL('../../.env', import.meta.url) });
const originalYouTubeConnectBaseUrl = process.env.YOUTUBE_CONNECT_BASE_URL;
process.env.YOUTUBE_CONNECT_BASE_URL = 'https://core.test/api/youtube/connect';
const { default: getDb } = await import('../config/database.js');
const db = getDb();
const [{ name: actualTestDb }] = (await db.raw('SELECT DATABASE() AS name'))[0];
if (!actualTestDb?.endsWith('_test')) throw new Error(`FAIL CLOSED: connected database '${actualTestDb}' is not a *_test database`);

const { auth } = await import('../config/auth.js');
const { createYouTubeRouter } = await import('../routes/youtube.js');
const { processTelegramUpdate } = await import('../publisher/telegram/composer.js');
const { CONNECTION_CALLBACKS } = await import('../publisher/telegram/connections.js');
const { hashState, YOUTUBE_OAUTH_SCOPES } = await import('../publisher/platforms/youtube/oauth.js');
const {
  YOUTUBE_CONNECTION_SOURCE,
  YOUTUBE_INTENT_STATUS,
  dbTimestamp,
} = await import('../publisher/platforms/youtube/connections.js');
const { encryptConfigValue } = await import('../integrations/secrets.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push([name, true]);
  } catch (error) {
    results.push([name, false, error?.stack || String(error)]);
  }
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end(body) { this.body = body; return this; },
    redirect(code, location) { this.statusCode = code; this.headers.location = location; return this; },
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    getHeader(key) { return this.headers[key.toLowerCase()]; },
  };
}

async function request(router, { method, path, user, body, query = {}, cookie, sessionError = null } = {}) {
  const req = {
    method,
    url: path,
    originalUrl: path,
    headers: { ...(cookie ? { cookie } : {}), ...(user?.current_org_id ? { 'x-org-id': String(user.current_org_id) } : {}) },
    body,
    query,
  };
  const res = response();
  const original = auth.api.getSession;
  auth.api.getSession = async () => {
    if (sessionError) throw sessionError;
    return user ? { user } : null;
  };
  try {
    await router.handler({ onError(error, _req, out) { out.error = error; out.status(500).end(); } })(req, res);
  } catch (error) {
    res.error = error;
  } finally {
    auth.api.getSession = original;
  }
  return res;
}

function oauthMock({ channels = [{ id: `channel-${marker}`, snippet: { title: `Channel ${marker}` } }], tokens: tokenOverrides = {} } = {}) {
  const calls = { authorizationUrls: [], tokenArgs: [], credentials: [], channelArgs: [] };
  const tokens = {
    access_token: accessToken,
    refresh_token: refreshToken,
    scope: YOUTUBE_OAUTH_SCOPES.join(' '),
    expiry_date: Date.now() + 3600_000,
    ...tokenOverrides,
  };
  return {
    calls,
    oauthClientFactory: () => ({
      redirectUri: 'https://core.test/api/youtube/oauth/callback',
      generateAuthUrl(params) {
        const url = `https://accounts.google.test/o?${new URLSearchParams(params).toString()}`;
        calls.authorizationUrls.push(url);
        return url;
      },
      async getToken(args) {
        calls.tokenArgs.push(args);
        return { tokens };
      },
      setCredentials(value) { calls.credentials.push(value); },
    }),
    youtubeApiFactory: async () => ({
      channels: {
        list: async (args) => {
          calls.channelArgs.push(args);
          return { status: 200, data: { items: channels } };
        },
      },
    }),
  };
}

function telegramMock() {
  return {
    sentMessages: [],
    answeredCallbacks: [],
    sendMessage: async function sendMessage(payload) {
      this.sentMessages.push(payload);
      return { message_id: this.sentMessages.length, ...payload };
    },
    answerCallbackQuery: async function answerCallbackQuery(payload) {
      this.answeredCallbacks.push(payload);
      return true;
    },
  };
}

function messageUpdate(text, userId = tgUserId) {
  return {
    update_id: crypto.randomUUID(),
    message: { message_id: Math.floor(Math.random() * 100000), chat: { id: userId, type: 'private' }, from: { id: userId }, text },
  };
}

function callbackUpdate(data, userId = tgUserId) {
  return {
    update_id: crypto.randomUUID(),
    callback_query: { id: crypto.randomUUID(), message: { message_id: 1, chat: { id: userId, type: 'private' } }, from: { id: userId }, data },
  };
}

function flattenButtons(message) {
  return message?.reply_markup?.inline_keyboard?.flat() || [];
}

const fixture = {
  org19Created: false,
  otherOrgId: null,
  userId: crypto.randomUUID(),
  otherUserId: crypto.randomUUID(),
  providerId: null,
  createdProvider: false,
};

async function setup() {
  const admin = await db('roles').where({ name: 'admin' }).first();
  if (!admin) throw new Error('admin role is required');
  const org19 = await db('organizations').where({ id: 19 }).first();
  if (!org19) {
    await db('organizations').insert({ id: 19, name: `ElecIO ${marker}`, slug: `elecio-${marker}`, is_active: true, created_at: new Date(), updated_at: new Date() });
    fixture.org19Created = true;
  }
  const [otherOrgId] = await db('organizations').insert({ name: `${marker}-other`, slug: `${marker}-other`, is_active: true, created_at: new Date(), updated_at: new Date() });
  fixture.otherOrgId = Number(otherOrgId);
  await db('user').insert([
    { id: fixture.userId, name: marker, email: `${marker}@example.test`, emailVerified: false, role_id: admin.id, createdAt: new Date(), updatedAt: new Date() },
    { id: fixture.otherUserId, name: `${marker}-other`, email: `${marker}-other@example.test`, emailVerified: false, role_id: admin.id, createdAt: new Date(), updatedAt: new Date() },
  ]);
  await db('user_organization_roles').insert([
    { user_id: fixture.userId, organization_id: 19, role_id: admin.id, created_at: new Date(), updated_at: new Date() },
    { user_id: fixture.userId, organization_id: fixture.otherOrgId, role_id: admin.id, created_at: new Date(), updated_at: new Date() },
    { user_id: fixture.otherUserId, organization_id: 19, role_id: admin.id, created_at: new Date(), updated_at: new Date() },
  ]);
  let provider = await db('integration_providers').where({ domain: 'publishing', code: 'youtube' }).first();
  if (!provider) {
    const [id] = await db('integration_providers').insert({ domain: 'publishing', code: 'youtube', display_name: 'YouTube', adapter_key: 'publishing.youtube', is_enabled: true, is_system: true });
    provider = { id };
    fixture.createdProvider = true;
  }
  fixture.providerId = Number(provider.id);
}

async function cleanup() {
  await db('integration_connection_intents').whereIn('user_id', [fixture.userId, fixture.otherUserId]).delete();
  await db('integration_configs').whereIn('organization_id', [19, fixture.otherOrgId].filter(Boolean)).andWhere({ provider_id: fixture.providerId }).delete();
  await db('telegram_user_bindings').whereIn('telegram_user_id', [tgUserId, tgOtherUserId]).delete();
  await db('user_organization_roles').whereIn('user_id', [fixture.userId, fixture.otherUserId]).delete();
  await db('user').whereIn('id', [fixture.userId, fixture.otherUserId]).delete();
  if (fixture.otherOrgId) await db('organizations').where({ id: fixture.otherOrgId }).delete();
  if (fixture.org19Created) await db('organizations').where({ id: 19 }).delete();
  if (fixture.createdProvider) await db('integration_providers').where({ id: fixture.providerId }).delete();
}

try {
  await setup();
  const tg = telegramMock();
  const google = oauthMock();
  const router = createYouTubeRouter({
    oauthClientFactory: google.oauthClientFactory,
    youtubeApiFactory: google.youtubeApiFactory,
    telegramClientFactory: () => tg,
  });

  await test('Telegram /connections confirms single explicit organization before showing providers', async () => {
    await db('telegram_user_bindings').insert({ telegram_user_id: tgUserId, user_id: fixture.userId, organization_id: 19, is_default: false, is_active: true });
    const res = await processTelegramUpdate(messageUpdate('/connections'), { telegramClient: tg });
    assert.equal(res.connection, true);
    const last = tg.sentMessages.at(-1);
    assert.match(last.text, /Organization:/);
    assert.equal(flattenButtons(last)[0].callback_data, `${CONNECTION_CALLBACKS.SELECT_ORG}:19`);
  });

  await test('Telegram menu exposes YouTube disconnected state and connect button for selected org', async () => {
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.SELECT_ORG}:19`), { telegramClient: tg });
    const last = tg.sentMessages.at(-1);
    assert.match(last.text, /YouTube: disconnected/);
    assert.equal(flattenButtons(last)[0].callback_data, `${CONNECTION_CALLBACKS.YOUTUBE_CONNECT}:19`);
  });

  let browserTicket;
  await test('Telegram connect creates source=telegram intent for org 19 and one-time browser ticket', async () => {
    const before = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.YOUTUBE_CONNECT}:19`), { telegramClient: tg });
    const last = tg.sentMessages.at(-1);
    const button = flattenButtons(last)[0];
    assert.equal(button.text, 'Connect YouTube');
    const url = new URL(button.url);
    browserTicket = url.searchParams.get('t');
    assert.ok(browserTicket && browserTicket.length >= 43);
    assert.ok(!button.url.includes(fixture.userId));
    assert.ok(!button.url.includes('organization_id=19'));
    const after = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
    assert.equal(Number(after[0].count), Number(before[0].count) + 1);
    const intent = await db('integration_connection_intents').where({ browser_ticket_hash: hashState(browserTicket) }).first();
    // Verify explicitly selected/authorized organization is preserved
    assert.equal(intent.organization_id, 19);
    assert.notEqual(intent.organization_id, 1);
    assert.equal(intent.source, YOUTUBE_CONNECTION_SOURCE.TELEGRAM);
    assert.equal(intent.status, YOUTUBE_INTENT_STATUS.PENDING);
    assert.equal(intent.telegram_user_id, tgUserId);
    assert.equal(intent.telegram_chat_id, tgUserId);
  });

  await test('Localhost connect base sends copyable link instead of invalid Telegram URL button', async () => {
    const previousBase = process.env.YOUTUBE_CONNECT_BASE_URL;
    process.env.YOUTUBE_CONNECT_BASE_URL = 'http://localhost:4000/api/youtube/connect';
    const strictTelegram = {
      sentMessages: [],
      answeredCallbacks: [],
      sendMessage: async function sendMessage(payload) {
        if (flattenButtons(payload).some(button => button.url)) {
          throw new Error('Bad Request: BUTTON_URL_INVALID');
        }
        this.sentMessages.push(payload);
        return payload;
      },
      answerCallbackQuery: async function answerCallbackQuery(payload) {
        this.answeredCallbacks.push(payload);
        return true;
      },
    };
    try {
      const before = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
      await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.YOUTUBE_CONNECT}:19`), { telegramClient: strictTelegram });
      const last = strictTelegram.sentMessages.at(-1);
      assert.match(last.text, /localhost:4000\/api\/youtube\/connect/);
      assert.equal(flattenButtons(last).length, 0);
      const after = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
      assert.equal(Number(after[0].count), Number(before[0].count) + 1);
    } finally {
      process.env.YOUTUBE_CONNECT_BASE_URL = previousBase;
    }
  });

  let telegramState;
  await test('Telegram browser ticket starts Google OAuth without Better Auth and cannot be reused', async () => {
    const start = await request(router, { method: 'GET', path: '/connect', query: { t: browserTicket }, user: null });
    assert.equal(start.statusCode, 302);
    const googleUrl = new URL(start.headers.location);
    telegramState = googleUrl.searchParams.get('state');
    assert.ok(telegramState);
    const requestedScopes = googleUrl.searchParams.get('scope').split(/[,\s]+/).filter(Boolean).sort();
    assert.deepEqual(requestedScopes, [...YOUTUBE_OAUTH_SCOPES].sort());
    const reserved = await db('integration_connection_intents').where({ nonce_hash: hashState(telegramState) }).first();
    assert.equal(reserved.browser_ticket_hash, null);
    assert.ok(reserved.browser_ticket_reserved_at);
    assert.ok(reserved.pkce_verifier_encrypted);
    const replay = await request(router, { method: 'GET', path: '/connect', query: { t: browserTicket }, user: null });
    assert.equal(replay.statusCode, 400);
  });

  let pendingIntent;
  let confirmButton;
  await test('Telegram OAuth callback shares Google verification and returns browser success page without Better Auth', async () => {
    const callback = await request(router, { method: 'GET', path: '/oauth/callback', query: { state: telegramState, code: `code-${marker}` }, user: null, sessionError: new Error('Better Auth unavailable') });
    assert.equal(callback.statusCode, 200, callback.error?.stack || String(callback.body));
    assert.match(String(callback.body), /Return to Telegram/);
    pendingIntent = await db('integration_connection_intents').where({ nonce_hash: hashState(telegramState) }).first();
    assert.equal(pendingIntent.status, YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION);
    assert.equal(pendingIntent.pending_secret_json.refresh_token.includes(refreshToken), false);
    const notification = tg.sentMessages.at(-1);
    assert.match(notification.text, /YouTube account verified/);
    assert.match(notification.text, /Organization:/);
    confirmButton = flattenButtons(notification).find(button => button.callback_data?.startsWith(`${CONNECTION_CALLBACKS.YOUTUBE_CONFIRM}:`));
    assert.ok(confirmButton);
    assert.equal(google.calls.channelArgs[0].part, 'id,snippet');
    assert.equal(google.calls.channelArgs[0].mine, true);
  });

  await test('Stolen Telegram confirmation callback from another Telegram user cannot activate', async () => {
    await db('telegram_user_bindings').insert({ telegram_user_id: tgOtherUserId, user_id: fixture.otherUserId, organization_id: 19, is_default: true, is_active: true });
    await processTelegramUpdate(callbackUpdate(confirmButton.callback_data, tgOtherUserId), { telegramClient: tg });
    const count = await db('integration_configs').where({ organization_id: 19, provider_id: fixture.providerId, status: 'active' }).count({ count: '*' });
    assert.equal(Number(count[0].count), 0);
  });

  await test('Telegram final confirmation activates exactly one same-org IntegrationConfig and consumes intent', async () => {
    await processTelegramUpdate(callbackUpdate(confirmButton.callback_data), { telegramClient: tg });
    const configs = await db('integration_configs').where({ organization_id: 19, provider_id: fixture.providerId, status: 'active' });
    assert.equal(configs.length, 1);
    assert.equal(configs[0].external_account_id, `channel-${marker}`);
    assert.ok(!JSON.stringify(configs[0].config_json).includes(refreshToken));
    const consumed = await db('integration_connection_intents').where({ id: pendingIntent.id }).first();
    assert.equal(consumed.status, YOUTUBE_INTENT_STATUS.CONSUMED);
    assert.equal(consumed.pending_secret_json, null);
    await processTelegramUpdate(callbackUpdate(confirmButton.callback_data), { telegramClient: tg });
    const after = await db('integration_configs').where({ organization_id: 19, provider_id: fixture.providerId, status: 'active' });
    assert.equal(after.length, 1);
  });

  await test('No-refresh reconnect cannot change the verified channel identity', async () => {
    const changedChannel = `changed-${marker}`;
    const noRefreshGoogle = oauthMock({
      channels: [{ id: changedChannel, snippet: { title: `Changed ${marker}` } }],
      tokens: { refresh_token: undefined },
    });
    const noRefreshRouter = createYouTubeRouter({
      oauthClientFactory: noRefreshGoogle.oauthClientFactory,
      youtubeApiFactory: noRefreshGoogle.youtubeApiFactory,
      telegramClientFactory: () => tg,
    });
    const webUser = { id: fixture.userId, role_id: 1, current_org_id: 19 };
    const connect = await request(noRefreshRouter, { method: 'POST', path: '/connect', user: webUser, body: { organization_id: 19 } });
    const reconnectState = new URL(connect.body.authorizationUrl).searchParams.get('state');
    const callback = await request(noRefreshRouter, { method: 'GET', path: '/oauth/callback', query: { state: reconnectState, code: 'code' }, user: webUser });
    assert.equal(callback.statusCode, 400);
    const failed = await db('integration_connection_intents').where({ nonce_hash: hashState(reconnectState) }).first();
    assert.equal(failed.status, YOUTUBE_INTENT_STATUS.CANCELLED);
    assert.equal(failed.failure_stage, 'REFRESH_TOKEN_MISSING');
    const config = await db('integration_configs').where({ organization_id: 19, provider_id: fixture.providerId, status: 'active' }).first();
    assert.equal(config.external_account_id, `channel-${marker}`);
  });

  await test('Telegram notification failure leaves verified pending intent recoverable from /connections', async () => {
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.YOUTUBE_CONNECT}:19`), { telegramClient: tg });
    const ticketUrl = new URL(flattenButtons(tg.sentMessages.at(-1))[0].url);
    const ticket = ticketUrl.searchParams.get('t');
    const start = await request(router, { method: 'GET', path: '/connect', query: { t: ticket }, user: null });
    const state = new URL(start.headers.location).searchParams.get('state');
    const failingTelegram = { sendMessage: async () => { throw new Error('Telegram send failed'); } };
    const failingNotifyRouter = createYouTubeRouter({
      oauthClientFactory: google.oauthClientFactory,
      youtubeApiFactory: google.youtubeApiFactory,
      telegramClientFactory: () => failingTelegram,
    });
    const callback = await request(failingNotifyRouter, { method: 'GET', path: '/oauth/callback', query: { state, code: 'code' }, user: null });
    assert.equal(callback.statusCode, 200);
    const pending = await db('integration_connection_intents').where({ nonce_hash: hashState(state) }).first();
    assert.equal(pending.status, YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION);
    assert.equal(pending.failure_stage, 'TELEGRAM_NOTIFICATION_FAILED');
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.SELECT_ORG}:19`), { telegramClient: tg });
    const buttons = flattenButtons(tg.sentMessages.at(-1));
    assert.ok(buttons.some(button => button.callback_data === `${CONNECTION_CALLBACKS.YOUTUBE_CONFIRM}:${pending.id}`));
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.YOUTUBE_CANCEL}:${pending.id}`), { telegramClient: tg });
    const cancelled = await db('integration_connection_intents').where({ id: pending.id }).first();
    assert.equal(cancelled.status, YOUTUBE_INTENT_STATUS.CANCELLED);
    assert.equal(cancelled.pending_secret_json, null);
  });

  await test('Telegram cancel/expired confirmation clears pending credential and does not activate', async () => {
    const expiredId = crypto.randomUUID();
    await db('integration_connection_intents').insert({
      id: expiredId,
      nonce_hash: hashState(crypto.randomBytes(32).toString('base64url')),
      user_id: fixture.userId,
      organization_id: 19,
      provider_id: fixture.providerId,
      purpose: 'publishing_connection',
      source: YOUTUBE_CONNECTION_SOURCE.TELEGRAM,
      telegram_user_id: tgUserId,
      telegram_chat_id: tgUserId,
      status: YOUTUBE_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      pending_secret_json: { refresh_token: encryptConfigValue(`EXPIRED_${refreshToken}`) },
      verified_channel_id: `expired-${marker}`,
      verified_channel_title: `Expired ${marker}`,
      expires_at: dbTimestamp(new Date(Date.now() - 1000)),
    });
    await processTelegramUpdate(callbackUpdate(`${CONNECTION_CALLBACKS.YOUTUBE_CONFIRM}:${expiredId}`), { telegramClient: tg });
    const expired = await db('integration_connection_intents').where({ id: expiredId }).first();
    assert.equal(expired.status, YOUTUBE_INTENT_STATUS.CANCELLED);
    assert.equal(expired.pending_secret_json, null);
    const count = await db('integration_configs').where({ organization_id: 19, external_account_id: `expired-${marker}` }).count({ count: '*' });
    assert.equal(Number(count[0].count), 0);
  });

  await test('Multiple Telegram org bindings ask for explicit org and do not create fallback intent', async () => {
    await db('telegram_user_bindings').insert({ telegram_user_id: tgUserId, user_id: fixture.userId, organization_id: fixture.otherOrgId, is_default: false, is_active: true });
    const before = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
    await processTelegramUpdate(messageUpdate('/connections'), { telegramClient: tg });
    const after = await db('integration_connection_intents').where({ user_id: fixture.userId }).count({ count: '*' });
    assert.equal(Number(after[0].count), Number(before[0].count));
    const buttons = flattenButtons(tg.sentMessages.at(-1));
    assert.ok(buttons.some(button => button.callback_data === `${CONNECTION_CALLBACKS.SELECT_ORG}:19`));
    assert.ok(buttons.some(button => button.callback_data === `${CONNECTION_CALLBACKS.SELECT_ORG}:${fixture.otherOrgId}`));
  });

  await test('Web Better Auth flow still requires session and confirms through POST /confirm', async () => {
    const webUser = { id: fixture.userId, role_id: 1, current_org_id: fixture.otherOrgId };
    const connect = await request(router, { method: 'POST', path: '/connect', user: webUser, body: { organization_id: fixture.otherOrgId } });
    assert.equal(connect.statusCode, 200, connect.error?.stack || JSON.stringify(connect.body));
    const webState = new URL(connect.body.authorizationUrl).searchParams.get('state');
    const noSession = await request(router, { method: 'GET', path: '/oauth/callback', query: { state: webState, code: 'code' }, user: null });
    assert.equal(noSession.statusCode, 400);

    const connect2 = await request(router, { method: 'POST', path: '/connect', user: webUser, body: { organization_id: fixture.otherOrgId } });
    const webState2 = new URL(connect2.body.authorizationUrl).searchParams.get('state');
    const callback = await request(router, { method: 'GET', path: '/oauth/callback', query: { state: webState2, code: 'code' }, user: webUser });
    assert.equal(callback.statusCode, 302);
    assert.match(callback.headers.location, /localhost:3000\/publisher\/integrations\/youtube\/confirm/);
    const cookie = callback.headers['set-cookie'].split(';')[0];
    const pending = await db('integration_connection_intents').where({ nonce_hash: hashState(webState2) }).first();
    const confirm = await request(router, { method: 'POST', path: '/confirm', user: webUser, cookie, body: { confirm: true, channelId: pending.verified_channel_id } });
    assert.equal(confirm.statusCode, 200);
    const config = await db('integration_configs').where({ organization_id: fixture.otherOrgId, provider_id: fixture.providerId, status: 'active' }).first();
    assert.ok(config);
  });
} finally {
  if (originalYouTubeConnectBaseUrl == null) delete process.env.YOUTUBE_CONNECT_BASE_URL;
  else process.env.YOUTUBE_CONNECT_BASE_URL = originalYouTubeConnectBaseUrl;
  await cleanup();
  await db.destroy();
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n${detail}` : ''}`);
console.log(`Telegram YouTube connection UX tests: ${results.filter(([, ok]) => ok).length}/${results.length} PASS; DB=${actualTestDb}`);
process.exitCode = results.some(([, ok]) => !ok) ? 1 : 0;
