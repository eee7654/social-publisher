import '../bootstrap.js';
import getDb from '../config/database.js';
import { createOutboxEvent } from '../publisher/outbox.js';
import { LINKEDIN_SUBJECT } from '../publisher/platforms/linkedin/constants.js';

const db = getDb();
const id = Number(process.argv.find(arg => arg.startsWith('--target='))?.split('=')[1]);

if (process.env.LINKEDIN_LIVE_TEST !== 'true' || !Number.isInteger(id) || id <= 0) {
  console.error('Refusing: set LINKEDIN_LIVE_TEST=true and pass --target=<CampaignTarget ID>.');
  process.exitCode = 1;
} else {
  try {
    const job = await db.transaction(async trx => {
      const target = await trx('campaign_targets').where({ id }).forUpdate().first();
      if (!target || target.platform !== 'linkedin') {
        throw new Error('Target is not a LinkedIn target');
      }

      const campaign = await trx('campaigns').where({ id: target.campaign_id }).forUpdate().first();
      if (!campaign || campaign.status !== 'ready') {
        throw new Error('Campaign is not READY');
      }

      if (!target.integration_config_id) {
        throw new Error('LinkedIn target is missing active IntegrationConfig connection');
      }

      const config = await trx('integration_configs')
        .where({ id: target.integration_config_id, organization_id: campaign.organization_id, status: 'active' })
        .whereNull('deleted_at')
        .first();

      if (!config) {
        throw new Error('Active LinkedIn IntegrationConfig is missing or not tenant-owned');
      }

      if (target.asset_id) {
        const asset = await trx('assets')
          .where({ id: target.asset_id, organization_id: campaign.organization_id, status: 'ready' })
          .first();
        if (!asset) {
          throw new Error('Attached asset is not tenant-owned and READY');
        }
      }

      const existing = await trx('publish_jobs')
        .where({ campaign_target_id: id })
        .whereIn('status', ['queued', 'running', 'retry_wait', 'reconcile_required', 'succeeded'])
        .first();

      if (existing) {
        console.log(`PublishJob ${existing.id} already exists for target ${id} (status: ${existing.status})`);
        return existing;
      }

      const [jobId] = await trx('publish_jobs').insert({
        organization_id: campaign.organization_id,
        campaign_target_id: id,
        idempotency_key: `live-li-c${campaign.id}-t${id}`,
        status: 'queued',
        attempt_count: 0,
        max_attempts: 3,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });

      await createOutboxEvent(trx, {
        organizationId: campaign.organization_id,
        eventType: LINKEDIN_SUBJECT,
        aggregateType: 'PublishJob',
        aggregateId: String(jobId),
        payloadJson: {
          jobId,
          organizationId: campaign.organization_id,
          campaignTargetId: id,
        },
      });

      return trx('publish_jobs').where({ id: jobId }).first();
    });

    console.log(`Queued LinkedIn PublishJob ${job.id} on ${LINKEDIN_SUBJECT}; no LinkedIn API was called directly.`);
    console.log(`Target ID: ${id}`);
    console.log(`Run worker to execute publish: pnpm --filter @esima/core start:worker:publish:linkedin`);
  } catch (error) {
    console.error(`Refusing: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}
