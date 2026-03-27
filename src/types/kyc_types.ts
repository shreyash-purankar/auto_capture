export const KYCStage = {
  PRE_FLIGHT: 'PRE_FLIGHT',
  ID_CAPTURE: 'ID_CAPTURE',
  FACE_CAPTURE: 'FACE_CAPTURE',
  VERIFICATION: 'VERIFICATION',
  DONE: 'DONE',
} as const;

export type KYCStageType = typeof KYCStage[keyof typeof KYCStage];

export type BoundingBox = { x: number; y: number; width: number; height: number };

export type WorkerMessage = {
  type: 'FRAME_RESULT';
  stage: KYCStageType;
  feedback: string;
  isReady: boolean;
  boundingBox?: BoundingBox | null;
  capturedImage?: Blob | null;
  isMocking?: boolean;
  progress?: number;
};

export interface VerifyFaceResponse {
  success: boolean;
  message: string;
  similarity?: number;
  matchConfidence?: number;
  matchStatus?: 'MATCHED' | 'NOT_MATCHED' | 'PARTIAL_MATCH';
  errorCode?: string;
  [key: string]: any;
}
