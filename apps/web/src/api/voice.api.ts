import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import { request } from "./client";

export type VoiceChunkPayload = RequestDTO.VoiceChunk;
export type VoiceSegmentAnalyzePayload = RequestDTO.VoiceSegmentAnalyze;
export type VoiceFinalEvaluatePayload = RequestDTO.VoiceFinalEvaluate;
export type VoiceAnalysisPayload = RequestDTO.VoiceAnalysisPayload;

export const voiceApi = {
  transcribeVoiceChunk: (payload: VoiceChunkPayload) =>
    request<ResponseDTO.VoiceTranscript>("/api/voice/transcribe", { method: "POST", body: JSON.stringify(payload) }),
  saveVoiceTranscriptSegment: (payload: VoiceSegmentAnalyzePayload) =>
    request<{ ok: true }>("/api/voice/segments", { method: "POST", body: JSON.stringify(payload) }),
  analyzeVoiceSegment: (payload: VoiceSegmentAnalyzePayload) =>
    request<ResponseDTO.VoiceSegmentAnalyze>("/api/voice/analyze-segment", { method: "POST", body: JSON.stringify(payload) }),
  evaluateVoiceInterview: (payload: VoiceFinalEvaluatePayload) =>
    request<ResponseDTO.VoiceFinalEvaluate>("/api/voice/final-evaluate", { method: "POST", body: JSON.stringify(payload) }),
  saveVoiceAnalysis: (payload: VoiceAnalysisPayload) =>
    request<ResponseDTO.SaveVoiceAnalysis>("/api/voice-analyses", { method: "POST", body: JSON.stringify(payload) }),
  deleteVoiceAnalysis: (id: string) =>
    request<{ state: import("./dto/schema.dto").SchemaDTO.AppState }>(`/api/voice-analyses/${id}`, { method: "DELETE" }),
};
