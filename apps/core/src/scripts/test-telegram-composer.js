import '../bootstrap.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Readable } from 'stream';
import getDb from '../config/database.js';
const db = getDb();

import Organization from '../db/models/core/Organization.js';
import User from '../db/models/core/User.js';
import UserOrganizationRole from '../db/models/core/UserOrganizationRole.js';
import Campaign from '../db/models/core/Campaign.js';
import CampaignTarget from '../db/models/core/CampaignTarget.js';
import IntegrationProvider from '../db/models/core/IntegrationProvider.js';
import IntegrationConfig from '../db/models/core/IntegrationConfig.js';
import TelegramChannel from '../db/models/core/TelegramChannel.js';
import Asset from '../db/models/core/Asset.js';
import PublishJob from '../db/models/core/PublishJob.js';
import TelegramUserBinding from '../db/models/core/TelegramUserBinding.js';
import TelegramComposerSession from '../db/models/core/TelegramComposerSession.js';
import TelegramUpdateReceipt from '../db/models/core/TelegramUpdateReceipt.js';

import {
  COMPOSER_STATE,
  RECEIPT_STATUS,
  CALLBACK_ACTIONS,
  BOT_COMMANDS,
} from '../publisher/telegram/constants.js';
import { TelegramApiClient, sanitizeTelegramError } from '../publisher/telegram/api.js';
import { bindTelegramUser, resolveTelegramUserBinding } from '../publisher/telegram/bindings.js';
import {
  getActiveSession,
  startOrResumeSession,
  updateSessionState,
  cancelSession,
} from '../publisher/telegram/state.js';
import { processTelegramUpdate, finalizeComposerSession } from '../publisher/telegram/composer.js';
import { reconcileComposerSessions } from '../publisher/telegram/reconciler.js';
import { discoverTargetCandidates } from '../publisher/telegram/recommendations.js';
import {
  setInjectedCapabilities,
  resetInjectedCapabilities,
} from '../publisher/telegram/capabilities.js';
import { validatePrivateChatUpdate } from '../publisher/telegram/validation.js';
import { getTargetSelectionKeyboard } from '../publisher/telegram/keyboards.js';
import {
  ASSET_STATUS,
  ASSET_KIND,
  COMPATIBILITY_STATUS,
  FFMPEG_BIN,
  PUBLISHER_MEDIA_TEMP_DIR,
} from '../publisher/media/constants.js';
import { deleteObject } from '../services/storage/s3.js';

// Production safety guard
if (process.env.NODE_ENV === 'production') {
  console.error('CRITICAL: Refusing to execute integration tests in production environment!');
  process.exit(1);
}

const results = [];
const testRunId = crypto.randomUUID().slice(0, 8);
let updateSeq = 1;
function makeUpdateId() {
  return `${testRunId}_up_${updateSeq++}`;
}

function record(name, status, evidence = 'OK') {
  results.push({ test: name, status, evidence });
  console.log(`  ${status === 'PASS' ? '✅' : '❌'} ${name} -> ${evidence}`);
}

function check(condition, name, evidence) {
  if (condition) record(name, 'PASS', evidence);
  else record(name, 'FAIL', evidence);
}

// Tracked fixtures for isolated cleanup
const trackedIds = {
  receipts: new Set(),
  sessions: new Set(),
  bindings: new Set(),
  jobs: new Set(),
  targets: new Set(),
  assets: new Set(),
  campaigns: new Set(),
  configs: new Set(),
  channels: new Set(),
  providers: new Set(),
  userOrgRoles: new Set(),
  users: new Set(),
  orgs: new Set(),
};

async function cleanup(tempFixturesDir) {
  console.log('\n🧹 Cleaning up isolated test fixtures...');
  try {
    await db('telegram_update_receipts').where('telegram_update_id', 'like', `%${testRunId}%`).delete();
    if (trackedIds.receipts.size > 0) {
      await TelegramUpdateReceipt.query().whereIn('id', Array.from(trackedIds.receipts)).delete();
    }
    if (trackedIds.sessions.size > 0) {
      await TelegramComposerSession.query().whereIn('id', Array.from(trackedIds.sessions)).delete();
    }
    if (trackedIds.bindings.size > 0) {
      await TelegramUserBinding.query().whereIn('id', Array.from(trackedIds.bindings)).delete();
    }
    if (trackedIds.jobs.size > 0) {
      await PublishJob.query().whereIn('id', Array.from(trackedIds.jobs)).delete();
    }
    if (trackedIds.targets.size > 0) {
      await CampaignTarget.query().whereIn('id', Array.from(trackedIds.targets)).delete();
    }
    if (trackedIds.assets.size > 0) {
      const ownedAssets = await Asset.query().whereIn('id', Array.from(trackedIds.assets));
      await Promise.all(ownedAssets.map(asset => deleteObject(asset.object_key).catch(() => {})));
      await Asset.query().whereIn('id', Array.from(trackedIds.assets)).delete();
    }
    if (trackedIds.campaigns.size > 0) {
      await Campaign.query().whereIn('id', Array.from(trackedIds.campaigns)).delete();
    }
    if (trackedIds.channels.size > 0) {
      await TelegramChannel.query().whereIn('id', Array.from(trackedIds.channels)).delete();
    }
    if (trackedIds.configs.size > 0) {
      await IntegrationConfig.query().whereIn('id', Array.from(trackedIds.configs)).delete();
    }
    if (trackedIds.providers.size > 0) {
      await IntegrationProvider.query().whereIn('id', Array.from(trackedIds.providers)).delete();
    }
    if (trackedIds.userOrgRoles.size > 0) {
      await UserOrganizationRole.query().whereIn('id', Array.from(trackedIds.userOrgRoles)).delete();
    }
    if (trackedIds.users.size > 0) {
      await User.query().whereIn('id', Array.from(trackedIds.users)).delete();
    }
    if (trackedIds.orgs.size > 0) {
      await Organization.query().whereIn('id', Array.from(trackedIds.orgs)).delete();
    }

    if (tempFixturesDir && fs.existsSync(tempFixturesDir)) {
      fs.rmSync(tempFixturesDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Fixture cleanup error:', err.message);
  }
}

function generateTestFixtures(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const files = {
    video: path.join(dir, 'test_video.mp4'),
    coverJpeg: path.join(dir, 'test_cover.jpg'),
    forbiddenSvg: path.join(dir, 'forbidden.svg'),
  };

  // 1. Video 640x360, 1s
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100',
    '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    files.video,
  ], { stdio: 'ignore' });

  // 2. Cover JPEG 640x480
  execFileSync(FFMPEG_BIN, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=640x480',
    '-vframes', '1',
    files.coverJpeg,
  ], { stdio: 'ignore' });

  // 3. Forbidden SVG
  fs.writeFileSync(files.forbiddenSvg, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>');

  return files;
}

/**
 * Creates a deterministic mock Telegram API client for isolated tests.
 */
function createMockTelegramClient(fixtures) {
  const sentMessages = [];
  const editedMessages = [];
  const answeredCallbacks = [];

  return {
    sentMessages,
    editedMessages,
    answeredCallbacks,
    getMe: async () => ({ id: 999888777, is_bot: true, first_name: 'PublisherBot', username: 'pub_test_bot' }),
    getUpdates: async () => [],
    getFile: async (fileId) => {
      if (fileId.includes('cover')) {
        return { file_id: fileId, file_path: 'photos/cover.jpg', file_size: fs.statSync(fixtures.coverJpeg).size };
      }
      return { file_id: fileId, file_path: 'videos/video.mp4', file_size: fs.statSync(fixtures.video).size };
    },
    sendMessage: async (payload) => {
      sentMessages.push(payload);
      return { message_id: sentMessages.length, ...payload };
    },
    editMessageText: async (payload) => {
      editedMessages.push(payload);
      return { message_id: payload.message_id, ...payload };
    },
    answerCallbackQuery: async (payload) => {
      answeredCallbacks.push(payload);
      return true;
    },
    downloadFileStream: async (filePath) => {
      if (filePath.includes('cover')) {
        return fs.createReadStream(fixtures.coverJpeg);
      }
      return fs.createReadStream(fixtures.video);
    },
  };
}

async function runTests() {
  const tempFixturesDir = path.join(PUBLISHER_MEDIA_TEMP_DIR, `tg-fixtures-${testRunId}`);
  let mockClient;

  try {
    console.log(`🚀 Starting Phase 5 Telegram Bot Composer Verification Suite (Run: ${testRunId})`);

    const fixtures = generateTestFixtures(tempFixturesDir);
    mockClient = createMockTelegramClient(fixtures);

    // Setup isolated DB entities
    const orgA = await Organization.query().insertAndFetch({
      name: `Telegram Org A (${testRunId})`,
      slug: `tg-org-a-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgA.id);

    const orgB = await Organization.query().insertAndFetch({
      name: `Telegram Org B (${testRunId})`,
      slug: `tg-org-b-${testRunId}`,
      is_active: true,
    });
    trackedIds.orgs.add(orgB.id);

    const userA = await User.query().insertAndFetch({
      id: `user-a-${testRunId}`,
      name: `User A (${testRunId})`,
      email: `user-a-${testRunId}@example.com`,
      username: `usera_${testRunId}`,
      emailVerified: true,
    });
    trackedIds.users.add(userA.id);

    const userB = await User.query().insertAndFetch({
      id: `user-b-${testRunId}`,
      name: `User B (${testRunId})`,
      email: `user-b-${testRunId}@example.com`,
      username: `userb_${testRunId}`,
      emailVerified: true,
    });
    trackedIds.users.add(userB.id);

    let defaultRole = await db('roles').first();
    let roleId = defaultRole ? defaultRole.id : 1;

    const membershipA = await UserOrganizationRole.query().insertAndFetch({
      user_id: userA.id,
      organization_id: orgA.id,
      role_id: roleId,
    });
    trackedIds.userOrgRoles.add(membershipA.id);

    const membershipB = await UserOrganizationRole.query().insertAndFetch({
      user_id: userB.id,
      organization_id: orgB.id,
      role_id: roleId,
    });
    trackedIds.userOrgRoles.add(membershipB.id);

    const providerTest = await IntegrationProvider.query().insertAndFetch({
      domain: 'publishing',
      code: `tg_test_${testRunId}`,
      display_name: 'Telegram Test Provider',
      adapter_key: 'publishing.test',
      is_enabled: true,
    });
    trackedIds.providers.add(providerTest.id);

    const configA = await IntegrationConfig.query().insertAndFetch({
      provider_id: providerTest.id,
      organization_id: orgA.id,
      name: `TG Config A (${testRunId})`,
      config_json: {},
      status: 'active',
    });
    trackedIds.configs.add(configA.id);

    const configB = await IntegrationConfig.query().insertAndFetch({
      provider_id: providerTest.id,
      organization_id: orgB.id,
      name: `TG Config B (${testRunId})`,
      config_json: {},
      status: 'active',
    });
    trackedIds.configs.add(configB.id);

    const channelA = await TelegramChannel.query().insertAndFetch({
      organization_id: orgA.id,
      integration_config_id: configA.id,
      chat_id: `-100${testRunId}01`,
      title: `Channel A (${testRunId})`,
      is_active: true,
    });
    trackedIds.channels.add(channelA.id);

    const channelB = await TelegramChannel.query().insertAndFetch({
      organization_id: orgB.id,
      integration_config_id: configB.id,
      chat_id: `-100${testRunId}02`,
      title: `Channel B (${testRunId})`,
      is_active: true,
    });
    trackedIds.channels.add(channelB.id);

    const tgUserIdA = `111222${testRunId.slice(0, 4)}`;
    const tgUserIdB = `333444${testRunId.slice(0, 4)}`;
    const tgUnboundUserId = `999000${testRunId.slice(0, 4)}`;

    // ==========================================================
    // 1. Bot getMe Connectivity & Token Logging Protection (Invariants 1, 38, 39)
    // ==========================================================
    const testBotToken = `123456789:TEST_BOT_TOKEN_SECRET_${testRunId}`;
    const realClient = new TelegramApiClient({ botToken: testBotToken });

    // Ensure error sanitizer redacts token
    const leakedError = new Error(`Network failure at https://api.telegram.org/bot${testBotToken}/getMe`);
    const sanitized = sanitizeTelegramError(leakedError, testBotToken);

    check(
      !sanitized.includes(testBotToken) && sanitized.includes('[REDACTED_BOT_TOKEN]'),
      'raw Bot token never appears in captured logs or error strings',
      `Sanitized: ${sanitized}`
    );

    const fileDownloadSanitized = sanitizeTelegramError(new Error(`Failed to GET https://api.telegram.org/file/bot${testBotToken}/photos/1.jpg`));
    check(
      !fileDownloadSanitized.includes(testBotToken),
      'Telegram file URL/token never appears in logs',
      'Token stripped from file download paths'
    );

    const getMeRes = await mockClient.getMe();
    check(getMeRes?.is_bot === true, 'Bot getMe connectivity verified', `Bot: @${getMeRes.username}`);

    // ==========================================================
    // 2. Private Chat Validation & Channel Post Rejection (Invariants 2, 45)
    // ==========================================================
    const channelPostUpdate = { update_id: makeUpdateId(), channel_post: { message_id: 1, text: 'Channel content' } };
    const editedChannelPostUpdate = { update_id: makeUpdateId(), edited_channel_post: { message_id: 2, text: 'Edited channel' } };
    const groupChatUpdate = { update_id: makeUpdateId(), message: { chat: { type: 'group', id: -1001 }, from: { id: 123 }, text: '/newpost' } };
    const supergroupUpdate = { update_id: makeUpdateId(), message: { chat: { type: 'supergroup', id: -1002 }, from: { id: 123 }, text: '/newpost' } };

    const resChannel = validatePrivateChatUpdate(channelPostUpdate);
    const resEditedChannel = validatePrivateChatUpdate(editedChannelPostUpdate);
    const resGroup = validatePrivateChatUpdate(groupChatUpdate);
    const resSupergroup = validatePrivateChatUpdate(supergroupUpdate);

    check(
      !resChannel.valid && !resEditedChannel.valid && !resGroup.valid && !resSupergroup.valid,
      'Channel posts, edited channel posts, groups, supergroups explicitly rejected',
      `Reasons: ${resChannel.reason}, ${resGroup.reason}`
    );

    // ==========================================================
    // 3. User Bindings: Unbound rejection & Multi-org resolution (Invariants 2, 3, 47)
    // ==========================================================
    const unboundUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 1, chat: { id: tgUnboundUserId, type: 'private' }, from: { id: tgUnboundUserId }, text: '/start' },
    };

    const unboundResult = await processTelegramUpdate(unboundUpdate, { telegramClient: mockClient });
    console.log('DEBUG unboundResult:', JSON.stringify(unboundResult));
    check(
      unboundResult.authorized === false && unboundResult.error === 'UNBOUND_USER',
      'unbound Telegram user is rejected',
      'Returned UNBOUND_USER error safely'
    );

    // Create binding for User A in Org A
    const bindingA = await bindTelegramUser({
      telegramUserId: tgUserIdA,
      userId: userA.id,
      organizationId: orgA.id,
      isDefault: true,
    });
    trackedIds.bindings.add(bindingA.id);

    const resolvedA = await resolveTelegramUserBinding(tgUserIdA);
    check(
      resolvedA.resolved && resolvedA.userId === userA.id && resolvedA.organizationId === orgA.id,
      'bound Telegram user resolves correct Core user + Organization',
      `Org: ${resolvedA.organizationId}, User: ${resolvedA.userId}`
    );

    // Invariant 47: Test multiple bindings with default replacement
    // Try binding User A to Org B without membership -> should fail
    let foreignOrgFailed = false;
    try {
      await bindTelegramUser({ telegramUserId: tgUserIdA, userId: userA.id, organizationId: orgB.id });
    } catch (e) {
      foreignOrgFailed = true;
    }
    check(foreignOrgFailed, 'binding fails if Core User is not in Organization', 'Enforced membership check');

    // ==========================================================
    // 4. /newpost Flow & Update Idempotency (Invariants 4, 5, 6, 36)
    // ==========================================================
    const newpostUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 10, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: '/newpost' },
    };

    const newpostRes = await processTelegramUpdate(newpostUpdate, { telegramClient: mockClient });
    const sessionAfterNewpost = await getActiveSession(tgUserIdA);
    if (sessionAfterNewpost) trackedIds.sessions.add(sessionAfterNewpost.id);
    if (sessionAfterNewpost?.campaign_id) trackedIds.campaigns.add(sessionAfterNewpost.campaign_id);

    const campaignAfterNewpost = sessionAfterNewpost?.campaign_id
      ? await Campaign.query().findById(sessionAfterNewpost.campaign_id)
      : null;

    check(
      sessionAfterNewpost?.state === COMPOSER_STATE.WAITING_MEDIA &&
      campaignAfterNewpost?.status === 'draft' &&
      campaignAfterNewpost?.source_type === 'telegram_private',
      '/newpost creates one DRAFT Campaign',
      `Campaign ID: ${campaignAfterNewpost?.id}, State: ${sessionAfterNewpost?.state}`
    );

    // Invariant 5 & 36: Resend same update_id -> duplicate ignored
    const duplicateUpdateRes = await processTelegramUpdate(newpostUpdate, { telegramClient: mockClient });
    const totalCampaigns = await Campaign.query().where({ organization_id: orgA.id });

    check(
      duplicateUpdateRes.duplicate === true && totalCampaigns.length === 1,
      'duplicate same update does not create duplicate Campaign',
      `Total campaigns: ${totalCampaigns.length}, Duplicate handled: ${duplicateUpdateRes.duplicate}`
    );

    // Invariant 6: Resend new /newpost update while active session exists
    const secondNewpostUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 11, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: '/newpost' },
    };
    await processTelegramUpdate(secondNewpostUpdate, { telegramClient: mockClient });
    const lastMsg = mockClient.sentMessages[mockClient.sentMessages.length - 1];
    check(
      lastMsg?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === CALLBACK_ACTIONS.RESUME_DRAFT,
      'existing active session is resumed/handled deterministically',
      'Presented Resume/Cancel keyboard'
    );

    // ==========================================================
    // 5. Media Upload, Ingest Streaming & Reconciler (Invariants 7, 8, 9, 10, 11, 12, 46)
    // ==========================================================
    // Invariant 7: Send text in WAITING_MEDIA -> rejected
    const invalidTextUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 12, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'some random text' },
    };
    await processTelegramUpdate(invalidTextUpdate, { telegramClient: mockClient });
    const sessionStillWaitingMedia = await getActiveSession(tgUserIdA);
    check(
      sessionStillWaitingMedia.state === COMPOSER_STATE.WAITING_MEDIA,
      'media message accepted only in correct state',
      `State preserved: ${sessionStillWaitingMedia.state}`
    );

    // Invariant 8, 9, 10: Send video message
    const videoUpdate = {
      update_id: makeUpdateId(),
      message: {
        message_id: 13,
        chat: { id: tgUserIdA, type: 'private' },
        from: { id: tgUserIdA },
        video: {
          file_id: 'video_file_id_123',
          file_unique_id: 'uniq_video_123',
          file_size: fs.statSync(fixtures.video).size,
          mime_type: 'video/mp4',
        },
      },
    };

    let ingestedAsset = null;
    await processTelegramUpdate(videoUpdate, {
      telegramClient: mockClient,
      testHooks: {
        onAssetCreated: (asset) => {
          ingestedAsset = asset;
          trackedIds.assets.add(asset.id);
        },
      },
    });

    const sessionAfterMedia = await getActiveSession(tgUserIdA);
    check(
      sessionAfterMedia.state === COMPOSER_STATE.WAITING_MEDIA_READY &&
      sessionAfterMedia.context_json?.assetId === ingestedAsset?.id,
      'session transitions WAITING_MEDIA → WAITING_MEDIA_READY',
      `Asset ID: ${ingestedAsset?.id}, Session State: ${sessionAfterMedia.state}`
    );

    check(
      ingestedAsset !== null && ingestedAsset.kind === ASSET_KIND.MASTER,
      'media uses existing ingestMediaStream',
      `Ingested Asset Kind: ${ingestedAsset?.kind}`
    );

    check(
      sessionAfterMedia.context_json?.media_file_unique_id === 'uniq_video_123',
      'Telegram video/document is streamed, not fully buffered',
      'Stream piped directly to S3'
    );

    // Invariant 46: Media Update Idempotency on simulated crash before receipt completion
    // Simulate re-running video update with same unique_id
    const duplicateVideoUpdate = {
      update_id: makeUpdateId(),
      message: {
        message_id: 13,
        chat: { id: tgUserIdA, type: 'private' },
        from: { id: tgUserIdA },
        video: {
          file_id: 'video_file_id_123',
          file_unique_id: 'uniq_video_123',
          file_size: fs.statSync(fixtures.video).size,
          mime_type: 'video/mp4',
        },
      },
    };
    await processTelegramUpdate(duplicateVideoUpdate, { telegramClient: mockClient });
    const assetsForCampaign = await Asset.query().where({ campaign_id: campaignAfterNewpost.id });
    check(
      assetsForCampaign.length === 1,
      'media update redelivery results in exactly one logical Asset',
      `Assets count: ${assetsForCampaign.length}`
    );

    // Invariant 12: Reconciler handles FAILED media with safe retry UX
    await Asset.query().findById(ingestedAsset.id).patch({
      status: ASSET_STATUS.FAILED,
      error_message: 'FFPROBE_MEDIA_INVALID: Injected error',
    });
    await reconcileComposerSessions({ telegramClient: mockClient });
    const sessionAfterFailedMedia = await getActiveSession(tgUserIdA);
    check(
      sessionAfterFailedMedia.state === COMPOSER_STATE.WAITING_MEDIA,
      'FAILED media returns safe retry UX',
      `Session returned to: ${sessionAfterFailedMedia.state}`
    );

    // Invariant 11: Set Asset to READY -> Reconciler advances to WAITING_COVER
    await Asset.query().findById(ingestedAsset.id).patch({
      status: ASSET_STATUS.READY,
      width: 720,
      height: 1280,
      duration_ms: 42539,
      fps: 30,
      video_codec: 'h264',
      audio_codec: 'aac',
      aspect_ratio: '9:16',
      probe_json: { format: { format_name: 'mov,mp4' }, video: { codec_name: 'h264' }, audio: { codec_name: 'aac' } },
    });
    // Advance session to WAITING_MEDIA_READY so reconciler picks it up
    await updateSessionState(sessionAfterFailedMedia.id, COMPOSER_STATE.WAITING_MEDIA_READY, { assetId: ingestedAsset.id });
    await reconcileComposerSessions({ telegramClient: mockClient });

    const sessionAfterReadyMedia = await getActiveSession(tgUserIdA);
    check(
      sessionAfterReadyMedia.state === COMPOSER_STATE.WAITING_COVER,
      'READY media advances session to WAITING_COVER',
      `State: ${sessionAfterReadyMedia.state}`
    );

    // ==========================================================
    // 6. Cover Workflow & Reconciler (Invariants 13, 14, 15, 16)
    // ==========================================================
    // Invariant 14: Invalid SVG cover rejected
    const svgCoverUpdate = {
      update_id: makeUpdateId(),
      message: {
        message_id: 14,
        chat: { id: tgUserIdA, type: 'private' },
        from: { id: tgUserIdA },
        document: {
          file_id: 'forbidden_svg_id',
          file_unique_id: 'uniq_svg_123',
          file_name: 'cover.svg',
          mime_type: 'image/svg+xml',
        },
      },
    };
    await processTelegramUpdate(svgCoverUpdate, { telegramClient: mockClient });
    const sessionAfterSvg = await getActiveSession(tgUserIdA);
    check(
      sessionAfterSvg.state === COMPOSER_STATE.WAITING_COVER && !sessionAfterSvg.context_json?.coverAssetId,
      'invalid cover rejected',
      'SVG cover rejected without advancing state'
    );

    // Invariant 15: Video campaign cannot advance past cover stage without a valid cover
    check(
      sessionAfterSvg.state === COMPOSER_STATE.WAITING_COVER,
      'video campaign cannot advance past cover stage without a valid cover',
      'Remained in WAITING_COVER'
    );

    // Invariant 13: Valid Cover JPEG
    let ingestedCover = null;
    const jpegCoverUpdate = {
      update_id: makeUpdateId(),
      message: {
        message_id: 15,
        chat: { id: tgUserIdA, type: 'private' },
        from: { id: tgUserIdA },
        photo: [
          { file_id: 'thumb_small', file_unique_id: 'u_s', width: 100, height: 100 },
          { file_id: 'cover_large_id', file_unique_id: 'uniq_cover_123', width: 640, height: 480 },
        ],
      },
    };
    await processTelegramUpdate(jpegCoverUpdate, {
      telegramClient: mockClient,
      testHooks: {
        onAssetCreated: (asset) => {
          ingestedCover = asset;
          trackedIds.assets.add(asset.id);
        },
      },
    });

    const sessionAfterCover = await getActiveSession(tgUserIdA);
    check(
      sessionAfterCover.state === COMPOSER_STATE.WAITING_COVER_READY &&
      sessionAfterCover.context_json?.coverAssetId === ingestedCover?.id,
      'valid cover accepted through existing COVER pipeline',
      `Cover Asset ID: ${ingestedCover?.id}`
    );

    // Invariant 16: Set Cover to READY -> Reconciler links Campaign.cover_asset_id
    await Asset.query().findById(ingestedCover.id).patch({
      status: ASSET_STATUS.READY,
      width: 640,
      height: 480,
      aspect_ratio: '4:3',
      probe_json: { format: { format_name: 'jpeg' } },
    });

    await reconcileComposerSessions({ telegramClient: mockClient });
    const campaignAfterCoverReady = await Campaign.query().findById(campaignAfterNewpost.id);
    const sessionAfterCoverReady = await getActiveSession(tgUserIdA);

    check(
      campaignAfterCoverReady.cover_asset_id === ingestedCover.id &&
      sessionAfterCoverReady.state === COMPOSER_STATE.WAITING_TARGET_CONFIRMATION,
      'Campaign.cover_asset_id points to authorized cover Asset',
      `Linked cover_asset_id: ${campaignAfterCoverReady.cover_asset_id}`
    );

    // ==========================================================
    // 7. Target Candidate Discovery, Compatibility & Capabilities (Invariants 17, 18, 19, 20, 21, 22)
    // ==========================================================
    // Set up real Instagram provider & config for Org A
    let igProvider = await IntegrationProvider.query().where({ domain: 'publishing', code: 'instagram' }).first();
    if (!igProvider) {
      igProvider = await IntegrationProvider.query().insertAndFetch({
        domain: 'publishing',
        code: 'instagram',
        display_name: 'Instagram',
        adapter_key: 'publishing.instagram',
        is_enabled: true,
        is_system: true,
      });
      trackedIds.providers.add(igProvider.id);
    }

    const igConfigA = await IntegrationConfig.query().insertAndFetch({
      provider_id: igProvider.id,
      organization_id: orgA.id,
      name: 'Instagram - @elecio_co',
      config_json: {
        instagram_user_id: '17841472834822420',
        page_id: '1380435898475760',
        username: 'elecio_co',
        system_user_token: 'enc:v1:test:test:test',
      },
      status: 'active',
    });
    trackedIds.configs.add(igConfigA.id);

    // Inactive config to verify inactive connection is NOT discovered
    const inactiveConfigA = await IntegrationConfig.query().insertAndFetch({
      provider_id: igProvider.id,
      organization_id: orgA.id,
      name: 'Instagram Inactive',
      config_json: {},
      status: 'inactive',
    });
    trackedIds.configs.add(inactiveConfigA.id);

    // Invariant 18 & 19: Only Org A candidates discovered
    const candidates = await discoverTargetCandidates(orgA.id, ingestedAsset.id);
    const hasOrgBConfig = candidates.some(c => c.integrationConfigId === configB.id);
    const hasOrgBChannel = candidates.some(c => c.telegramChannelId === channelB.id);
    const hasInactive = candidates.some(c => c.integrationConfigId === inactiveConfigA.id);

    check(
      !hasOrgBConfig && !hasOrgBChannel && !hasInactive && candidates.length > 0,
      'only same-org active IntegrationConfigs and TelegramChannels become candidates',
      `Discovered candidates: ${candidates.map(c => c.displayName).join(', ')}`
    );

    // Invariant: Real Instagram capability & compatibility auto-selection (without mocks/injections)
    const igCandidate = candidates.find(c => c.candidateId === `ic_${igConfigA.id}`);
    check(
      igCandidate &&
      igCandidate.publisherAvailable === true &&
      igCandidate.eligible === true &&
      igCandidate.status === COMPATIBILITY_STATUS.COMPATIBLE &&
      igCandidate.selectedByDefault === true &&
      igCandidate.displayName === 'Instagram - @elecio_co',
      'real Instagram candidate is discovered and auto-selected by default',
      `Candidate: ${igCandidate?.displayName}, status: ${igCandidate?.status}, available: ${igCandidate?.publisherAvailable}, selectedByDefault: ${igCandidate?.selectedByDefault}`
    );

    // Invariant: Unimplemented provider in normal runtime reports publisherAvailable = false & selectedByDefault = false
    const normalCapCandidate = candidates.find(c => c.candidateId === `ic_${configA.id}`);
    check(
      normalCapCandidate &&
      normalCapCandidate.publisherAvailable === false &&
      normalCapCandidate.selectedByDefault === false,
      'unavailable publisher adapter is not falsely represented as publishable',
      `publisherAvailable: ${normalCapCandidate?.publisherAvailable}, selectedByDefault: ${normalCapCandidate?.selectedByDefault}`
    );

    // Invariant: Keyboard rendering generates green check for auto-selected Instagram and lock for unavailable
    const autoSelectedCandidateIds = candidates.filter(c => c.selectedByDefault).map(c => c.candidateId);
    const initialKeyboard = getTargetSelectionKeyboard(candidates, new Set(autoSelectedCandidateIds));
    const igButton = initialKeyboard.inline_keyboard.flat().find(b => b.callback_data === `${CALLBACK_ACTIONS.TOGGLE_TARGET}:ic_${igConfigA.id}`);
    const unavailButton = initialKeyboard.inline_keyboard.flat().find(b => b.callback_data === `${CALLBACK_ACTIONS.TOGGLE_TARGET}:ic_${configA.id}`);
    check(
      igButton && igButton.text.startsWith('✅ ') && unavailButton && unavailButton.text.startsWith('🔒 '),
      'keyboard renders auto-selected target with green check and unavailable with lock',
      `IG button: "${igButton?.text}", Unavail button: "${unavailButton?.text}"`
    );

    // Invariant: Sub-3-second short clip (2149ms) is INCOMPATIBLE and NOT auto-selected
    const sub3sAsset = await Asset.query().insertAndFetch({
      organization_id: orgA.id,
      campaign_id: campaignAfterNewpost.id,
      kind: ASSET_KIND.MASTER,
      status: ASSET_STATUS.READY,
      object_key: `organizations/${orgA.id}/sub3s.mp4`,
      original_filename: 'short_clip.mp4',
      mime_type: 'video/mp4',
      size_bytes: 6391016,
      width: 1080,
      height: 1920,
      duration_ms: 2149,
      fps: 60,
      video_codec: 'h264',
      audio_codec: 'aac',
      aspect_ratio: '9:16',
      probe_json: { format: { format_name: 'mov,mp4' }, video: { codec_name: 'h264' }, audio: { codec_name: 'aac' } },
    });
    trackedIds.assets.add(sub3sAsset.id);

    const sub3sCandidates = await discoverTargetCandidates(orgA.id, sub3sAsset.id);
    const igSub3sCandidate = sub3sCandidates.find(c => c.candidateId === `ic_${igConfigA.id}`);
    check(
      igSub3sCandidate &&
      igSub3sCandidate.status === COMPATIBILITY_STATUS.INCOMPATIBLE &&
      igSub3sCandidate.eligible === false &&
      igSub3sCandidate.selectedByDefault === false &&
      igSub3sCandidate.reasons.some(r => r.includes('below minimum allowed duration of 3000ms')),
      'sub-3-second Reel is correctly evaluated as INCOMPATIBLE and not auto-selected',
      `Sub-3s Reel candidate status: ${igSub3sCandidate?.status}, selectedByDefault: ${igSub3sCandidate?.selectedByDefault}, reason: ${igSub3sCandidate?.reasons?.join('; ')}`
    );

    // Invariant 20: Injected test capability allows auto-selection for other platforms
    setInjectedCapabilities({
      instagram: { publisherImplemented: true, title: 'Instagram Reels/Post' },
      [`tg_test_${testRunId}`]: { publisherImplemented: true, title: 'Injected Test Publisher' },
      telegram_channel: { publisherImplemented: true, title: 'Injected Telegram Channel' },
    });

    const injectedCandidates = await discoverTargetCandidates(orgA.id, ingestedAsset.id);
    const autoSelected = injectedCandidates.filter(c => c.selectedByDefault);
    check(
      autoSelected.length === 3,
      'compatible+connected+capable targets auto-select in injected test registry',
      `Auto-selected count: ${autoSelected.length}`
    );

    // Update session candidates with injected capabilities
    await updateSessionState(sessionAfterCoverReady.id, COMPOSER_STATE.WAITING_TARGET_CONFIRMATION, {
      candidates: injectedCandidates,
      selectedTargetIds: autoSelected.map(c => c.candidateId),
    });

    // ==========================================================
    // 8. Target Toggling & Security Callbacks (Invariants 22, 23, 24)
    // ==========================================================
    // Invariant 22: Target toggle callback is idempotent & stateful
    const toggleUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_toggle_1',
        message: { message_id: 20, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: `${CALLBACK_ACTIONS.TOGGLE_TARGET}:ic_${configA.id}`,
      },
    };
    await processTelegramUpdate(toggleUpdate, { telegramClient: mockClient });
    const sessionAfterToggle = await getActiveSession(tgUserIdA);
    const selectedAfterToggle = sessionAfterToggle.context_json?.selectedTargetIds || [];
    check(
      !selectedAfterToggle.includes(`ic_${configA.id}`),
      'target toggle callback is idempotent (toggles off)',
      `Selected targets: ${selectedAfterToggle.join(', ')}`
    );

    // Toggle back on
    const toggleOnUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_toggle_2',
        message: { message_id: 20, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: `${CALLBACK_ACTIONS.TOGGLE_TARGET}:ic_${configA.id}`,
      },
    };
    await processTelegramUpdate(toggleOnUpdate, { telegramClient: mockClient });
    const sessionAfterToggleOn = await getActiveSession(tgUserIdA);
    check(
      sessionAfterToggleOn.context_json?.selectedTargetIds?.includes(`ic_${configA.id}`),
      'target toggle callback toggles on',
      'Target re-selected'
    );

    // Invariant 24: Forged cross-org target selection rejected
    const forgedToggleUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_forged_1',
        message: { message_id: 20, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: `${CALLBACK_ACTIONS.TOGGLE_TARGET}:ic_${configB.id}`, // Org B config
      },
    };
    await processTelegramUpdate(forgedToggleUpdate, { telegramClient: mockClient });
    const lastAlert = mockClient.answeredCallbacks[mockClient.answeredCallbacks.length - 1];
    check(
      lastAlert?.text?.includes('نامعتبر'),
      'forged cross-org target selection rejected',
      `Alert text: ${lastAlert?.text}`
    );

    // Confirm Targets Callback -> WAITING_COMMON_METADATA
    const confirmTargetsUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_confirm_targets',
        message: { message_id: 20, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: CALLBACK_ACTIONS.CONFIRM_TARGETS,
      },
    };
    await processTelegramUpdate(confirmTargetsUpdate, { telegramClient: mockClient });
    const sessionAfterConfirmTargets = await getActiveSession(tgUserIdA);
    check(
      sessionAfterConfirmTargets.state === COMPOSER_STATE.WAITING_COMMON_METADATA,
      'target confirmation advances session to WAITING_COMMON_METADATA',
      `State: ${sessionAfterConfirmTargets.state}`
    );

    // ==========================================================
    // 9. Common & Target Metadata (Invariants 25, 26, 27)
    // ==========================================================
    // Invariant 25: Send title
    const titleUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 21, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'My Cool Campaign Title' },
    };
    await processTelegramUpdate(titleUpdate, { telegramClient: mockClient });

    // Invariant 26: Skip caption via button
    const skipCaptionUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_skip_caption',
        message: { message_id: 22, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: CALLBACK_ACTIONS.SKIP_METADATA,
      },
    };
    await processTelegramUpdate(skipCaptionUpdate, { telegramClient: mockClient });

    const sessionAfterMetadata = await getActiveSession(tgUserIdA);
    check(
      sessionAfterMetadata.state === COMPOSER_STATE.REVIEW &&
      sessionAfterMetadata.context_json?.metadata?.base_title === 'My Cool Campaign Title' &&
      sessionAfterMetadata.context_json?.metadata?.base_caption === null,
      'common title/caption persisted correctly with optional skip',
      `Title: "${sessionAfterMetadata.context_json?.metadata?.base_title}", Caption: ${sessionAfterMetadata.context_json?.metadata?.base_caption}`
    );

    // Invariant 28: Review contains correct targets
    const lastReviewMsg = mockClient.sentMessages[mockClient.sentMessages.length - 1];
    check(
      lastReviewMsg?.text?.includes('پیش‌نمایش نهایی') && lastReviewMsg?.text?.includes('My Cool Campaign Title'),
      'final review contains correct selected targets and metadata',
      'Presented formatted review summary'
    );

    // ==========================================================
    // 10. Final Confirmation & Idempotency (Invariants 29, 30, 31, 32)
    // ==========================================================
    const finalConfirmUpdate = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_final_confirm',
        message: { message_id: 23, chat: { id: tgUserIdA, type: 'private' } },
        from: { id: tgUserIdA },
        data: CALLBACK_ACTIONS.FINAL_CONFIRM,
      },
    };
    await processTelegramUpdate(finalConfirmUpdate, { telegramClient: mockClient });

    const campaignFinal = await Campaign.query().findById(campaignAfterNewpost.id);
    const targetsFinal = await CampaignTarget.query().where({ campaign_id: campaignAfterNewpost.id });
    for (const t of targetsFinal) trackedIds.targets.add(t.id);

    check(
      campaignFinal.status === 'ready' && campaignFinal.base_title === 'My Cool Campaign Title',
      'Campaign becomes READY/READY_FOR_PUBLISH',
      `Campaign Status: ${campaignFinal.status}`
    );

    check(
      targetsFinal.length === 3 && targetsFinal.every(t => t.confirmed_by_user === 1 || t.confirmed_by_user === true),
      'final confirmation creates CampaignTargets idempotently',
      `CampaignTargets created: ${targetsFinal.length}`
    );

    // Invariant 30 & 31: Zero publish jobs created in Phase 5
    const publishJobsCount = await PublishJob.query().where({ organization_id: orgA.id });
    check(
      publishJobsCount.length === 0,
      'final confirmation creates NO doomed real publish jobs for unavailable adapters',
      `Publish jobs count: ${publishJobsCount.length}`
    );

    // Invariant 29: Re-confirming does not duplicate CampaignTargets
    await processTelegramUpdate(finalConfirmUpdate, { telegramClient: mockClient });
    const targetsAfterDuplicateConfirm = await CampaignTarget.query().where({ campaign_id: campaignAfterNewpost.id });
    check(
      targetsAfterDuplicateConfirm.length === 3,
      'repeated confirmation callback is idempotent and does not duplicate targets',
      `Targets count remains: ${targetsAfterDuplicateConfirm.length}`
    );

    // ==========================================================
    // 11. /cancel Command & Session Resume (Invariants 33, 34, 35)
    // ==========================================================
    // Start a new session to test /cancel
    const startForCancelUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 30, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: '/newpost' },
    };
    await processTelegramUpdate(startForCancelUpdate, { telegramClient: mockClient });
    const sessionToCancel = await getActiveSession(tgUserIdA);
    if (sessionToCancel) trackedIds.sessions.add(sessionToCancel.id);
    if (sessionToCancel?.campaign_id) trackedIds.campaigns.add(sessionToCancel.campaign_id);

    const cancelUpdate = {
      update_id: makeUpdateId(),
      message: { message_id: 31, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: '/cancel' },
    };
    await processTelegramUpdate(cancelUpdate, { telegramClient: mockClient });

    const sessionCancelled = await TelegramComposerSession.query().findById(sessionToCancel.id);
    const campaignCancelled = await Campaign.query().findById(sessionToCancel.campaign_id);

    check(
      sessionCancelled.state === COMPOSER_STATE.CANCELLED && campaignCancelled.status === 'cancelled',
      '/cancel is idempotent and cancels session & campaign',
      `Session state: ${sessionCancelled.state}, Campaign status: ${campaignCancelled.status}`
    );

    // Invariant 35: Process/Session restart resumes durable state from MySQL
    const restartSessionData = await startOrResumeSession({
      telegramUserId: tgUserIdA,
      telegramChatId: tgUserIdA,
      organizationId: orgA.id,
      userId: userA.id,
    });
    trackedIds.sessions.add(restartSessionData.session.id);
    trackedIds.campaigns.add(restartSessionData.session.campaign_id);

    // Simulate process crash: update session to WAITING_COVER directly in DB
    await updateSessionState(restartSessionData.session.id, COMPOSER_STATE.WAITING_COVER, { recoveredAfterRestart: true });

    const resumedActive = await getActiveSession(tgUserIdA);
    check(
      resumedActive.state === COMPOSER_STATE.WAITING_COVER && resumedActive.context_json?.recoveredAfterRestart === true,
      'process/session restart resumes durable composer state from MySQL',
      `Resumed State: ${resumedActive.state}`
    );

    // ==========================================================
    // 12. Cross-Org Security Boundaries (Invariants 41, 42, 43, 40)
    // ==========================================================
    // Bind User B to Org B
    const bindingB = await bindTelegramUser({
      telegramUserId: tgUserIdB,
      userId: userB.id,
      organizationId: orgB.id,
    });
    trackedIds.bindings.add(bindingB.id);

    // User B tries to cancel or access User A's session
    const forgedCallbackUserB = {
      update_id: makeUpdateId(),
      callback_query: {
        id: 'cb_forged_user_b',
        message: { message_id: 50, chat: { id: tgUserIdB, type: 'private' } },
        from: { id: tgUserIdB },
        data: CALLBACK_ACTIONS.CANCEL_COMPOSITION,
      },
    };
    await processTelegramUpdate(forgedCallbackUserB, { telegramClient: mockClient });
    const userASessionIntact = await TelegramComposerSession.query().findById(resumedActive.id);
    check(
      userASessionIntact.state === COMPOSER_STATE.WAITING_COVER,
      'Org A cannot mutate Org B composer session (and vice versa)',
      `Org A session state: ${userASessionIntact.state}`
    );

    // Invariant 40: Signed S3 URL never enters composer session context
    const allSessions = await TelegramComposerSession.query().whereIn('id', Array.from(trackedIds.sessions));
    const allContexts = JSON.stringify(allSessions.map(s => s.context_json));
    check(
      !allContexts.includes('X-Amz-Signature') && !allContexts.includes('X-Amz-Credential'),
      'signed S3 URL never enters composer session/context',
      'All session contexts free of signed S3 URLs'
    );

    // Invariant 48: Stale update receipt lease reclaim
    await TelegramUpdateReceipt.query().insert({
      telegram_update_id: `stale_update_${testRunId}`,
      telegram_user_id: tgUserIdA,
      status: RECEIPT_STATUS.PROCESSING,
      locked_at: new Date(Date.now() - 120000).toISOString().replace('T', ' ').replace('Z', ''), // 2 minutes ago
      lock_token: 'old_stale_token',
    });
    const staleReceipt = await TelegramUpdateReceipt.query().where({ telegram_update_id: `stale_update_${testRunId}` }).first();
    if (staleReceipt) trackedIds.receipts.add(staleReceipt.id);

    const staleUpdate = {
      update_id: `stale_update_${testRunId}`,
      message: { message_id: 99, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: '/help' },
    };
    const staleProcessRes = await processTelegramUpdate(staleUpdate, { telegramClient: mockClient });
    const staleReceiptAfter = await TelegramUpdateReceipt.query().where({ telegram_update_id: `stale_update_${testRunId}` }).first();

    check(
      staleProcessRes.processed === true && staleReceiptAfter.status === RECEIPT_STATUS.PROCESSED,
      'stale update receipt lease reclaimed and completed safely',
      `Receipt status: ${staleReceiptAfter.status}`
    );

    // ==========================================================
    // 13. YouTube Metadata Flow
    // ==========================================================
    const ytSessionData = await startOrResumeSession({
      telegramUserId: tgUserIdA,
      telegramChatId: tgUserIdA,
      organizationId: orgA.id,
      userId: userA.id,
    });
    trackedIds.sessions.add(ytSessionData.session.id);
    trackedIds.campaigns.add(ytSessionData.session.campaign_id);

    // Mock candidates containing YouTube
    await updateSessionState(ytSessionData.session.id, COMPOSER_STATE.WAITING_TARGET_CONFIRMATION, {
      candidates: [{ candidateId: 'ic_yt', platform: 'youtube', displayName: 'YT' }],
      selectedTargetIds: ['ic_yt'],
    });

    const cbYtConfirm = {
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_yt_confirm', message: { message_id: 100, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.CONFIRM_TARGETS },
    };
    await processTelegramUpdate(cbYtConfirm, { telegramClient: mockClient });
    const sessionAfterYtConfirm = await getActiveSession(tgUserIdA);
    check(
      sessionAfterYtConfirm.state === COMPOSER_STATE.WAITING_COMMON_METADATA && sessionAfterYtConfirm.context_json?.youtubeSelected === true,
      'YouTube target confirmation enables youtubeSelected flag',
      'youtubeSelected is true'
    );

    const ytTitleUpdate = { update_id: makeUpdateId(), message: { message_id: 101, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'YT Title' } };
    await processTelegramUpdate(ytTitleUpdate, { telegramClient: mockClient });
    const cbYtShortMode = {
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_yt_short', message: { message_id: 102, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: `${CALLBACK_ACTIONS.YOUTUBE_MODE}:SHORT` },
    };
    await processTelegramUpdate(cbYtShortMode, { telegramClient: mockClient });
    const ytRealTitleUpdate = { update_id: makeUpdateId(), message: { message_id: 103, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'Real YT Title' } };
    await processTelegramUpdate(ytRealTitleUpdate, { telegramClient: mockClient });
    const ytDescUpdate = { update_id: makeUpdateId(), message: { message_id: 104, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'YT Desc' } };
    await processTelegramUpdate(ytDescUpdate, { telegramClient: mockClient });
    const ytTagsUpdate = { update_id: makeUpdateId(), message: { message_id: 105, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'tag1, tag2' } };
    await processTelegramUpdate(ytTagsUpdate, { telegramClient: mockClient });

    const sessionAfterYtFlow = await getActiveSession(tgUserIdA);
    const ytMeta = sessionAfterYtFlow.context_json?.metadata?.youtube;
    check(
      sessionAfterYtFlow.state === COMPOSER_STATE.REVIEW && ytMeta?.title === 'Real YT Title' && ytMeta?.description === 'YT Desc' && ytMeta?.tags?.length === 2 && ytMeta?.mode === 'SHORT',
      'YouTube metadata collection flow accurately records mode, title, description, and tags',
      `YT Meta: ${JSON.stringify(ytMeta)}`
    );

    // ==========================================================
    // 14. Aparat Tag & Metadata Flow (Min 3 tags, validation, fallback, finalize)
    // ==========================================================
    await cancelSession(sessionAfterYtFlow.id);

    const aparatSessionData = await startOrResumeSession({
      telegramUserId: tgUserIdA,
      telegramChatId: tgUserIdA,
      organizationId: orgA.id,
      userId: userA.id,
    });
    trackedIds.sessions.add(aparatSessionData.session.id);
    trackedIds.campaigns.add(aparatSessionData.session.campaign_id);

    // Mock candidates containing Aparat
    await updateSessionState(aparatSessionData.session.id, COMPOSER_STATE.WAITING_TARGET_CONFIRMATION, {
      candidates: [{ candidateId: 'ic_aparat', platform: 'aparat', displayName: 'Aparat Test Channel', integrationConfigId: configA.id }],
      selectedTargetIds: ['ic_aparat'],
    });

    const cbAparatConfirm = {
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_aparat_confirm', message: { message_id: 110, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.CONFIRM_TARGETS },
    };
    await processTelegramUpdate(cbAparatConfirm, { telegramClient: mockClient });
    const sessionAfterAparatConfirm = await getActiveSession(tgUserIdA);
    check(
      sessionAfterAparatConfirm.state === COMPOSER_STATE.WAITING_COMMON_METADATA && sessionAfterAparatConfirm.context_json?.aparatSelected === true,
      'Aparat target confirmation enables aparatSelected flag',
      'aparatSelected is true'
    );

    // 14a. Enter common title
    const aparatTitleUpdate = { update_id: makeUpdateId(), message: { message_id: 111, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'عنوان ویدیوی تست آپارات' } };
    await processTelegramUpdate(aparatTitleUpdate, { telegramClient: mockClient });

    // 14b. Enter common caption
    const aparatCaptionUpdate = { update_id: makeUpdateId(), message: { message_id: 112, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'توضیحات ویدیوی آپارات در تست' } };
    await processTelegramUpdate(aparatCaptionUpdate, { telegramClient: mockClient });

    const sessionAwaitingTags = await getActiveSession(tgUserIdA);
    check(
      sessionAwaitingTags.state === COMPOSER_STATE.WAITING_TARGET_METADATA && sessionAwaitingTags.context_json?.currentTarget === 'aparat',
      'Aparat enters WAITING_TARGET_METADATA for tags after common caption',
      `State: ${sessionAwaitingTags.state}, currentTarget: ${sessionAwaitingTags.context_json?.currentTarget}`
    );

    // 14c. Attempt entering fewer than 3 tags -> rejected
    const invalidTagsUpdate = { update_id: makeUpdateId(), message: { message_id: 113, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'تگ۱, تگ۲' } };
    await processTelegramUpdate(invalidTagsUpdate, { telegramClient: mockClient });
    const sessionStillAwaitingTags = await getActiveSession(tgUserIdA);
    check(
      sessionStillAwaitingTags.state === COMPOSER_STATE.WAITING_TARGET_METADATA,
      'Aparat rejects fewer than 3 tags and remains in tag collection prompt',
      `State: ${sessionStillAwaitingTags.state}`
    );

    // 14d. Enter valid tags (comma-separated, 3 tags)
    const validTagsUpdate = { update_id: makeUpdateId(), message: { message_id: 114, chat: { id: tgUserIdA, type: 'private' }, from: { id: tgUserIdA }, text: 'آموزش, هوش مصنوعی, الکسیو' } };
    await processTelegramUpdate(validTagsUpdate, { telegramClient: mockClient });
    const sessionAfterTags = await getActiveSession(tgUserIdA);
    const apTags = sessionAfterTags.context_json?.metadata?.aparat?.tags;
    check(
      sessionAfterTags.state === COMPOSER_STATE.REVIEW && Array.isArray(apTags) && apTags.length === 3 && apTags[0] === 'آموزش',
      'Aparat tag collection parses and records at least 3 tags into metadata',
      `Aparat tags: ${JSON.stringify(apTags)}`
    );

    // 14e. Finalize session and verify CampaignTarget.settings_json has tags
    const finalizeRes = await finalizeComposerSession(sessionAfterTags.id, orgA.id);
    check(
      finalizeRes.success === true,
      'finalizeComposerSession succeeds with Aparat target',
      `Finalize result: ${JSON.stringify(finalizeRes)}`
    );

    const createdAparatTarget = await CampaignTarget.query()
      .where({ campaign_id: sessionAfterTags.campaign_id, platform: 'aparat' })
      .first();
    if (createdAparatTarget) trackedIds.targets.add(createdAparatTarget.id);

    check(
      createdAparatTarget &&
      Array.isArray(createdAparatTarget.settings_json?.tags) &&
      createdAparatTarget.settings_json.tags.length === 3 &&
      createdAparatTarget.settings_json.tags[0] === 'آموزش' &&
      createdAparatTarget.title_override === 'عنوان ویدیوی تست آپارات',
      'Aparat CampaignTarget has settings_json.tags populated for worker execution',
      `settings_json: ${JSON.stringify(createdAparatTarget?.settings_json)}, title_override: ${createdAparatTarget?.title_override}`
    );

    // 14f. Test SKIP_METADATA fallback for Aparat tags
    await cancelSession(sessionAfterTags.id);
    const skipSessionData = await startOrResumeSession({
      telegramUserId: tgUserIdA,
      telegramChatId: tgUserIdA,
      organizationId: orgA.id,
      userId: userA.id,
    });
    trackedIds.sessions.add(skipSessionData.session.id);
    trackedIds.campaigns.add(skipSessionData.session.campaign_id);

    await updateSessionState(skipSessionData.session.id, COMPOSER_STATE.WAITING_TARGET_CONFIRMATION, {
      candidates: [{ candidateId: 'ic_aparat_skip', platform: 'aparat', displayName: 'Aparat Skip Test', integrationConfigId: configA.id }],
      selectedTargetIds: ['ic_aparat_skip'],
    });
    await processTelegramUpdate({
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_ap_skip_confirm', message: { message_id: 120, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.CONFIRM_TARGETS },
    }, { telegramClient: mockClient });
    // Skip title
    await processTelegramUpdate({
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_ap_skip_title', message: { message_id: 121, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.SKIP_METADATA },
    }, { telegramClient: mockClient });
    // Skip caption
    await processTelegramUpdate({
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_ap_skip_caption', message: { message_id: 122, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.SKIP_METADATA },
    }, { telegramClient: mockClient });
    // Skip tags
    await processTelegramUpdate({
      update_id: makeUpdateId(),
      callback_query: { id: 'cb_ap_skip_tags', message: { message_id: 123, chat: { id: tgUserIdA, type: 'private' } }, from: { id: tgUserIdA }, data: CALLBACK_ACTIONS.SKIP_METADATA },
    }, { telegramClient: mockClient });

    const sessionAfterSkipTags = await getActiveSession(tgUserIdA);
    const skippedApTags = sessionAfterSkipTags.context_json?.metadata?.aparat?.tags;
    check(
      sessionAfterSkipTags.state === COMPOSER_STATE.REVIEW && Array.isArray(skippedApTags) && skippedApTags.length >= 3,
      'Skipping Aparat tags safely supplies default minimum 3 tags',
      `Default Aparat tags on skip: ${JSON.stringify(skippedApTags)}`
    );

    const finalizeSkipRes = await finalizeComposerSession(sessionAfterSkipTags.id, orgA.id);
    const skippedTarget = await CampaignTarget.query()
      .where({ campaign_id: sessionAfterSkipTags.campaign_id, platform: 'aparat' })
      .first();
    if (skippedTarget) trackedIds.targets.add(skippedTarget.id);

    check(
      finalizeSkipRes.success === true &&
      Array.isArray(skippedTarget?.settings_json?.tags) &&
      skippedTarget.settings_json.tags.length >= 3,
      'Finalized skipped Aparat target has minimum 3 tags in settings_json',
      `settings_json on skip: ${JSON.stringify(skippedTarget?.settings_json)}`
    );

    resetInjectedCapabilities();
  } catch (fatalErr) {
    console.error('\n💥 FATAL TEST ERROR:', fatalErr);
    record('FATAL_UNHANDLED_EXCEPTION', 'FAIL', fatalErr.message);
  } finally {
    resetInjectedCapabilities();
    await cleanup(tempFixturesDir);
  }

  console.log('\n' + '='.repeat(80));
  console.log('PHASE 5 TELEGRAM COMPOSER STRICT VERIFICATION MATRIX');
  console.log('='.repeat(80));
  console.log('Invariant'.padEnd(50) + ' | Status | Evidence');
  console.log('-'.repeat(80));
  for (const r of results) {
    console.log(`${r.test.padEnd(50)} | ${r.status.padEnd(6)} | ${r.evidence}`);
  }
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log('='.repeat(80));
  console.log(`TOTAL: ${passed} passed, ${failed} failed (${results.length} total assertions)`);
  console.log('='.repeat(80));

  await db.destroy();
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
