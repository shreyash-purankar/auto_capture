import { useEffect, useRef, useState, useCallback } from 'react';
import { KYCStage } from '../types/kyc_types';
import type { WorkerMessage, KYCStageType, BoundingBox } from '../types/kyc_types';

export const useKYCPipeline = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const workerRef = useRef<Worker | null>(null);

    // --- ADD THE LOCK ---
    const isProcessingWorker = useRef<boolean>(false);

    const [currentStage, setCurrentStage] = useState<KYCStageType>(KYCStage.PRE_FLIGHT);
    const [feedback, setFeedback] = useState<string>("Initializing...");
    const [isReadyForNextStage, setIsReady] = useState(false);

    const [capturedId, setCapturedId] = useState<string | null>(null);
    const [capturedFace, setCapturedFace] = useState<string | null>(null);
    const [boundingBox, setBoundingBox] = useState<BoundingBox | null>(null);
    const [isMocking, setIsMocking] = useState(false);
    const [progress, setProgress] = useState(0);
    const [isMirrored, setIsMirrored] = useState(true);

    const isMobile = useCallback(() => {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }, []);

    // Initialize Web Worker
    useEffect(() => {
        console.log("[Main] Bootstrapping KYC Worker...");
        const worker = new Worker(
            new URL('../workers/kyc_worker.ts', import.meta.url),
            { type: 'module' }
        );
        workerRef.current = worker;

        worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
            // --- RELEASE THE LOCK WHEN WORKER RESPONDS ---
            isProcessingWorker.current = false;

            setFeedback(e.data.feedback);
            setIsReady(e.data.isReady);
            setBoundingBox(e.data.boundingBox || null);
            setProgress(e.data.progress || 0);
            if (e.data.isMocking !== undefined) {
                setIsMocking(e.data.isMocking);
            }

            if (e.data.capturedImage) {
                console.log(`[Main] Image Received for stage: ${e.data.stage}`);
                if (e.data.stage === KYCStage.ID_CAPTURE) {
                    setCapturedId(e.data.capturedImage);
                    setCurrentStage(KYCStage.FACE_CAPTURE);
                } else if (e.data.stage === KYCStage.FACE_CAPTURE) {
                    setCapturedFace(e.data.capturedImage);
                    setCurrentStage(KYCStage.DONE);
                }
            }
        };

        const isHighEnd = navigator.hardwareConcurrency ? navigator.hardwareConcurrency >= 4 : false;
        worker.postMessage({ type: 'INIT', tier: isHighEnd ? 'high' : 'low' });

        worker.onerror = (err) => {
            console.error("[Main] Worker Error Encountered:", err);
            isProcessingWorker.current = false; // Release lock on error
            setFeedback("Detection error. Please refresh.");
        };

        return () => {
            console.log("[Main] Terminating Worker...");
            worker.terminate();
        }
    }, []);

    // Track Stage Transitions
    useEffect(() => {
        console.log(`[Main] Stage transitioned to: ${currentStage}`);
    }, [currentStage]);

    // Initialize Camera Stream
    useEffect(() => {
        let stream: MediaStream | null = null;
        const startCamera = async () => {
            console.log("[Main] Requesting Camera Permissions...");
            
            const mobile = isMobile();
            let facingMode: ConstrainDOMString = 'environment';
            let mirror = true;

            if (mobile) {
                if (currentStage === KYCStage.FACE_CAPTURE) {
                    facingMode = 'user';
                    mirror = true;
                } else {
                    facingMode = 'environment';
                    mirror = false;
                }
            } else {
                // Desktop stays as it was (environment/default, mirrored)
                facingMode = 'environment';
                mirror = true;
            }

            setIsMirrored(mirror);

            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { 
                        facingMode, 
                        width: { min: 1280, ideal: 1920, max: 4096 }, 
                        height: { min: 720, ideal: 1080, max: 2160 },
                        aspectRatio: { ideal: 1.7777777778 } // 16:9
                    }
                });
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    console.log(`[Main] Camera access granted (${facingMode}) and stream attached.`);
                }
            } catch (e) {
                console.error("[Main] Camera Access Failed:", e);
                setFeedback("Camera access required.");
            }
        };
        startCamera();

        return () => {
            if (stream) {
                console.log("[Main] Stopping Camera Tracks.");
                stream.getTracks().forEach(track => track.stop());
            }
        };
    }, [currentStage, isMobile]);

    // Headless Processing Loop
    useEffect(() => {
        if (currentStage === KYCStage.DONE) return;
        let animationFrameId: number;
        let lastProcessedTime = 0;

        const isHighEnd = navigator.hardwareConcurrency ? navigator.hardwareConcurrency >= 4 : false;
        const throttleMs = isHighEnd ? 33 : 166; // 6fps for Tier 2 (Low-End Mobile)
        console.log(`[Main] Performance Tier set: isHighEnd = ${isHighEnd}, throttleMs = ${throttleMs}ms`);

        const processFrame = (timestamp: number) => {
            // Check throttle AND ensure worker is NOT busy
            if (timestamp - lastProcessedTime >= throttleMs && !isProcessingWorker.current) {
                const video = videoRef.current;
                const canvas = hiddenCanvasRef.current;
                const overlay = overlayCanvasRef.current;

                if (video && canvas && workerRef.current && video.readyState >= 2 && video.videoWidth > 0) {
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    
                    // Force the internal buffer to stay at native resolution
                    if (video.width !== video.videoWidth) video.width = video.videoWidth;
                    if (video.height !== video.videoHeight) video.height = video.videoHeight;
                    
                    if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
                    if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;

                    if (overlay) {
                        if (overlay.width !== video.videoWidth) overlay.width = video.videoWidth;
                        if (overlay.height !== video.videoHeight) overlay.height = video.videoHeight;
                    }

                    if (ctx) {
                        ctx.imageSmoothingEnabled = false; // Preserve raw sensor edges
                        const win = window as any;
                        if (!win._kyc_log_once) {
                            console.log(`[Main] Capture Pipeline Resolution: ${video.videoWidth}x${video.videoHeight}`);
                            win._kyc_log_once = true;
                        }
                        try {
                            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

                            // --- SET THE LOCK BEFORE SENDING ---
                            isProcessingWorker.current = true;

                            workerRef.current.postMessage({
                                stage: currentStage,
                                frameData: imageData.data,
                                width: canvas.width,
                                height: canvas.height,
                            }, [imageData.data.buffer]);

                            lastProcessedTime = timestamp;
                        } catch (err) {
                            console.error("[Main] Error reading canvas context data:", err);
                            isProcessingWorker.current = false;
                        }
                    }
                }
            }
            animationFrameId = requestAnimationFrame(processFrame);
        };
        animationFrameId = requestAnimationFrame(processFrame);

        return () => cancelAnimationFrame(animationFrameId);
    }, [currentStage]);

    // Dynamic Bounding Box Overlay UI
    useEffect(() => {
        const overlay = overlayCanvasRef.current;
        if (!overlay) return;
        const ctx = overlay.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (boundingBox && (currentStage === KYCStage.ID_CAPTURE || currentStage === KYCStage.FACE_CAPTURE)) {
            const color = isReadyForNextStage ? '#10b981' : '#f59e0b';

            ctx.strokeStyle = color;
            ctx.lineWidth = isReadyForNextStage ? 6 : 3;
            ctx.shadowColor = color;
            ctx.shadowBlur = isReadyForNextStage ? 20 : 5;
            ctx.strokeRect(boundingBox.x, boundingBox.y, boundingBox.width, boundingBox.height);

            ctx.fillStyle = color;
            const size = 22; const t = 6;
            const { x, y, width: w, height: h } = boundingBox;
            ctx.fillRect(x, y, size, t); ctx.fillRect(x, y, t, size);
            ctx.fillRect(x + w - size, y, size, t); ctx.fillRect(x + w - t, y, t, size);
            ctx.fillRect(x, y + h - t, size, t); ctx.fillRect(x, y + h - size, t, size);
            ctx.fillRect(x + w - size, y + h - t, size, t); ctx.fillRect(x + w - t, y + h - size, t, size);

            // Draw progress bar at the bottom of the bounding box
            if (isReadyForNextStage && progress > 0) {
                const progressWidth = w * progress;
                ctx.fillStyle = '#10b981';
                ctx.shadowBlur = 10;
                ctx.fillRect(x, y + h + 10, progressWidth, 6);
                
                // Draw background for progress bar
                ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
                ctx.shadowBlur = 0;
                ctx.fillRect(x + progressWidth, y + h + 10, w - progressWidth, 6);
            }
        }
    }, [boundingBox, currentStage, isReadyForNextStage, progress]);

    const transitionStage = useCallback(() => {
        if (currentStage === KYCStage.PRE_FLIGHT) {
            console.log("[Main] User triggered stage transition to ID_CAPTURE");
            setCurrentStage(KYCStage.ID_CAPTURE);
        }
    }, [currentStage]);

    const forceCapture = useCallback(() => {
        if (workerRef.current) {
            workerRef.current.postMessage({ type: 'FORCE_CAPTURE' });
        }
    }, []);

    return { videoRef, hiddenCanvasRef, overlayCanvasRef, currentStage, feedback, isReadyForNextStage, transitionStage, capturedId, capturedFace, isMocking, forceCapture, progress, isMirrored };
};
