import '../bootstrap.js';
import { resolveOutboxSubject } from '../publisher/dispatcher.js';

const assert = (condition, msg) => {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
};

const assertThrows = (fn, msg) => {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
  }
  if (!threw) {
    console.error(`❌ Assertion failed: Expected function to throw. ${msg}`);
    process.exit(1);
  }
};

console.log('🧪 Running Dispatcher Routing Matrix Tests...');

// 1. jobs.* -> return unchanged
assert(resolveOutboxSubject('jobs.publish.instagram') === 'jobs.publish.instagram', 'jobs.publish.instagram -> jobs.publish.instagram');
assert(resolveOutboxSubject('jobs.publish.youtube') === 'jobs.publish.youtube', 'jobs.publish.youtube -> jobs.publish.youtube');
assert(resolveOutboxSubject('jobs.media.probe') === 'jobs.media.probe', 'jobs.media.probe -> jobs.media.probe');
assert(resolveOutboxSubject('jobs.cleanup.assets') === 'jobs.cleanup.assets', 'jobs.cleanup.assets -> jobs.cleanup.assets');

// 2. events.* -> return unchanged
assert(resolveOutboxSubject('events.publisher.something') === 'events.publisher.something', 'events.publisher.something -> unchanged events.*');

// 3. legacy publish.instagram -> jobs.publish.instagram
assert(resolveOutboxSubject('publish.instagram') === 'jobs.publish.instagram', 'legacy publish.instagram -> jobs.publish.instagram');

// 4. unknown typo -> REJECT
assertThrows(() => resolveOutboxSubject('job.publish.instagram'), 'unknown typo job.publish.instagram should throw');
assertThrows(() => resolveOutboxSubject('test.foo.bar'), 'unknown event type should throw');
assertThrows(() => resolveOutboxSubject(''), 'empty event type should throw');

console.log('✅ All Dispatcher Routing Matrix Tests passed!');
process.exit(0);
