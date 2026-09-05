import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME || 'social_publisher'
  });

  const [rows] = await connection.execute(
    `SELECT p.id, p.status, p.external_container_id, p.external_media_id 
     FROM publish_jobs p 
     JOIN campaign_targets ct ON p.campaign_target_id = ct.id 
     JOIN campaigns c ON ct.campaign_id = c.id 
     WHERE c.organization_id = 19 AND ct.integration_config_id IS NOT NULL 
     ORDER BY p.id DESC LIMIT 1;`
  );
  
  if (rows.length > 0) {
    console.log('JOB_ID:', rows[0].id);
    console.log('STATUS:', rows[0].status);
    console.log('EXTERNAL_CONTAINER_ID:', rows[0].external_container_id);
    console.log('EXTERNAL_MEDIA_ID:', rows[0].external_media_id);
  } else {
    console.log('No job found.');
  }

  await connection.end();
}

run();
