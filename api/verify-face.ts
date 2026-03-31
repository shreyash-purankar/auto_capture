/**
 * Backend proxy endpoint for face verification API
 * This solves CORS issues by making the API call server-to-server
 */

export default async function handler(req: any, res: any) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { docFileBase64, userPhotoBase64, bearerToken, similarityThreshold = '75', imageType = '1' } = req.body;

    // Use environment variable if available, otherwise use bearer token from frontend
    const token = process.env.AADRILA_BEARER_TOKEN || bearerToken;
    const apiUrl = process.env.AADRILA_API_URL || 'https://uat.aadrila.com/api/v1/verify-face';

    if (!token) {
      return res.status(400).json({ 
        error: 'Missing authentication token',
        message: 'Bearer token not found in environment or request body'
      });
    }

    if (!docFileBase64 || !userPhotoBase64) {
      return res.status(400).json({ error: 'Missing image data' });
    }

    // Create FormData
    const form = new FormData();

    // Convert base64 to Buffer then to Blob
    const docBuffer = Buffer.from(docFileBase64, 'base64');
    const photoBuffer = Buffer.from(userPhotoBase64, 'base64');

    form.append('docFile', new Blob([docBuffer], { type: 'image/jpeg' }), 'id_document.jpg');
    form.append('user_photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'face_photo.jpg');
    form.append('SimilarityThreshold', String(similarityThreshold));
    form.append('ImageType', String(imageType));

    // Call the Aadrila API from backend (no CORS)
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
      body: form as any,
    });

    const data = await response.json();

    if (!response.ok) {
      // Return detailed error info for debugging
      return res.status(response.status).json({
        ...data,
        debug: {
          statusCode: response.status,
          tokenSource: process.env.AADRILA_BEARER_TOKEN ? 'environment' : 'frontend',
          apiUrl: apiUrl,
        }
      });
    }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({
      error: 'Verification failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
