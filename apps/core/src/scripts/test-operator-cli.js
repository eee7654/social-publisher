import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import getDb from '../config/database.js';

if (process.env.NODE_ENV === 'test' && !process.env.DB_NAME?.endsWith('_test')) {
  process.env.DB_NAME = `${process.env.DB_NAME}_test`;
}

const exec = promisify(execFile);
const db = getDb();
const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'operator-youtube-live-test.js');

const tests = [];
async function test(name, fn) { try { await fn(); tests.push([name, true]); } catch (e) { tests.push([name, false, e.stack]); } }

async function runTests() {
  let targetId;
  
  try {
    const { default: CampaignTarget } = await import('../db/models/core/CampaignTarget.js');
    const { default: Campaign } = await import('../db/models/core/Campaign.js');
    const { default: IntegrationConfig } = await import('../db/models/core/IntegrationConfig.js');
    const { default: Asset } = await import('../db/models/core/Asset.js');
    
    // Create fixtures
    await db('organizations').insert({ id: 9997, name: 'cli test', slug: 'cli-test', created_at: new Date(), updated_at: new Date() }).catch(()=>{});
    await db('integration_configs').insert({ id: 9997, organization_id: 9997, provider_id: 1, name: 'cfg', config_json: JSON.stringify({refresh_token:'x'}), status: 'active' }).catch(()=>{});
    await db('assets').insert({ id: 9997, organization_id: 9997, kind: 'master', status: 'ready', object_key: 'test', mime_type: 'video/mp4', width: 1080, height: 1920 }).catch(()=>{});
    await db('assets').where({ id: 9997 }).update({ width: 1080, height: 1920, status: 'ready' });
    await db('campaigns').insert({ id: 9997, organization_id: 9997, base_title: 't', status: 'ready', source_type: 'manual' }).catch(()=>{});
    await db('campaign_targets').insert({ id: 9997, campaign_id: 9997, integration_config_id: 9997, asset_id: 9997, platform: 'youtube', status: 'pending', title_override: 't', settings_json: JSON.stringify({youtube_mode: 'SHORT'}) }).catch(()=>{});
    targetId = 9997;

    await test('fails safely without YOUTUBE_LIVE_TEST env', async () => {
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: '' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('Refusing: set YOUTUBE_LIVE_TEST=true'));
      }
      assert.ok(threw);
    });
    
    await test('fails safely with YOUTUBE_LIVE_TEST=false', async () => {
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'false' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('Refusing: set YOUTUBE_LIVE_TEST=true'));
      }
      assert.ok(threw);
    });
    
    await test('fails on invalid target', async () => {
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=invalid`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      } catch (err) {
        threw = true;
      }
      assert.ok(threw);
    });

    await test('fails on non-YouTube target', async () => {
      await db('campaign_targets').where({ id: targetId }).update({ platform: 'instagram' });
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('not a YouTube target'));
      }
      assert.ok(threw);
      await db('campaign_targets').where({ id: targetId }).update({ platform: 'youtube' });
    });

    await test('fails if target campaign not READY', async () => {
      await db('campaigns').where({ id: 9997 }).update({ status: 'draft' });
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('Campaign is not READY'));
      }
      assert.ok(threw);
      await db('campaigns').where({ id: 9997 }).update({ status: 'ready' });
    });

    await test('fails safely when target is waiting_media_ready', async () => {
      await db('campaign_targets').where({ id: targetId }).update({ status: 'waiting_media_ready' });
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('Refusing: TARGET_NOT_READY: WAITING_MEDIA_READY'));
      }
      assert.ok(threw);
      await db('campaign_targets').where({ id: targetId }).update({ status: 'pending' });
    });

    await test('fails on cross-org IntegrationConfig mismatch', async () => {
      await db('organizations').insert({ id: 1234, name: 'other', slug: 'other', created_at: new Date(), updated_at: new Date() }).catch(()=>{});
      await db('integration_configs').where({ id: 9997 }).update({ organization_id: 1234 });
      let threw = false;
      try {
        await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      } catch (err) {
        threw = true;
        assert.ok(err.stderr.includes('Connection or resolved asset is not tenant-owned and READY'));
      }
      assert.ok(threw);
      await db('integration_configs').where({ id: 9997 }).update({ organization_id: 9997 });
      await db('organizations').where({ id: 1234 }).delete().catch(()=>{});
    });

    await test('valid ENV creates exactly ONE PublishJob and ONE Outbox event in same transaction', async () => {
      const { stdout } = await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      assert.ok(stdout.includes('Queued YouTube PublishJob'));
      assert.ok(stdout.includes('no Google API was called'));

      const jobs = await db('publish_jobs').where({ campaign_target_id: targetId });
      assert.equal(jobs.length, 1);
      
      const outbox = await db('outbox_events').where({ aggregate_type: 'PublishJob', aggregate_id: jobs[0].id });
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].event_type, 'jobs.publish.youtube');
    });

    await test('second run is rejected cleanly (idempotent)', async () => {
      const { stdout } = await exec('node', [scriptPath, `--target=${targetId}`], { env: { ...process.env, YOUTUBE_LIVE_TEST: 'true' } });
      assert.ok(stdout.includes('Queued YouTube PublishJob')); // It just returns the existing job ID without recreating it

      const jobs = await db('publish_jobs').where({ campaign_target_id: targetId });
      assert.equal(jobs.length, 1);
    });

  } finally {
    if (targetId) {
      const jobs = await db('publish_jobs').where({ campaign_target_id: targetId });
      if (jobs.length) await db('outbox_events').where({ aggregate_type: 'PublishJob', aggregate_id: jobs[0].id }).delete();
      await db('publish_jobs').where({ campaign_target_id: targetId }).delete();
      await db('campaign_targets').where({ id: targetId }).delete();
      await db('campaigns').where({ id: targetId }).delete();
      await db('assets').where({ id: targetId }).delete();
      await db('integration_configs').where({ id: targetId }).delete();
      await db('organizations').where({ id: targetId }).delete();
    }
    await db.destroy();
  }

  for (const [name, ok, detail] of tests) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `\n${detail}` : ''}`);
  const failed = tests.filter(([, ok]) => !ok);
  console.log(`Operator CLI Proof: ${tests.length - failed.length}/${tests.length} PASS`);
  if (failed.length) process.exit(1);
}

runTests();
