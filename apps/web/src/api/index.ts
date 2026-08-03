import { authApi } from "./auth.api";
import { candidateApi } from "./candidate.api";
import { fileApi } from "./file.api";
import { jobApi } from "./job.api";
import { regionApi } from "./region.api";
import { salaryApi } from "./salary.api";
import { voiceApi } from "./voice.api";

export type { InterviewStagePayload } from "./candidate.api";
export type { JobCopilotPayload, JobCopilotResult, JobPayload, MultiCityJobPayload, ResumeUploadPayload, UpdateJobPayload } from "./job.api";
export type { VoiceAnalysisPayload, VoiceChunkPayload, VoiceFinalEvaluatePayload, VoiceSegmentAnalyzePayload } from "./voice.api";

export const api = {
  ...authApi,
  ...jobApi,
  ...regionApi,
  ...fileApi,
  ...candidateApi,
  ...salaryApi,
  ...voiceApi,
};
export type { AuthAccountSummary } from "./auth.api";
