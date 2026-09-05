import '../bootstrap.js';
import { initJetStream } from '../services/messaging/jetstream.js';
async function run() {
  const { jsm } = await initJetStream();
  try {
    const info = await jsm.streams.info('ELECIO_EVENTS');
    console.log('ELECIO_EVENTS num_messages:', info.state.messages);
    console.log('ELECIO_EVENTS last_seq:', info.state.last_seq);
    const msg = await jsm.streams.getMessage('ELECIO_EVENTS', { seq: info.state.last_seq });
    console.log('last msg subject:', msg.subject);
  } catch(e) {
    console.log(e.message);
  }
  process.exit(0);
}
run();
