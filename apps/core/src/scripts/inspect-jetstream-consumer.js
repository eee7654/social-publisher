import '../bootstrap.js';
import { initJetStream } from '../services/messaging/jetstream.js';

async function main() {
  console.log('================================================================================');
  console.log('🔍 NATS JETSTREAM CONSUMER INSPECTION');
  console.log('================================================================================');

  const { jsm, nc } = await initJetStream();

  try {
    const streamInfo = await jsm.streams.info('ELECIO_JOBS');
    console.log('ELECIO_JOBS Stream State:', {
      messages: streamInfo.state.messages,
      bytes: streamInfo.state.bytes,
      first_seq: streamInfo.state.first_seq,
      last_seq: streamInfo.state.last_seq,
      consumer_count: streamInfo.state.consumer_count,
    });
  } catch (err) {
    console.error('Error fetching stream info:', err.message);
  }

  const consumers = await jsm.consumers.list('ELECIO_JOBS').next();
  console.log('\nActive Consumers on ELECIO_JOBS:');
  for (const c of consumers) {
    console.log(`\n• Consumer Name: ${c.name}`);
    console.log(`  - Durable:        ${c.config.durable_name}`);
    console.log(`  - Filter Subject: ${c.config.filter_subject}`);
    console.log(`  - Deliver Policy: ${c.config.deliver_policy}`);
    console.log(`  - Ack Policy:     ${c.config.ack_policy}`);
    console.log(`  - Num Pending:    ${c.num_pending}`);
    console.log(`  - Num Ack Pending:${c.num_ack_pending}`);
    console.log(`  - Delivered Seq:  ${JSON.stringify(c.delivered)}`);
    console.log(`  - Ack Floor:      ${JSON.stringify(c.ack_floor)}`);
  }

  await nc.drain();
  process.exit(0);
}

main().catch(err => {
  console.error('Inspection fatal error:', err);
  process.exit(1);
});
