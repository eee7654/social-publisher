import { connect } from 'nats';

let nc = null;
let connectPromise = null;

export async function connectNats() {
    if (nc) return nc;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
    try {
        const connection = await connect({
            servers: process.env.NATS_URL || 'nats://127.0.0.1:4222',
            maxReconnectAttempts: -1,
        });
        nc = connection;
        console.log(`🔌 NATS Connected to ${connection.getServer()}`);
        
        connection.closed().then((err) => {
            if (err) {
                console.error(`❌ NATS connection closed with error: ${err.message}`);
            } else {
                console.log(`🔌 NATS connection gracefully closed.`);
            }
            if (nc === connection) nc = null;
        });

        return connection;
    } catch (err) {
        console.error(`❌ NATS Connection failed: ${err.message}`);
        // Return null instead of crashing for graceful error handling
        return null;
    } finally {
        connectPromise = null;
    }
    })();

    return connectPromise;
}

export function getNatsConnection() {
    return nc;
}

export async function closeNats() {
    if (nc) {
        await nc.drain();
        console.log('🔌 NATS drained and closed.');
        nc = null;
    }
}
