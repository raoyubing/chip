import type { AppState, CandidateTimeline, Job, ResumeFilePayload, SalaryFilters } from "./types";

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = options.body ? { "Content-Type": "application/json", ...(options.headers || {}) } : options.headers;
  const response = await fetch(url, {
    headers,
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `请求失败：${response.status}`);
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
  updateInterviewStage: (id: string, payload: InterviewStagePayload) =>
    request<AppState>(`/api/candidates/${id}/interview-stage`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCandidate: (id: string) => request<AppState>(`/api/candidates/${id}`, { method: "DELETE" }),
  refreshSalary: (jobId: string, filters: SalaryFilters) =>
    request<{ state: AppState }>(`/api/jobs/${jobId}/salary/refresh`, { method: "POST", body: JSON.stringify(filters) }),
};

export type JobPayload = Pick<Job, "title" | "dept" | "location" | "experience" | "level" | "salaryRange" | "keywords" | "description" | "status">;

export interface JobCopilotPayload extends JobPayload {
  useCase: "jd-optimize" | "interview-questions";
}

export interface JobCopilotResult {
  recommendedTitle: string;
  optimizedDescription: string;
  actionSuggestions: string[];
  interviewQuestions: Array<{ title: string; text: string; probe: string }>;
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
