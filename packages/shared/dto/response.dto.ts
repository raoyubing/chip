import type { SchemaDTO } from "./schema.dto.js";

export declare namespace ResponseDTO {
  export type GetState = SchemaDTO.AppState;
  export type MutateState = SchemaDTO.AppState;

  export interface UploadResumes {
    state: SchemaDTO.AppState;
  }

  export type UploadFile = SchemaDTO.UploadedFile;
  export type GetFileViewUrl = SchemaDTO.FileViewUrl;

  export interface JobCopilot {
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

  export interface CandidateInterviewPlan {
    interviewPlan: SchemaDTO.CandidateInterviewPlan;
    state: SchemaDTO.AppState;
  }

  export interface TalentRevivalScript {
    script: string;
  }

  export interface SalaryResearch {
    salaryData: SchemaDTO.SalaryData;
  }

  export type VoiceTranscript = SchemaDTO.VoiceTranscriptResult;

  export interface VoiceSegmentAnalyze {
    quickInsight: SchemaDTO.VoiceSegmentInsight;
    followUp: SchemaDTO.VoiceFollowUpPlan;
  }

  export type VoiceFinalEvaluate = SchemaDTO.VoiceFinalEvaluation;

  export interface SaveVoiceAnalysis {
    state: SchemaDTO.AppState;
    analysis: SchemaDTO.VoiceAnalysis;
  }

  export interface ActionResult {
    success: boolean;
  }
}
