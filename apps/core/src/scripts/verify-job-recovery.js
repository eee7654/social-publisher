import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
import PublishJob from '../db/models/core/PublishJob.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';

async function run() {
  const jobId = 715;
  const job = await PublishJob.query().findById(jobId);
  const attempts = await PublishAttempt.query().where({ job_id: jobId });
  
  console.log('RECOVERY JOB ID:', job.id);
  console.log('JOB STATUS:', job.status);
  console.log('ATTEMPT COUNT:', job.attempt_count);
  console.log('EXTERNAL CONTAINER:', job.external_container_id);
  console.log('EXTERNAL MEDIA:', job.external_media_id);
  console.log('HAS ATTEMPTS:', attempts.length > 0);

  const isSafe = 
    job.status === 'queued' &&
    job.attempt_count === 0 &&
    attempts.length === 0 &&
    job.external_container_id === null &&
    job.external_media_id === null;

  console.log('Is Safe For Recovery?', isSafe);
  
  if (!isSafe) {
    console.error('Job 715 is not safe for recovery.');
    process.exit(1);
  }

  // Before creation assert there is no pending/processing or undispatched equivalent recovery event for that job
  const recoveryEvents = await OutboxEvent.query()
    .where({ aggregate_type: 'publish_jobs', aggregate_id: String(job.id) })
    .whereIn('status', ['pending', 'processing']);

  if (recoveryEvents.length > 0) {
    console.error('Found undispatched recovery events!', recoveryEvents);
    process.exit(1);
  }
  console.log('No pending/processing recovery events found.');
  process.exit(0);
}

run();
