import { useCallback, useRef, useState } from "react";
import type { TtsStateEvent } from "../lib/contracts";
import { frontendLog, speakText, stopSpeaking } from "../lib/tauri";
import { isCurrentTenantContext } from "../lib/tenant-session";
import { errorMessage } from "../lib/companion-utils";

export function useSpeechOutput(tenantContextId: string) {
  const isTtsSpeakingRef = useRef(false);
  const pendingSpeechIdsRef = useRef(new Set<string>());
  const suppressedSpeechIdsRef = useRef(new Set<string>());
  const [hasSpeechOutput, setHasSpeechOutput] = useState(false);

  const requestSpeech = useCallback((requestId: string, text: string, voice: string | null) => {
    suppressedSpeechIdsRef.current.delete(requestId);
    pendingSpeechIdsRef.current.add(requestId);
    setHasSpeechOutput(true);
    void speakText(requestId, text, voice, tenantContextId).catch((error) => {
      pendingSpeechIdsRef.current.delete(requestId);
      if (!isCurrentTenantContext(tenantContextId)) return;
      setHasSpeechOutput(pendingSpeechIdsRef.current.size > 0);
      if (!suppressedSpeechIdsRef.current.has(requestId)) {
        void frontendLog("warn", `speech output failed: ${errorMessage(error, "TTS_FAILED")}`);
      }
    });
  }, [tenantContextId]);

  const stopSpeechOutput = useCallback(async () => {
    pendingSpeechIdsRef.current.forEach((id) => suppressedSpeechIdsRef.current.add(id));
    pendingSpeechIdsRef.current.clear();
    isTtsSpeakingRef.current = false;
    setHasSpeechOutput(false);
    try {
      await stopSpeaking(tenantContextId);
    } catch (error) {
      if (isCurrentTenantContext(tenantContextId)) setHasSpeechOutput(true);
      throw error;
    }
  }, [tenantContextId]);

  const acceptSpeechState = useCallback((event: TtsStateEvent) => {
    if (suppressedSpeechIdsRef.current.has(event.requestId)) return false;
    if (event.speaking) pendingSpeechIdsRef.current.add(event.requestId);
    else pendingSpeechIdsRef.current.delete(event.requestId);
    setHasSpeechOutput(pendingSpeechIdsRef.current.size > 0);
    return true;
  }, []);
  return { hasSpeechOutput, isTtsSpeakingRef, requestSpeech, stopSpeechOutput, acceptSpeechState };
}
