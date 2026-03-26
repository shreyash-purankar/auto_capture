import { KYCStage } from '../types/kyc_types';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import '@tensorflow/tfjs-backend-wasm';

setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm@4.22.0/dist/');

let yoloModel: tf.GraphModel | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceLandmarker: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cv: any = null;
let captureTimer = 0;
let previousBoundingBox: { x: number, y: number, width: number, height: number } | null = null;
let smoothedBoundingBox: { x: number, y: number, width: number, height: number } | null = null;
let forceNextCapture = false;
let currentTier: 'high' | 'low' = 'high';
let offscreenCanvas: OffscreenCanvas | null = null;
let offscreenCtx: OffscreenCanvasRenderingContext2D | null = null;
// Dedicated canvas for ROI crops — avoids thrashing the full-frame canvas dimensions
let roiCanvas: OffscreenCanvas | null = null;
let roiCtx: OffscreenCanvasRenderingContext2D | null = null;
// Feedback debounce state
let lastFeedbackText = '';
let feedbackSameCount = 0;
let isMobileDevice = false;

// --- CONFIGURATION CONSTANTS ---
const CONFIG = {
    // Pre-Flight Checks
    MIN_BRIGHTNESS: 60,       // Minimum average pixel intensity (0-255)
    MAX_BRIGHTNESS: 240,      // Maximum average pixel intensity (0-255)
    MIN_GLOBAL_VARIANCE: 20,  // Minimum Laplacian variance for the entire frame (lowered from 80)

    // ID Capture (YOLO & OpenCV)
    YOLO_SIZE: 640,           // Input size for YOLOv11
    YOLO_SIZE_MOBILE: 320,    // Reduced input size for mobile devices
    YOLO_CONFIDENCE: 0.15,    // Minimum confidence score — kept low so close-up shots (where YOLO loses background context) still fire
    ID_MIN_WIDTH_RATIO: 0.38, // ID must take up at least 38% of the frame width (closer to camera)
    ID_MAX_DIST_CENTER: 0.95,  // Maximum distance from center
    ID_ASPECT_RATIO: 1.58,    // Standard ID card aspect ratio (width/height)
    ID_ASPECT_TOLERANCE: 0.40, // Wide tolerance — close-up perspective distortion skews the ratio
    ID_BOX_EXPAND_FACTOR: 1.10, // Expand YOLO box by 10% so OpenCV sees full card edges and corners
    ID_MIN_VARIANCE: 90,     // Minimum Laplacian variance for the ID crop (raised to reject blurry captures)
    ID_STABILITY_TOLERANCE: 0.25, // Maximum allowed movement between frames
    ID_CAPTURE_FRAMES: 15,    // Number of consecutive stable frames required to auto-capture


    // Face Capture (MediaPipe)
    FACE_MIN_WIDTH_RATIO: 0.25, // Face must take up at least 25% of the frame width (desktop)
    FACE_MIN_WIDTH_RATIO_MOBILE: 0.15, // Face must take up at least 15% of the frame width (mobile - more comfortable distance)
    FACE_CENTER_TOLERANCE: 0.25, // Face must be within 25% of the center
    FACE_CENTER_TOLERANCE_MOBILE: 0.25, // Face must be within 30% of the center (mobile - more forgiving)
    FACE_MIN_EAR: 0.2,        // Minimum Eye Aspect Ratio (openness)
    FACE_MAX_GAZE_OFFSET: 0.1, // Maximum gaze offset from center
    FACE_MAX_POSE_ANGLE: 0.2, // Maximum head pose angle (yaw/pitch in radians)
    FACE_MIN_VARIANCE: 20,    // Minimum Laplacian variance for the face crop (lowered to 40 as requested)
    FACE_CAPTURE_FRAMES: 20,  // Number of consecutive stable frames required to auto-capture
};

// Patch atob/btoa onto TF.js's internal env().global object.
// TF.js uses `env().global.atob` (NOT globalThis.atob) to decode base64 model params.
// In Vite module workers, env().global may lack atob even though self.atob exists.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tfGlobal = (tf.env() as any).global;
if (tfGlobal && typeof tfGlobal.atob !== 'function') {
    tfGlobal.atob = self.atob.bind(self);
}
if (tfGlobal && typeof tfGlobal.btoa !== 'function') {
    tfGlobal.btoa = self.btoa.bind(self);
}

// Apply exponential moving average to smooth bounding box jitter between frames
const EMA_ALPHA = 0.35;
function applyEMA(
    prev: { x: number; y: number; width: number; height: number } | null,
    next: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
    if (!prev) return { ...next };
    return {
        x: prev.x + EMA_ALPHA * (next.x - prev.x),
        y: prev.y + EMA_ALPHA * (next.y - prev.y),
        width: prev.width + EMA_ALPHA * (next.width - prev.width),
        height: prev.height + EMA_ALPHA * (next.height - prev.height),
    };
}

// Debounce feedback: only emit a new message if it has appeared 2+ times consecutively
function debounceFeedback(next: string): string {
    if (next === lastFeedbackText) {
        feedbackSameCount++;
    } else {
        lastFeedbackText = next;
        feedbackSameCount = 1;
    }
    return feedbackSameCount >= 2 ? next : lastFeedbackText || next;
}

async function initModels(tier?: 'high' | 'low') {
    currentTier = tier || 'high';
    console.log(`[Worker] Initializing models for ${currentTier} tier...`);
    try {
        const preferredBackend = currentTier === 'low' ? 'wasm' : 'webgl';
        console.log(`[Worker] Proactively selecting preferred backend: ${preferredBackend}`);

        try {
            await tf.setBackend(preferredBackend);
            await tf.ready();
            console.log(`[Worker] TFJS Backend: ${preferredBackend} initialized (Proactive)`);
        } catch (e) {
            console.warn(`[Worker] Preferred backend ${preferredBackend} failed, falling back:`, e);
            const fallback = preferredBackend === 'webgl' ? 'wasm' : 'cpu';
            try {
                await tf.setBackend(fallback);
                await tf.ready();
                console.log(`[Worker] TFJS Backend: ${fallback} initialized (Fallback)`);
            } catch (fallbackErr) {
                console.error("[Worker] Fallback failed:", fallbackErr);
                await tf.setBackend('cpu');
                await tf.ready();
                console.log("[Worker] TFJS Backend: cpu (Last resort)");
            }
        }

        try {
            yoloModel = await tf.loadGraphModel('/models/yolo11n_web_model/model.json');
            console.log("[Worker] YOLOv11 loaded successfully.");
        } catch (err) {
            console.warn("[Worker] YOLOv11 model not found, ID detection will be mocked.", err);
        }

        const cdnUrl = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mediapipe: any = await import(/* @vite-ignore */ cdnUrl);
        const { FilesetResolver, FaceLandmarker } = mediapipe;

        // Polyfill for MediaPipe WASM bootstrap
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (typeof (self as any).import !== 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (self as any).import = async (url: string) => {
                const res = await fetch(url);
                const code = await res.text();
                return (0, eval)(code);
            };
        }

        const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm");
        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
                delegate: "CPU"
            },
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            runningMode: "IMAGE"
        });
        console.log("[Worker] FaceLandmarker loaded successfully.");

        try {
            console.log("[Worker] Loading OpenCV.js...");
            const response = await fetch('/opencv.js');
            const text = await response.text();
            (0, eval)(text);

            if (typeof (self as any).cv === 'function') {
                cv = await (self as any).cv();
            } else if ((self as any).cv instanceof Promise) {
                cv = await (self as any).cv;
            } else {
                cv = (self as any).cv;
            }

            if (cv && cv.getPerspectiveTransform === undefined) {
                await new Promise(resolve => {
                    cv.onRuntimeInitialized = resolve;
                });
            }
            console.log("[Worker] OpenCV.js loaded successfully.");
        } catch (err) {
            console.error("[Worker] OpenCV.js load failed:", err);
        }

    } catch (err) {
        console.error("[Worker] Model Load Error:", err);
    }
}
// initModels() call removed from top-level to allow parameter passing from main thread

function getLaplacianVariance(data: Uint8ClampedArray, width: number, height: number, box?: { x: number, y: number, w: number, h: number }): number {
    let startX, startY, cropW, cropH;
    if (box) {
        startX = Math.max(0, Math.floor(box.x));
        startY = Math.max(0, Math.floor(box.y));
        cropW = Math.min(width - startX, Math.floor(box.w));
        cropH = Math.min(height - startY, Math.floor(box.h));
    } else {
        cropW = 160;
        cropH = 160;
        startX = Math.floor(width / 2 - cropW / 2);
        startY = Math.floor(height / 2 - cropH / 2);
    }

    let sum = 0, sqSum = 0, count = 0;

    for (let y = startY + 1; y < startY + cropH - 1; y += 2) {
        for (let x = startX + 1; x < startX + cropW - 1; x += 2) {
            // Use Green channel (+1) as it approximates luminance best for quick edge detection
            const idx = (y * width + x) * 4 + 1;
            const c = data[idx];
            const t = data[((y - 1) * width + x) * 4 + 1];
            const b = data[((y + 1) * width + x) * 4 + 1];
            const l = data[(y * width + (x - 1)) * 4 + 1];
            const r = data[(y * width + (x + 1)) * 4 + 1];

            const laplacian = t + b + l + r - 4 * c;
            sum += laplacian;
            sqSum += laplacian * laplacian;
            count++;
        }
    }
    if (count === 0) return 0;
    const mean = sum / count;
    return (sqSum / count) - (mean * mean);
}

function findIDCardBoundingBox(data: Uint8ClampedArray, width: number, height: number, faceBox?: { x: number, y: number, w: number, h: number } | null) {
    const scale = 4;
    const w = Math.floor(width / scale);
    const h = Math.floor(height / scale);
    const gray = new Uint8Array(w * h);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const srcIdx = ((y * scale) * width + (x * scale)) * 4;
            gray[y * w + x] = 0.299 * data[srcIdx] + 0.587 * data[srcIdx + 1] + 0.114 * data[srcIdx + 2];
        }
    }

    const edges = new Uint8Array(w * h);
    const fx1 = faceBox ? Math.floor(faceBox.x / scale) : -1;
    const fy1 = faceBox ? Math.floor(faceBox.y / scale) : -1;
    const fx2 = faceBox ? Math.floor((faceBox.x + faceBox.w) / scale) : -1;
    const fy2 = faceBox ? Math.floor((faceBox.y + faceBox.h) / scale) : -1;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            if (faceBox && x >= fx1 && x <= fx2 && y >= fy1 && y <= fy2) {
                continue; // Ignore edges inside the face
            }
            const gx = -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
                - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
                - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
            const gy = -gray[(y - 1) * w + (x - 1)] - 2 * gray[(y - 1) * w + x] - gray[(y - 1) * w + (x + 1)]
                + gray[(y + 1) * w + (x - 1)] + 2 * gray[(y + 1) * w + x] + gray[(y + 1) * w + (x + 1)];
            const mag = Math.abs(gx) + Math.abs(gy);
            if (mag > 100) {
                edges[y * w + x] = 1;
            }
        }
    }

    // Project edges to X and Y axes
    const rowSum = new Int32Array(h);
    const colSum = new Int32Array(w);
    let totalEdges = 0;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (edges[y * w + x]) {
                rowSum[y]++;
                colSum[x]++;
                totalEdges++;
            }
        }
    }

    if (totalEdges < w * h * 0.005) return null;

    const colThreshold = Math.max(2, Math.max(...Array.from(colSum)) * 0.1);
    const rowThreshold = Math.max(2, Math.max(...Array.from(rowSum)) * 0.1);

    const findLongestSegment = (arr: Int32Array, threshold: number) => {
        let maxStart = 0, maxEnd = 0, maxLen = 0;
        let currentStart = -1;
        for (let i = 0; i < arr.length; i++) {
            if (arr[i] > threshold) {
                if (currentStart === -1) currentStart = i;
            } else {
                if (currentStart !== -1) {
                    const len = i - currentStart;
                    if (len > maxLen) {
                        maxLen = len;
                        maxStart = currentStart;
                        maxEnd = i - 1;
                    }
                    currentStart = -1;
                }
            }
        }
        if (currentStart !== -1) {
            const len = arr.length - currentStart;
            if (len > maxLen) {
                maxLen = len;
                maxStart = currentStart;
                maxEnd = arr.length - 1;
            }
        }
        return { start: maxStart, end: maxEnd, len: maxLen };
    };

    const xSeg = findLongestSegment(colSum, colThreshold);
    const ySeg = findLongestSegment(rowSum, rowThreshold);

    if (xSeg.len < w * 0.15 || ySeg.len < h * 0.15) return null;

    const boxW = xSeg.len;
    const boxH = ySeg.len;
    const minX = xSeg.start;
    const minY = ySeg.start;

    const padX = 0; // Removed padding to make box tighter
    const padY = 0;

    return {
        x: Math.max(0, (minX - padX) * scale),
        y: Math.max(0, (minY - padY) * scale),
        width: Math.min(width, (boxW + padX * 2) * scale),
        height: Math.min(height, (boxH + padY * 2) * scale)
    };
}

async function captureImage(frameData: Uint8ClampedArray, width: number, height: number, box?: { x: number, y: number, width: number, height: number }): Promise<Blob> {
    let cropX = 0, cropY = 0, cropW = width, cropH = height;
    if (box) {
        cropX = Math.max(0, Math.floor(box.x));
        cropY = Math.max(0, Math.floor(box.y));
        cropW = Math.min(width - cropX, Math.floor(box.width));
        cropH = Math.min(height - cropY, Math.floor(box.height));
    }

    // Extract crop pixels at native resolution — no upscaling
    const croppedData = new Uint8ClampedArray(cropW * cropH * 4);
    if (!box || (cropX === 0 && cropY === 0 && cropW === width && cropH === height)) {
        croppedData.set(frameData.subarray(0, cropW * cropH * 4));
    } else {
        for (let y = 0; y < cropH; y++) {
            const srcStart = ((cropY + y) * width + cropX) * 4;
            const destStart = y * cropW * 4;
            croppedData.set(frameData.subarray(srcStart, srcStart + cropW * 4), destStart);
        }
    }

    console.log(`[Worker] Capturing image: ${cropW}x${cropH}...`);

    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas context unavailable');

    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(new ImageData(croppedData, cropW, cropH), 0, 0);

    const blob = await canvas.convertToBlob({ 
        type: "image/webp", 
        quality: 1.0  // 100% quality
    });
    
    console.log("[Worker] Capture successful, size:", Math.round((blob.size / 1024)) + "KB");
    return blob;
}

async function captureWarpedImage(imageData: ImageData): Promise<Blob> {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d', { hideFromRaw: true } as any);
    if (!ctx) throw new Error('Canvas context unavailable');
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(imageData, 0, 0);
    
    return await canvas.convertToBlob({ 
        type: "image/webp", 
        quality: 1.0  // 100% quality
    });
}

function processIDCardOpenCV(roiData: Uint8ClampedArray, rw: number, rh: number, yoloBoxInRoi: any) {
    if (!cv) return null;

    let src: any = null;
    let gray: any = null;
    let blurred: any = null;
    let edges: any = null;
    let lines: any = null;
    let contours: any = null;
    let hierarchy: any = null;

    try {
        src = cv.matFromImageData(new ImageData(new Uint8ClampedArray(roiData), rw, rh));

        // 1. Preprocess
        gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

        // 2. Edge Detection
        edges = new cv.Mat();
        cv.Canny(blurred, edges, 50, 150);

        // 3. Fine Tune: Refine edges with HoughLinesP (Requirement)
        lines = new cv.Mat();
        cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 40, 30, 10);

        if (currentTier === 'low') {
            contours = new cv.MatVector();
            hierarchy = new cv.Mat();
            cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let maxArea = 0;
            let bestApprox = new cv.Mat();
            let found = false;

            for (let i = 0; i < contours.size(); ++i) {
                const cnt = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area > (rw * rh * 0.2)) {
                    const peri = cv.arcLength(cnt, true);
                    const approx = new cv.Mat();
                    cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

                    if (approx.rows === 4) {
                        if (area > maxArea) {
                            maxArea = area;
                            if (found) bestApprox.delete();
                            bestApprox = approx;
                            found = true;
                        } else {
                            approx.delete();
                        }
                    } else {
                        approx.delete();
                    }
                }
                cnt.delete();
            }

            if (found) {
                const pts = [];
                for (let i = 0; i < 4; i++) {
                    pts.push({ x: bestApprox.data32S[i * 2], y: bestApprox.data32S[i * 2 + 1] });
                }
                bestApprox.delete();

                pts.sort((a, b) => (a.x + a.y) - (b.x + b.y));
                const tl = pts[0];
                const br = pts[3];
                const rem = [pts[1], pts[2]];
                rem.sort((a, b) => (a.y - a.x) - (b.y - b.x));
                const tr = rem[0];
                const bl = rem[1];

                const maxWidth = Math.max(Math.hypot(br.x - bl.x, br.y - bl.y), Math.hypot(tr.x - tl.x, tr.y - tl.y));
                const maxHeight = Math.max(Math.hypot(tr.x - br.x, tr.y - br.y), Math.hypot(tl.x - bl.x, tl.y - bl.y));

                const ratio = maxWidth / maxHeight;
                if (Math.abs(ratio - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE ||
                    Math.abs((1 / ratio) - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE) {
                    return { isStable: true, tightBox: { x: tl.x, y: tl.y, width: maxWidth, height: maxHeight } };
                }
            }
        } else {
            // Tier 1: High Precision with HoughLinesP Corner Solving
            if (lines.rows >= 4) {
                let horizontalLines = [];
                let verticalLines = [];

                for (let i = 0; i < lines.rows; ++i) {
                    const [x1, y1, x2, y2] = lines.data32S.slice(i * 4, i * 4 + 4);
                    const angle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);

                    if (angle < 20 || angle > 160) {
                        horizontalLines.push({ y: (y1 + y2) / 2, x1, x2 });
                    } else if (Math.abs(angle - 90) < 20) {
                        verticalLines.push({ x: (x1 + x2) / 2, y1, y2 });
                    }
                }

                if (horizontalLines.length >= 2 && verticalLines.length >= 2) {
                    horizontalLines.sort((a, b) => a.y - b.y);
                    verticalLines.sort((a, b) => a.x - b.x);

                    const top = horizontalLines[0].y;
                    const bottom = horizontalLines[horizontalLines.length - 1].y;
                    const left = verticalLines[0].x;
                    const right = verticalLines[verticalLines.length - 1].x;

                    const w = right - left;
                    const h = bottom - top;
                    const ratio = w / h;

                    if (Math.abs(ratio - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE ||
                        Math.abs((1 / ratio) - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE) {
                        return { isStable: true, tightBox: { x: left, y: top, width: w, height: h } };
                    }
                }
            }
            return { isStable: true, tightBox: yoloBoxInRoi };
        }

        return { isStable: false };

    } catch (err) {
        console.error("[Worker] OpenCV Processing Error:", err);
        return { isStable: false };
    } finally {
        if (src) src.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (edges) edges.delete();
        if (lines) lines.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
    }
}

self.onmessage = async (e: MessageEvent) => {
    if (e.data.type === 'FORCE_CAPTURE') {
        forceNextCapture = true;
        return;
    }
    const { type, bitmap, width, height, stage, tier, isMobile } = e.data;

    // Capture mobile device flag
    if (isMobile !== undefined) {
        isMobileDevice = isMobile;
    }

    if (type === 'INIT') {
        await initModels(tier);
        self.postMessage({
            type: 'STATUS',
            feedback: yoloModel ? "System Ready" : "System Ready (Simulated)",
            isMocking: !yoloModel
        });
        return;
    }

    if (!bitmap && type !== 'INIT') return;

    try {
        // Helper to get ImageData from bitmap (used for Pre-Flight and Face)
        const getImageData = (bmp: ImageBitmap, w: number, h: number): ImageData => {
            if (!offscreenCanvas || offscreenCanvas.width !== w || offscreenCanvas.height !== h) {
                offscreenCanvas = new OffscreenCanvas(w, h);
                offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
            }
            offscreenCtx!.drawImage(bmp, 0, 0);
            return offscreenCtx!.getImageData(0, 0, w, h);
        };

        if (stage === KYCStage.PRE_FLIGHT) {
            const imageData = getImageData(bitmap, width, height);
            const frameData = imageData.data;
            let brightnessSum = 0;
            let pixelCount = 0;

            for (let i = 0; i < frameData.length; i += 16) {
                const r = frameData[i];
                const g = frameData[i + 1];
                const b = frameData[i + 2];
                const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
                brightnessSum += luminance;
                pixelCount++;
            }
            const meanBrightness = brightnessSum / pixelCount;

            if (meanBrightness < CONFIG.MIN_BRIGHTNESS) {
                return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Too dark. Move to a well-lit area.", isReady: false });
            }
            if (meanBrightness > CONFIG.MAX_BRIGHTNESS) {
                return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Too bright. Avoid direct glare.", isReady: false });
            }

            const variance = getLaplacianVariance(frameData, width, height);
            if (variance < CONFIG.MIN_GLOBAL_VARIANCE) {
                return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Camera blurry. Clean your lens.", isReady: false });
            }

            self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Environment optimal.", isReady: true });
        }

        else if (stage === KYCStage.ID_CAPTURE) {
            let boundingBox = null;
            let feedback = yoloModel ? "Show your ID card to the camera." : "Simulating ID detector...";
            let isReady = false;
            let capturedImage = null;

            // Skip YOLO on mobile devices to save performance - use lightweight edge detection instead
            const useYOLO = yoloModel && !isMobileDevice;
            
            if (useYOLO) {
                try {
                    // Use smaller YOLO input size to reduce processing time
                    const yoloInputSize = isMobileDevice ? CONFIG.YOLO_SIZE_MOBILE : CONFIG.YOLO_SIZE;
                    
                    // --- LETTERBOX: pad the 16:9 frame to a square so YOLO sees undistorted geometry ---
                    // Direct resize to 640×640 compresses horizontal pixels ~3× more than vertical,
                    // producing degenerate boxes (a thin strip) when the card fills the frame.
                    const lbMaxDim = Math.max(width, height);
                    const lbPadTop = Math.floor((lbMaxDim - height) / 2);
                    const lbPadLeft = Math.floor((lbMaxDim - width) / 2);
                    const lbPadBottom = lbMaxDim - height - lbPadTop;
                    const lbPadRight = lbMaxDim - width - lbPadLeft;
                    const lbScale = lbMaxDim / yoloInputSize; // original pixels per YOLO pixel

                    const { boxes, maxScores, maxIdxTensor, debugShape, numClasses } = tf.tidy(() => {
                        // 1. Convert to Tensor (Optimized for WebGL/WASM)
                        const imgTensor = tf.browser.fromPixels(bitmap) as tf.Tensor3D;

                        // 2. Letterbox-pad to square, then resize — preserves aspect ratio
                        const padded = tf.pad(imgTensor, [[lbPadTop, lbPadBottom], [lbPadLeft, lbPadRight], [0, 0]], 114);
                        const resized = tf.image.resizeBilinear(padded as tf.Tensor3D, [yoloInputSize, yoloInputSize]);
                        const input = resized.expandDims(0).div(255.0);

                        // 3. Execute model
                        let res = yoloModel!.execute(input);
                        if (Array.isArray(res)) res = res[0];
                        let tensor = res as tf.Tensor;
                        let shape = tensor.shape;

                        if (shape[1]! > shape[2]!) {
                            tensor = tensor.transpose([0, 2, 1]);
                            shape = tensor.shape;
                        }

                        const numRows = shape[1]!;
                        const numBoxes = shape[2]!;
                        const numClasses = numRows - 4;

                        const finalBoxes = tensor.slice([0, 0, 0], [1, 4, numBoxes]);
                        const finalScores = tensor.slice([0, 4, 0], [1, numClasses, numBoxes]);

                        // Skip class 0 (person) to prevent the user's face being mistaken for an ID card
                        const nonPersonScores = numClasses > 1
                            ? finalScores.slice([0, 1, 0], [1, numClasses - 1, numBoxes])
                            : finalScores;
                        const maxScores = nonPersonScores.max(1);
                        const maxIdxTensor = maxScores.argMax(1);

                        return { boxes: finalBoxes, maxScores, maxIdxTensor, debugShape: shape, numClasses };
                    });

                    const [boxesData, scoresData, idxData] = await Promise.all([
                        boxes.data(), maxScores.data(), maxIdxTensor.data()
                    ]);

                    tf.dispose([boxes, maxScores, maxIdxTensor]);

                    const maxIdx = idxData[0];
                    const score = scoresData[maxIdx];

                    if (score > 0.05) {
                        console.log(`[Worker] YOLO Best: Score=${score.toFixed(2)}, BoxIdx=${maxIdx}, Classes=${numClasses}`);
                    }

                    // Always recover coordinates when there's any signal. Even a low-confidence
                    // detection is useful for close-up frames where YOLO loses background context.
                    if (score > 0.03) {
                        // --- LETTERBOX-AWARE coordinate recovery ---
                        // Convert YOLO-space (0-640 or normalized 0-1) back to original frame coords
                        // using the letterbox scale and padding offsets.
                        const rawW = boxesData[debugShape[2]! * 2 + maxIdx];
                        const isNormalized = rawW <= 1.1;

                        let cx: number, cy: number, w: number, h: number;
                        if (isNormalized) {
                            cx = boxesData[maxIdx] * lbMaxDim - lbPadLeft;
                            cy = boxesData[debugShape[2]! + maxIdx] * lbMaxDim - lbPadTop;
                            w  = boxesData[debugShape[2]! * 2 + maxIdx] * lbMaxDim;
                            h  = boxesData[debugShape[2]! * 3 + maxIdx] * lbMaxDim;
                        } else {
                            cx = boxesData[maxIdx] * lbScale - lbPadLeft;
                            cy = boxesData[debugShape[2]! + maxIdx] * lbScale - lbPadTop;
                            w  = boxesData[debugShape[2]! * 2 + maxIdx] * lbScale;
                            h  = boxesData[debugShape[2]! * 3 + maxIdx] * lbScale;
                        }

                        // --- CLOSE-UP DETECTION ---
                        // When the card is close it fills the frame; YOLO loses background context
                        // and confidence drops well below YOLO_CONFIDENCE. Check the box size first
                        // and bypass the confidence gate so close-up captures still work.
                        const cardFillsFrame = w >= width * 0.65 || h >= height * 0.65;
                        let proceedToQualityCheck = false;

                        if (cardFillsFrame) {
                            const inset = Math.min(width, height) * 0.02;
                            const rawBox = { x: inset, y: inset, width: width - inset * 2, height: height - inset * 2 };
                            smoothedBoundingBox = applyEMA(smoothedBoundingBox, rawBox);
                            boundingBox = smoothedBoundingBox;
                            proceedToQualityCheck = true;
                        } else if (score > CONFIG.YOLO_CONFIDENCE) {
                            const adjW = w * CONFIG.ID_BOX_EXPAND_FACTOR;
                            const adjH = h * CONFIG.ID_BOX_EXPAND_FACTOR;

                            // Apply EMA smoothing to raw YOLO box before any quality checks
                            const rawBox = { x: cx - adjW / 2, y: cy - adjH / 2, width: adjW, height: adjH };
                            smoothedBoundingBox = applyEMA(smoothedBoundingBox, rawBox);
                            boundingBox = smoothedBoundingBox;

                            const ratio = w / h;
                            const isHorizontal = Math.abs(ratio - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE;
                            const isVertical = Math.abs(ratio - (1 / CONFIG.ID_ASPECT_RATIO)) < CONFIG.ID_ASPECT_TOLERANCE;
                            const distToCenter = Math.sqrt(Math.pow(cx - width / 2, 2) + Math.pow(cy - height / 2, 2));

                            if (!isHorizontal && !isVertical) {
                                feedback = "Align ID directly to the frame.";
                                captureTimer = Math.max(0, captureTimer - 2);
                            } else if (w < width * CONFIG.ID_MIN_WIDTH_RATIO) {
                                feedback = "Bring the ID closer to the camera.";
                                captureTimer = Math.max(0, captureTimer - 2);
                            } else if (distToCenter > width * CONFIG.ID_MAX_DIST_CENTER) {
                                feedback = "Center the ID in the frame.";
                                captureTimer = Math.max(0, captureTimer - 2);
                            } else {
                                proceedToQualityCheck = true;
                            }
                        } else {
                            // Low confidence and card is not close enough — no useful detection
                            captureTimer = Math.max(0, captureTimer - 1);
                            smoothedBoundingBox = null;
                        }

                        if (proceedToQualityCheck) {
                            if (cv && !isMobileDevice) {
                                // Skip heavy OpenCV processing on mobile - use YOLO box directly
                                // Extract ROI using dedicated roiCanvas to avoid thrashing offscreenCanvas dimensions
                                const rx = Math.max(0, Math.floor(boundingBox!.x - boundingBox!.width * 0.15));
                                const ry = Math.max(0, Math.floor(boundingBox!.y - boundingBox!.height * 0.15));
                                const rw = Math.min(width - rx, Math.floor(boundingBox!.width * 1.3));
                                const rh = Math.min(height - ry, Math.floor(boundingBox!.height * 1.3));

                                if (!roiCanvas || roiCanvas.width !== rw || roiCanvas.height !== rh) {
                                    roiCanvas = new OffscreenCanvas(rw, rh);
                                    roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });
                                }
                                roiCtx!.drawImage(bitmap, rx, ry, rw, rh, 0, 0, rw, rh);
                                const roiData = roiCtx!.getImageData(0, 0, rw, rh);

                                const cvResult = processIDCardOpenCV(roiData.data, rw, rh, { x: boundingBox!.x - rx, y: boundingBox!.y - ry, width: boundingBox!.width, height: boundingBox!.height });
                                if (cvResult && cvResult.isStable && cvResult.tightBox) {
                                    // Apply EMA to the refined OpenCV box as well
                                    const refined = {
                                        x: cvResult.tightBox.x + rx,
                                        y: cvResult.tightBox.y + ry,
                                        width: cvResult.tightBox.width,
                                        height: cvResult.tightBox.height
                                    };
                                    smoothedBoundingBox = applyEMA(smoothedBoundingBox, refined);
                                    boundingBox = smoothedBoundingBox;
                                }

                                const variance = getLaplacianVariance(roiData.data, rw, rh, { x: boundingBox!.x - rx, y: boundingBox!.y - ry, w: boundingBox!.width, h: boundingBox!.height });

                                let isStableBox = true;
                                if (previousBoundingBox) {
                                    const dx = Math.abs(boundingBox!.x - previousBoundingBox.x);
                                    const dy = Math.abs(boundingBox!.y - previousBoundingBox.y);
                                    if (dx > width * CONFIG.ID_STABILITY_TOLERANCE || dy > height * CONFIG.ID_STABILITY_TOLERANCE) {
                                        isStableBox = false;
                                    }
                                }
                                previousBoundingBox = { ...boundingBox! };

                                if (variance < CONFIG.ID_MIN_VARIANCE || !isStableBox) {
                                    feedback = !isStableBox ? "Hold ID still." : "ID is blurry. Hold steady.";
                                    isReady = false;
                                    // Soft decay — a single bad frame won't restart the full countdown
                                    captureTimer = Math.max(0, captureTimer - 2);
                                } else {
                                    feedback = "Perfect. Hold steady...";
                                    isReady = true;
                                    captureTimer++;
                                    if (captureTimer > CONFIG.ID_CAPTURE_FRAMES) {
                                        // Full-frame capture using the stable offscreenCanvas
                                        if (!offscreenCanvas || offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
                                            offscreenCanvas = new OffscreenCanvas(width, height);
                                            offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
                                        }
                                        offscreenCtx!.drawImage(bitmap, 0, 0);
                                        const fullFrameData = offscreenCtx!.getImageData(0, 0, width, height);
                                        capturedImage = await captureImage(fullFrameData.data, width, height, boundingBox!);
                                        captureTimer = 0;
                                    }
                                }
                            } else if (isMobileDevice) {
                                // Mobile: simplified quality check without OpenCV
                                // Get ImageData for variance check
                                if (!offscreenCanvas || offscreenCanvas.width !== width || offscreenCanvas.height !== height) {
                                    offscreenCanvas = new OffscreenCanvas(width, height);
                                    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
                                }
                                offscreenCtx!.drawImage(bitmap, 0, 0);
                                const fullFrameData = offscreenCtx!.getImageData(0, 0, width, height);
                                
                                const variance = getLaplacianVariance(fullFrameData.data, width, height, { 
                                    x: boundingBox!.x, 
                                    y: boundingBox!.y, 
                                    w: boundingBox!.width, 
                                    h: boundingBox!.height 
                                });

                                let isStableBox = true;
                                if (previousBoundingBox) {
                                    const dx = Math.abs(boundingBox!.x - previousBoundingBox.x);
                                    const dy = Math.abs(boundingBox!.y - previousBoundingBox.y);
                                    if (dx > width * CONFIG.ID_STABILITY_TOLERANCE || dy > height * CONFIG.ID_STABILITY_TOLERANCE) {
                                        isStableBox = false;
                                    }
                                }
                                previousBoundingBox = { ...boundingBox! };

                                if (variance < CONFIG.ID_MIN_VARIANCE * 0.7 || !isStableBox) {
                                    // Lower variance threshold for mobile
                                    feedback = !isStableBox ? "Hold ID still." : "ID is blurry. Hold steady.";
                                    isReady = false;
                                    captureTimer = Math.max(0, captureTimer - 2);
                                } else {
                                    feedback = "Perfect. Hold steady...";
                                    isReady = true;
                                    captureTimer++;
                                    if (captureTimer > CONFIG.ID_CAPTURE_FRAMES) {
                                        capturedImage = await captureImage(fullFrameData.data, width, height, boundingBox!);
                                        captureTimer = 0;
                                    }
                                }
                            } else {
                                // OpenCV not yet loaded — show status so the UI isn't silently frozen
                                feedback = "Optimizing detection...";
                                captureTimer = 0;
                            }
                        }
                    } else {
                        // No YOLO signal at all — decay timer
                        captureTimer = Math.max(0, captureTimer - 1);
                        smoothedBoundingBox = null;
                    }
                } catch (err) {
                    console.error("[Worker] YOLO Crash Intercepted: ", err);
                    feedback = "Analyzing ID...";
                }
            } else {
                // FALLBACK ID DETECTION (Using bitmap)
                const imageData = getImageData(bitmap, width, height);
                const frameData = imageData.data;
                let faceBox = null;
                if (faceLandmarker) {
                    try {
                        const results = faceLandmarker.detect(imageData);
                        if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                            const landmarks = results.faceLandmarks[0];
                            let minX = width, minY = height, maxX = 0, maxY = 0;
                            landmarks.forEach((l: { x: number; y: number }) => {
                                const x = l.x * width; const y = l.y * height;
                                if (x < minX) minX = x; if (x > maxX) maxX = x;
                                if (y < minY) minY = y; if (y > maxY) maxY = y;
                            });
                            const padX = (maxX - minX) * 0.25;
                            const padY = (maxY - minY) * 0.25;
                            faceBox = { x: minX - padX, y: minY - padY, w: (maxX - minX) + padX * 2, h: (maxY - minY) + padY * 2 };
                        }
                    } catch (e) {
                        console.error("[Worker] FaceLandmarker error during ID capture:", e);
                    }
                }

                const box = findIDCardBoundingBox(frameData, width, height, faceBox);

                if (!box) {
                    feedback = faceBox ? "Face detected. Please show only the ID card." : "Show your ID card to the camera.";
                    isReady = false;
                    captureTimer = 0;
                    boundingBox = null;
                    smoothedBoundingBox = null;
                } else {
                    boundingBox = box;
                    const ratio = box.width / box.height;
                    const isHorizontal = Math.abs(ratio - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE;
                    const isVertical = Math.abs(ratio - (1 / CONFIG.ID_ASPECT_RATIO)) < CONFIG.ID_ASPECT_TOLERANCE;

                    const isCutOff = box.x <= 0 || box.y <= 0 || (box.x + box.width) >= width || (box.y + box.height) >= height;

                    if (isCutOff && (box.width > width * 0.9 || box.height > height * 0.9)) {
                        feedback = "Center the ID in the frame.";
                        captureTimer = 0;
                        isReady = false;
                    } else if (!isHorizontal && !isVertical) {
                        feedback = "Align ID directly to the frame.";
                        captureTimer = 0;
                        isReady = false;
                    } else {
                        const variance = getLaplacianVariance(frameData, width, height, { x: box.x, y: box.y, w: box.width, h: box.height });

                        if (variance < CONFIG.MIN_GLOBAL_VARIANCE) {
                            feedback = "ID is blurry. Hold steady.";
                            isReady = false;
                            captureTimer = 0;
                        } else {
                            feedback = "Perfect. Hold steady...";
                            isReady = true;
                            captureTimer++;
                            if (captureTimer > CONFIG.ID_CAPTURE_FRAMES) {
                                capturedImage = await captureImage(frameData, width, height);
                                captureTimer = 0;
                            }
                        }
                    }
                }
            }

            const progress = isReady ? Math.min(1, captureTimer / CONFIG.ID_CAPTURE_FRAMES) : 0;
            self.postMessage({ type: 'FRAME_RESULT', stage, feedback: debounceFeedback(feedback), isReady, boundingBox, capturedImage, isMocking: false, progress });
        }

        else if (stage === KYCStage.FACE_CAPTURE) {
            const imageData = getImageData(bitmap, width, height);
            const frameData = imageData.data;
            let feedback = faceLandmarker ? "Center your face." : "Loading face detector...";
            let isReady = false;
            let capturedImage = null;
            let boundingBox = null;

            if (faceLandmarker) {
                try {
                    const results = faceLandmarker.detect(imageData);

                    if (results.faceLandmarks && results.faceLandmarks.length > 0) {
                        const landmarks = results.faceLandmarks[0];
                        let minX = width, minY = height, maxX = 0, maxY = 0;
                        landmarks.forEach((l: { x: number; y: number }) => {
                            const x = l.x * width; const y = l.y * height;
                            if (x < minX) minX = x; if (x > maxX) maxX = x;
                            if (y < minY) minY = y; if (y > maxY) maxY = y;
                        });
                        const padX = (maxX - minX) * 0.25;
                        const padY = (maxY - minY) * 0.25;
                        boundingBox = { x: minX - padX, y: minY - padY, width: (maxX - minX) + padX * 2, height: (maxY - minY) + padY * 2 };

                        const faceWidthRatio = boundingBox.width / width;
                        const faceCenterX = boundingBox.x + (boundingBox.width / 2);
                        const faceCenterY = boundingBox.y + (boundingBox.height / 2);
                        
                        // Use mobile-specific thresholds when on mobile devices
                        const minWidthRatio = isMobileDevice ? CONFIG.FACE_MIN_WIDTH_RATIO_MOBILE : CONFIG.FACE_MIN_WIDTH_RATIO;
                        const centerTolerance = isMobileDevice ? CONFIG.FACE_CENTER_TOLERANCE_MOBILE : CONFIG.FACE_CENTER_TOLERANCE;
                        const isCentered = Math.abs(faceCenterX - width / 2) < width * centerTolerance && Math.abs(faceCenterY - height / 2) < height * centerTolerance;

                        if (!isCentered) {
                            feedback = "Center your face in the frame.";
                            captureTimer = 0;
                        } else if (faceWidthRatio < minWidthRatio) {
                            feedback = isMobileDevice ? "Move closer to the camera." : "Move your phone closer.";
                            captureTimer = 0;
                        } else {
                            // 1. Eye Openness (EAR)
                            const lOuter = landmarks[33];
                            const lInner = landmarks[133];
                            const lTop = landmarks[159];
                            const lBottom = landmarks[145];
                            const lWidth = Math.hypot(lOuter.x - lInner.x, lOuter.y - lInner.y);
                            const lHeight = Math.hypot(lTop.x - lBottom.x, lTop.y - lBottom.y);
                            const earL = lHeight / lWidth;

                            const rInner = landmarks[362];
                            const rOuter = landmarks[263];
                            const rTop = landmarks[386];
                            const rBottom = landmarks[374];
                            const rWidth = Math.hypot(rOuter.x - rInner.x, rOuter.y - rInner.y);
                            const rHeight = Math.hypot(rTop.x - rBottom.x, rTop.y - rBottom.y);
                            const earR = rHeight / rWidth;

                            // 2. Gaze Direction
                            const lIris = landmarks[468];
                            const lEyeCenterX = (lOuter.x + lInner.x) / 2;
                            const lGazeOffset = Math.abs(lIris.x - lEyeCenterX) / lWidth;

                            const rIris = landmarks[473];
                            const rEyeCenterX = (rOuter.x + rInner.x) / 2;
                            const rGazeOffset = Math.abs(rIris.x - rEyeCenterX) / rWidth;

                            // 3. Head Pose Factor
                            let yaw = 0;
                            let pitch = 0;
                            if (results.facialTransformationMatrixes && results.facialTransformationMatrixes.length > 0) {
                                const matrix = results.facialTransformationMatrixes[0].data;
                                pitch = Math.atan2(matrix[6], matrix[10]);
                                yaw = Math.atan2(-matrix[2], Math.sqrt(matrix[6] * matrix[6] + matrix[10] * matrix[10]));
                            }

                            console.log(`[Face Liveness] EAR (L:${earL.toFixed(2)}, R:${earR.toFixed(2)}) | Gaze: (L:${lGazeOffset.toFixed(2)}, R:${rGazeOffset.toFixed(2)}) | Pose: (Y:${yaw.toFixed(2)}, P:${pitch.toFixed(2)})`);

                            if (earL < CONFIG.FACE_MIN_EAR || earR < CONFIG.FACE_MIN_EAR) {
                                feedback = "Keep your eyes open.";
                                captureTimer = 0;
                            } else if (lGazeOffset > CONFIG.FACE_MAX_GAZE_OFFSET || rGazeOffset > CONFIG.FACE_MAX_GAZE_OFFSET) {
                                feedback = "Look directly at the camera.";
                                captureTimer = 0;
                            } else if (Math.abs(yaw) > CONFIG.FACE_MAX_POSE_ANGLE || Math.abs(pitch) > CONFIG.FACE_MAX_POSE_ANGLE) {
                                feedback = "Face the camera directly.";
                                captureTimer = 0;
                            } else {
                                const variance = getLaplacianVariance(frameData, width, height, { x: boundingBox.x, y: boundingBox.y, w: boundingBox.width, h: boundingBox.height });
                                if (variance < CONFIG.FACE_MIN_VARIANCE) {
                                    feedback = "Face is blurry. Hold still.";
                                    captureTimer = 0;
                                    isReady = false;
                                } else {
                                    feedback = "Face clear. Hold still...";
                                    isReady = true;
                                    captureTimer++;
                                    if (captureTimer > CONFIG.FACE_CAPTURE_FRAMES) { // 500ms at 30fps
                                        capturedImage = await captureImage(frameData, width, height);
                                        captureTimer = 0;
                                    }
                                }
                            }
                        }
                    } else {
                        captureTimer = 0;
                        feedback = "Center your face.";
                    }
                } catch (err) {
                    console.error("[Worker] FaceLandmarker error:", err);
                    feedback = "Analyzing face...";
                }
            }
            const progress = isReady ? Math.min(1, captureTimer / CONFIG.FACE_CAPTURE_FRAMES) : 0;
            self.postMessage({ type: 'FRAME_RESULT', stage, feedback, isReady, boundingBox, capturedImage, progress });
        }
    } finally {
        if (bitmap) bitmap.close();
    }
};
