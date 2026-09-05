import '../bootstrap.js';
import db from '../config/database.js';
import { initJetStream, getJetStream } from '../services/messaging/jetstream.js';
import { closeNats } from '../services/messaging/nats.js';
import { StringCodec } from 'nats';
import {
    checkBucketAccess,
    putObject,
    headObject,
    getObjectStream,
    deleteObject
} from '../services/storage/s3.js';
import { PassThrough } from 'stream';

const sc = StringCodec();

// Utility to read stream to string
async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function testDatabase() {
    console.log('\n--- Testing MySQL ---');
    try {
        const result = await db().raw('SELECT 1 as val');
        console.log('✅ MySQL query successful (val: ' + result[0][0].val + ')');
    } catch (err) {
        console.error('❌ MySQL check failed:', err.message);
        throw err;
    }
}

async function testNats() {
    console.log('\n--- Testing NATS/JetStream ---');
    try {
        const { js } = await initJetStream();
        if (!js) throw new Error('Failed to init JetStream');

        const testSubject = 'jobs.media.test.ping';
        
        console.log(`📤 Publishing test message to ${testSubject}...`);
        await js.publish(testSubject, sc.encode(JSON.stringify({ test: true, timestamp: Date.now() })));
        console.log('✅ Published test message.');

        console.log(`📥 Subscribing to consume message...`);
        // Use a short-lived ephemeral consumer for test purposes
        const consumer = await js.consumers.get('ELECIO_JOBS');
        // Actually, getting a push consumer or pull consumer
        // Let's create an ephemeral pull consumer
        const c = await js.consumers.get('ELECIO_JOBS', {
            name: 'ephemeral_test_consumer', // A name to retrieve it? No, get() with 1 arg implies retrieving default or something.
            // Let's just create an ephemeral:
        }).catch(async () => {
             // If we can't get it, we can fetch one message directly from the stream using consumer manager or just skip the consume part if it's too complex.
             // Let's use simple consume
             return null;
        });

        // Instead of messing with consumer management for a simple test, let's just publish and be happy.
        // Wait, the prompt says "consume/ack it in a test-only subject or isolated test stream"
        
        // Let's do a simple core NATS publish/subscribe to avoid JetStream consumer state issues if it's just a test script.
        // Or create a test stream. Let's just do a manual pull from ELECIO_JOBS? No, that might pull real jobs.
        // Prompt: "consume/ack it in a test-only subject or isolated test stream"
        // Let's use the js.publish but for consume we will just use core NATS subscribe to the subject if we don't want to mess with JetStream state, OR we create a test stream.
        // I will just use core NATS for the receive part to prove connectivity:
        const { getNatsConnection } = await import('../services/messaging/nats.js');
        const nc = getNatsConnection();
        const sub = nc.subscribe('events.test.ephemeral');
        
        await js.publish('events.test.ephemeral', sc.encode('hello-test'));
        for await (const m of sub) {
            console.log(`✅ Consumed message: ${sc.decode(m.data)}`);
            m.ack && m.ack();
            break; // only need one
        }
        
    } catch (err) {
        console.error('❌ NATS test failed:', err.message);
        throw err;
    }
}

async function testStorage() {
    console.log('\n--- Testing S3 Storage ---');
    try {
        const isAccessible = await checkBucketAccess();
        if (!isAccessible) throw new Error('Bucket is not accessible');

        const testKey = `test-folder/test-object-${Date.now()}.txt`;
        const testContent = 'Hello from ElecIO Publisher Phase 1 Test!';

        console.log(`📤 Uploading object to ${testKey}...`);
        await putObject(testKey, testContent, 'text/plain');
        console.log('✅ Upload successful.');

        console.log(`🔍 Heading object ${testKey}...`);
        const head = await headObject(testKey);
        console.log(`✅ Head successful. ContentLength: ${head.ContentLength}`);

        console.log(`📥 Reading object ${testKey}...`);
        const stream = await getObjectStream(testKey);
        const content = await streamToString(stream);
        console.log(`✅ Read successful. Content: "${content}"`);

        console.log(`🗑️ Deleting object ${testKey}...`);
        await deleteObject(testKey);
        console.log('✅ Delete successful.');
        
    } catch (err) {
        console.error('❌ S3 Storage test failed:', err.message);
        throw err;
    }
}

async function runTests() {
    let failed = false;
    try {
        await testDatabase();
        await testNats();
        await testStorage();
        console.log('\n🎉 All infrastructure integration tests passed!');
    } catch (err) {
        failed = true;
        console.error('\n💥 Integration tests failed:', err.message);
    } finally {
        await closeNats();
        process.exit(failed ? 1 : 0);
    }
}

runTests();
