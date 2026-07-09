import type { SchemaDTO } from "./schema.dto.js";

export declare namespace RequestDTO {
  export interface SetCurrentJob {
    jobId: string;
  }

  export type CreateJob = Pick<SchemaDTO.Job, "title" | "dept" | "location" | "experience" | "level" | "salaryRange" | "keywords" | "scoreWeights" | "description" | "status">;
  export type UpdateJob = CreateJob;

  export interface JobPath {
    ":id": string;
  }

  export interface JobCopilot extends CreateJob {
    useCase: "jd-optimize" | "interview-questions";
  }

  export interface UploadResumes {
    name?: string;
    source?: string;
    resumeText?: string;
    files?: SchemaDTO.ResumeFilePayload[];
    duplicateAction?: "skip" | "overwrite";
  }

  export interface UploadFile {
    file: File;
    scene?: SchemaDTO.FileUploadScene;
  }

  export interface DeleteFile {
    object_key: string;
  }

  export interface GetFileViewUrl {
    object_key: string;
    purpose?: "default" | "kkfile" | "markdown";
    content_type?: string;
  }

  export interface CandidatePath {
    ":id": string;
  }

  export interface AddToTalentPool {
    note?: string;
  }

  export interface RecommendTalentToJob {
    jobId: string;
    duplicateAction?: "skip" | "overwrite";
  }

  export interface InterviewStage {
    interviewStage: "推荐" | "初试" | "复试" | "offer";
    stageRecommendation: "待定" | "是" | "否";
    interviewResult: "通过" | "淘汰" | "待定" | "未到面";
    onboarded: "待入职" | "是" | "否";
    reportMonth: string;
    interviewReason: string;
    reasonTags: string[];
    interviewTimeline: SchemaDTO.CandidateTimeline;
  }

  export type SalaryResearch = SchemaDTO.SalaryFilters;

  export interface VoiceChunk {
    audioBase64: string;
    mimeType: string;
    fileName?: string;
    normalize?: boolean;
  }

  export interface VoiceSegmentAnalyze {
    sessionId: string;
    segmentId: string;
    jobId: string;
    candidateId: string;
    segmentIndex: number;
    rawTranscript: string;
    normalizedTranscript: string;
  }

  export interface VoiceFinalEvaluate {
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
    recommendation: SchemaDTO.VoiceAnalysis["recommendation"];
  }
}
