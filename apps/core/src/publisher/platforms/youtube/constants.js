export const YOUTUBE_CONSTANTS = {
  DOMAIN: 'publishing',
  CODE: 'youtube',
  ADAPTER_KEY: 'publishing.youtube',
  SCOPES: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.readonly'
  ],
  UPLOAD_URI: 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable'
};
