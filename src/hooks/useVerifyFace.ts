import { useState, useCallback } from 'react';

export interface VerifyFaceResponse {
  success?: boolean;
  message?: string;
  similarity?: number;
  matchConfidence?: number;
  matchStatus?: 'MATCHED' | 'NOT_MATCHED' | 'PARTIAL_MATCH';
  errorCode?: string;
  // Aadrila API specific fields
  status?: number;
  data?: {
    crn?: string;
    status?: number;
    threshold?: string;
    face_match_score?: string;
    request_timestamp?: string;
    response_timestamp?: string;
    total_time?: number;
  };
  error?: string;
  [key: string]: any;
}

interface UseVerifyFaceOptions {
  bearerToken?: string;
  similarityThreshold?: string;
  imageType?: string;
}

// Helper function to convert blob to base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1]; // Remove data:image/jpeg;base64, prefix
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

// Helper function to ensure blob is a valid image
const ensureValidImageBlob = async (blob: Blob, filename: string): Promise<Blob> => {
  // console.log(`[ensureValidImageBlob] Processing ${filename}, original size: ${blob.size}, type: ${blob.type}`);
  
  try {
    // Create a canvas and draw the image
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    return new Promise((resolve, reject) => {
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error('Could not get canvas context'));
          return;
        }
        
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        
        // Convert canvas to JPEG blob
        canvas.toBlob(
          (jpegBlob) => {
            if (!jpegBlob) {
              reject(new Error('Failed to convert canvas to blob'));
              return;
            }
            // console.log(`[ensureValidImageBlob] Successfully converted ${filename} to JPEG, new size: ${jpegBlob.size}, type: ${jpegBlob.type}`);
            resolve(jpegBlob);
          },
          'image/jpeg',
          0.95 // quality
        );
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(`Failed to load image for ${filename}`));
      };
      
      img.src = url;
    });
  } catch (err) {
    // console.error(`[ensureValidImageBlob] Error converting ${filename}:`, err);
    // If conversion fails, return original blob
    return blob;
  }
};

export const useVerifyFace = (options: UseVerifyFaceOptions = {}) => {
  const {
    bearerToken = (import.meta as any).env.VITE_AADRILA_BEARER_TOKEN || '',
    similarityThreshold = (import.meta as any).env.VITE_SIMILARITY_THRESHOLD || '75',
    imageType = (import.meta as any).env.VITE_IMAGE_TYPE || '1',
  } = options;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyFaceResponse | null>(null);

  const verifyFace = useCallback(
    async (
      docFileBlob: Blob,
      userPhotoBlob: Blob
    ): Promise<VerifyFaceResponse | null> => {
      setLoading(true);
      setError(null);
      setResult(null);

      try {
        // Ensure blobs are valid image files
        // console.log('[useVerifyFace] Processing images...');
        // console.log('[useVerifyFace] Doc file blob size:', docFileBlob.size, 'type:', docFileBlob.type);
        // console.log('[useVerifyFace] User photo blob size:', userPhotoBlob.size, 'type:', userPhotoBlob.type);

        const docFile = await ensureValidImageBlob(docFileBlob, 'id_document.jpg');
        const userPhoto = await ensureValidImageBlob(userPhotoBlob, 'face_photo.jpg');

        // Convert blobs to base64 for proxy API
        const docFileBase64 = await blobToBase64(docFile);
        const userPhotoBase64 = await blobToBase64(userPhoto);

        // console.log('[useVerifyFace] Converted to base64, sending to proxy endpoint');
        // console.log('[useVerifyFace] Parameters:', {
        //   SimilarityThreshold: similarityThreshold,
        //   ImageType: imageType,
        //   docFileSize: docFile.size,
        //   userPhotoSize: userPhoto.size,
        // });

        // Call the proxy endpoint instead of the API directly (solves CORS)
        const proxyUrl = '/api/verify-face';
        const response = await fetch(proxyUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            docFileBase64,
            userPhotoBase64,
            bearerToken,
            similarityThreshold,
            imageType,
          }),
        });

        if (!response.ok) {
          const errorData = await response.text();
          // console.error('[useVerifyFace] Proxy Error Response:', errorData);
          throw new Error(
            `API Error: ${response.status} - ${errorData || response.statusText}`
          );
        }

        const data = await response.json();
        // console.log('[useVerifyFace] API Response:', data);

        // Normalize API response to standard format
        const normalizedResponse: VerifyFaceResponse = {
          ...data,
          success: false,
          message: '',
          similarity: undefined,
        };

        // Handle Aadrila API response format
        if (data.data) {
          const apiData = data.data;
          const faceMatchScore = parseFloat(apiData.face_match_score || '0');
          const threshold = parseFloat(apiData.threshold || '75');
          
          // console.log('[useVerifyFace] Extracted face_match_score:', faceMatchScore, 'threshold:', threshold);
          
          // Determine success based on status and threshold
          const isSuccess = apiData.status === 1 && faceMatchScore >= threshold;
          
          normalizedResponse.success = isSuccess;
          normalizedResponse.similarity = faceMatchScore;
          normalizedResponse.matchConfidence = faceMatchScore;
          normalizedResponse.matchStatus = isSuccess ? 'MATCHED' : 'NOT_MATCHED';
          normalizedResponse.message = isSuccess 
            ? `Face match successful! Score: ${faceMatchScore.toFixed(2)}%`
            : `Face match failed. Score: ${faceMatchScore.toFixed(2)}% (Required: ${threshold}%)`;
          
          // console.log('[useVerifyFace] Normalized response:', {
          //   success: normalizedResponse.success,
          //   similarity: normalizedResponse.similarity,
          //   matchStatus: normalizedResponse.matchStatus,
          //   message: normalizedResponse.message,
          // });
        } else if (data.success !== undefined) {
          // Handle standard API format
          normalizedResponse.success = data.success;
          normalizedResponse.message = data.message || '';
          normalizedResponse.similarity = data.similarity;
          normalizedResponse.matchConfidence = data.matchConfidence;
          normalizedResponse.matchStatus = data.matchStatus;
        }

        setResult(normalizedResponse);
        setLoading(false);
        return normalizedResponse;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';
        // console.error('[useVerifyFace] Error:', errorMessage);
        setError(errorMessage);
        setLoading(false);
        return null;
      }
    },
    [bearerToken, similarityThreshold, imageType]
  );

  const reset = useCallback(() => {
    setLoading(false);
    setError(null);
    setResult(null);
  }, []);

  return {
    verifyFace,
    loading,
    error,
    result,
    reset,
  };
};
