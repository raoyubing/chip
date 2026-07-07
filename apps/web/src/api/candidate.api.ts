import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import { request } from "./client";

export type InterviewStagePayload = RequestDTO.InterviewStage;

export const candidateApi = {
  markInterview: (id: string) => request<ResponseDTO.MutateState>(`/api/candidates/${id}/mark-interview`, { method: "POST" }),
  generateCandidateInterviewPlan: (id: string) =>
    request<ResponseDTO.CandidateInterviewPlan>(`/api/candidates/${id}/interview-plan`, { method: "POST", body: JSON.stringify({ candidateId: id }) }),
  updateInterviewStage: (id: string, payload: InterviewStagePayload) =>
    request<ResponseDTO.MutateState>(`/api/candidates/${id}/interview-stage`, { method: "PATCH", body: JSON.stringify(payload) }),
  deleteCandidate: (id: string) => request<ResponseDTO.MutateState>(`/api/candidates/${id}`, { method: "DELETE" }),
};
