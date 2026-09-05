import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();

import OutboxEvent from '../db/models/core/OutboxEvent.js';
import PublishJob from '../db/models/core/PublishJob.js';

async function main() {
  const job611 = await PublishJob.query().findById(611);
  const outbox477 = await OutboxEvent.query().findById(477);
  const allOutboxFor611 = await OutboxEvent.query().where({ aggregate_id: '611' });

  console.log('JOB 611:', JSON.stringify(job611, null, 2));
  console.log('OUTBOX 477:', JSON.stringify(outbox477, null, 2));
  console.log('ALL OUTBOX FOR 611:', JSON.stringify(allOutboxFor611, null, 2));

  await db.destroy();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
