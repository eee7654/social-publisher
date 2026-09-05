import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import PublishJob from '../db/models/core/PublishJob.js';
import OutboxEvent from '../db/models/core/OutboxEvent.js';
import PublishAttempt from '../db/models/core/PublishAttempt.js';
import { initJetStream } from '../services/messaging/jetstream.js';

async function main() {
  console.log('================================================================================');
  console.log('🔍 1. INSPECTION: PUBLISH JOB 611, OUTBOX EVENTS & ATTEMPTS');
  console.log('================================================================================');

  const job611 = await PublishJob.query().findById(611);
  const outboxEvents = await OutboxEvent.query().where({ aggregate_id: '611' }).orderBy('id', 'asc');
  const attempts = await PublishAttempt.query().where({ job_id: 611 });

  console.log('PublishJob 611:');
  console.log('  • ID:                    ', job611?.id);
  console.log('  • Status:                ', job611?.status);
  console.log('  • Attempt Count:         ', job611?.attempt_count);
  console.log('  • Locked At:             ', job611?.locked_at);
  console.log('  • Lock Token:            ', job611?.lock_token);
  console.log('  • External Stage:        ', job611?.external_stage);
  console.log('  • External Container ID: ', job611?.external_container_id);
  console.log('  • External Media ID:     ', job611?.external_media_id);
  console.log('  • Last Error Code:       ', job611?.last_error_code);
  console.log('  • Last Error Message:    ', job611?.last_error_message);

  console.log('\nOutbox Events for Job 611:');
  for (const ev of outboxEvents) {
    console.log(`  • Outbox ID: ${ev.id}`);
    console.log(`    - Event Type:    ${ev.event_type}`);
    console.log(`    - Status:        ${ev.status}`);
    console.log(`    - Attempt Count: ${ev.attempt_count}`);
    console.log(`    - Created At:    ${ev.created_at}`);
    console.log(`    - Available At:  ${ev.available_at}`);
    console.log(`    - Dispatched At: ${ev.dispatched_at}`);
    console.log(`    - Payload:       ${JSON.stringify(ev.payload_json)}`);
  }

  console.log('\nPublish Attempts for Job 611:');
  console.log('  • Attempt Rows Count:    ', attempts.length);
  for (const att of attempts) {
    console.log(`    - Attempt ID: ${att.id}, Attempt Number: ${att.attempt_number}, Status: ${att.status}, Error: ${att.error_code}`);
  }

  console.log('\n================================================================================');
  console.log('🔍 2. INSPECTION: NATS SERVER CONSUMER INFO');
  console.log('================================================================================');

  const { jsm, nc } = await initJetStream();

  try {
    const streamInfo = await jsm.streams.info('ELECIO_JOBS');
    console.log('Stream ELECIO_JOBS:');
    console.log('  • Messages:   ', streamInfo.state.messages);
    console.log('  • Bytes:      ', streamInfo.state.bytes);
    console.log('  • First Seq:  ', streamInfo.state.first_seq);
    console.log('  • Last Seq:   ', streamInfo.state.last_seq);
    console.log('  • Consumers:  ', streamInfo.state.consumer_count);
  } catch (err) {
    console.error('Error fetching stream info:', err.message);
  }

  try {
    const cInfo = await jsm.consumers.info('ELECIO_JOBS', 'WORKER_PUBLISH_INSTAGRAM');
    console.log('\nConsumer WORKER_PUBLISH_INSTAGRAM (Actual Server Config):');
    console.log('  • config.deliver_policy:   ', cInfo.config.deliver_policy);
    console.log('  • config.filter_subject:   ', cInfo.config.filter_subject);
    console.log('  • config.ack_policy:       ', cInfo.config.ack_policy);
    console.log('  • config.ack_wait (ns):    ', cInfo.config.ack_wait);
    console.log('  • config.max_deliver:      ', cInfo.config.max_deliver);
    console.log('  • delivered.consumer_seq:  ', cInfo.delivered.consumer_seq);
    console.log('  • delivered.stream_seq:    ', cInfo.delivered.stream_seq);
    console.log('  • ack_floor.consumer_seq:  ', cInfo.ack_floor.consumer_seq);
    console.log('  • ack_floor.stream_seq:    ', cInfo.ack_floor.stream_seq);
    console.log('  • num_pending:             ', cInfo.num_pending);
    console.log('  • num_ack_pending:         ', cInfo.num_ack_pending);
    console.log('  • num_redelivered:         ', cInfo.num_redelivered);
  } catch (err) {
    console.log('Consumer WORKER_PUBLISH_INSTAGRAM error:', err.message);
  }

  await db.destroy();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await db.destroy();
  process.exit(1);
});
