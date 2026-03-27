/**
 * Local Development API Server
 * Runs on port 3001, proxied from Vite dev server on port 3000
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3002;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API server is running' });
});

/**
 * Face Verification Proxy Endpoint
 * Receives base64 images from frontend and calls Aadrila API
 */
app.post('/api/verify-face', async (req, res) => {
  try {
    const { docFileBase64, userPhotoBase64, bearerToken, similarityThreshold = '75', imageType = '1' } = req.body;

    if (!docFileBase64 || !userPhotoBase64) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    // Create FormData with images and parameters
    const form = new FormData();

    // Convert base64 to Buffer then to Blob
    const docBuffer = Buffer.from(docFileBase64, 'base64');
    const photoBuffer = Buffer.from(userPhotoBase64, 'base64');

    form.append('docFile', new Blob([docBuffer], { type: 'image/jpeg' }), 'id_document.jpg');
    form.append('user_photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'face_photo.jpg');
    form.append('SimilarityThreshold', String(similarityThreshold));
    form.append('ImageType', String(imageType));

    // Call the Aadrila API from backend (no CORS issues)
    const apiUrl = process.env.AADRILA_API_URL || 'https://uat.aadrila.com/api/v1/verify-face';
    const token = process.env.AADRILA_BEARER_TOKEN || bearerToken;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: form as any,
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    // console.error('[verify-face API] Error:', error);
    return res.status(500).json({
      error: 'Verification failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ API Server running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
