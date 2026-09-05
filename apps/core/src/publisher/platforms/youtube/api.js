import { Transform } from 'node:stream';
import { google } from 'googleapis';
import { getYouTubeOAuthConfig } from './oauth.js';

export function createByteCountingStream(expectedLength) {
  let count = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      count += chunk.length;
      if (count > expectedLength) {
        return callback(new Error(`Stream exceeded expected chunk size: emitted ${count} > expected ${expectedLength}`));
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (count !== expectedLength) {
        return callback(new Error(`Stream underflow: emitted ${count} !== expected ${expectedLength}`));
      }
      callback();
    }
  });
}

export class YouTubeApiClient {
  constructor(accessToken, refreshToken) {
    const config = getYouTubeOAuthConfig();
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
    this.oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    this.youtube = google.youtube({ version: 'v3', auth: this.oauth2Client });
  }

  async verifyConnection() {
    try {
      const res = await this.youtube.channels.list({ part: ['id', 'snippet'], mine: true });
      if (res.data.items && res.data.items.length > 0) {
        return {
          valid: true,
          channelId: res.data.items[0].id,
          channelTitle: res.data.items[0].snippet.title
        };
      }
      return { valid: false, error: 'No channel found' };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  async getAccessToken() {
    const { token } = await this.oauth2Client.getAccessToken();
    if (!token) throw new Error('Google did not return an access token');
    return token;
  }

  // DIRECT OFFICIAL PROTOCOL for resumable upload
  // Step 1: Create Session
  async createResumableSession(metadata, fileSize) {
    const token = await this.getAccessToken();
    const response = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fileSize)
      },
      body: JSON.stringify(metadata)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to create upload session: ${response.status} ${errText}`);
    }

    const sessionUri = response.headers.get('location');
    if (!sessionUri) throw new Error('No location header returned from YouTube');
    
    return sessionUri;
  }

  // Step 2: Query Session Status (for interrupted uploads)
  async getUploadStatus(sessionUri, fileSize) {
    const token = await this.getAccessToken();
    const response = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Length': '0',
        'Content-Range': `bytes */${fileSize}`
      }
    });

    if (response.status === 308) {
      const range = response.headers.get('range');
      if (range) {
        const match = /^bytes=0-(\d+)$/.exec(range);
        const bytesReceived = match ? Number(match[1]) + 1 : NaN;
        if (!Number.isSafeInteger(bytesReceived) || bytesReceived < 0 || bytesReceived >= fileSize) {
          throw new Error('YouTube returned an invalid resumable upload range');
        }
        return { status: 'incomplete', bytesReceived };
      }
      return { status: 'incomplete', bytesReceived: 0 };
    } else if (response.ok) {
      const data = await response.json();
      return { status: 'completed', videoId: data.id };
    } else if (response.status === 404) {
      const error = new Error('YouTube resumable session expired');
      error.code = 'YOUTUBE_RESUMABLE_SESSION_EXPIRED';
      throw error;
    } else {
      throw new Error(`Failed to check upload status: ${response.status}`);
    }
  }

  // Step 3: Stream Data
  async uploadVideo(sessionUri, stream, chunkSize, startByte = 0, totalSize = chunkSize) {
    const token = await this.getAccessToken();
    const endByte = startByte + chunkSize - 1;
    
    // Exact byte metering: count emitted bytes and fail closed if stream length != chunkSize
    const meteredStream = createByteCountingStream(chunkSize);
    stream.pipe(meteredStream);

    const response = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'video/mp4',
        'Content-Length': String(chunkSize),
        'Content-Range': `bytes ${startByte}-${endByte}/${totalSize}`
      },
      body: meteredStream,
      duplex: 'half'
    });

    if (response.ok) {
      const data = await response.json();
      return { status: 'completed', videoId: data.id, raw: data };
    } else if (response.status === 308) {
      const range = response.headers.get('range');
      let bytesReceived = 0;
      if (range) {
        const match = /^bytes=0-(\d+)$/.exec(range);
        bytesReceived = match ? Number(match[1]) + 1 : 0;
      }
      return { status: 'incomplete', bytesReceived, response };
    } else {
      const err = await response.text();
      throw new Error(`Upload failed: ${response.status} ${err}`);
    }
  }

  async setThumbnail(videoId, coverStream, coverMimeType, contentLength = null) {
    const token = await this.getAccessToken();
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': coverMimeType,
    };
    if (contentLength && Number.isSafeInteger(Number(contentLength))) {
      headers['Content-Length'] = String(contentLength);
    }

    const response = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: 'POST',
      headers,
      body: coverStream,
      duplex: 'half',
    });

    if (!response.ok) {
      const errText = await response.text();
      let errJson = null;
      try { errJson = JSON.parse(errText); } catch {}
      const reason = errJson?.error?.errors?.[0]?.reason || errJson?.error?.message || errText;
      const error = new Error(`Thumbnail upload failed: ${response.status} ${reason}`);
      error.status = response.status;
      error.code = response.status;
      error.response = { status: response.status, data: errJson || { message: errText } };
      throw error;
    }

    return await response.json();
  }

  async getVideoDetails(videoId, parts = ['snippet', 'status', 'contentDetails']) {
    const token = await this.getAccessToken();
    const partStr = encodeURIComponent(parts.join(','));
    const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(videoId)}&part=${partStr}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Failed to fetch video details: ${response.status} ${errText}`);
    }

    const data = await response.json();
    return data.items?.[0] || null;
  }
}
