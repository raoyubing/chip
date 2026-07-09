import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import { request } from "./client";

export type InterviewStagePayload = RequestDTO.InterviewStage;
export type AddToTalentPoolPayload = RequestDTO.AddToTalentPool;
export type RecommendTalentToJobPayload = RequestDTO.RecommendTalentToJob;

export const candidateApi = {
  markInterview: (id: string) => request<ResponseDTO.MutateState>(`/api/candidates/${id}/mark-interview`, { method: "POST" }),
  addToTalentPool: (id: string, payload: AddToTalentPoolPayload = {}) =>
    request<ResponseDTO.MutateState>(`/api/candidates/${id}/talent-pool`, { method: "POST", body: JSON.stringify(payload) }),
  recommendTalentToJob: (id: string, payload: RecommendTalentToJobPayload) =>
    request<ResponseDTO.MutateState>(`/api/candidates/${id}/recommend-to-job`, { method: "POST", body: JSON.stringify(payload) }),
  generateTalentRevivalScript: (id: string, jobId: string) =>
    request<ResponseDTO.TalentRevivalScript>(`/api/candidates/${id}/talent-revival-script`, { method: "POST", body: JSON.stringify({ jobId }) }),
  generateCandidateInterviewPlan: (id: string) =>
    request<ResponseDTO.CandidateInterviewPlan>(`/api/candidates/${id}/interview-plan`, { method: "POST", body: JSON.stringify({ candidateId: id }) }),
  updateInterviewStage: (id: string, payload: InterviewStagePayload) =>
    request<ResponseDTO.MutateState>(`/api/candidates/${id}/interview-stage`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCandidate: (id: string) => request<ResponseDTO.MutateState>(`/api/candidates/${id}`, { method: "DELETE" }),
};
