/**
 * Backend proxy endpoint for face verification API
 * This solves CORS issues by making the API call server-to-server
 */

export default async function handler(req: any, res: any) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { formData, bearerToken } = req.body;

    if (!formData) {
      return res.status(400).json({ error: 'Missing form data' });
    }

    // Create FormData from the received data
    const form = new FormData();
    
    // Add files
    if (formData.docFile) {
      const docBuffer = Buffer.from(formData.docFile, 'base64');
      form.append('docFile', new Blob([docBuffer], { type: 'image/jpeg' }), 'id_document.jpg');
    }

    if (formData.userPhoto) {
      const photoBuffer = Buffer.from(formData.userPhoto, 'base64');
      form.append('user_photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'face_photo.jpg');
    }

    // Add parameters
    form.append('SimilarityThreshold', formData.similarityThreshold || '75');
    form.append('ImageType', formData.imageType || '1');

    console.log('[verify-face API] Forwarding request to Aadrila API');

    // Call the Aadrila API from the backend (no CORS issues)
    const response = await fetch('https://uat.aadrila.com/api/v1/verify-face', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${bearerToken}`,
      },
      body: form,
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('[verify-face API] Aadrila API error:', data);
      return res.status(response.status).json(data);
    }

    console.log('[verify-face API] Success response:', data);
    return res.status(200).json(data);

  } catch (error) {
    console.error('[verify-face API] Error:', error);
    return res.status(500).json({ 
      error: 'Verification failed', 
      message: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
}
