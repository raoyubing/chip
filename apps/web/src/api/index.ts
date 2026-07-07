import { candidateApi } from "./candidate.api";
import { fileApi } from "./file.api";
import { jobApi } from "./job.api";
import { salaryApi } from "./salary.api";
import { voiceApi } from "./voice.api";

export type { InterviewStagePayload } from "./candidate.api";
export type { JobCopilotPayload, JobCopilotResult, JobPayload, ResumeUploadPayload } from "./job.api";
export type { VoiceAnalysisPayload, VoiceChunkPayload, VoiceFinalEvaluatePayload, VoiceSegmentAnalyzePayload } from "./voice.api";

export const api = {
  ...jobApi,
  ...fileApi,
  ...candidateApi,
  ...salaryApi,
  ...voiceApi,
};
