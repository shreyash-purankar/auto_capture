# KYC Automated Capture System - Technical Documentation

This document explains the complete architecture, workflow, and tunable parameters of the KYC (Know Your Customer) automated capture system.

## 1. Architecture Overview

The application is built using a **Main Thread (React UI)** and a **Background Thread (Web Worker)**. 
This separation ensures that the heavy Machine Learning models do not freeze the camera feed or the user interface.

*   **UI Layer (`src/components/KYCScanner.tsx`)**: Handles the webcam stream, draws the bounding boxes, displays feedback text, and manages the overall state (Pre-flight -> ID -> Face -> Success).
*   **ML Engine (`src/workers/kyc_worker.ts`)**: Receives frame data from the UI, runs the AI models, calculates math/geometry, and sends back bounding boxes, feedback, and final captured images.

## 2. Technology Stack

*   **YOLOv11-Nano (TensorFlow.js)**: Used for coarse ID card detection. It excels at ignoring background clutter. (mAPval 50-95 score of 39.5 on COCO).
*   **OpenCV.js (WASM)**: Used for high-precision edge detection, contour finding, and perspective warping (flattening the ID card), along with HoughLinesP for edge reconstruction.
*   **MediaPipe Face Landmarker**: Used for sub-millisecond face detection, localization, and liveness checks (Eye Openness, Gaze Direction, Head Pose).

---

## 3. Configuration Variables & Tuning Guide

All critical thresholds and parameters are centralized in the `CONFIG` object at the top of `src/workers/kyc_worker.ts`. Modifying these values will directly impact how strict or fast the auto-capture system behaves.

### Pre-Flight Checks (Health Sensors)
Before any ML runs, the system checks if the environment is suitable.

*   **`MIN_BRIGHTNESS` (Default: 60)**: The minimum average pixel intensity (0-255).
    *   *Increase*: Requires a brighter room to start the process.
    *   *Decrease*: Allows capture in darker environments (may reduce OCR accuracy).
*   **`MAX_BRIGHTNESS` (Default: 240)**: The maximum average pixel intensity.
    *   *Increase*: Allows capture under very harsh lighting or glare.
    *   *Decrease*: Stricter against over-exposed environments.
*   **`MIN_GLOBAL_VARIANCE` (Default: 20)**: The minimum Laplacian variance for the entire frame.
    *   *Increase*: Requires a much sharper, cleaner camera lens to proceed.
    *   *Decrease*: Allows capture even if the camera lens is slightly smudged.

### Stage 1: ID Card Capture
This is a hybrid pipeline using YOLO for finding the card and OpenCV for flattening it.

*   **`YOLO_CONFIDENCE` (Default: 0.15)**: Minimum confidence score for YOLO ID detection.
    *   *Increase*: Stricter detection; ignores background noise better but might struggle to find the ID if lighting is poor.
    *   *Decrease*: Faster detection, but might falsely identify random rectangles (like phones or books) as ID cards.
*   **`ID_MIN_WIDTH_RATIO` (Default: 0.30)**: ID must take up at least 30% of the frame width.
    *   *Increase*: Forces the user to bring the ID much closer to the camera (better for high-res OCR).
    *   *Decrease*: Allows capturing the ID from further away.
*   **`ID_MAX_DIST_CENTER` (Default: 0.8)**: Maximum distance the ID can be from the center of the screen.
    *   *Decrease*: Forces the user to perfectly center the ID card.
*   **`ID_ASPECT_RATIO` (Default: 1.58)**: Standard ID card aspect ratio (width/height).
*   **`ID_ASPECT_TOLERANCE` (Default: 0.40)**: Tolerance for aspect ratio matching.
    *   *Increase*: Allows more tilted or skewed cards to be captured.
    *   *Decrease*: Stricter requirement for a perfect rectangle. Prevents square objects from being detected.
*   **`ID_BOX_EXPAND_FACTOR` (Default: 0.98)**: Multiplier to adjust the YOLO bounding box size.
    *   *Increase (e.g., 1.05)*: Makes the bounding box larger, capturing more background around the ID.
    *   *Decrease (e.g., 0.95)*: Shrinks the bounding box to tightly hug the inside of the ID card.
*   **`ID_OPENCV_PADDING` (Default: 0.00)**: Padding added to the OpenCV tight bounding box.
    *   *Increase*: Adds a visual margin around the perfectly cropped OpenCV shape.
*   **`ID_MIN_VARIANCE` (Default: 80)**: Minimum Laplacian variance for the ID crop (sharpness).
    *   *Increase*: Requires the text on the ID to be perfectly in focus.
    *   *Decrease*: Faster capture, but the resulting image might be slightly blurry.
*   **`ID_STABILITY_TOLERANCE` (Default: 0.30)**: Maximum allowed movement between frames.
    *   *Decrease*: Requires the user to hold the card perfectly still.
*   **`ID_CAPTURE_FRAMES` (Default: 3)**: Number of consecutive stable frames required to auto-capture.
    *   *Increase*: Slower capture, but guarantees absolute stability and focus.
    *   *Decrease*: Extremely fast, snappy capture, but risks motion blur.

### Stage 2: Face Capture (with Liveness)
Once the ID is captured, the worker switches to MediaPipe for face detection and liveness checks.

*   **`FACE_MIN_WIDTH_RATIO` (Default: 0.25)**: Face must take up at least 25% of the frame width.
    *   *Increase*: Forces the user to bring their face closer to the camera.
*   **`FACE_CENTER_TOLERANCE` (Default: 0.25)**: Face must be within 25% of the center.
*   **`FACE_MIN_EAR` (Default: 0.2)**: Minimum Eye Aspect Ratio (openness).
    *   *Increase*: Stricter check; user must open their eyes very wide.
    *   *Decrease*: More forgiving for users with naturally narrower eyes or squinting.
*   **`FACE_MAX_GAZE_OFFSET` (Default: 0.1)**: Maximum gaze offset from the center of the eye.
    *   *Decrease*: Stricter check; user must look dead-center into the camera lens.
*   **`FACE_MAX_POSE_ANGLE` (Default: 0.2)**: Maximum head pose angle (yaw/pitch in radians).
    *   *Decrease*: User must face the camera perfectly straight without tilting their head.
*   **`FACE_MIN_VARIANCE` (Default: 40)**: Minimum Laplacian variance for the face crop.
    *   *Increase*: Requires perfect lighting and focus on the face.
*   **`FACE_CAPTURE_FRAMES` (Default: 10)**: Number of consecutive stable frames required to auto-capture.
    *   *Increase*: Slower capture, ensures the user is completely still and looking at the camera for a longer duration.

---

## 4. Security & Memory
*   **Image Quality**: `quality: 1.0` (100% WebP). WebP provides excellent compression while maintaining OCR-readable text.
*   **Memory**: Images are passed as `ImageData` and `Blob` objects. They are never written to `localStorage`, ensuring compliance with basic PII handling standards.
*   **Anti-Spoofing**: The Laplacian noise check serves as a basic "Screen Replay" detection, as photos of screens exhibit specific moiré patterns and low variance. The Eye Logic (EAR, Gaze, Pose) ensures the user is a live, attentive human.
