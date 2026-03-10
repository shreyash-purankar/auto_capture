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
let forceNextCapture = false;

// --- CONFIGURATION CONSTANTS ---
const CONFIG = {
    // Pre-Flight Checks
    MIN_BRIGHTNESS: 60,       // Minimum average pixel intensity (0-255)
    MAX_BRIGHTNESS: 240,      // Maximum average pixel intensity (0-255)
    MIN_GLOBAL_VARIANCE: 80,  // Minimum Laplacian variance for the entire frame (blur check)

    // ID Capture (YOLO & OpenCV)
    YOLO_CONFIDENCE: 0.40,    // Minimum confidence score for YOLO ID detection (lowered for faster detection)
    ID_MIN_WIDTH_RATIO: 0.45, // ID must take up at least 45% of the frame width (forces user to move closer)
    ID_MAX_DIST_CENTER: 0.4,  // Maximum distance from center (as a ratio of frame width)
    ID_ASPECT_RATIO: 1.58,    // Standard ID card aspect ratio (width/height)
    ID_ASPECT_TOLERANCE: 0.25, // Tolerance for aspect ratio matching (reduced to prevent square detection)
    ID_BOX_EXPAND_FACTOR: 0.98, // Multiplier to slightly reduce YOLO bounding box size
    ID_OPENCV_PADDING: 0.00,  // Padding added to OpenCV tight bounding box (0 = no padding)
    ID_MIN_VARIANCE: 120,     // Minimum Laplacian variance for the ID crop (lowered slightly for faster capture)
    ID_STABILITY_TOLERANCE: 0.08, // Maximum allowed movement between frames (ratio of frame dimensions)
    ID_CAPTURE_FRAMES: 5,     // Number of consecutive stable frames required to auto-capture (reduced for faster capture)

    // Face Capture (MediaPipe)
    FACE_MIN_WIDTH_RATIO: 0.10, // Face must take up at least 10% of the frame width
    FACE_CENTER_TOLERANCE: 0.25, // Face must be within 25% of the center
    FACE_MIN_EAR: 0.2,        // Minimum Eye Aspect Ratio (openness)
    FACE_MAX_GAZE_OFFSET: 0.1, // Maximum gaze offset from center
    FACE_MAX_POSE_ANGLE: 0.2, // Maximum head pose angle (yaw/pitch in radians)
    FACE_MIN_VARIANCE: 180,   // Minimum Laplacian variance for the face crop
    FACE_CAPTURE_FRAMES: 15,  // Number of consecutive stable frames required to auto-capture
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

async function initModels() {
    console.log("[Worker] Initializing models...");
    try {
        try {
            await tf.setBackend('webgl');
            await tf.ready();
            console.log("[Worker] TFJS Backend: webgl initialized (Tier 1 GPU)");
        } catch (e) {
            console.warn("[Worker] WebGL failed, falling back to WASM:", e);
            try {
                await tf.setBackend('wasm');
                await tf.ready();
                console.log("[Worker] TFJS Backend: wasm initialized (Tier 2 CPU)");
            } catch (wasmErr) {
                console.error("[Worker] WASM failed:", wasmErr);
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
initModels();

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

async function captureImage(frameData: Uint8ClampedArray, width: number, height: number, box?: { x: number, y: number, width: number, height: number }): Promise<string> {
    let cropX = 0, cropY = 0, cropW = width, cropH = height;
    if (box) {
        cropX = Math.max(0, Math.floor(box.x));
        cropY = Math.max(0, Math.floor(box.y));
        cropW = Math.min(width - cropX, Math.floor(box.width));
        cropH = Math.min(height - cropY, Math.floor(box.height));
    }
    console.log(`[Worker] Capturing high-res WebP image (${cropW}x${cropH})...`);

    const canvas = new OffscreenCanvas(cropW, cropH);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const tempCanvas = new OffscreenCanvas(width, height);
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return '';
    tempCtx.putImageData(new ImageData(new Uint8ClampedArray(frameData), width, height), 0, 0);

    ctx.drawImage(tempCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 1.0 });
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            console.log("[Worker] Capture successful, size:", Math.round((blob.size / 1024)) + "KB");
            resolve(reader.result as string);
        };
        reader.readAsDataURL(blob);
    });
}

async function captureWarpedImage(imageData: ImageData): Promise<string> {
    const canvas = new OffscreenCanvas(imageData.width, imageData.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.putImageData(imageData, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 1.0 });
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
    });
}

function processIDCardOpenCV(frameData: Uint8ClampedArray, width: number, height: number, yoloBox: any) {
    if (!cv) return null;

    let src: any = null;
    let roi: any = null;
    let gray: any = null;
    let blurred: any = null;
    let edges: any = null;
    let contours: any = null;
    let hierarchy: any = null;
    let warped: any = null;

    try {
        src = cv.matFromImageData(new ImageData(new Uint8ClampedArray(frameData), width, height));

        // 1. Calculate ROI with 15% padding
        const padX = yoloBox.width * 0.15;
        const padY = yoloBox.height * 0.15;

        const rx = Math.max(0, Math.floor(yoloBox.x - padX));
        const ry = Math.max(0, Math.floor(yoloBox.y - padY));
        const rw = Math.min(width - rx, Math.floor(yoloBox.width + padX * 2));
        const rh = Math.min(height - ry, Math.floor(yoloBox.height + padY * 2));

        const rect = new cv.Rect(rx, ry, rw, rh);
        roi = src.roi(rect);

        // 2. Preprocess
        gray = new cv.Mat();
        cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);

        blurred = new cv.Mat();
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

        edges = new cv.Mat();
        cv.Canny(blurred, edges, 75, 200);

        // 3. Find Contours
        contours = new cv.MatVector();
        hierarchy = new cv.Mat();
        cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

        // 4. Find the largest 4-point contour (using convex hull to ignore fingers)
        let maxArea = 0;
        let bestApprox = new cv.Mat();
        let found = false;

        for (let i = 0; i < contours.size(); ++i) {
            const cnt = contours.get(i);
            const area = cv.contourArea(cnt);
            if (area > maxArea && area > (rw * rh * 0.2)) { // At least 20% of ROI
                const hull = new cv.Mat();
                cv.convexHull(cnt, hull, false, true); // Wrap around fingers

                const peri = cv.arcLength(hull, true);
                const approx = new cv.Mat();
                cv.approxPolyDP(hull, approx, 0.04 * peri, true); // Increased epsilon to 0.04 for robustness

                if (approx.rows === 4) {
                    maxArea = area;
                    if (found) bestApprox.delete();
                    bestApprox = approx;
                    found = true;
                } else {
                    approx.delete();
                }
                hull.delete();
            }
            cnt.delete();
        }

        if (found) {
            // We have 4 corners!
            const pts = [];
            for (let i = 0; i < 4; i++) {
                pts.push({ x: bestApprox.data32S[i * 2], y: bestApprox.data32S[i * 2 + 1] });
            }

            // Sort by sum (TL has smallest sum, BR has largest sum)
            pts.sort((a, b) => (a.x + a.y) - (b.x + b.y));
            const tl = pts[0];
            const br = pts[3];

            // Sort remaining two by difference (TR has smallest diff, BL has largest diff)
            const rem = [pts[1], pts[2]];
            rem.sort((a, b) => (a.y - a.x) - (b.y - b.x));
            const tr = rem[0];
            const bl = rem[1];

            const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
            const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
            const maxWidth = Math.max(widthA, widthB);

            const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
            const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);
            const maxHeight = Math.max(heightA, heightB);

            const ratio = maxWidth / maxHeight;
            const isHorizontal = Math.abs(ratio - 1.58) < 0.3;
            const isVertical = Math.abs((1 / ratio) - 1.58) < 0.3;

            if (isHorizontal || isVertical) {
                const finalW = isHorizontal ? 856 : 540;
                const finalH = isHorizontal ? 540 : 856;

                const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
                const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, finalW, 0, finalW, finalH, 0, finalH]);

                const M = cv.getPerspectiveTransform(srcTri, dstTri);
                warped = new cv.Mat();
                const dsize = new cv.Size(finalW, finalH);
                cv.warpPerspective(roi, warped, M, dsize, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar());

                const imgData = new ImageData(new Uint8ClampedArray(warped.data), finalW, finalH);

                const minX = Math.min(tl.x, tr.x, bl.x, br.x) + rx;
                const minY = Math.min(tl.y, tr.y, bl.y, br.y) + ry;
                const maxX = Math.max(tl.x, tr.x, bl.x, br.x) + rx;
                const maxY = Math.max(tl.y, tr.y, bl.y, br.y) + ry;

                // Add configured padding to ensure it's strictly around the outer edges
                const padW = (maxX - minX) * CONFIG.ID_OPENCV_PADDING;
                const padH = (maxY - minY) * CONFIG.ID_OPENCV_PADDING;

                const tightBox = {
                    x: minX - padW,
                    y: minY - padH,
                    width: (maxX - minX) + padW * 2,
                    height: (maxY - minY) + padH * 2
                };

                srcTri.delete(); dstTri.delete(); M.delete(); bestApprox.delete();

                return { imgData, isStable: true, tightBox };
            }
            bestApprox.delete();
        }

        return { imgData: null, isStable: false };

    } catch (err) {
        console.error("[Worker] OpenCV Processing Error:", err);
        return { imgData: null, isStable: false };
    } finally {
        if (src) src.delete();
        if (roi) roi.delete();
        if (gray) gray.delete();
        if (blurred) blurred.delete();
        if (edges) edges.delete();
        if (contours) contours.delete();
        if (hierarchy) hierarchy.delete();
        if (warped) warped.delete();
    }
}

self.onmessage = async (e: MessageEvent) => {
    if (e.data.type === 'FORCE_CAPTURE') {
        forceNextCapture = true;
        return;
    }
    const { frameData, width, height, stage } = e.data;

    if (stage === KYCStage.PRE_FLIGHT) {
        let brightnessSum = 0;
        let pixelCount = 0;

        // Calculate true relative luminance (Grayscale)
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
            console.log(`[Pre-Flight] Failed: Too dark (${Math.round(meanBrightness)})`);
            return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Too dark. Move to a well-lit area.", isReady: false });
        }
        if (meanBrightness > CONFIG.MAX_BRIGHTNESS) {
            console.log(`[Pre-Flight] Failed: Too bright (${Math.round(meanBrightness)})`);
            return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Too bright. Avoid direct glare.", isReady: false });
        }

        const variance = getLaplacianVariance(frameData, width, height);
        if (variance < CONFIG.MIN_GLOBAL_VARIANCE) {
            console.log(`[Pre-Flight] Failed: Blurry lens (Variance: ${Math.round(variance)})`);
            return self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Camera blurry. Clean your lens.", isReady: false });
        }

        console.log(`[Pre-Flight] Passed. Brightness: ${Math.round(meanBrightness)}, Variance: ${Math.round(variance)}`);
        self.postMessage({ type: 'FRAME_RESULT', stage, feedback: "Environment optimal.", isReady: true });
    }

    else if (stage === KYCStage.ID_CAPTURE) {
        let boundingBox = null;
        let feedback = yoloModel ? "Show your ID card to the camera." : "Simulating ID detector...";
        let isReady = false;
        let capturedImage = null;

        if (yoloModel) {
            try {
                const { boxes, maxScores, maxIdxTensor, debugShape } = tf.tidy(() => {
                    // 1. Convert incoming buffer to Tensor
                    const pixels = new Uint8Array(frameData);
                    const imgTensor = tf.tensor3d(pixels, [height, width, 4], 'int32');

                    // 2. Preprocess for YOLO
                    const rgb = imgTensor.slice([0, 0, 0], [-1, -1, 3]) as tf.Tensor3D;
                    const resized = tf.image.resizeBilinear(rgb, [640, 640]);
                    const input = resized.expandDims(0).div(255.0);

                    // 3. Execute model
                    let res = yoloModel!.execute(input);

                    // If model returns an array of outputs, take the first one
                    if (Array.isArray(res)) res = res[0];
                    let tensor = res as tf.Tensor;
                    let shape = tensor.shape;

                    let finalBoxes, finalScores;

                    // 4. Handle dynamic tensor shapes (Transposing if necessary)
                    // Some models export[1, 84, 8400], others [1, 8400, 84]
                    if (shape[1]! > shape[2]!) {
                        tensor = tensor.transpose([0, 2, 1]); // Convert [1, 8400, 84] to[1, 84, 8400]
                        shape = tensor.shape;
                    }

                    const numRows = shape[1]!;
                    const numBoxes = shape[2]!;
                    const numClasses = numRows - 4;

                    // 5. Slice coordinates and scores safely
                    finalBoxes = tensor.slice([0, 0, 0], [1, 4, numBoxes]);
                    finalScores = tensor.slice([0, 4, 0], [1, numClasses, numBoxes]);

                    // Ignore class 0 (person) to prevent detecting the user's face as an ID card
                    const nonPersonScores = finalScores.slice([0, 1, 0], [1, numClasses - 1, numBoxes]);
                    const maxScores = nonPersonScores.max(1);
                    const maxIdxTensor = maxScores.argMax(1);

                    return { boxes: finalBoxes, maxScores, maxIdxTensor, debugShape: shape };
                });

                // Pull data back to Javascript synchronously
                const [boxesData, scoresData, idxData] = await Promise.all([
                    boxes.data(), maxScores.data(), maxIdxTensor.data()
                ]);

                // Free GPU memory manually for safety
                tf.dispose([boxes, maxScores, maxIdxTensor]);

                const maxIdx = idxData[0];
                const score = scoresData[maxIdx];

                // Debug print (1 in 30 frames to avoid console flood)
                if (Math.random() < 0.03) {
                    console.log(`[Worker - YOLO] Tensor Shape: [${debugShape}] | Max Conf: ${(score * 100).toFixed(1)}%`);
                }

                if (score > CONFIG.YOLO_CONFIDENCE) {
                    const cx = (boxesData[maxIdx] / 640) * width;
                    const cy = (boxesData[debugShape[2]! + maxIdx] / 640) * height;
                    const w = (boxesData[debugShape[2]! * 2 + maxIdx] / 640) * width;
                    const h = (boxesData[debugShape[2]! * 3 + maxIdx] / 640) * height;

                    // Adjust the bounding box size based on configuration
                    const expandFactor = CONFIG.ID_BOX_EXPAND_FACTOR;
                    const adjW = w * expandFactor;
                    const adjH = h * expandFactor;

                    boundingBox = { x: cx - adjW / 2, y: cy - adjH / 2, width: adjW, height: adjH };

                    const ratio = w / h;
                    const isHorizontal = Math.abs(ratio - CONFIG.ID_ASPECT_RATIO) < CONFIG.ID_ASPECT_TOLERANCE;
                    const isVertical = Math.abs(ratio - (1 / CONFIG.ID_ASPECT_RATIO)) < CONFIG.ID_ASPECT_TOLERANCE;
                    const distToCenter = Math.sqrt(Math.pow(cx - width / 2, 2) + Math.pow(cy - height / 2, 2));

                    if (!isHorizontal && !isVertical) {
                        feedback = "Align ID directly to the frame.";
                        captureTimer = 0;
                    } else if (distToCenter > width * CONFIG.ID_MAX_DIST_CENTER || w < width * CONFIG.ID_MIN_WIDTH_RATIO) {
                        feedback = "Center and bring the ID closer.";
                        captureTimer = 0;
                    } else {
                        let warpedImageData = null;
                        if (cv) {
                            const cvResult = processIDCardOpenCV(frameData, width, height, boundingBox);
                            if (cvResult && cvResult.isStable) {
                                warpedImageData = cvResult.imgData;
                                if (cvResult.tightBox) {
                                    boundingBox = cvResult.tightBox; // Snap bounding box strictly to OpenCV contour
                                }
                            }
                        }

                        if (warpedImageData) {
                            // Even with OpenCV, we must verify the crop isn't blurry
                            const variance = getLaplacianVariance(frameData, width, height, { x: boundingBox.x, y: boundingBox.y, w: boundingBox.width, h: boundingBox.height });

                            // Check bounding box stability
                            let isStableBox = true;
                            if (previousBoundingBox) {
                                const dx = Math.abs(boundingBox.x - previousBoundingBox.x);
                                const dy = Math.abs(boundingBox.y - previousBoundingBox.y);
                                const dw = Math.abs(boundingBox.width - previousBoundingBox.width);
                                const dh = Math.abs(boundingBox.height - previousBoundingBox.height);
                                if (dx > width * CONFIG.ID_STABILITY_TOLERANCE || dy > height * CONFIG.ID_STABILITY_TOLERANCE || dw > width * CONFIG.ID_STABILITY_TOLERANCE || dh > height * CONFIG.ID_STABILITY_TOLERANCE) {
                                    isStableBox = false;
                                }
                            }
                            previousBoundingBox = boundingBox;

                            if (variance < CONFIG.ID_MIN_VARIANCE || !isStableBox) { // Very strict blur check + stability check
                                feedback = !isStableBox ? "Hold ID still." : "ID is blurry. Hold steady.";
                                isReady = false;
                                captureTimer = 0;
                            } else {
                                feedback = "Perfect. Hold steady...";
                                isReady = true;
                                captureTimer++;
                                if (captureTimer > CONFIG.ID_CAPTURE_FRAMES) { // Increased to 10 frames for absolute stability
                                    capturedImage = await captureWarpedImage(warpedImageData);
                                    captureTimer = 0;
                                }
                            }
                        } else {
                            // Fallback to Laplacian variance if OpenCV fails to find perfect corners
                            const variance = getLaplacianVariance(frameData, width, height, { x: boundingBox.x, y: boundingBox.y, w: boundingBox.width, h: boundingBox.height });

                            // Check bounding box stability
                            let isStableBox = true;
                            if (previousBoundingBox) {
                                const dx = Math.abs(boundingBox.x - previousBoundingBox.x);
                                const dy = Math.abs(boundingBox.y - previousBoundingBox.y);
                                const dw = Math.abs(boundingBox.width - previousBoundingBox.width);
                                const dh = Math.abs(boundingBox.height - previousBoundingBox.height);
                                if (dx > width * CONFIG.ID_STABILITY_TOLERANCE || dy > height * CONFIG.ID_STABILITY_TOLERANCE || dw > width * CONFIG.ID_STABILITY_TOLERANCE || dh > height * CONFIG.ID_STABILITY_TOLERANCE) {
                                    isStableBox = false;
                                }
                            }
                            previousBoundingBox = boundingBox;

                            if (variance < CONFIG.ID_MIN_VARIANCE || !isStableBox) { // Very strict blur check + stability check
                                feedback = !isStableBox ? "Hold ID still." : "ID is blurry. Hold steady.";
                                isReady = false;
                                captureTimer = 0;
                            } else {
                                feedback = "Perfect. Hold steady...";
                                isReady = true;
                                captureTimer++;
                                if (captureTimer > CONFIG.ID_CAPTURE_FRAMES) { // Increased to 10 frames
                                    capturedImage = await captureImage(frameData, width, height, boundingBox);
                                    captureTimer = 0;
                                }
                            }
                        }
                    }
                } else {
                    captureTimer = 0;
                }
            } catch (err) {
                console.error("[Worker] YOLO Crash Intercepted: ", err);
                feedback = "Analyzing ID...";
            }
        } else {
            // FALLBACK ID DETECTION
            let faceBox = null;
            if (faceLandmarker) {
                try {
                    const imageDataArray = frameData instanceof Uint8ClampedArray ? frameData : new Uint8ClampedArray(frameData);
                    const imageData = new ImageData(imageDataArray, width, height);
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
                if (faceBox) {
                    feedback = "Face detected. Please show only the ID card.";
                } else {
                    feedback = "Show your ID card to the camera.";
                }
                isReady = false;
                captureTimer = 0;
                boundingBox = null;
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

            const progress = isReady ? Math.min(1, captureTimer / CONFIG.ID_CAPTURE_FRAMES) : 0;
            self.postMessage({ type: 'FRAME_RESULT', stage, feedback, isReady, boundingBox, capturedImage, isMocking: false, progress });
            return;
        }

        // Always post back to release the Main Thread lock!
        const progress = isReady ? Math.min(1, captureTimer / CONFIG.ID_CAPTURE_FRAMES) : 0;
        self.postMessage({ type: 'FRAME_RESULT', stage, feedback, isReady, boundingBox, capturedImage, isMocking: false, progress });
    }

    else if (stage === KYCStage.FACE_CAPTURE) {
        let feedback = faceLandmarker ? "Center your face." : "Loading face detector...";
        let isReady = false;
        let capturedImage = null;
        let boundingBox = null;

        if (faceLandmarker) {
            try {
                const imageDataArray = frameData instanceof Uint8ClampedArray ? frameData : new Uint8ClampedArray(frameData);
                const imageData = new ImageData(imageDataArray, width, height);
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
                    const isCentered = Math.abs(faceCenterX - width / 2) < width * CONFIG.FACE_CENTER_TOLERANCE && Math.abs(faceCenterY - height / 2) < height * CONFIG.FACE_CENTER_TOLERANCE;

                    if (!isCentered) {
                        feedback = "Center your face in the frame.";
                        captureTimer = 0;
                    } else if (faceWidthRatio < CONFIG.FACE_MIN_WIDTH_RATIO) {
                        feedback = "Move your phone closer.";
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
};
