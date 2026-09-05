import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    HeadBucketCommand,
    ListMultipartUploadsCommand,
    AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

let s3Client = null;
let presignClient = null;
let bucketName = null;

export function isPrivateOrLocalHost(host) {
    if (!host) return { isPublic: false, reason: 'EMPTY_HOST' };
    const cleanHost = host.split(':')[0].toLowerCase();
    if (cleanHost === 'localhost' || cleanHost === '127.0.0.1' || cleanHost === '::1' || cleanHost === '0.0.0.0') {
        return { isPublic: false, reason: 'LOOPBACK_LOCALHOST', host: cleanHost };
    }
    if (cleanHost.startsWith('10.') || cleanHost.startsWith('192.168.') || cleanHost.startsWith('169.254.')) {
        return { isPublic: false, reason: 'RFC1918_PRIVATE_LAN', host: cleanHost };
    }
    if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanHost)) {
        return { isPublic: false, reason: 'RFC1918_PRIVATE_LAN', host: cleanHost };
    }
    if (cleanHost.endsWith('.local') || cleanHost.endsWith('.internal') || cleanHost.endsWith('.lan')) {
        return { isPublic: false, reason: 'PRIVATE_TLD', host: cleanHost };
    }
    return { isPublic: true, reason: 'PUBLICLY_ROUTABLE', host: cleanHost };
}

export function initS3() {
    if (!s3Client) {
        bucketName = process.env.S3_BUCKET;
        s3Client = new S3Client({
            endpoint: process.env.S3_ENDPOINT,
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY,
            },
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        });
        console.log(`📦 S3 Client Initialized (Endpoint: ${process.env.S3_ENDPOINT}, Bucket: ${bucketName})`);
    }
    return s3Client;
}

export function initPresignS3() {
    if (!presignClient) {
        bucketName = process.env.S3_BUCKET;
        const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT;
        presignClient = new S3Client({
            endpoint: publicEndpoint,
            region: process.env.S3_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.S3_ACCESS_KEY,
                secretAccessKey: process.env.S3_SECRET_KEY,
            },
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        });
    }
    return presignClient;
}

export async function checkBucketAccess() {
    const client = initS3();
    try {
        const command = new HeadBucketCommand({ Bucket: bucketName });
        await client.send(command);
        console.log(`✅ S3 Bucket ${bucketName} is accessible.`);
        return true;
    } catch (err) {
        console.error(`❌ S3 Bucket ${bucketName} accessibility check failed:`, err.message);
        return false;
    }
}

export async function putObject(key, body, contentType) {
    const client = initS3();
    const command = new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: body,
        ContentType: contentType
    });
    return await client.send(command);
}

export async function getObjectStream(key) {
    const client = initS3();
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const response = await client.send(command);
    return response.Body;
}

/** Read exactly one inclusive byte range for resumable provider uploads. */
export async function getObjectRangeStream(key, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        throw new Error('Invalid object byte range');
    }
    const client = initS3();
    const response = await client.send(new GetObjectCommand({
        Bucket: bucketName, Key: key, Range: `bytes=${start}-${end}`,
    }));
    const expected = `bytes ${start}-${end}/`;
    if (response.ContentRange == null || !String(response.ContentRange).startsWith(expected) || Number(response.ContentLength) !== end - start + 1) {
        throw new Error('S3 range response did not honor the requested byte range');
    }
    return response.Body;
}

export async function headObject(key) {
    const client = initS3();
    const command = new HeadObjectCommand({ Bucket: bucketName, Key: key });
    return await client.send(command);
}

export async function deleteObject(key) {
    const client = initS3();
    const command = new DeleteObjectCommand({ Bucket: bucketName, Key: key });
    return await client.send(command);
}

/** Test/support helper: lists in-progress uploads under a safe key prefix. */
export async function listMultipartUploads(prefix) {
    const client = initS3();
    const response = await client.send(new ListMultipartUploadsCommand({ Bucket: bucketName, Prefix: prefix }));
    return response.Uploads || [];
}

/** Best-effort backstop for a multipart upload that raced a stream failure. */
export async function abortMultipartUploadsForKey(key) {
    const client = initS3();
    const uploads = await listMultipartUploads(key);
    await Promise.all(uploads.filter(upload => upload.Key === key && upload.UploadId).map(upload =>
        client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: key, UploadId: upload.UploadId }))
    ));
}

export async function createSignedReadUrl(key, expiresIn = 3600) {
    const client = initPresignS3();
    const command = new GetObjectCommand({ Bucket: bucketName, Key: key });
    return await getSignedUrl(client, command, { expiresIn });
}

export async function createSignedUploadUrl(key, contentType, expiresIn = 3600) {
    const client = initPresignS3();
    const command = new PutObjectCommand({ 
        Bucket: bucketName, 
        Key: key,
        ContentType: contentType
    });
    return await getSignedUrl(client, command, { expiresIn });
}
