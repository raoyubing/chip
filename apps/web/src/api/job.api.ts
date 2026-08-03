import type { RequestDTO } from "./dto/request.dto";
import type { ResponseDTO } from "./dto/response.dto";
import type { SchemaDTO } from "./dto/schema.dto";
import { request } from "./client";

export type JobPayload = RequestDTO.CreateJob;
export type UpdateJobPayload = RequestDTO.UpdateJob;
export type MultiCityJobPayload = RequestDTO.CreateMultiCityJob;
export type JobCopilotPayload = RequestDTO.JobCopilot;
export type JobCopilotResult = ResponseDTO.JobCopilot;
export type ResumeUploadPayload = RequestDTO.UploadResumes;
export type ResumeParsePayload = RequestDTO.ParseResumes;

export const jobApi = {
  state: () => request<ResponseDTO.GetState>("/api/state"),
  clearData: () => request<ResponseDTO.MutateState>("/api/data/clear", { method: "POST" }),
  setCurrentJob: (jobId: string) => request<ResponseDTO.MutateState>("/api/current-job", { method: "POST", body: JSON.stringify({ jobId } satisfies RequestDTO.SetCurrentJob) }),
  createJob: (payload: JobPayload) => request<ResponseDTO.MutateState>("/api/jobs", { method: "POST", body: JSON.stringify(payload) }),
  createMultiCityJob: (payload: MultiCityJobPayload) => request<ResponseDTO.MutateState>("/api/jobs/multi-city", { method: "POST", body: JSON.stringify(payload) }),
  addJobCityTask: (jobId: string, payload: RequestDTO.AddJobCityTask) => request<ResponseDTO.MutateState>(`/api/jobs/${jobId}/cities`, { method: "POST", body: JSON.stringify(payload) }),
  updateJob: (id: string, payload: UpdateJobPayload) => request<ResponseDTO.MutateState>(`/api/jobs/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
  generateJobCopilot: (payload: JobCopilotPayload) =>
    request<ResponseDTO.JobCopilot>("/api/job-copilot", { method: "POST", body: JSON.stringify(payload) }),
  closeJob: (id: string) => request<ResponseDTO.MutateState>(`/api/jobs/${id}/close`, { method: "POST" }),
  reopenJob: (id: string, targetMonth: string, demandType: RequestDTO.ReopenJob["demandType"], plannedHeadcount: number) => request<ResponseDTO.MutateState>(`/api/jobs/${id}/reopen`, { method: "POST", body: JSON.stringify({ targetMonth, demandType, plannedHeadcount } satisfies RequestDTO.ReopenJob) }),
  deleteJob: (id: string) => request<ResponseDTO.MutateState>(`/api/jobs/${id}`, { method: "DELETE" }),
  parseResumes: (payload: ResumeParsePayload) =>
    request<ResponseDTO.ParseResumes>("/api/resumes/parse", { method: "POST", body: JSON.stringify(payload) }),
  uploadResumes: (jobId: string, payload: ResumeUploadPayload) =>
    request<ResponseDTO.UploadResumes>(`/api/jobs/${jobId}/resumes`, { method: "POST", body: JSON.stringify(payload) }),
  refreshSalary: (jobId: string, filters: SchemaDTO.SalaryFilters) =>
    request<{ state: SchemaDTO.AppState }>(`/api/jobs/${jobId}/salary/refresh`, { method: "POST", body: JSON.stringify(filters) }),
};
