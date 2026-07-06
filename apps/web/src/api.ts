import type { AppState, CandidateInterviewPlan, CandidateTimeline, Job, ResumeFilePayload, SalaryFilters, VoiceAnalysis, VoiceFinalEvaluation, VoiceFollowUpPlan, VoiceSegmentInsight, VoiceTranscriptResult } from "./types";

function buildNetworkErrorMessage(url: string) {
  if (url.startsWith("/api/voice")) {
    return "访音解析服务连接失败，请确认本地后端已启动后重试。";
  }
  return "本地服务连接失败，请确认 Node 后端已启动并监听 5175 端口。";
}

function buildHttpErrorMessage(url: string, status: number, text: string) {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (status >= 500) {
    if (url.startsWith("/api/voice")) {
      return "访音解析服务暂时不可用，请确认本地后端已启动后重试。";
    }
    return "本地服务暂时不可用，请确认 Node 后端已启动并监听 5175 端口。";
  }
  return `请求失败：${status}`;
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      ...options,
    });
  } catch {
    throw new Error(buildNetworkErrorMessage(url));
  }
  if (!response.ok) {
    const text = await response.text();
    let message = buildHttpErrorMessage(url, response.status, text);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) message = String(parsed.message);
    } catch {
      message = buildHttpErrorMessage(url, response.status, text);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  state: () => request<AppState>("/api/state"),
  reset: () => request<AppState>("/api/reset", { method: "POST" }),
  setCurrentJob: (jobId: string) => request<AppState>("/api/current-job", { method: "POST", body: JSON.stringify({ jobId }) }),
  createJob: (payload: JobPayload) => request<AppState>("/api/jobs", { method: "POST", body: JSON.stringify(payload) }),
  updateJob: (id: string, payload: JobPayload) => request<AppState>(`/api/jobs/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  generateJobCopilot: (payload: JobCopilotPayload) =>
    request<JobCopilotResult>("/api/job-copilot", { method: "POST", body: JSON.stringify(payload) }),
  closeJob: (id: string) => request<AppState>(`/api/jobs/${id}/close`, { method: "POST" }),
  deleteJob: (id: string) => request<AppState>(`/api/jobs/${id}`, { method: "DELETE" }),
  uploadResumes: (jobId: string, payload: ResumeUploadPayload) =>
    request<{ state: AppState }>(`/api/jobs/${jobId}/resumes`, { method: "POST", body: JSON.stringify(payload) }),
  markInterview: (id: string) => request<AppState>(`/api/candidates/${id}/mark-interview`, { method: "POST" }),
  generateCandidateInterviewPlan: (id: string) =>
    request<{ interviewPlan: CandidateInterviewPlan; state: AppState }>(`/api/candidates/${id}/interview-plan`, { method: "POST", body: JSON.stringify({ candidateId: id }) }),
  updateInterviewStage: (id: string, payload: InterviewStagePayload) =>
    request<AppState>(`/api/candidates/${id}/interview-stage`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCandidate: (id: string) => request<AppState>(`/api/candidates/${id}`, { method: "DELETE" }),
  refreshSalary: (jobId: string, filters: SalaryFilters) =>
    request<{ state: AppState }>(`/api/jobs/${jobId}/salary/refresh`, { method: "POST", body: JSON.stringify(filters) }),
  researchSalary: (filters: SalaryFilters) =>
    request<{ salaryData: import("./types").SalaryData }>("/api/salary/research", { method: "POST", body: JSON.stringify(filters) }),
  transcribeVoiceChunk: (payload: VoiceChunkPayload) =>
    request<VoiceTranscriptResult>("/api/voice/transcribe", { method: "POST", body: JSON.stringify(payload) }),
  analyzeVoiceSegment: (payload: VoiceSegmentAnalyzePayload) =>
    request<{ quickInsight: VoiceSegmentInsight; followUp: VoiceFollowUpPlan }>("/api/voice/analyze-segment", { method: "POST", body: JSON.stringify(payload) }),
  evaluateVoiceInterview: (payload: VoiceFinalEvaluatePayload) =>
    request<VoiceFinalEvaluation>("/api/voice/final-evaluate", { method: "POST", body: JSON.stringify(payload) }),
  saveVoiceAnalysis: (payload: VoiceAnalysisPayload) =>
    request<{ state: AppState; analysis: VoiceAnalysis }>("/api/voice-analyses", { method: "POST", body: JSON.stringify(payload) }),
  deleteVoiceAnalysis: (id: string) =>
    request<{ state: AppState }>(`/api/voice-analyses/${id}`, { method: "DELETE" }),
};

export type JobPayload = Pick<Job, "title" | "dept" | "location" | "experience" | "level" | "salaryRange" | "keywords" | "description" | "status">;

export interface JobCopilotPayload extends JobPayload {
  useCase: "jd-optimize" | "interview-questions";
}

export interface JobCopilotResult {
  recommendedTitle: string;
  optimizedDescription: string;
  actionSuggestions: string[];
  sourcingTitles: string[];
  interviewQuestions: Array<{
    title: string;
    text: string;
    probe: string;
    competency?: string;
    starFocus?: string[];
    evaluationSignals?: string[];
  }>;
}

export interface ResumeUploadPayload {
  name?: string;
  source?: string;
  resumeText?: string;
  files?: ResumeFilePayload[];
}

export interface InterviewStagePayload {
  interviewStage: "初试" | "复试" | "offer";
  stageRecommendation: "是" | "否";
  interviewResult: "通过" | "淘汰" | "待定" | "未到面";
  onboarded: "待入职" | "是" | "否";
  reportMonth: string;
  interviewReason: string;
  reasonTags: string[];
  interviewTimeline: CandidateTimeline;
}

export interface VoiceChunkPayload {
  audioBase64: string;
  mimeType: string;
  fileName?: string;
}

export interface VoiceSegmentAnalyzePayload {
  sessionId: string;
  segmentId: string;
  jobId: string;
  candidateId: string;
  segmentIndex: number;
  rawTranscript: string;
  normalizedTranscript: string;
}

export interface VoiceFinalEvaluatePayload {
  sessionId: string;
  jobId: string;
  candidateId: string;
}

export interface VoiceAnalysisPayload {
  jobId: string;
  candidateId: string;
  audioName: string;
  audioType?: string | null;
  audioSize?: number | null;
  transcript: string;
  summary: string;
  jobFitAdvice: string;
  communicationStrengths: string[];
  communicationRisks: string[];
  recruiterSuggestions: string[];
  recruiterReview: Array<{ title: string; level: "良好" | "注意" | "待优化"; text: string }>;
  recommendation: VoiceAnalysis["recommendation"];
}
