import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionState, TranscriptionProviderId } from "../lib/contracts";
import { appendTranscriptionAudio, commitTranscriptionTurn, frontendLog, onTranscriptionSessionEvent, startTranscriptionSession, stopSpeaking, stopTranscriptionSession } from "../lib/tauri";
import { t } from "../lib/i18n";
import { isCurrentTenantContext } from "../lib/tenant-session";
import { errorMessage, waitMs } from "../lib/companion-utils";

const VOICE_MAX_RECORDING_MS = 20_000;
const VOICE_SILENCE_HOLD_MS = 2_200;
const VOICE_ACTIVITY_POLL_MS = 120;
const VOICE_SILENCE_RMS_THRESHOLD = 0.01;
const VOICE_SPEECH_RMS_THRESHOLD = 0.012;
const VOICE_MIN_AUTOSTOP_ELAPSED_MS = 2_400;
const VOICE_MAX_INITIAL_SILENCE_MS = 7_000;
const VOICE_MIN_TRANSCRIPTION_MS = 700;
const VOICE_MIN_TRANSCRIPTION_BYTES = 1_500;
const VOICE_TRANSCRIPT_PREVIEW_MS = 2200;
const VOICE_PCM_SAMPLE_RATE = 24_000;
const VOICE_STT_CHUNK_BYTES = 12 * 1024;
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary);
}

function splitBytesToBase64Chunks(
  bytes: Uint8Array,
  chunkSize = VOICE_STT_CHUNK_BYTES,
): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    chunks.push(bytesToBase64(chunk));
  }
  return chunks;
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  if (value < -1) {
    return -1;
  }
  return value;
}

function readMixedSample(buffer: AudioBuffer, frameIndex: number): number {
  const clampedIndex = Math.max(0, Math.min(buffer.length - 1, frameIndex));
  let sum = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    sum += buffer.getChannelData(channel)[clampedIndex] ?? 0;
  }
  return sum / Math.max(1, buffer.numberOfChannels);
}

function audioBufferToPcm16(buffer: AudioBuffer, targetSampleRate = VOICE_PCM_SAMPLE_RATE): Uint8Array {
  const frameCount = Math.max(
    1,
    Math.round((buffer.length * targetSampleRate) / buffer.sampleRate),
  );
  const pcm = new Uint8Array(frameCount * 2);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sourcePosition = (frame * buffer.sampleRate) / targetSampleRate;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, buffer.length - 1);
    const ratio = sourcePosition - leftIndex;
    const leftSample = readMixedSample(buffer, leftIndex);
    const rightSample = readMixedSample(buffer, rightIndex);
    const interpolated = clampSample(leftSample + (rightSample - leftSample) * ratio);
    const int16 = interpolated < 0 ? interpolated * 0x8000 : interpolated * 0x7fff;
    const signed = Math.max(-32768, Math.min(32767, Math.round(int16)));
    const byteOffset = frame * 2;
    pcm[byteOffset] = signed & 0xff;
    pcm[byteOffset + 1] = (signed >> 8) & 0xff;
  }
  return pcm;
}

async function decodeBlobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

async function prepareTranscriptionUpload(
  blob: Blob,
  provider: TranscriptionProviderId,
): Promise<{ mimeType: string; chunks: string[]; totalBytes: number }> {
  if (provider === "openai-realtime") {
    const audioBuffer = await decodeBlobToAudioBuffer(blob);
    const pcm = audioBufferToPcm16(audioBuffer, VOICE_PCM_SAMPLE_RATE);
    return {
      mimeType: "audio/pcm",
      chunks: splitBytesToBase64Chunks(pcm),
      totalBytes: pcm.length,
    };
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    mimeType: blob.type || "audio/webm",
    chunks: splitBytesToBase64Chunks(bytes),
    totalBytes: bytes.length,
  };
}

function preferredMimeType(): string {
  const options = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  return (
    options.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ""
  );
}

interface VoiceCaptureOptions {
  tenantContextId: string;
  transcriptionProvider: TranscriptionProviderId;
  onTranscript: (text: string, contextId: string) => Promise<void>;
  setStatus: (status: string | null) => void;
  setError: (error: string | null) => void;
  setCompanionState: (state: CompanionState) => void;
}

export function useVoiceCapture({ tenantContextId, transcriptionProvider, onTranscript, setStatus, setError, setCompanionState }: VoiceCaptureOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const captureGenerationRef = useRef(0);
  const captureBusyRef = useRef(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const activeTranscriptionSessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingAudioContextRef = useRef<AudioContext | null>(null);
  const recordingSourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(
    null,
  );
  const recordingAnalyserNodeRef = useRef<AnalyserNode | null>(null);
  const recordingMonitorIntervalRef = useRef<number | null>(null);
  const recordingSilenceSinceMsRef = useRef<number | null>(null);
  const recordingStartedAtMsRef = useRef<number | null>(null);
  const recordingSpeechDetectedRef = useRef(false);
  const recordingAutoStopReasonRef = useRef<
    "manual" | "silence" | "limit" | null
  >(null);
  const transcriptionProviderRef = useRef<TranscriptionProviderId>(
    transcriptionProvider,
  );

  useEffect(() => {
    transcriptionProviderRef.current = transcriptionProvider;
  }, [transcriptionProvider]);
  const clearRecordingMonitor = useCallback(() => {
    if (recordingMonitorIntervalRef.current !== null) {
      window.clearInterval(recordingMonitorIntervalRef.current);
      recordingMonitorIntervalRef.current = null;
    }
    recordingSilenceSinceMsRef.current = null;
    recordingStartedAtMsRef.current = null;
    recordingSpeechDetectedRef.current = false;
  }, []);

  const clearRecordingStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    recordingSourceNodeRef.current?.disconnect();
    recordingSourceNodeRef.current = null;
    recordingAnalyserNodeRef.current = null;

    const audioContext = recordingAudioContextRef.current;
    recordingAudioContextRef.current = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {
        // Best-effort close.
      });
    }
  }, []);

  const stopActiveRecorder = useCallback(
    (reason: "manual" | "silence" | "limit" = "manual") => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        return;
      }
      recordingAutoStopReasonRef.current = reason;
      recorder.stop();
    },
    [],
  );


  useEffect(() => {
    let active = true;
    let unlistenTranscription: (() => void) | undefined;
    void onTranscriptionSessionEvent((event) => {
      if (!active) return;
      if (event.type === "partial") {
        setStatus(
          t("status.transcribingPartial", {
            text: event.text.trim(),
          }),
        );
        setCompanionState("transcribing");
        return;
      }
      if (event.type === "error") {
        void frontendLog(
          "warn",
          `transcription provider ${event.provider} failed: ${event.message}`,
        );
      }
    }).then((unlisten) => {
      if (!active) {
        unlisten();
        return;
      }
      unlistenTranscription = unlisten;
    });


    return () => {
      active = false;
      captureGenerationRef.current += 1;
      captureBusyRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      unlistenTranscription?.();
      clearRecordingMonitor();
      clearRecordingStream();
      mediaRecorderRef.current = null;
      if (activeTranscriptionSessionIdRef.current) {
        void stopTranscriptionSession({
          sessionId: activeTranscriptionSessionIdRef.current,
        }, tenantContextId).catch(() => undefined);
        activeTranscriptionSessionIdRef.current = null;
      }
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;

    };
  }, [tenantContextId, clearRecordingMonitor, clearRecordingStream, setStatus, setCompanionState]);

  async function startRecording() {
    if (captureBusyRef.current || !isCurrentTenantContext(tenantContextId)) return;
    captureBusyRef.current = true;
    const generation = ++captureGenerationRef.current;
    const transcriptionContextId = tenantContextId;
    const isCurrentCapture = () => generation === captureGenerationRef.current && isCurrentTenantContext(transcriptionContextId);
    try {
      await stopSpeaking(transcriptionContextId).catch(() => {
        // Recording should still start even if stopping TTS fails.
      });

      if (!isCurrentCapture()) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (!isCurrentCapture()) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const transcriptionSessionId = crypto.randomUUID();
      activeTranscriptionSessionIdRef.current = transcriptionSessionId;
      await startTranscriptionSession({
        sessionId: transcriptionSessionId,
        locale: navigator.language,
      }, transcriptionContextId);
      if (!isCurrentCapture()) {
        stream.getTracks().forEach((track) => track.stop());
        await stopTranscriptionSession({ sessionId: transcriptionSessionId }, transcriptionContextId).catch(() => undefined);
        return;
      }
      activeTranscriptionSessionIdRef.current = transcriptionSessionId;
      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;
      recordingStartedAtMsRef.current = performance.now();
      recordingSilenceSinceMsRef.current = null;
      recordingSpeechDetectedRef.current = false;

      const audioContext = new AudioContext();
      const sourceNode = audioContext.createMediaStreamSource(stream);
      const analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 2048;
      sourceNode.connect(analyserNode);
      recordingAudioContextRef.current = audioContext;
      recordingSourceNodeRef.current = sourceNode;
      recordingAnalyserNodeRef.current = analyserNode;

      const sampleBuffer = new Float32Array(analyserNode.fftSize);
      recordingMonitorIntervalRef.current = window.setInterval(() => {
        const activeRecorder = mediaRecorderRef.current;
        if (!activeRecorder || activeRecorder.state !== "recording") {
          return;
        }

        analyserNode.getFloatTimeDomainData(sampleBuffer);
        let sumSquares = 0;
        for (const sample of sampleBuffer) {
          sumSquares += sample * sample;
        }
        const rms = Math.sqrt(sumSquares / sampleBuffer.length);
        const now = performance.now();
        const startedAt = recordingStartedAtMsRef.current ?? now;
        const elapsedMs = now - startedAt;

        if (elapsedMs >= VOICE_MAX_RECORDING_MS) {
          setStatus(t("status.voiceAutoStoppedLimit"));
          stopActiveRecorder("limit");
          return;
        }

        if (rms >= VOICE_SPEECH_RMS_THRESHOLD) {
          recordingSpeechDetectedRef.current = true;
          recordingSilenceSinceMsRef.current = null;
          return;
        }

        if (!recordingSpeechDetectedRef.current) {
          if (elapsedMs >= VOICE_MAX_INITIAL_SILENCE_MS) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            stopActiveRecorder("silence");
          }
          return;
        }

        if (rms < VOICE_SILENCE_RMS_THRESHOLD) {
          if (recordingSilenceSinceMsRef.current === null) {
            recordingSilenceSinceMsRef.current = now;
          } else if (
            elapsedMs >= VOICE_MIN_AUTOSTOP_ELAPSED_MS &&
            now - recordingSilenceSinceMsRef.current >= VOICE_SILENCE_HOLD_MS
          ) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            stopActiveRecorder("silence");
          }
          return;
        }

        recordingSilenceSinceMsRef.current = null;
      }, VOICE_ACTIVITY_POLL_MS);

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (!isCurrentCapture()) return;
        const autoStopReason = recordingAutoStopReasonRef.current;
        const startedAt = recordingStartedAtMsRef.current;
        const elapsedMs =
          startedAt === null ? 0 : Math.max(0, performance.now() - startedAt);
        clearRecordingMonitor();

        try {
          if (!chunksRef.current.some((chunk) => chunk.size > 0)) {
            if (autoStopReason === "silence") {
              setStatus(t("status.voiceAutoStoppedSilence"));
            } else if (autoStopReason === "limit") {
              setStatus(t("status.voiceAutoStoppedLimit"));
            } else {
              setStatus(null);
            }
            setCompanionState("idle");
            return;
          }

          const totalBytes = chunksRef.current.reduce(
            (sum, chunk) => sum + chunk.size,
            0,
          );
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          const speechDetected = recordingSpeechDetectedRef.current;
          void frontendLog(
            "info",
            `voice recording finished: mime=${blob.type || "audio/webm"} bytes=${totalBytes} elapsedMs=${Math.round(elapsedMs)} speechDetected=${speechDetected}`,
          );

          if (
            elapsedMs < VOICE_MIN_TRANSCRIPTION_MS ||
            totalBytes < VOICE_MIN_TRANSCRIPTION_BYTES
          ) {
            setStatus(t("status.voiceAutoStoppedSilence"));
            setCompanionState("idle");
            return;
          }

          setCompanionState("transcribing");
          setStatus(t("status.transcribing"));
          const activeSessionId = activeTranscriptionSessionIdRef.current;
          if (!activeSessionId) {
            throw new Error("No active transcription session.");
          }
          const upload = await prepareTranscriptionUpload(
            blob,
            transcriptionProviderRef.current,
          );
          void frontendLog(
            "info",
            `voice transcription upload: provider=${transcriptionProviderRef.current} mime=${upload.mimeType} bytes=${upload.totalBytes} chunks=${upload.chunks.length}`,
          );
          for (const chunk of upload.chunks) {
            await appendTranscriptionAudio({
              sessionId: activeSessionId,
              audioBase64: chunk,
              mimeType: upload.mimeType,
            }, transcriptionContextId);
            if (!isCurrentCapture()) {
              throw new Error("DESKTOP_SESSION_CHANGED");
            }
          }
          const transcript = await commitTranscriptionTurn({
            sessionId: activeSessionId,
          }, transcriptionContextId);
          if (!isCurrentCapture()) {
            throw new Error("DESKTOP_SESSION_CHANGED");
          }
          await stopTranscriptionSession({ sessionId: activeSessionId }, transcriptionContextId).catch(
            () => undefined,
          );
          activeTranscriptionSessionIdRef.current = null;
          const cleanedTranscript = transcript.trim();
          if (cleanedTranscript) {
            setStatus(
              t("status.voiceRecognized", {
                text: cleanedTranscript,
              }),
            );
            await waitMs(VOICE_TRANSCRIPT_PREVIEW_MS);
            if (!isCurrentCapture()) {
              throw new Error("DESKTOP_SESSION_CHANGED");
            }
            await onTranscript(cleanedTranscript, transcriptionContextId);
          } else {
            setStatus(null);
            if (autoStopReason === "silence") {
              setStatus(t("status.voiceAutoStoppedSilence"));
            } else if (autoStopReason === "limit") {
              setStatus(t("status.voiceAutoStoppedLimit"));
            } else {
              setStatus(null);
            }
            setCompanionState("idle");
          }
        } catch (caughtError) {
          if (!isCurrentCapture()) return;
          const fallbackMessage = t("status.voiceTranscriptionFailed");
          const detailedMessage = errorMessage(caughtError, fallbackMessage);
          const message = import.meta.env.DEV
            ? detailedMessage
            : fallbackMessage;
          void frontendLog(
            "error",
            `voice transcription failed: ${detailedMessage}`,
          );
          setError(message);
          setStatus(message);
          setCompanionState("error");
        } finally {
          if (!isCurrentCapture()) return;
          setIsRecording(false);
          clearRecordingMonitor();
          clearRecordingStream();
          mediaRecorderRef.current = null;
          if (activeTranscriptionSessionIdRef.current) {
            await stopTranscriptionSession({
              sessionId: activeTranscriptionSessionIdRef.current,
            }, transcriptionContextId).catch(() => undefined);
            activeTranscriptionSessionIdRef.current = null;
          }
          chunksRef.current = [];
          recordingAutoStopReasonRef.current = null;
          captureBusyRef.current = false;
        }
      };

      recorder.start();
      setError(null);
      setIsRecording(true);
      setCompanionState("listening");
      setStatus(t("status.listening"));
    } catch (caughtError) {
      if (!isCurrentCapture()) return;
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : t("status.microphoneAccessFailed");
      setError(message);
      setStatus(message);
      setCompanionState("error");
      setIsRecording(false);
      clearRecordingMonitor();
      clearRecordingStream();
      mediaRecorderRef.current = null;
      if (activeTranscriptionSessionIdRef.current) {
        await stopTranscriptionSession({
          sessionId: activeTranscriptionSessionIdRef.current,
        }, transcriptionContextId).catch(() => undefined);
        activeTranscriptionSessionIdRef.current = null;
      }
      chunksRef.current = [];
      recordingAutoStopReasonRef.current = null;
      captureBusyRef.current = false;
    }
  }

  async function stopRecording(
    reason: "manual" | "silence" | "limit" = "manual",
  ) {
    stopActiveRecorder(reason);
  }

  async function toggleRecording() {
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }

  return { isRecording, toggleRecording };
}
