import { initS3 } from './src/services/storage/s3.js';
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

async function clearBucket() {
    const s3Client = initS3();
    const bucketName = process.env.S3_BUCKET;
    
    console.log(`Starting to clear bucket: ${bucketName}`);
    let isTruncated = true;
    let continuationToken = undefined;

    let totalDeleted = 0;

    while (isTruncated) {
        const listParams = {
            Bucket: bucketName,
            ContinuationToken: continuationToken,
        };
        const listCommand = new ListObjectsV2Command(listParams);
        const listResponse = await s3Client.send(listCommand);

        const objects = listResponse.Contents;
        if (objects && objects.length > 0) {
            console.log(`Found ${objects.length} objects. Deleting...`);
            const deleteParams = {
                Bucket: bucketName,
                Delete: {
                    Objects: objects.map(obj => ({ Key: obj.Key }))
                }
            };
            const deleteCommand = new DeleteObjectsCommand(deleteParams);
            const deleteResponse = await s3Client.send(deleteCommand);
            
            if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
                console.error('Errors deleting some objects:', deleteResponse.Errors);
            }
            
            totalDeleted += objects.length;
            console.log(`Deleted batch of ${objects.length} objects.`);
        }

        isTruncated = listResponse.IsTruncated;
        continuationToken = listResponse.NextContinuationToken;
    }
    
    console.log(`Bucket cleared successfully. Total objects deleted: ${totalDeleted}`);
}

clearBucket().catch(err => {
    console.error('Error clearing bucket:', err);
    process.exit(1);
});
