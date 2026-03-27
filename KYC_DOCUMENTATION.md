# KYC Automated Capture System - Technical Documentation

This document explains the complete architecture, workflow, and tunable parameters of the KYC (Know Your Customer) automated capture system.

## 1. Architecture Overview

The application is built using a **Main Thread (React UI)** and a **Background Thread (Web Worker)**. 
This separation ensures that the heavy Machine Learning models do not freeze the camera feed or the user interface.

*   **UI Layer (`src/components/KYCScanner.tsx`)**: Handles the webcam stream, draws the bounding boxes, displays feedback text, and manages the overall state (Pre-flight -> ID -> Face -> Success).
*   **ML Engine (`src/workers/kyc_worker.ts`)**: Receives frame data from the UI, runs the AI models, calculates math/geometry, and sends back bounding boxes, feedback, and final captured images.

## 2. Technology Stack

*   **YOLOv11-Nano (TensorFlow.js)**: Used for coarse ID card detection with letterbox padding to preserve aspect ratio.
*   **OpenCV.js (WASM)**: Used for high-precision edge detection, contour finding, and perspective warping (flattening the ID card), along with HoughLinesP for edge reconstruction. Skipped on mobile and low-end devices.
*   **MediaPipe Face Landmarker**: Used for sub-millisecond face detection, localization, and liveness checks (Eye Openness, Gaze Direction, Head Pose).

## 3. Device-Specific Optimization

The system detects and optimizes for three device tiers:
- **High-End Desktop**: Full YOLO (640×640) + OpenCV + all quality checks
- **Low-End Laptop**: YOLO (640×640) + frame skipping + relaxed quality checks (no OpenCV)
- **Mobile**: Simplified detection (no YOLO, uses fallback edge detection)

---

## 4. Configuration Variables & Tuning Guide

All critical thresholds and parameters are centralized in the `CONFIG` object at the top of `src/workers/kyc_worker.ts`. Modifying these values will directly impact how strict or fast the auto-capture system behaves.

### Pre-Flight Checks (Health Sensors)
Before any ML runs, the system checks if the environment is suitable.

*   **`MIN_BRIGHTNESS` (Default: 60)**: The minimum average pixel intensity (0-255).
    *   *Increase*: Requires a brighter room to start the process.
    *   *Decrease*: Allows capture in darker environments (may reduce OCR accuracy).
*   **`MAX_BRIGHTNESS` (Default: 240)**: The maximum average pixel intensity.
    *   *Increase*: Allows capture under very harsh lighting or glare.
    *   *Decrease*: Stricter against over-exposed environments.
*   **`MIN_GLOBAL_VARIANCE` (Default: 15)**: The minimum Laplacian variance for the entire frame.
    *   *Increase*: Requires a much sharper, cleaner camera lens to proceed.
    *   *Decrease*: Allows capture even if the camera lens is slightly smudged (lowered for faster pre-flight→ID transition).

### Stage 1: ID Card Capture - Model Configuration

*   **`YOLO_SIZE` (Default: 640)**: Input size for YOLO model on desktop (FIXED - model requires 640×640).
*   **`YOLO_SIZE_MOBILE` (Default: 320)**: Input size for YOLO on mobile (not used when YOLO absent).
*   **`YOLO_CONFIDENCE` (Default: 0.15)**: Minimum confidence score for YOLO ID detection.
    *   *Increase*: Stricter detection; better ignores background noise but may miss IDs in poor lighting.
    *   *Decrease*: Faster detection, but may falsely identify rectangles as ID cards.
    *   *Note*: Kept low (0.15) to catch close-up shots where YOLO loses background context.

### Stage 1: ID Card Capture - Position & Size Checks

*   **`ID_MIN_WIDTH_RATIO` (Default: 0.38)**: ID must take up at least 38% of frame width (desktop).
    *   *Increase*: Requires bringing the ID much closer (better OCR resolution).
    *   *Decrease*: Allows capturing from further away.
*   **`ID_MIN_WIDTH_RATIO_MOBILE` (Default: 0.42)**: ID must take up at least 42% of frame width (mobile fallback).
*   **`ID_MAX_DIST_CENTER` (Default: 0.95)**: Maximum normalized distance from center (0.95 = 95% frame width).
    *   *Decrease*: Forces stricter centering.
*   **`ID_ASPECT_RATIO` (Default: 1.58)**: Standard ID card aspect ratio (width/height).
*   **`ID_ASPECT_TOLERANCE` (Default: 0.40)**: Tolerance for aspect ratio matching (high-end desktop).
    *   *Increase*: Allows more tilted/skewed cards.
    *   *Decrease*: Stricter rectangle requirement.
*   **`ID_ASPECT_TOLERANCE_MOBILE` (Default: 0.30)**: Stricter tolerance for mobile (less deformation tolerated).

### Stage 1: ID Card Capture - Quality Checks

*   **`ID_BOX_EXPAND_FACTOR` (Default: 1.10)**: Expands YOLO box by 10% so OpenCV sees full card edges.
*   **`ID_MIN_VARIANCE` (Default: 90)**: Minimum Laplacian variance for sharp ID detection (high-end desktop).
    *   *Increase*: Requires perfectly sharp card.
    *   *Decrease*: Faster capture but may blur.
*   **`ID_MIN_VARIANCE_MOBILE` (Default: 45)**: Lower variance threshold for mobile (45 is more forgiving).
*   **`ID_MIN_TEXTURE_VARIANCE` (Default: 300)**: Minimum texture variance inside ID region (cards have text/images).
    *   *Increase*: Require more visible card details.
    *   *Decrease*: Tolerate blank or reflective cards.
*   **`ID_MIN_EDGE_DENSITY` (Default: 0.015)**: Minimum edge pixel ratio (1.5% of pixels should be edges).
    *   *Increase*: Require more defined card edges.
    *   *Decrease*: Tolerate softer edge definition.

### Stage 1: ID Card Capture - Stability & Capture

*   **`ID_STABILITY_TOLERANCE` (Default: 0.12)**: Maximum allowed movement between frames (desktop - tight).
    *   *Decrease*: Require card to be held perfectly still.
    *   *Increase*: Tolerate slight hand movement.
*   **`ID_STABILITY_TOLERANCE_MOBILE` (Default: 0.25)**: Maximum movement on mobile (more forgiving due to frame skipping).
*   **`ID_CAPTURE_FRAMES` (Default: 15)**: Consecutive stable frames required to auto-capture.
    *   *Increase*: Slower capture, guarantees stability.
    *   *Decrease*: Faster capture, risks motion blur.
*   **`ID_HYSTERESIS_THRESHOLD` (Default: 8)**: Frame count threshold for entering "hysteresis zone" (mobile only).
    *   Once > 8 frames stable, forgive temporary failures (variance dips, slight movement) to prevent ready-state flickering.

### Stage 2: Face Capture - Position & Size

*   **`FACE_MIN_WIDTH_RATIO` (Default: 0.25)**: Face must take up at least 25% of frame width (desktop).
    *   *Increase*: Require face closer to camera.
*   **`FACE_MIN_WIDTH_RATIO_MOBILE` (Default: 0.10)**: More relaxed for mobile (0.10 - helps detect on low-end cameras).
*   **`FACE_CENTER_TOLERANCE` (Default: 0.25)**: Face must be within 25% of center on all devices.

### Stage 2: Face Capture - Liveness Checks

*   **`FACE_MIN_EAR` (Default: 0.15)**: Minimum Eye Aspect Ratio (openness).
    *   *Increase*: Require eyes very wide open.
    *   *Decrease*: More forgiving for narrow/squinting eyes.
*   **`FACE_MAX_GAZE_OFFSET` (Default: 0.125)**: Maximum gaze offset from iris center.
    *   *Decrease*: Require looking dead-center at camera.
    *   *Increase*: Tolerate slight eye deviation.
*   **`FACE_MAX_POSE_ANGLE` (Default: 0.25)**: Maximum head yaw/pitch angle in radians (~14 degrees).
    *   *Decrease*: Require face perfectly straight.
    *   *Increase*: Tolerate more head tilt.
*   **`FACE_MIN_VARIANCE` (Default: 20)**: Minimum Laplacian variance for face crop (sharpness).
*   **`FACE_CAPTURE_FRAMES` (Default: 20)**: Consecutive frames needed for face auto-capture.

### Performance & Frame Skipping

*   **`MAX_PROCESSING_MS` (Default: 150)**: Target max frame processing time before adaptive frame skipping.
    *   *Decrease*: Trigger skipping sooner (more aggressive).
    *   *Increase*: Tolerate slower processing before skipping.

---

## 5. Advanced Features

### Letterbox Padding (YOLO)
To avoid distorting the ID card aspect ratio when resizing to 640×640, the system:
1. Calculates the larger dimension (width or height)
2. Pads the frame equally on all sides to make it square
3. Resizes the square to 640×640 (no distortion)
4. Converts coordinates back using scale/padding offsets

### Close-Up Detection
When ID card fills 80%+ of frame, YOLO loses background context and confidence drops. The system:
- Bypasses the confidence threshold check when card is close
- Uses bounding box size directly if coverage is high
- Ensures captures work at comfortable viewing distance

### Hysteresis Zone (Mobile)
Once mobile reaches 8+ stable frames, the system enters a "hysteresis zone":
- Temporary quality failures don't decrement timer
- UI stays green even on occasional variance dips
- Prevents flickering between "ready" and "not ready" states
- Improves perceived stability on slower devices

### Exponential Moving Average (EMA)
Bounding boxes are smoothed between frames using:
- **Desktop**: alpha = 0.35 (faster tracking)
- **Mobile**: alpha = 0.25 (gentler, smoother transitions)

Prevents jitter and creates smooth visual animations.

---

## 6. Security & Memory
*   **Image Quality**: WebP format at 100% quality. Maintains OCR-readable clarity while providing good compression.
*   **Memory**: Images passed as `ImageData` and `Blob` objects. Never written to `localStorage`.
*   **Anti-Spoofing**: 
    - Laplacian variance check detects screen replay (moire patterns have low variance)
    - Eye Aspect Ratio (EAR) ensures eyes are naturally open
    - Gaze direction check prevents fixed-eye photos
    - Head pose angle check prevents static face images
    - Combined liveness checks ensure genuine human capture

---

## 7. Frame Skipping & Device Optimization

### Why Frame Skipping?
YOLO model has fixed 640×640 input (cannot reduce resolution). On low-end devices, each frame takes 180-250ms:
- Worker processes 4-5 FPS but camera sends 30 FPS
- Frame queue builds up → UI lag and stuttering
- **Solution**: Skip frames intelligently to reduce worker load by 50-67%

### How It Works
1. Measure frame processing time on low-end/mobile devices
2. If avg > 150ms: enable 1/2 frame skip (process every 2nd frame)
3. If avg > 225ms: enable 1/3 frame skip (process every 3rd frame)
4. If avg < 105ms: disable skipping (device caught up)
5. Continuous re-evaluation maintains optimal balance

### Impact
- Frame processing still ~180-250ms (YOLO limitation)
- Effective frame rate becomes 3-10 FPS (no lag)
- Detection quality maintained through EMA smoothing
- ID detection works in 3-5 seconds (same as non-skipping devices)

---

## 8. Tuning for Different Scenarios

### For Faster ID Capture
```typescript
MIN_GLOBAL_VARIANCE: 10,     // Faster pre-flight transition
ID_MIN_VARIANCE: 70,          // Relaxed sharpness
ID_CAPTURE_FRAMES: 10,        // Fewer frames to capture
ID_HYSTERESIS_THRESHOLD: 5,   // Earlier hysteresis entry
```

### For Stricter Quality
```typescript
MIN_GLOBAL_VARIANCE: 25,      // Stricter environment check
ID_MIN_VARIANCE: 110,         // Require sharp cards
ID_STABILITY_TOLERANCE: 0.08, // Tighter stability
ID_CAPTURE_FRAMES: 20,        // More frames = more stable
```

### For Mobile Optimization
```typescript
FACE_MIN_WIDTH_RATIO_MOBILE: 0.15,  // More forgiving face size
ID_HYSTERESIS_THRESHOLD: 6,         // Earlier hysteresis
ID_STABILITY_TOLERANCE_MOBILE: 0.30 // More movement tolerance
```
