export const KYCStage = {
  PRE_FLIGHT: 'PRE_FLIGHT',
  ID_CAPTURE: 'ID_CAPTURE',
  FACE_CAPTURE: 'FACE_CAPTURE',
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
