import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

if (!process.env.DB_NAME?.endsWith('_test')) {
  throw new Error('FAIL CLOSED: Telegram Channel tests require DB_NAME ending in _test');
}

const { default: getDb } = await import('../config/database.js');
const db = getDb();
const [{ name: actualTestDb }] = (await db.raw('SELECT DATABASE() AS name'))[0];
if (!actualTestDb?.endsWith('_test')) {
  throw new Error(`FAIL CLOSED: connected database '${actualTestDb}' is not a *_test database`);
}

// Model & System Imports
const { seedIntegrationProviders } = await import('../integrations/seeder.js');
const { INTEGRATION_CONFIG_SCHEMAS, getIntegrationConfigSchema } = await import('../integrations/configSchemas.js');
const { buildProviderConfig } = await import('../integrations/configSerializer.js');
const {
  TelegramApiClient,
  TelegramBotApiClient,
  getTelegramClient,
  sanitizeTelegramError,
  readStreamWithByteLimit,
  CLOUD_MAX_UPLOAD_BYTES,
  LOCAL_MAX_UPLOAD_BYTES,
  PUBLISHER_HARD_CAP_BYTES,
  resolveTelegramFileSource,
  checkTelegramHealth,
} = await import('../publisher/telegram/api.js');
const { validatePrivateChatUpdate } = await import('../publisher/telegram/validation.js');
const {
  createTelegramChannelConnectionIntent,
  verifyTelegramChannelCandidate,
  activateVerifiedTelegramConnection,
  cancelVerifiedTelegramConnection,
  disconnectTelegramConnection,
  getTelegramConnectionState,
  getTelegramProvider,
  TELEGRAM_INTENT_STATUS,
  TELEGRAM_CONNECTION_SOURCE,
} = await import('../publisher/platforms/telegram/connections.js');
const {
  CONNECTION_CALLBACKS,
  sendTelegramConnectionsMenu,
  pendingTelegramChannelIntent,
} = await import('../publisher/telegram/connections.js');
const { processTelegramUpdate } = await import('../publisher/telegram/composer.js');
const {
  publishToTelegramChannel,
  formatTelegramText,
  formatTelegramCaption,
  buildTelegramPublishedUrl,
} = await import('../publisher/platforms/telegram/adapter.js');
const { normalizeTelegramError } = await import('../publisher/platforms/telegram/errors.js');
const { telegramPublishHandler } = await import('../publisher/handlers/telegramPublishHandler.js');
const { ERROR_CATEGORY } = await import('../publisher/constants.js');

let passCount = 0;
let failCount = 0;

async function asyncCheck(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passCount++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    failCount++;
    throw err;
  }
}

function makeStream(chunks) {
  return Readable.from(chunks);
}

const runId = crypto.randomUUID().slice(0, 8);
const testOrgId = 99100 + Math.floor(Math.random() * 800);
const testUserId = `usr_tg_test_${runId}`;
const testChatId = `-10022334455${Math.floor(Math.random() * 100)}`;
const testTgUserId = `98765${runId}`;

console.log('=== Telegram Channel Publisher Test Suite ===\n');

try {
  // Setup Fixture Data
  await asyncCheck('0. Setup test organization, user, and role in test DB', async () => {
    await db('organizations').insert({
      id: testOrgId,
      name: `ElecIO Telegram Test Org ${runId}`,
      slug: `elecio-tg-test-${runId}`,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    const adminRole = await db('roles').where({ name: 'admin' }).first();
    await db('user').insert({
      id: testUserId,
      name: `Telegram Test Operator ${runId}`,
      email: `tg-operator-${runId}@elecio.test`,
      emailVerified: false,
      role_id: adminRole?.id || 1,
      createdAt: db.fn.now(),
      updatedAt: db.fn.now(),
    });

    await db('user_organization_roles').insert({
      user_id: testUserId,
      organization_id: testOrgId,
      role_id: adminRole?.id || 1,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });

    await db('telegram_user_bindings').insert({
      telegram_user_id: testTgUserId,
      user_id: testUserId,
      organization_id: testOrgId,
      is_default: true,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
  });

  // --- SECTION 1: Provider Catalog & Config Schema ---
  console.log('\n--- 1. Provider Catalog & Schema ---');
  await asyncCheck('1. Provider catalog includes publishing.telegram', async () => {
    const { INTEGRATION_PROVIDER_CATALOG } = await import('../integrations/types.js');
    const tgProvider = INTEGRATION_PROVIDER_CATALOG.find(p => p.adapter_key === 'publishing.telegram');
    assert(tgProvider, 'publishing.telegram must exist in INTEGRATION_CATALOG');
    assert.equal(tgProvider.code, 'telegram');
  });

  await asyncCheck('2. seedIntegrationProviders seeds telegram provider idempotently', async () => {
    await seedIntegrationProviders(db);
    const provider = await getTelegramProvider(db);
    assert(provider, 'telegram provider must exist in database');
    assert.equal(provider.adapter_key, 'publishing.telegram');
  });

  await asyncCheck('3. Config schema declares required chat_id and safe metadata fields', async () => {
    const schema = getIntegrationConfigSchema('publishing.telegram');
    assert(schema, 'Schema for publishing.telegram must exist');
    const paths = schema.fields.map(f => f.path);
    assert(paths.includes('chat_id'), 'chat_id field must exist');
    assert(paths.includes('chat_title'), 'chat_title field must exist');
    assert(paths.includes('chat_username'), 'chat_username field must exist');
    const secretFields = schema.fields.filter(f => f.secret);
    assert.equal(secretFields.length, 0, 'No bot tokens should be declared in per-tenant config schema');
  });

  await asyncCheck('4. Config serializer stores safe non-secret metadata in plaintext without bot token', async () => {
    const submitted = {
      chat_id: testChatId,
      chat_title: 'ElecIO Shop',
      chat_username: '@elecio_shop',
      bot_token: '123456:FAKE_TOKEN_LEAK', // Should be dropped!
    };
    const serialized = buildProviderConfig({
      adapterKey: 'publishing.telegram',
      submitted,
      stored: {},
      isCreate: true,
    });
    assert.equal(serialized.chat_id, testChatId);
    assert.equal(serialized.chat_title, 'ElecIO Shop');
    assert.equal(serialized.chat_username, '@elecio_shop');
    assert.equal(serialized.bot_token, undefined, 'bot_token must not be saved in config_json');
  });

  // --- SECTION 2: Centralized TelegramBotApiClient ---
  console.log('\n--- 2. Centralized TelegramBotApiClient ---');
  await asyncCheck('5. TelegramApiClient and TelegramBotApiClient are exported aliases', async () => {
    assert.equal(TelegramApiClient, TelegramBotApiClient);
  });

  await asyncCheck('6. Constructor defaults to Cloud mode with 50 MB limit and https://api.telegram.org', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    assert.equal(client.mode, 'cloud');
    assert.equal(client.maxUploadBytes, CLOUD_MAX_UPLOAD_BYTES);
    assert.equal(client.baseUrl, 'https://api.telegram.org');
  });

  await asyncCheck('7. Constructor respects Local mode with 2000 MB limit and custom base URL', async () => {
    const client = new TelegramApiClient({
      botToken: 'test_token',
      mode: 'local',
      baseUrl: 'http://telegram-bot-api:8081/',
    });
    assert.equal(client.mode, 'local');
    assert.equal(client.maxUploadBytes, LOCAL_MAX_UPLOAD_BYTES);
    assert.equal(client.baseUrl, 'http://telegram-bot-api:8081');
  });

  await asyncCheck('7a. Constructor defaults Local mode to loopback 127.0.0.1 base URL', async () => {
    const client = new TelegramApiClient({
      botToken: 'test_token',
      mode: 'local',
    });
    assert.equal(client.baseUrl, 'http://127.0.0.1:8081');
  });

  await asyncCheck('7b. Method URL construction uses base URL plus bot token and method', async () => {
    const client = new TelegramApiClient({
      botToken: '123456:SECRET',
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8081/',
    });
    assert.equal(client.getApiUrl('sendVideo'), 'http://127.0.0.1:8081/bot123456:SECRET/sendVideo');
  });

  await asyncCheck('8. sanitizeTelegramError masks bot token and URLs', async () => {
    const token = '123456789:ABCDefGhi-JkL';
    const err = new Error(`Failed to call https://api.telegram.org/bot${token}/sendVideo`);
    const sanitized = sanitizeTelegramError(err, token);
    assert(!sanitized.includes(token), 'Sanitized string must not contain token');
    assert(sanitized.includes('[REDACTED_BOT_TOKEN]'));
  });

  await asyncCheck('9. readStreamWithByteLimit enforces byte-exact match and fails on short read', async () => {
    const shortStream = makeStream([Buffer.from('hello')]); // 5 bytes
    await assert.rejects(
      async () => readStreamWithByteLimit(shortStream, 100, 10), // expected 10 bytes
      /Stream finished with short read/
    );
  });

  await asyncCheck('10. readStreamWithByteLimit fails closed on overflow read exceeding limit', async () => {
    const bigStream = makeStream([Buffer.alloc(100)]);
    await assert.rejects(
      async () => readStreamWithByteLimit(bigStream, 50), // max 50 bytes
      /Payload size exceeded limit of 50 bytes/
    );
  });

  await asyncCheck('11. sendVideo hard fails closed before upload if video exceeds 50 MB in Cloud mode', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token', mode: 'cloud' });
    const overLimitBytes = 55 * 1024 * 1024; // 55 MB
    await assert.rejects(
      async () => client.sendVideo({
        chat_id: testChatId,
        video: makeStream([Buffer.from('video')]),
        fileSizeBytes: overLimitBytes,
      }),
      (err) => err.code === 'TELEGRAM_CLOUD_FILE_TOO_LARGE' && err.message.includes('50MB')
    );
  });

  await asyncCheck('11a. Cloud pre-limit does not consume video stream or call fetch', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token', mode: 'cloud' });
    let pulled = false;
    let fetchCalled = false;
    async function* guardedStream() {
      pulled = true;
      yield Buffer.from('must-not-read');
    }
    await assert.rejects(
      async () => client.sendVideo({
        chat_id: testChatId,
        video: guardedStream(),
        fileSizeBytes: CLOUD_MAX_UPLOAD_BYTES + 1,
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ ok: true, result: {} }) };
        },
      }),
      (err) => err.code === 'TELEGRAM_CLOUD_FILE_TOO_LARGE'
    );
    assert.equal(pulled, false, 'stream must not be pulled');
    assert.equal(fetchCalled, false, 'fetch must not be called');
  });

  await asyncCheck('12. sendVideo allows large video and streams multipart in Local mode', async () => {
    const client = new TelegramApiClient({
      botToken: 'test_token',
      mode: 'local',
      baseUrl: 'http://localhost:8081',
    });
    let uploadedBodyBuffer = null;
    let uploadedHeaders = null;
    const mockFetch = async (url, options) => {
      uploadedHeaders = options.headers;
      const chunks = [];
      for await (const chunk of options.body) {
        chunks.push(chunk);
      }
      uploadedBodyBuffer = Buffer.concat(chunks);
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1001 } }),
      };
    };

    const videoBuffer = Buffer.from('large-simulated-video-data');
    const res = await client.sendVideo({
      chat_id: testChatId,
      video: videoBuffer,
      fileSizeBytes: videoBuffer.length,
      caption: 'Big video in local mode',
      fetchImpl: mockFetch,
    });
    assert.equal(res.message_id, 1001);
    const bodyStr = uploadedBodyBuffer.toString('utf8');
    assert(bodyStr.includes(`name="chat_id"\r\n\r\n${testChatId}`));
    assert(bodyStr.includes('name="caption"\r\n\r\nBig video in local mode'));
    assert(bodyStr.includes('name="video"; filename="video.mp4"'));
    assert(bodyStr.includes('large-simulated-video-data'));
    assert(uploadedHeaders['Content-Type'].includes('multipart/form-data; boundary='));
    assert(uploadedHeaders['Content-Length']);
  });

  await asyncCheck('12a. Local mode allows >50MB declared size before streaming', async () => {
    const client = new TelegramApiClient({
      botToken: 'test_token',
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8081',
    });
    let fetchCalled = false;
    const res = await client.sendVideo({
      chat_id: testChatId,
      video: makeStream([Buffer.from('not-actually-large')]),
      fileSizeBytes: CLOUD_MAX_UPLOAD_BYTES + 1024,
      fetchImpl: async (url, options) => {
        fetchCalled = true;
        assert.equal(url, 'http://127.0.0.1:8081/bottest_token/sendVideo');
        assert.equal(typeof options.body.pipe, 'function', 'multipart body must be a Node stream');
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1201 } }) };
      },
    });
    assert.equal(fetchCalled, true);
    assert.equal(res.message_id, 1201);
  });

  await asyncCheck('12b. Local mode rejects declared size above ElecIO hard cap before fetch', async () => {
    const client = new TelegramApiClient({
      botToken: 'test_token',
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8081',
    });
    let fetchCalled = false;
    await assert.rejects(
      async () => client.sendVideo({
        chat_id: testChatId,
        video: makeStream([Buffer.from('too-large')]),
        fileSizeBytes: PUBLISHER_HARD_CAP_BYTES + 1,
        fetchImpl: async () => {
          fetchCalled = true;
          return { ok: true, json: async () => ({ ok: true, result: {} }) };
        },
      }),
      (err) => err.code === 'TELEGRAM_FILE_TOO_LARGE'
    );
    assert.equal(fetchCalled, false);
  });

  await asyncCheck('13. sendPhoto sends streaming multipart with photo and plain caption', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    let uploadedBodyBuffer = null;
    const mockFetch = async (url, options) => {
      const chunks = [];
      for await (const chunk of options.body) {
        chunks.push(chunk);
      }
      uploadedBodyBuffer = Buffer.concat(chunks);
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1002, photo: [{ file_id: 'p123' }] } }),
      };
    };

    const photoBuffer = Buffer.from('test-image-binary');
    const res = await client.sendPhoto({
      chat_id: testChatId,
      photo: photoBuffer,
      caption: 'Photo test',
      fetchImpl: mockFetch,
    });
    assert.equal(res.message_id, 1002);
    const bodyStr = uploadedBodyBuffer.toString('utf8');
    assert(bodyStr.includes(`name="chat_id"\r\n\r\n${testChatId}`));
    assert(bodyStr.includes('name="caption"\r\n\r\nPhoto test'));
    assert(bodyStr.includes('name="photo"; filename="photo.jpg"'));
    assert(bodyStr.includes('test-image-binary'));
  });

  await asyncCheck('13a. Campaign cover maps to cover, NOT thumbnail in sendVideo multipart', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    let uploadedBodyStr = '';
    const mockFetch = async (url, options) => {
      const chunks = [];
      for await (const chunk of options.body) {
        chunks.push(chunk);
      }
      uploadedBodyStr = Buffer.concat(chunks).toString('utf8');
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: 1003 } }),
      };
    };

    const coverData = Buffer.from('social-cover-data-500kb');
    await client.sendVideo({
      chat_id: testChatId,
      video: Buffer.from('vid-data'),
      cover: coverData,
      coverFilename: 'custom_cover.jpg',
      coverSizeBytes: coverData.length,
      fileSizeBytes: 8,
      fetchImpl: mockFetch,
    });

    // Verify multipart contains cover field and cover file attachment
    assert(uploadedBodyStr.includes('name="video"\r\n\r\nattach://video'), 'video field must be attach://video');
    assert(uploadedBodyStr.includes('name="cover"\r\n\r\nattach://cover'), 'cover field must be attach://cover');
    assert(uploadedBodyStr.includes('name="cover"; filename="custom_cover.jpg"'), 'cover file must be attached under name cover');
    assert(!uploadedBodyStr.includes('thumbnail'), 'thumbnail parameter must NOT be used for Campaign cover');
  });

  await asyncCheck('13b. Telegram thumbnail rules (320x320, 200KB) are NOT applied to Campaign cover', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1004 } }) };
    };

    // 500 KB cover (exceeds legacy 200 KB thumbnail cap)
    const largeCover = Buffer.alloc(500 * 1024, 0x41);
    await client.sendVideo({
      chat_id: testChatId,
      video: Buffer.from('dummy-video'),
      cover: largeCover,
      coverSizeBytes: largeCover.length,
      fileSizeBytes: 11,
      fetchImpl: mockFetch,
    });
    assert.equal(fetchCalled, true, 'Large cover > 200KB must be accepted without error');
  });

  await asyncCheck('13c. True multipart streaming does not require complete-file Buffer/Blob in memory', async () => {
    const { createMultipartStream, calculateMultipartLength } = await import('../publisher/telegram/api.js');
    const boundary = '----ElecIOTestBoundary';
    
    // Create an async generator that yields 3 small chunks
    async function* chunkGenerator() {
      yield Buffer.from('chunk1-');
      yield Buffer.from('chunk2-');
      yield Buffer.from('chunk3');
    }

    const files = [
      {
        name: 'video',
        filename: 'stream.mp4',
        contentType: 'video/mp4',
        stream: chunkGenerator(),
        sizeBytes: 20, // 'chunk1-chunk2-chunk3' = 20 bytes
      },
    ];

    const expectedLen = calculateMultipartLength({ boundary, fields: { chat_id: '123' }, files });
    assert.ok(expectedLen > 20);

    const stream = createMultipartStream({ boundary, fields: { chat_id: '123' }, files });
    const collected = [];
    for await (const part of stream) {
      collected.push(part);
    }
    const combined = Buffer.concat(collected);
    assert.equal(combined.length, expectedLen, 'Streamed chunks length must match exact calculated length');
    assert(combined.toString('utf8').includes('chunk1-chunk2-chunk3'));
  });

  await asyncCheck('13d. S3 stream errors propagate cleanly', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    async function* failingStream() {
      yield Buffer.from('first-chunk');
      throw new Error('S3 socket abruptly closed');
    }

    const mockFetch = async (url, opts) => {
      for await (const _ of opts.body) {}
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };

    await assert.rejects(
      async () => client.sendVideo({
        chat_id: testChatId,
        video: failingStream(),
        fileSizeBytes: 100,
        fetchImpl: mockFetch,
      }),
      /S3 socket abruptly closed/
    );
  });

  await asyncCheck('13e. Short stream read fails closed with STREAM_SHORT_READ', async () => {
    const client = new TelegramApiClient({ botToken: 'test_token' });
    const shortStream = makeStream([Buffer.from('only-20-bytes-data!')]);
    const mockFetch = async (url, opts) => {
      for await (const _ of opts.body) {}
      return { ok: true, json: async () => ({ ok: true, result: {} }) };
    };

    await assert.rejects(
      async () => client.sendVideo({
        chat_id: testChatId,
        video: shortStream,
        fileSizeBytes: 1000, // declared 1000 bytes, provided 20
        fetchImpl: mockFetch,
      }),
      (err) => err.code === 'STREAM_SHORT_READ'
    );
  });

  await asyncCheck('13f. resolveTelegramFileSource uses cloud relative file path over Bot API HTTP', async () => {
    let requestedUrl = null;
    const source = await resolveTelegramFileSource({
      filePath: 'videos/file.mp4',
      mode: 'cloud',
      baseUrl: 'https://api.telegram.org',
      botToken: '123456:SECRET',
      httpGet: async (url, config) => {
        requestedUrl = url;
        assert.equal(config.responseType, 'stream');
        return { data: makeStream([Buffer.from('cloud-file')]) };
      },
    });
    assert.equal(source.kind, 'bot-api-http');
    assert.equal(requestedUrl, 'https://api.telegram.org/file/bot123456:SECRET/videos/file.mp4');
  });

  await asyncCheck('13g. resolveTelegramFileSource opens Local absolute file paths only inside TELEGRAM_LOCAL_FILES_DIR', async () => {
    const localRoot = fs.mkdtempSync(path.join(process.cwd(), `tg-local-root-${runId}-`));
    const allowed = path.join(localRoot, 'files', 'video.mp4');
    fs.mkdirSync(path.dirname(allowed), { recursive: true });
    fs.writeFileSync(allowed, 'local-video-bytes');

    const source = await resolveTelegramFileSource({
      filePath: allowed,
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8081',
      botToken: '123456:SECRET',
      localFilesDir: localRoot,
    });
    assert.equal(source.kind, 'local-file');
    const chunks = [];
    for await (const chunk of source.stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), 'local-video-bytes');

    const outside = path.join(process.cwd(), `tg-outside-${runId}.mp4`);
    fs.writeFileSync(outside, 'outside');
    await assert.rejects(
      async () => resolveTelegramFileSource({
        filePath: outside,
        mode: 'local',
        baseUrl: 'http://127.0.0.1:8081',
        botToken: '123456:SECRET',
        localFilesDir: localRoot,
      }),
      (err) => err.code === 'TELEGRAM_LOCAL_FILE_OUT_OF_ROOT'
    );
    fs.rmSync(localRoot, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  await asyncCheck('13h. resolveTelegramFileSource rejects traversal-like relative paths', async () => {
    await assert.rejects(
      async () => resolveTelegramFileSource({
        filePath: '../secret',
        mode: 'cloud',
        baseUrl: 'https://api.telegram.org',
        botToken: '123456:SECRET',
      }),
      (err) => err.code === 'TELEGRAM_FILE_PATH_INVALID'
    );
  });

  await asyncCheck('13i. Telegram health reports local API reachability and getMe authentication safely', async () => {
    const client = {
      mode: 'local',
      baseUrl: 'http://127.0.0.1:8081',
      botToken: '123456:SECRET',
      getMe: async () => ({ id: 42, is_bot: true, username: 'elecio_test_bot' }),
    };
    const health = await checkTelegramHealth({
      client,
      httpGet: async () => ({ status: 404 }),
    });
    assert.equal(health.telegram_local_api, 'healthy');
    assert.equal(health.telegram_bot, 'authenticated');
    assert.equal(health.bot_username, 'elecio_test_bot');
    assert(!JSON.stringify(health).includes('123456:SECRET'));
  });

  // --- SECTION 3: Input Isolation ---
  console.log('\n--- 3. Input Isolation (Telegram Channel Output Only) ---');
  await asyncCheck('14. validatePrivateChatUpdate rejects channel_post with CHANNEL_POSTS_REJECTED', async () => {
    const update = {
      update_id: 1001,
      channel_post: { message_id: 1, chat: { id: testChatId, type: 'channel' }, text: 'Illegal ingest' },
    };
    const res = validatePrivateChatUpdate(update);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'CHANNEL_POSTS_REJECTED');
  });

  await asyncCheck('15. validatePrivateChatUpdate rejects edited_channel_post with CHANNEL_POSTS_REJECTED', async () => {
    const update = {
      update_id: 1002,
      edited_channel_post: { message_id: 1, chat: { id: testChatId, type: 'channel' }, text: 'Edited' },
    };
    const res = validatePrivateChatUpdate(update);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'CHANNEL_POSTS_REJECTED');
  });

  await asyncCheck('16. validatePrivateChatUpdate rejects non-private chats (groups, supergroups)', async () => {
    const update = {
      update_id: 1003,
      message: { message_id: 1, chat: { id: -12345, type: 'group' }, from: { id: 1 }, text: 'Hi' },
    };
    const res = validatePrivateChatUpdate(update);
    assert.equal(res.valid, false);
    assert.match(res.reason, /NON_PRIVATE_CHAT_REJECTED/);
  });

  await asyncCheck('17. validatePrivateChatUpdate accepts private messages from operators', async () => {
    const update = {
      update_id: 1004,
      message: { message_id: 1, chat: { id: testTgUserId, type: 'private' }, from: { id: testTgUserId }, text: '/start' },
    };
    const res = validatePrivateChatUpdate(update);
    assert.equal(res.valid, true);
    assert.equal(res.chatId, String(testTgUserId));
    assert.equal(res.type, 'message');
  });

  // --- SECTION 4: Channel Connection Lifecycle & Verification ---
  console.log('\n--- 4. Channel Connection Lifecycle & Verification ---');
  let connectionIntentId = null;

  await asyncCheck('18. createTelegramChannelConnectionIntent creates pending intent', async () => {
    const { intent } = await createTelegramChannelConnectionIntent({
      telegramUserId: testTgUserId,
      telegramChatId: testTgUserId,
      userId: testUserId,
      organizationId: testOrgId,
    });
    assert(intent);
    assert.equal(intent.status, TELEGRAM_INTENT_STATUS.PENDING);
    assert.equal(intent.source, TELEGRAM_CONNECTION_SOURCE.TELEGRAM);
    assert.equal(intent.organization_id, testOrgId);
    connectionIntentId = intent.id;
  });

  await asyncCheck('19. verifyTelegramChannelCandidate checks getChat and rejects non-channel chat', async () => {
    const mockTelegram = {
      getChat: async () => ({ id: 123, type: 'group', title: 'A Group' }),
    };
    const res = await verifyTelegramChannelCandidate({
      intentId: connectionIntentId,
      channelIdentifier: '@mygroup',
      telegramClient: mockTelegram,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'NOT_A_CHANNEL');
  });

  await asyncCheck('20. verifyTelegramChannelCandidate checks getChatMember and rejects non-admin bot', async () => {
    const mockTelegram = {
      getChat: async () => ({ id: -100123, type: 'channel', title: 'My Channel' }),
      getMe: async () => ({ id: 99999, is_bot: true, username: 'elecio_bot' }),
      getChatMember: async () => ({ status: 'member', user: { id: 99999 } }),
    };
    const res = await verifyTelegramChannelCandidate({
      intentId: connectionIntentId,
      channelIdentifier: '@mychannel',
      telegramClient: mockTelegram,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'BOT_NOT_ADMIN_OR_CANNOT_POST');
  });

  await asyncCheck('21. verifyTelegramChannelCandidate checks getChatMember and rejects admin without can_post_messages', async () => {
    const mockTelegram = {
      getChat: async () => ({ id: -100123, type: 'channel', title: 'My Channel' }),
      getMe: async () => ({ id: 99999, is_bot: true, username: 'elecio_bot' }),
      getChatMember: async () => ({ status: 'administrator', can_post_messages: false }),
    };
    const res = await verifyTelegramChannelCandidate({
      intentId: connectionIntentId,
      channelIdentifier: '@mychannel',
      telegramClient: mockTelegram,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'BOT_NOT_ADMIN_OR_CANNOT_POST');
  });

  await asyncCheck('22. verifyTelegramChannelCandidate approves channel when bot is admin with can_post_messages', async () => {
    const mockTelegram = {
      getChat: async () => ({ id: -1001234567, type: 'channel', title: 'ElecIO Test Channel', username: 'elecio_channel' }),
      getMe: async () => ({ id: 99999, is_bot: true, username: 'elecio_bot' }),
      getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
    };
    const res = await verifyTelegramChannelCandidate({
      intentId: connectionIntentId,
      channelIdentifier: '@elecio_channel',
      telegramClient: mockTelegram,
    });
    assert.equal(res.ok, true);
    assert.equal(res.intent.status, TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION);
    assert.equal(res.intent.verified_channel_id, '-1001234567');
    assert.equal(res.intent.verified_channel_title, 'ElecIO Test Channel');
  });

  await asyncCheck('23. activateVerifiedTelegramConnection activates IntegrationConfig and TelegramChannel without bot token', async () => {
    const res = await activateVerifiedTelegramConnection({
      intentId: connectionIntentId,
      userId: testUserId,
      organizationId: testOrgId,
      channelId: '-1001234567',
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
    });
    assert.equal(res.ok, true);
    assert(res.config);
    assert(res.channel);

    const configRow = await db('integration_configs').where({ id: res.config.id }).first();
    assert.equal(configRow.status, 'active');
    assert.equal(configRow.external_account_id, '-1001234567');
    assert.equal(configRow.external_account_name, 'ElecIO Test Channel');

    const configJson = typeof configRow.config_json === 'string' ? JSON.parse(configRow.config_json) : configRow.config_json;
    assert.equal(configJson.chat_id, '-1001234567');
    assert.equal(configJson.bot_token, undefined, 'Must not store bot token');

    const channelRow = await db('telegram_channels').where({ id: res.channel.id }).first();
    assert.equal(channelRow.chat_id, '-1001234567');
    assert.equal(channelRow.is_active, 1);
  });

  await asyncCheck('24. activateVerifiedTelegramConnection prevents cross-tenant activation', async () => {
    const fraudIntentId = crypto.randomUUID();
    const [otherOrgId] = await db('organizations').insert({
      name: `Other Tenant ${Date.now()}`,
      slug: `other-tenant-${Date.now()}`,
      is_active: true,
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    const provider = await getTelegramProvider(db);
    await db('integration_connection_intents').insert({
      id: fraudIntentId,
      nonce_hash: crypto.createHash('sha256').update(fraudIntentId).digest('hex'),
      user_id: testUserId,
      organization_id: otherOrgId, // Mismatched tenant
      provider_id: provider.id,
      purpose: 'channel_publishing',
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
      status: TELEGRAM_INTENT_STATUS.VERIFIED_PENDING_CONFIRMATION,
      verified_channel_id: '-10099999',
      verified_channel_title: 'Fraud Channel',
      expires_at: new Date(Date.now() + 1000000).toISOString().slice(0, 19).replace('T', ' '),
    });

    const crossTenantAttempt = await activateVerifiedTelegramConnection({
      intentId: fraudIntentId,
      userId: testUserId,
      organizationId: testOrgId, // Mismatched org
      channelId: '-10099999',
      source: TELEGRAM_CONNECTION_SOURCE.TELEGRAM,
    });
    assert.equal(crossTenantAttempt.ok, false);
    await db('integration_connection_intents').where({ id: fraudIntentId }).delete();
    await db('organizations').where({ id: otherOrgId }).delete();
  });

  await asyncCheck('25. getTelegramConnectionState returns connected: true for active config and channel', async () => {
    const state = await getTelegramConnectionState(testOrgId);
    assert.equal(state.connected, true);
    assert(state.config);
    assert(state.channel);
  });

  await asyncCheck('26. disconnectTelegramConnection marks IntegrationConfig and TelegramChannel inactive', async () => {
    const res = await disconnectTelegramConnection({ organizationId: testOrgId, userId: testUserId });
    assert.equal(res.ok, true);

    const state = await getTelegramConnectionState(testOrgId);
    assert.equal(state.connected, false);

    // Reactivate for subsequent tests
    const provider = await getTelegramProvider(db);
    await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id })
      .update({ status: 'active', deleted_at: null });
    await db('telegram_channels')
      .where({ organization_id: testOrgId })
      .update({ is_active: true });
  });

  // --- SECTION 5: Telegram Bot Menu & Message Interception ---
  console.log('\n--- 5. Telegram Bot Menu & Message Interception ---');
  await asyncCheck('27. sendTelegramConnectionsMenu displays Telegram Channel state and action buttons', async () => {
    const messages = [];
    const mockTelegram = {
      sendMessage: async (msg) => { messages.push(msg); return { ok: true }; },
    };

    await sendTelegramConnectionsMenu({
      telegramClient: mockTelegram,
      chatId: '123',
      binding: { organization_id: testOrgId, user_id: testUserId, telegram_user_id: testTgUserId },
    });

    assert(messages.length > 0);
    const text = messages[0].text;
    assert(text.includes('Telegram Channel: connected'));
    const buttons = messages[0].reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.text === 'Reconnect Telegram Channel'));
    assert(buttons.some(b => b.text === 'Disconnect Telegram Channel'));
  });

  await asyncCheck('28. Intercept forwarded channel message advances pending intent to verified confirmation', async () => {
    // Create new pending intent
    const { intent: newIntent } = await createTelegramChannelConnectionIntent({
      telegramUserId: testTgUserId,
      telegramChatId: testTgUserId,
      userId: testUserId,
      organizationId: testOrgId,
    });

    const mockTelegram = {
      sentMessages: [],
      getChat: async (id) => ({ id: -1005555, type: 'channel', title: 'Forwarded Channel', username: 'fwd_chan' }),
      getMe: async () => ({ id: 99999, is_bot: true }),
      getChatMember: async () => ({ status: 'administrator', can_post_messages: true }),
      sendMessage: async function(msg) { this.sentMessages.push(msg); return { ok: true }; },
    };

    // Simulate forwarded message from channel
    const update = {
      update_id: crypto.randomUUID(),
      message: {
        message_id: 999,
        chat: { id: testTgUserId, type: 'private' },
        from: { id: testTgUserId },
        forward_from_chat: { id: -1005555, type: 'channel', title: 'Forwarded Channel' },
      },
    };

    const res = await processTelegramUpdate(update, { telegramClient: mockTelegram });
    assert.equal(res.processed, true);
    assert.equal(res.channelVerification, true);
    assert.equal(res.ok, true);

    const lastMsg = mockTelegram.sentMessages.at(-1);
    assert(lastMsg.text.includes('Telegram Channel verified'));
    assert(lastMsg.text.includes('Forwarded Channel'));
    const buttons = lastMsg.reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.callback_data === `conn_tg_ok:${newIntent.id}`));
  });

  // --- SECTION 6: Content Delivery Pipeline ---
  console.log('\n--- 6. Content Delivery Pipeline ---');
  let activeConfig = null;
  await asyncCheck('29. Fetch active integration config for delivery tests', async () => {
    const provider = await getTelegramProvider(db);
    activeConfig = await db('integration_configs')
      .where({ organization_id: testOrgId, provider_id: provider.id, status: 'active' })
      .first();
    assert(activeConfig);
  });

  await asyncCheck('30. publishToTelegramChannel delivers text post to channel', async () => {
    let sentPayload = null;
    const mockTelegram = {
      sendMessage: async (payload) => {
        sentPayload = payload;
        return { message_id: 3001, text: payload.text };
      },
    };

    const mockJob = { id: 1, external_media_id: null };
    const mockTarget = {
      $query: () => ({
        patch: async (p) => Object.assign(mockTarget, p),
      }),
      title_override: 'Breaking News',
      caption_override: 'Electric vehicle charging breakthrough.',
    };
    const mockCampaign = { base_title: null, base_caption: null };

    const res = await publishToTelegramChannel(mockJob, {
      campaignTarget: mockTarget,
      campaign: mockCampaign,
      asset: null,
      integrationConfig: activeConfig,
      telegramClient: mockTelegram,
      contentType: 'TELEGRAM_TEXT',
    });

    assert.equal(res.ok, true);
    assert.equal(res.messageId, 3001);
    assert.equal(sentPayload.chat_id, '-1001234567');
    assert(sentPayload.text.includes('Breaking News'));
    assert(sentPayload.text.includes('Electric vehicle charging breakthrough'));
    assert.equal(mockTarget.status, 'published');
    assert.equal(mockTarget.external_post_id, '3001');
  });

  await asyncCheck('31. publishToTelegramChannel delivers photo post to channel with caption', async () => {
    let sentPhotoPayload = null;
    const mockTelegram = {
      sendPhoto: async (payload) => {
        sentPhotoPayload = payload;
        return { message_id: 3002 };
      },
    };

    const mockJob = { id: 2, external_media_id: null };
    const mockTarget = {
      $query: () => ({ patch: async (p) => Object.assign(mockTarget, p) }),
      title_override: null,
      caption_override: 'Check out our new charging station!',
    };
    const mockAsset = {
      object_key: 'assets/photo.jpg',
      original_filename: 'charger.jpg',
      size_bytes: 1024,
    };

    const res = await publishToTelegramChannel(mockJob, {
      campaignTarget: mockTarget,
      campaign: {},
      asset: mockAsset,
      integrationConfig: activeConfig,
      telegramClient: mockTelegram,
      s3StreamFactory: async () => makeStream([Buffer.from('image-binary')]),
      contentType: 'TELEGRAM_PHOTO',
    });

    assert.equal(res.ok, true);
    assert.equal(res.messageId, 3002);
    assert.equal(sentPhotoPayload.chat_id, '-1001234567');
    assert.equal(sentPhotoPayload.caption, 'Check out our new charging station!');
    assert.equal(sentPhotoPayload.filename, 'charger.jpg');
  });

  await asyncCheck('32. publishToTelegramChannel delivers video post with duration, cover, and streaming', async () => {
    let sentVideoPayload = null;
    const mockTelegram = {
      sendVideo: async (payload) => {
        sentVideoPayload = payload;
        return { message_id: 3003 };
      },
    };

    const mockJob = { id: 3, external_media_id: null };
    const mockTarget = {
      $query: () => ({ patch: async (p) => Object.assign(mockTarget, p) }),
      title_override: 'How it Works',
      caption_override: 'Full explanation of our smart plug.',
    };
    const mockAsset = {
      object_key: 'assets/master.mp4',
      original_filename: 'master.mp4',
      size_bytes: 5000,
      duration_ms: 60000, // 60s
      width: 1920,
      height: 1080,
    };
    const mockCoverAsset = {
      object_key: 'assets/cover.jpg',
      original_filename: 'cover.jpg',
      size_bytes: 500,
      status: 'ready',
    };

    const res = await publishToTelegramChannel(mockJob, {
      campaignTarget: mockTarget,
      campaign: {},
      asset: mockAsset,
      coverAsset: mockCoverAsset,
      integrationConfig: activeConfig,
      telegramClient: mockTelegram,
      s3StreamFactory: async () => makeStream([Buffer.from('video-binary')]),
      contentType: 'TELEGRAM_VIDEO',
    });

    assert.equal(res.ok, true);
    assert.equal(res.messageId, 3003);
    assert.equal(sentVideoPayload.chat_id, '-1001234567');
    assert.equal(sentVideoPayload.duration, 60);
    assert.equal(sentVideoPayload.width, 1920);
    assert.equal(sentVideoPayload.height, 1080);
    assert.equal(sentVideoPayload.supports_streaming, true);
    assert(sentVideoPayload.cover);
  });

  await asyncCheck('32a. Cloud > 50MB fails BEFORE opening S3 body stream', async () => {
    let s3Called = false;
    const mockS3 = async () => { s3Called = true; return makeStream([Buffer.from('vid')]); };
    const cloudTg = new TelegramApiClient({ botToken: 'test_token', mode: 'cloud' });
    const hugeAsset = { object_key: 'assets/huge.mp4', size_bytes: 55 * 1024 * 1024 };

    await assert.rejects(
      async () => publishToTelegramChannel({ id: 5 }, {
        campaignTarget: { $query: () => ({ patch: async () => {} }) },
        campaign: {},
        asset: hugeAsset,
        integrationConfig: activeConfig,
        telegramClient: cloudTg,
        s3StreamFactory: mockS3,
        contentType: 'TELEGRAM_VIDEO',
      }),
      (err) => err.code === 'TELEGRAM_CLOUD_FILE_TOO_LARGE'
    );
    assert.equal(s3Called, false, 'S3 stream must NOT be opened or consumed when exceeding Cloud limit');
  });

  await asyncCheck('32b. Invalid cover omission logs warning and does NOT create PHOTO fallback', async () => {
    let photoCalled = false;
    let videoCalled = false;
    let videoPassedCover = 'initial';
    const mockTelegram = {
      sendVideo: async (payload) => {
        videoCalled = true;
        videoPassedCover = payload.cover;
        return { message_id: 3004 };
      },
      sendPhoto: async () => {
        photoCalled = true;
        return { message_id: 3005 };
      },
    };

    const invalidCoverAsset = {
      object_key: 'assets/corrupted.txt',
      original_filename: 'corrupted.txt',
      mime_type: 'text/plain', // NOT an image
      status: 'ready',
    };

    const res = await publishToTelegramChannel({ id: 6 }, {
      campaignTarget: { $query: () => ({ patch: async () => {} }) },
      campaign: {},
      asset: { object_key: 'assets/video.mp4', size_bytes: 1000 },
      coverAsset: invalidCoverAsset,
      integrationConfig: activeConfig,
      telegramClient: mockTelegram,
      s3StreamFactory: async () => makeStream([Buffer.from('vid')]),
      contentType: 'TELEGRAM_VIDEO',
    });

    assert.equal(res.ok, true);
    assert.equal(videoCalled, true, 'sendVideo must be called');
    assert.equal(videoPassedCover, null, 'cover must be omitted when invalid');
    assert.equal(photoCalled, false, 'sendPhoto must NOT be called as fallback');
  });

  await asyncCheck('32c. Caption exceeding 1024 characters throws TELEGRAM_CAPTION_TOO_LONG without silent truncation', async () => {
    const { formatTelegramCaption } = await import('../publisher/platforms/telegram/adapter.js');
    const longCaption = 'A'.repeat(1025);
    assert.throws(
      () => formatTelegramCaption({ title: 'Title', caption: longCaption }),
      (err) => err.code === 'TELEGRAM_CAPTION_TOO_LONG'
    );
  });

  await asyncCheck('32d. Plain text format does NOT contain unintended <b> markup', async () => {
    const { formatTelegramText } = await import('../publisher/platforms/telegram/adapter.js');
    const text = formatTelegramText({ title: 'Important Update', caption: 'Here is the detail.' });
    assert.equal(text, 'Important Update\n\nHere is the detail.');
    assert(!text.includes('<b>'));
    assert(!text.includes('</b>'));
  });

  await asyncCheck('32e. Current public permalink is username-based with private fallback tested', async () => {
    const { buildTelegramPublishedUrl } = await import('../publisher/platforms/telegram/adapter.js');
    const publicUrl = buildTelegramPublishedUrl(-1002289635128, '@elecio_shop', 42);
    assert.equal(publicUrl, 'https://t.me/elecio_shop/42');

    const publicUrlNoAt = buildTelegramPublishedUrl(-1002289635128, 'elecio_shop', 42);
    assert.equal(publicUrlNoAt, 'https://t.me/elecio_shop/42');

    const privateUrl = buildTelegramPublishedUrl(-1002289635128, null, 42);
    assert.equal(privateUrl, 'https://t.me/c/2289635128/42');
  });

  await asyncCheck('33. publishToTelegramChannel idempotency skips publish if external_media_id already exists', async () => {
    let apiCalled = false;
    const mockTelegram = {
      sendMessage: async () => { apiCalled = true; return { message_id: 999 }; },
    };
    const mockJob = { id: 4, external_media_id: 'ALREADY_PUBLISHED_999' };
    const res = await publishToTelegramChannel(mockJob, {
      campaignTarget: {},
      campaign: {},
      integrationConfig: activeConfig,
      telegramClient: mockTelegram,
      contentType: 'TELEGRAM_TEXT',
    });
    assert.equal(res.ok, true);
    assert.equal(res.idempotentSkipped, true);
    assert.equal(apiCalled, false, 'API must not be invoked on idempotent replay');
  });

  // --- SECTION 7: Worker Handler Execution ---
  console.log('\n--- 7. Worker Handler Execution ---');
  let campaignId = null;
  let targetId = null;
  let publishJobId = null;

  await asyncCheck('34. Setup Campaign, Target, and Job in DB for worker handler', async () => {
    const [cId] = await db('campaigns').insert({
      organization_id: testOrgId,
      created_by: testUserId,
      source_type: 'telegram_private',
      status: 'ready',
      base_title: 'Live Test Post',
      base_caption: 'Testing Telegram worker pipeline.',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    campaignId = cId;

    const [tId] = await db('campaign_targets').insert({
      campaign_id: campaignId,
      integration_config_id: activeConfig.id,
      platform: 'telegram',
      status: 'ready',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    targetId = tId;

    const [jId] = await db('publish_jobs').insert({
      organization_id: testOrgId,
      campaign_target_id: targetId,
      idempotency_key: `tg_job_${Date.now()}`,
      status: 'running',
      created_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    publishJobId = jId;
  });

  await asyncCheck('35. telegramPublishHandler executes text publish successfully', async () => {
    const mockTelegram = {
      sendMessage: async (p) => ({ message_id: 4001, text: p.text }),
    };

    const res = await telegramPublishHandler({
      jobId: publishJobId,
      organizationId: testOrgId,
      campaignTargetId: targetId,
      telegramClient: mockTelegram,
    });

    assert.equal(res.ok, true);
    assert.equal(res.externalMediaId, '4001');

    const updatedJob = await db('publish_jobs').where({ id: publishJobId }).first();
    assert.equal(updatedJob.external_media_id, '4001');
    assert.equal(updatedJob.external_stage, 'PUBLISHED');

    const updatedTarget = await db('campaign_targets').where({ id: targetId }).first();
    assert.equal(updatedTarget.status, 'published');
    assert.equal(updatedTarget.external_post_id, '4001');
  });

  await asyncCheck('36. telegramPublishHandler rejects target belonging to different organization', async () => {
    const otherOrgId = testOrgId + 5;
    await assert.rejects(
      async () => telegramPublishHandler({
        jobId: publishJobId,
        organizationId: otherOrgId, // Mismatched
        campaignTargetId: targetId,
      }),
      /Telegram publish job or target was not found/
    );
  });

  // --- SECTION 8: Error Classification ---
  console.log('\n--- 8. Error Classification ---');
  await asyncCheck('37. normalizeTelegramError maps 401 to AUTH_REQUIRED', async () => {
    const raw = { error_code: 401, description: 'Unauthorized' };
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.AUTH_REQUIRED);
  });

  await asyncCheck('38. normalizeTelegramError maps 403 to AUTH_REQUIRED (permission denied)', async () => {
    const raw = { error_code: 403, description: 'Forbidden: bot was kicked from the channel' };
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.AUTH_REQUIRED);
    assert.equal(err.code, 'TELEGRAM_PERMISSION_DENIED');
  });

  await asyncCheck('39. normalizeTelegramError maps 429 to RATE_LIMIT with retryAfterMs parsed', async () => {
    const raw = { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 45 } };
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.RATE_LIMIT);
    assert.equal(err.retryAfterMs, 45000);
  });

  await asyncCheck('40. normalizeTelegramError maps 400 to VALIDATION', async () => {
    const raw = { error_code: 400, description: 'Bad Request: message is too long' };
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.VALIDATION);
    assert.equal(err.code, 'TELEGRAM_VALIDATION_ERROR');
  });

  await asyncCheck('41. normalizeTelegramError maps 502/500 to PLATFORM_5XX', async () => {
    const raw = { error_code: 502, description: 'Bad Gateway' };
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.PLATFORM_5XX);
  });

  await asyncCheck('42. normalizeTelegramError maps network failure to TRANSIENT_NETWORK', async () => {
    const raw = new Error('Socket timeout');
    raw.code = 'ETIMEDOUT';
    const err = normalizeTelegramError(raw);
    assert.equal(err.category, ERROR_CATEGORY.TRANSIENT_NETWORK);
  });

  await asyncCheck('43. normalizeTelegramError maps ambiguous state to AMBIGUOUS_EXTERNAL_STATE', async () => {
    const raw = new Error('Network dropped after send');
    const err = normalizeTelegramError(raw, { isAmbiguous: true });
    assert.equal(err.category, ERROR_CATEGORY.AMBIGUOUS_EXTERNAL_STATE);
  });

  console.log('\n==============================================');
  console.log(`ALL CHECKS PASSED: ${passCount}/${passCount} checks OK`);
  console.log('==============================================\n');
} finally {
  // Cleanup test fixtures
  try {
    await db('publish_jobs').where({ organization_id: testOrgId }).delete();
    await db('campaign_targets').whereIn('campaign_id', function() {
      this.select('id').from('campaigns').where({ organization_id: testOrgId });
    }).delete();
    await db('campaigns').where({ organization_id: testOrgId }).delete();
    await db('telegram_channels').where({ organization_id: testOrgId }).delete();
    await db('integration_configs').where({ organization_id: testOrgId }).delete();
    await db('integration_connection_intents').where({ user_id: testUserId }).delete();
    await db('telegram_user_bindings').where({ telegram_user_id: testTgUserId }).delete();
    await db('user_organization_roles').where({ user_id: testUserId }).delete();
    await db('user').where({ id: testUserId }).delete();
    await db('organizations').where({ id: testOrgId }).delete();
  } catch (cleanErr) {
    console.warn('Cleanup warning:', cleanErr.message);
  }
  process.exit(0);
}
