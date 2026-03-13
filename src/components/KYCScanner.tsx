import { useKYCPipeline } from "../hooks/useKYCPipeline";
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
    isMocking,
    forceCapture,
    progress,
    isMirrored,
  } = useKYCPipeline();

  return (
    <div className="relative w-full h-[100dvh] bg-black overflow-hidden font-sans select-none flex items-center justify-center">
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
      {isReadyForNextStage && progress > 0.9 && (
        <div className="absolute inset-0 z-40 bg-white pointer-events-none animate-flash" />
      )}

      {/* HEADER / PROMPTS */}
      <div className="absolute top-10 left-0 w-full flex justify-center z-20 px-4">
        <div className="kyc-glass px-8 py-4 rounded-3xl flex flex-col items-center shadow-2xl max-w-sm w-full animate-in fade-in slide-in-from-top duration-700">
          <h2 className="text-emerald-400/80 uppercase tracking-[0.2em] text-[10px] font-black mb-1.5">
            {currentStage === KYCStage.PRE_FLIGHT && "Phase 1: Environment"}
            {currentStage === KYCStage.ID_CAPTURE && "Phase 2: ID Document"}
            {currentStage === KYCStage.FACE_CAPTURE && "Phase 3: Liveness"}
            {currentStage === KYCStage.DONE && "All Checks Passed"}
          </h2>
          <div
            className={`text-center font-bold text-lg tracking-tight transition-all duration-300 ${isReadyForNextStage ? "text-emerald-400 scale-105" : "text-white"
              }`}
          >
            {feedback}
          </div>
        </div>
      </div>

      {/* PICTURE-IN-PICTURE THUMBNAILS */}
      <div className="absolute top-10 right-8 z-30 flex flex-col gap-4">
        {capturedId && (
          <div className="w-28 h-18 kyc-glass rounded-2xl overflow-hidden shadow-2xl animate-in zoom-in duration-500 border-2 border-emerald-500/50 bg-black/40">
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
          <div className="w-24 h-24 kyc-glass rounded-full overflow-hidden shadow-2xl animate-in zoom-in duration-500 border-2 border-emerald-500/50 bg-black/40">
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

      {/* BOTTOM CONTROLS */}
      <div className="absolute bottom-12 left-0 w-full flex justify-center z-20 px-4">
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

      {/* FINAL SUCCESS MODAL */}
      {currentStage === KYCStage.DONE && (
        <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-2xl flex flex-col items-center justify-center p-6 animate-in fade-in duration-700">
          <div className="kyc-glass p-8 rounded-[40px] shadow-[0_0_100px_rgba(16,185,129,0.2)] max-w-md w-full flex flex-col items-center border border-white/20 animate-in zoom-in slide-in-from-bottom-10 duration-500">
            <div className="w-20 h-20 bg-emerald-500 text-white rounded-full flex items-center justify-center mb-8 shadow-[0_0_40px_rgba(16,185,129,0.5)]">
              <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={4} d="M5 13l4 4L19 7" />
              </svg>
            </div>

            <h1 className="text-3xl font-black text-white mb-2 text-center tracking-tight">
              Identity Verified
            </h1>
            <p className="text-gray-400 text-sm mb-10 text-center font-medium">Your documents have been processed securely.</p>

            <div className="w-full flex gap-6 mb-12">
              <div className="flex-1 group">
                <p className="text-[10px] text-emerald-400 font-black uppercase tracking-widest mb-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">ID Card</p>
                <div className="relative aspect-[3/2] rounded-2xl overflow-hidden border-2 border-white/10 group-hover:border-emerald-500/50 transition-all shadow-xl bg-black/40">
                  <img src={capturedId!} alt="ID" className="w-full h-full object-contain" style={{ imageRendering: 'crisp-edges' }} />
                </div>
              </div>
              <div className="flex-1 group">
                <p className="text-[10px] text-emerald-400 font-black uppercase tracking-widest mb-3 text-center opacity-70 group-hover:opacity-100 transition-opacity">Selfie</p>
                <div className="relative aspect-square rounded-2xl overflow-hidden border-2 border-white/10 group-hover:border-emerald-500/50 transition-all shadow-xl bg-black/40">
                  <img src={capturedFace!} alt="Face" className="w-full h-full object-contain" />
                </div>
              </div>
            </div>

            <button className="w-full py-5 bg-white text-black font-black rounded-2xl hover:bg-emerald-50 hover:scale-[1.02] active:scale-95 transition-all shadow-2xl uppercase tracking-widest text-sm">
              Complete Onboarding
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
