import { useState, useEffect, useRef } from "react";
import { useKYCPipeline } from "../hooks/useKYCPipeline";
import { useVerifyFace, type VerifyFaceResponse } from "../hooks/useVerifyFace";
import { KYCStage } from "../types/kyc_types";

export default function KYCScanner() {
  const {
    videoRef,
    hiddenCanvasRef,
    overlayCanvasRef,
    currentStage,
    feedback,
    isReadyForNextStage,
    transitionStage,
    capturedId,
    capturedFace,
    capturedIdBlob,
    capturedFaceBlob,
    isMocking,
    forceCapture,
    progress,
    isMirrored,
    resetFlow,
  } = useKYCPipeline();

  const { verifyFace, loading: verifying, error: verifyError, result: verifyResult, reset: resetVerification } = useVerifyFace();
  
  // Track previous blob references to detect when new images are captured
  const prevBlobsRef = useRef<{ id: Blob | null; face: Blob | null }>({ id: null, face: null });
  
  // Clear verification state when new images are captured
  useEffect(() => {
    if (currentStage === KYCStage.DONE) {
      const blobsChanged = 
        capturedIdBlob !== prevBlobsRef.current.id || 
        capturedFaceBlob !== prevBlobsRef.current.face;
      
      if (blobsChanged) {
        console.log("[KYCScanner] New images captured - verification state cleared, verify button visible");
        resetVerification();
        prevBlobsRef.current = { id: capturedIdBlob, face: capturedFaceBlob };
      }
    }
  }, [capturedIdBlob, capturedFaceBlob, currentStage, resetVerification]);
  
  // Handle manual verification
  const handleVerifyClick = async () => {
    if (capturedIdBlob && capturedFaceBlob) {
      console.log("[KYCScanner] User clicked verify button");
      await verifyFace(capturedIdBlob, capturedFaceBlob);
    }
  };

  return (
    <div className="relative w-full h-dvh bg-black overflow-hidden font-sans select-none flex flex-col md:flex-row">
      {/* MAIN VIDEO SECTION */}
      <div className="relative flex-1 md:flex-1 flex items-center justify-center overflow-hidden">
        {/* CAMERA VIDEO */}
        <video
          ref={videoRef}
          className={`absolute top-0 left-0 w-full h-full object-cover z-0 ${isMirrored ? '-scale-x-100' : ''}`}
          playsInline
          muted
          autoPlay
        />

        {/* BOUNDING BOX CANVAS */}
        <canvas
          ref={overlayCanvasRef}
          className={`absolute top-0 left-0 w-full h-full object-cover z-10 pointer-events-none ${isMirrored ? '-scale-x-100' : ''}`}
        />

        {/* Hidden Extraction Canvas */}
        <canvas ref={hiddenCanvasRef} className="hidden" />

        {/* VIGNETTE & SCANNING LINE */}
        <div className={`absolute top-0 left-0 w-full h-full z-10 pointer-events-none bg-black/20 shadow-[inset_0_0_150px_rgba(0,0,0,0.9)] ${(currentStage === KYCStage.ID_CAPTURE || currentStage === KYCStage.FACE_CAPTURE) && isReadyForNextStage ? 'animate-border-pulse' : ''}`}>
          {(currentStage === KYCStage.ID_CAPTURE || currentStage === KYCStage.FACE_CAPTURE) && (
            <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500/50 shadow-[0_0_15px_rgba(16,185,129,0.8)] animate-[scan_3s_ease-in-out_infinite]" />
          )}
        </div>

        {/* FLASH EFFECT */}
        {isReadyForNextStage && progress > 1 && (
          <div className="absolute inset-0 z-40 bg-white pointer-events-none animate-flash" />
        )}

        {/* HEADER / PROMPTS */}
        <div className="absolute top-4 sm:top-10 left-0 w-full flex justify-center z-20 px-3 sm:px-4">
          <div className="kyc-glass px-4 sm:px-8 py-3 sm:py-4 rounded-2xl sm:rounded-3xl flex flex-col items-center shadow-2xl max-w-xs sm:max-w-sm w-full animate-in fade-in slide-in-from-top duration-700">
            <h2 className="text-emerald-400/80 uppercase tracking-[0.2em] text-[8px] sm:text-[10px] font-black mb-1.5">
              {currentStage === KYCStage.PRE_FLIGHT && "Phase 1: Environment"}
              {currentStage === KYCStage.ID_CAPTURE && "Phase 2: ID Document"}
              {currentStage === KYCStage.FACE_CAPTURE && "Phase 3: Liveness"}
              {currentStage === KYCStage.DONE && "All Checks Passed"}
            </h2>
            <div
              className={`text-center font-bold text-base sm:text-lg tracking-tight transition-all duration-300 ${isReadyForNextStage ? "text-emerald-400 scale-105" : "text-white"
                }`}
            >
              {feedback}
            </div>
          </div>
        </div>

      {/* BOTTOM CONTROLS - MOBILE & TABLET */}
      <div className="absolute bottom-4 sm:bottom-8 left-0 w-full flex justify-center z-20 px-4 md:hidden">
        {currentStage === KYCStage.PRE_FLIGHT && isReadyForNextStage && (
          <button
            onClick={transitionStage}
            className="px-6 sm:px-10 py-3 sm:py-4 bg-emerald-500 text-white font-black text-xs sm:text-sm rounded-full shadow-[0_0_30px_rgba(16,185,129,0.6)] hover:bg-emerald-400 hover:scale-110 active:scale-95 transition-all duration-300 uppercase tracking-widest"
          >
            Start Capture Flow
          </button>
        )}

        {(currentStage === KYCStage.ID_CAPTURE || currentStage === KYCStage.FACE_CAPTURE) && (
          <div className="relative flex justify-center items-center w-20 h-20 sm:w-24 sm:h-24">
            {isReadyForNextStage ? (
              <div className="absolute inset-0 border-4 border-emerald-400 rounded-full animate-ping opacity-60" />
            ) : (
              <div className="absolute inset-0 border-4 border-emerald-500/20 rounded-full" />
            )}
            <div className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center transition-all duration-500 ${isReadyForNextStage ? 'bg-emerald-500 shadow-[0_0_40px_rgba(16,185,129,0.8)]' : 'bg-white/10 backdrop-blur-md'}`}>
              {isReadyForNextStage ? (
                <svg className="w-6 h-6 sm:w-8 sm:h-8 text-white animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              ) : (
                <div className="w-6 h-6 sm:w-8 sm:h-8 border-4 border-t-emerald-400 border-white/20 rounded-full animate-spin" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* BOTTOM CONTROLS - DESKTOP ONLY (centered) */}
      <div className="hidden md:flex absolute bottom-12 left-1/2 transform -translate-x-1/2 z-20 px-4">
        {currentStage === KYCStage.PRE_FLIGHT && isReadyForNextStage && (
          <button
            onClick={transitionStage}
            className="px-10 py-4 bg-emerald-500 text-white font-black text-sm rounded-full shadow-[0_0_30px_rgba(16,185,129,0.6)] hover:bg-emerald-400 hover:scale-110 active:scale-95 transition-all duration-300 uppercase tracking-widest"
          >
            Start Capture Flow
          </button>
        )}

        {(currentStage === KYCStage.ID_CAPTURE || currentStage === KYCStage.FACE_CAPTURE) && (
          <div className="relative flex justify-center items-center w-24 h-24">
            {isReadyForNextStage ? (
              <div className="absolute inset-0 border-4 border-emerald-400 rounded-full animate-ping opacity-60" />
            ) : (
              <div className="absolute inset-0 border-4 border-emerald-500/20 rounded-full" />
            )}
            <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-all duration-500 ${isReadyForNextStage ? 'bg-emerald-500 shadow-[0_0_40px_rgba(16,185,129,0.8)]' : 'bg-white/10 backdrop-blur-md'}`}>
              {isReadyForNextStage ? (
                <svg className="w-8 h-8 text-white animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              ) : (
                <div className="w-8 h-8 border-4 border-t-emerald-400 border-white/20 rounded-full animate-spin" />
              )}
            </div>
          </div>
        )}
      </div>

        {/* PICTURE-IN-PICTURE THUMBNAILS - DESKTOP ONLY */}
        <div className="absolute top-10 right-8 z-30 hidden md:flex flex-col gap-4">
          {capturedId && (
            <div className="w-48 h-32 kyc-glass rounded-2xl overflow-hidden shadow-2xl animate-in zoom-in duration-500 border-2 border-emerald-500/50 bg-black/40">
              <img src={capturedId} alt="ID" className="w-full h-full object-contain" />
              <div className="absolute inset-0 bg-emerald-500/10 flex items-center justify-center">
                <div className="bg-emerald-500 rounded-full p-1 shadow-lg">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </div>
          )}
          {capturedFace && (
            <div className="w-36 h-36 kyc-glass rounded-full overflow-hidden shadow-2xl animate-in zoom-in duration-500 border-2 border-emerald-500/50 bg-black/40">
              <img src={capturedFace} alt="Face" className="w-full h-full object-contain" />
              <div className="absolute inset-0 bg-emerald-500/10 flex items-center justify-center">
                <div className="bg-emerald-500 rounded-full p-1 shadow-lg">
                  <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* SIDE PANEL FOR MOBILE - IMAGES ON RIGHT (small) */}
      <div className="fixed md:hidden bottom-20 right-2 z-30 flex flex-col gap-2">
        {capturedId && (
          <div className="group">
            <div className="relative w-16 h-12 rounded-lg overflow-hidden border-2 border-emerald-500/30 group-hover:border-emerald-500/50 transition-all shadow-lg bg-black/40">
              <img src={capturedId} alt="ID" className="w-full h-full object-contain" style={{ imageRendering: 'crisp-edges' }} />
              <div className="absolute inset-0 bg-emerald-500/10 flex items-center justify-center">
                <div className="bg-emerald-500 rounded-full p-0.5 shadow-lg">
                  <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        )}
        {capturedFace && (
          <div className="group">
            <div className="relative w-14 h-14 rounded-full overflow-hidden border-2 border-emerald-500/30 group-hover:border-emerald-500/50 transition-all shadow-lg bg-black/40">
              <img src={capturedFace} alt="Face" className="w-full h-full object-contain" style={{ imageRendering: 'crisp-edges' }} />
              <div className="absolute inset-0 bg-emerald-500/10 flex items-center justify-center">
                <div className="bg-emerald-500 rounded-full p-0.5 shadow-lg">
                  <svg className="w-2 h-2 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FINAL SUCCESS MODAL */}
      {currentStage === KYCStage.DONE && (
        <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-2xl flex flex-col items-center justify-center p-4 sm:p-6 animate-in fade-in duration-700 overflow-y-auto">
          <div className="kyc-glass p-4 sm:p-8 rounded-[30px] sm:rounded-[40px] shadow-[0_0_100px_rgba(16,185,129,0.2)] max-w-sm sm:max-w-md w-full flex flex-col items-center border border-white/20 animate-in zoom-in slide-in-from-bottom-10 duration-500 my-auto">
            
            {/* Pre-Verification State - Show Images and Verify Button */}
            {!verifying && !verifyResult && !verifyError && (
              <>
                <div className="w-16 sm:w-20 h-16 sm:h-20 bg-emerald-500 text-white rounded-full flex items-center justify-center mb-6 sm:mb-8 shadow-[0_0_40px_rgba(16,185,129,0.5)]">
                  <svg className="w-8 sm:w-10 h-8 sm:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <h1 className="text-2xl sm:text-3xl font-black text-white mb-2 text-center tracking-tight">
                  Documents Captured
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm mb-8 sm:mb-10 text-center font-medium">Verify your identity by comparing the images</p>

                {/* Images Display */}
                <div className="w-full flex flex-col sm:flex-row gap-4 sm:gap-6 mb-8 sm:mb-12">
                  <div className="flex-1 group">
                    <p className="text-[8px] sm:text-[10px] text-emerald-400 font-black uppercase tracking-widest mb-2 sm:mb-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">ID Card</p>
                    <div className="relative aspect-4/3 rounded-xl sm:rounded-2xl overflow-hidden border-2 border-white/10 group-hover:border-emerald-500/50 transition-all shadow-xl bg-black/40">
                      <img src={capturedId!} alt="ID" className="w-full h-full object-contain" style={{ imageRendering: 'crisp-edges' }} />
                    </div>
                  </div>
                  <div className="flex-1 group">
                    <p className="text-[8px] sm:text-[10px] text-emerald-400 font-black uppercase tracking-widest mb-2 sm:mb-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">Selfie</p>
                    <div className="relative aspect-4/3 rounded-xl sm:rounded-2xl overflow-hidden border-2 border-white/10 group-hover:border-emerald-500/50 transition-all shadow-xl bg-black/40">
                      <img src={capturedFace!} alt="Face" className="w-full h-full object-contain" style={{ imageRendering: 'crisp-edges' }} />
                    </div>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="w-full flex flex-col gap-3 sm:gap-4">
                  <button 
                    onClick={handleVerifyClick}
                    disabled={verifying}
                    className="w-full py-4 sm:py-5 bg-emerald-500 text-white font-black rounded-xl sm:rounded-2xl hover:bg-emerald-400 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl uppercase tracking-widest text-xs sm:text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {verifying ? "Verifying..." : "Verify Face"}
                  </button>
                  <button 
                    onClick={resetFlow}
                    className="w-full py-3 sm:py-4 bg-white/10 text-white font-black rounded-xl sm:rounded-2xl hover:bg-white/20 transition-all uppercase tracking-widest text-xs sm:text-sm"
                  >
                    Retake Photos
                  </button>
                </div>
              </>
            )}

            {/* Verification Loading State */}
            {verifying && (
              <>
                <div className="w-16 sm:w-20 h-16 sm:h-20 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mb-6 sm:mb-8 shadow-[0_0_40px_rgba(16,185,129,0.3)] animate-pulse">
                  <svg className="w-8 sm:w-10 h-8 sm:h-10 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" fill="none" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-white mb-2 text-center tracking-tight">
                  Verifying Face...
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm text-center font-medium">Comparing ID and face images</p>
              </>
            )}

            {/* Verification Success State */}
            {!verifying && verifyResult && verifyResult.success && (
              <>
                <div className="w-16 sm:w-20 h-16 sm:h-20 bg-emerald-500 text-white rounded-full flex items-center justify-center mb-6 sm:mb-8 shadow-[0_0_40px_rgba(16,185,129,0.5)]">
                  <svg className="w-8 sm:w-10 h-8 sm:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <h1 className="text-2xl sm:text-3xl font-black text-emerald-400 mb-2 text-center tracking-tight">
                  Face Match Verified
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm mb-6 sm:mb-8 text-center font-medium">{verifyResult.message}</p>

                {/* Result Details */}
                <div className="w-full bg-white/5 rounded-lg sm:rounded-xl p-4 sm:p-5 mb-8 sm:mb-12 border border-white/10">
                  {verifyResult.similarity !== undefined && (
                    <div className="flex items-center justify-between mb-3 sm:mb-4">
                      <span className="text-gray-400 text-xs sm:text-sm font-medium">Similarity Score</span>
                      <span className="text-emerald-400 font-black text-sm sm:text-base">{Math.round(verifyResult.similarity as number)}%</span>
                    </div>
                  )}
                  {verifyResult.matchConfidence !== undefined && (
                    <div className="flex items-center justify-between mb-3 sm:mb-4">
                      <span className="text-gray-400 text-xs sm:text-sm font-medium">Confidence</span>
                      <span className="text-emerald-400 font-black text-sm sm:text-base">{Math.round(verifyResult.matchConfidence as number)}%</span>
                    </div>
                  )}
                  {verifyResult.matchStatus && (
                    <div className="flex items-center justify-between">
                      <span className="text-gray-400 text-xs sm:text-sm font-medium">Status</span>
                      <span className="text-emerald-400 font-black text-xs sm:text-sm uppercase">{verifyResult.matchStatus}</span>
                    </div>
                  )}
                </div>

                <button onClick={resetFlow} className="w-full py-4 sm:py-5 bg-white text-black font-black rounded-xl sm:rounded-2xl hover:bg-emerald-50 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl uppercase tracking-widest text-xs sm:text-sm">
                  Complete Onboarding
                </button>
              </>
            )}

            {/* Verification Failure State */}
            {!verifying && verifyResult && !verifyResult.success && (
              <>
                <div className="w-16 sm:w-20 h-16 sm:h-20 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center mb-6 sm:mb-8 shadow-[0_0_40px_rgba(239,68,68,0.3)]">
                  <svg className="w-8 sm:w-10 h-8 sm:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-red-400 mb-2 text-center tracking-tight">
                  Face Match Failed
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm mb-6 sm:mb-8 text-center font-medium">{verifyResult.message}</p>

                {/* Result Details */}
                {(verifyResult.similarity !== undefined || verifyResult.matchConfidence !== undefined) && (
                  <div className="w-full bg-white/5 rounded-lg sm:rounded-xl p-4 sm:p-5 mb-8 sm:mb-12 border border-white/10">
                    {verifyResult.similarity !== undefined && (
                      <div className="flex items-center justify-between mb-3 sm:mb-4">
                        <span className="text-gray-400 text-xs sm:text-sm font-medium">Similarity Score</span>
                        <span className="text-red-400 font-black text-sm sm:text-base">{Math.round(verifyResult.similarity as number)}%</span>
                      </div>
                    )}
                    {verifyResult.matchConfidence !== undefined && (
                      <div className="flex items-center justify-between">
                        <span className="text-gray-400 text-xs sm:text-sm font-medium">Confidence</span>
                        <span className="text-red-400 font-black text-sm sm:text-base">{Math.round(verifyResult.matchConfidence as number)}%</span>
                      </div>
                    )}
                  </div>
                )}

                <div className="w-full flex flex-col gap-3 sm:gap-4">
                  <button 
                    onClick={() => resetVerification()}
                    className="w-full py-4 sm:py-5 bg-emerald-500 text-white font-black rounded-xl sm:rounded-2xl hover:bg-emerald-400 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl uppercase tracking-widest text-xs sm:text-sm"
                  >
                    Try Again
                  </button>
                  <button 
                    onClick={resetFlow}
                    className="w-full py-3 sm:py-4 bg-white/10 text-white font-black rounded-xl sm:rounded-2xl hover:bg-white/20 transition-all uppercase tracking-widest text-xs sm:text-sm"
                  >
                    Retake Photos
                  </button>
                </div>
              </>
            )}

            {/* API Error State */}
            {!verifying && verifyError && (
              <>
                <div className="w-16 sm:w-20 h-16 sm:h-20 bg-red-500/20 text-red-400 rounded-full flex items-center justify-center mb-6 sm:mb-8 shadow-[0_0_40px_rgba(239,68,68,0.3)]">
                  <svg className="w-8 sm:w-10 h-8 sm:h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <h1 className="text-2xl sm:text-3xl font-black text-red-400 mb-2 text-center tracking-tight">
                  Verification Error
                </h1>
                <p className="text-gray-400 text-xs sm:text-sm mb-8 sm:mb-10 text-center font-medium break-all">{verifyError}</p>

                <div className="w-full flex flex-col gap-3 sm:gap-4">
                  <button 
                    onClick={() => resetVerification()}
                    className="w-full py-4 sm:py-5 bg-emerald-500 text-white font-black rounded-xl sm:rounded-2xl hover:bg-emerald-400 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl uppercase tracking-widest text-xs sm:text-sm"
                  >
                    Retry Verification
                  </button>
                  <button 
                    onClick={resetFlow}
                    className="w-full py-3 sm:py-4 bg-white/10 text-white font-black rounded-xl sm:rounded-2xl hover:bg-white/20 transition-all uppercase tracking-widest text-xs sm:text-sm"
                  >
                    Start Over
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
