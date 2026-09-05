import '../bootstrap.js';
import getDb from '../config/database.js';
const db = getDb();
async function run() {
  const outbox = await db('outbox_events').where({ id: 492 }).first();
  console.log('outbox 492 event_type:', outbox.event_type);
  await db.destroy();
  process.exit(0);
}
run();
