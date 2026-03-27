import { useEffect, useRef, useState, useCallback } from 'react';
import { KYCStage } from '../types/kyc_types';
import type { WorkerMessage, KYCStageType, BoundingBox } from '../types/kyc_types';

export const useKYCPipeline = () => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const hiddenCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const workerRef = useRef<Worker | null>(null);
    
    // Stream ref for constraint switching optimization
    const streamRef = useRef<MediaStream | null>(null);

    // --- ADD THE LOCK ---
    const isProcessingWorker = useRef<boolean>(false);

    const [currentStage, setCurrentStage] = useState<KYCStageType>(KYCStage.PRE_FLIGHT);
    const [feedback, setFeedback] = useState<string>("Initializing...");
    const [isReadyForNextStage, setIsReady] = useState(false);

    const [capturedId, setCapturedId] = useState<string | null>(null);
    const [capturedFace, setCapturedFace] = useState<string | null>(null);
    const [capturedIdBlob, setCapturedIdBlob] = useState<Blob | null>(null);
    const [capturedFaceBlob, setCapturedFaceBlob] = useState<Blob | null>(null);
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
                    setCapturedIdBlob(e.data.capturedImage);
                    const objectUrl = URL.createObjectURL(e.data.capturedImage);
                    setCapturedId(objectUrl);
                    setCurrentStage(KYCStage.FACE_CAPTURE);
                } else if (e.data.stage === KYCStage.FACE_CAPTURE) {
                    setCapturedFaceBlob(e.data.capturedImage);
                    const objectUrl = URL.createObjectURL(e.data.capturedImage);
                    setCapturedFace(objectUrl);
                    setCurrentStage(KYCStage.DONE);
                }
            }
        };

        const isHighEnd = navigator.hardwareConcurrency ? navigator.hardwareConcurrency >= 4 : false;
        const mobile = isMobile();
        worker.postMessage({ type: 'INIT', tier: isHighEnd ? 'high' : 'low', isMobile: mobile });

        worker.onerror = (err) => {
            console.error("[Main] Worker Error Encountered:", err);
            isProcessingWorker.current = false; // Release lock on error
            setFeedback("Detection error. Please refresh.");
        };

        return () => {
            console.log("[Main] Terminating Worker...");
            // Clean up object URLs to prevent memory leaks
            if (capturedId) URL.revokeObjectURL(capturedId);
            if (capturedFace) URL.revokeObjectURL(capturedFace);
            // Clean up camera stream
            if (streamRef.current) {
                console.log("[Main] Stopping Camera Tracks on component unmount.");
                streamRef.current.getTracks().forEach(track => track.stop());
                streamRef.current = null;
            }
            worker.terminate();
        }
    }, []);

    // Track Stage Transitions
    useEffect(() => {
        console.log(`[Main] Stage transitioned to: ${currentStage}`);
        // Reset worker lock on stage transition to prevent stale state blocking new frames
        isProcessingWorker.current = false;
    }, [currentStage]);

    // Initialize Camera Stream
    useEffect(() => {
        let isMounted = true;
        
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

            if (!isMounted) return;
            setIsMirrored(mirror);

            try {
                // Mobile devices use lower resolution to reduce processing load
                const videoConstraints = mobile ? {
                    facingMode,
                    width: { min: 640, ideal: 1280, max: 1920 },
                    height: { min: 480, ideal: 720, max: 1080 },
                    aspectRatio: { ideal: 1.7777777778 } // 16:9
                } : {
                    facingMode,
                    width: { min: 1280, ideal: 1920, max: 4096 },
                    height: { min: 720, ideal: 1080, max: 2160 },
                    aspectRatio: { ideal: 1.7777777778 } // 16:9
                };

                // Try constraint switching optimization for mobile devices
                let stream = streamRef.current;
                let constraintSwitchSucceeded = false;
                
                if (mobile && stream && stream.active) {
                    const videoTrack = stream.getVideoTracks()[0];
                    if (videoTrack) {
                        try {
                            console.log(`[Main] Attempting constraint switch to ${facingMode}...`);
                            await videoTrack.applyConstraints({ facingMode });
                            constraintSwitchSucceeded = true;
                            console.log(`[Main] Constraint switch successful (${facingMode})`);
                        } catch (constraintError) {
                            console.warn("[Main] Constraint switching not supported, falling back to new stream:", constraintError);
                            // Stop existing stream before requesting new one
                            stream.getTracks().forEach(track => track.stop());
                            stream = null;
                            streamRef.current = null;
                        }
                    }
                }
                
                // If constraint switching didn't work or no existing stream, get new stream
                if (!constraintSwitchSucceeded) {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: videoConstraints
                    });
                    streamRef.current = stream;
                }
                
                if (isMounted && videoRef.current) {
                    videoRef.current.srcObject = stream;
                    console.log(`[Main] Camera access granted (${facingMode}) and stream attached.`);
                } else if (stream) {
                    // Component unmounted before stream was attached — release immediately
                    stream.getTracks().forEach(track => track.stop());
                    streamRef.current = null;
                }
            } catch (e) {
                console.error("[Main] Camera Access Failed:", e);
                if (isMounted) setFeedback("Camera access required.");
            }
        };
        startCamera();

        return () => {
            isMounted = false;
            // Don't stop stream on cleanup - keep it alive for constraint switching
            // Only stop on component unmount (handled in main cleanup useEffect)
        };
    }, [currentStage, isMobile]);

    // Headless Processing Loop
    useEffect(() => {
        if (currentStage === KYCStage.DONE) return;
        let animationFrameId: number;
        let lastProcessedTime = 0;

        const mobile = isMobile();
        const isHighEnd = navigator.hardwareConcurrency ? navigator.hardwareConcurrency >= 4 : false;
        
        // More aggressive throttling for mobile devices during ID capture
        let throttleMs;
        if (mobile && currentStage === KYCStage.ID_CAPTURE) {
            throttleMs = 250; // 4fps for mobile ID capture
        } else if (mobile) {
            throttleMs = 166; // 6fps for mobile face capture
        } else {
            throttleMs = isHighEnd ? 33 : 100; // 30fps for desktop high-end, 10fps for low-end
        }
        
        console.log(`[Main] Performance Tier: isHighEnd=${isHighEnd}, mobile=${mobile}, throttleMs=${throttleMs}ms`);

        const processFrame = async (timestamp: number) => {
            // Check throttle AND ensure worker is NOT busy
            if (timestamp - lastProcessedTime >= throttleMs && !isProcessingWorker.current) {
                const video = videoRef.current;
                const overlay = overlayCanvasRef.current;

                if (video && workerRef.current && video.readyState >= 3 && video.videoWidth > 0 && !video.paused && !video.ended) {
                    if (overlay) {
                        if (overlay.width !== video.videoWidth) overlay.width = video.videoWidth;
                        if (overlay.height !== video.videoHeight) overlay.height = video.videoHeight;
                    }

                    try {
                        // --- OPTIMIZATION: Use ImageBitmap for zero-copy transfer ---
                        const bitmap = await createImageBitmap(video);

                        // --- SET THE LOCK BEFORE SENDING ---
                        isProcessingWorker.current = true;

                        const mobile = isMobile();
                        workerRef.current.postMessage({
                            stage: currentStage,
                            bitmap: bitmap,
                            width: video.videoWidth,
                            height: video.videoHeight,
                            isMobile: mobile,
                        }, [bitmap]);

                        lastProcessedTime = timestamp;
                    } catch (err) {
                        console.error("[Main] Error creating ImageBitmap or sending to worker:", err);
                        isProcessingWorker.current = false;
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

    const resetFlow = useCallback(() => {
        console.log("[Main] Resetting KYC flow to PRE_FLIGHT");
        isProcessingWorker.current = false;
        
        // Clean up object URLs before resetting
        if (capturedId) URL.revokeObjectURL(capturedId);
        if (capturedFace) URL.revokeObjectURL(capturedFace);
        
        // Clean up camera stream to force fresh start
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }
        
        setCapturedId(null);
        setCapturedFace(null);
        setCapturedIdBlob(null);
        setCapturedFaceBlob(null);
        setBoundingBox(null);
        setProgress(0);
        setIsReady(false);
        setFeedback("Initializing...");
        setCurrentStage(KYCStage.PRE_FLIGHT);
    }, [capturedId, capturedFace]);

    return { videoRef, hiddenCanvasRef, overlayCanvasRef, currentStage, feedback, isReadyForNextStage, transitionStage, capturedId, capturedFace, capturedIdBlob, capturedFaceBlob, isMocking, forceCapture, progress, isMirrored, resetFlow };
};
