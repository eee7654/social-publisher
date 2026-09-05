import { connectNats } from './nats.js';

let js = null;
let jsm = null;
let initPromise = null;

export async function initJetStream() {
    if (js && jsm) return { js, jsm };
    if (initPromise) return initPromise;

    initPromise = (async () => {
    const nc = await connectNats();
    if (!nc) {
        console.warn('⚠️ JetStream init skipped because NATS connection is unavailable.');
        return { js: null, jsm: null };
    }
    
    const nextJs = nc.jetstream();
    const nextJsm = await nc.jetstreamManager();
    console.log(`🚀 JetStream Context Initialized.`);
    await bootstrapStreams(nextJsm);
    js = nextJs;
    jsm = nextJsm;
    return { js, jsm };
    })();

    try {
        return await initPromise;
    } finally {
        initPromise = null;
    }
}

export function getJetStream() {
    if (!js || !jsm) {
        throw new Error('JetStream not initialized. Call initJetStream() first.');
    }
    return { js, jsm };
}

async function bootstrapStreams(jsm) {
    const streams = [
        {
            name: 'ELECIO_JOBS',
            subjects: ['jobs.media.>', 'jobs.publish.>', 'jobs.cleanup.>'],
            retention: 'workqueue', // standard for tasks
            storage: 'file', // File-backed
            num_replicas: 1
        },
        {
            name: 'ELECIO_EVENTS',
            subjects: ['events.>'],
            retention: 'limits',
            storage: 'file',
            num_replicas: 1
        }
    ];

    for (const streamConfig of streams) {
        try {
            await jsm.streams.info(streamConfig.name);
            console.log(`ℹ️ JetStream stream ${streamConfig.name} verified.`);
        } catch (err) {
            if (err.message && err.message.includes('stream not found')) {
                console.log(`🔨 Creating JetStream stream ${streamConfig.name}...`);
                await jsm.streams.add(streamConfig);
                console.log(`✅ JetStream stream ${streamConfig.name} created.`);
            } else {
                console.error(`❌ Failed to verify/create stream ${streamConfig.name}:`, err.message);
            }
        }
    }
}
