export type JobStatus = "招聘中" | "暂停" | "已关闭";

export interface SalaryFilters {
  region: string;
  experience: string;
  industry: string;
  education: string;
}

export interface SalaryData {
  filters: SalaryFilters;
  benchmarkRegion: string;
  jobFamily: string;
  p25: number;
  p50: number;
  p75: number;
  suggestedLow: number;
  suggestedHigh: number;
  anchor: number;
  experienceBands: Array<{ label: string; p25: number; p50: number; p75: number }>;
  regionComparison: Array<{ city: string; p25: number; p50: number; p75: number }>;
  educationComparison: Array<{ label: string; value: number }>;
  industryComparison: Array<{ name: string; value: number }>;
  updatedAt: string;
  insights: Array<{ title: string; text: string }>;
  advice: {
    summary: string;
    reasons: string[];
    keywordPremiums: string[];
  };
}

export interface Job {
  id: string;
  title: string;
  dept: string;
  location: string;
  experience: string;
  level: string;
  salaryRange: string;
  keywords: string;
  description: string;
  status: JobStatus;
  resumeCount: number;
  salaryData: SalaryData | null;
  sortOrder: number;
}

export interface CandidateTimeline {
  recommendedAt?: string;
  firstInterviewPassedAt?: string;
  secondInterviewPassedAt?: string;
  offerAt?: string;
  onboardedAt?: string;
}

export interface Candidate {
  id: string;
  jobId: string;
  name: string;
  source: string;
  score: number;
  conclusion: string;
  reason: string;
  resumeText: string;
  uploadTime: string;
  fileName?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  fileDataBase64?: string | null;
  keyPointAnalysis: Array<{ keyword: string; matched: boolean; evidence: string }>;
  interviewQuestions: Array<{ title: string; text: string; probe: string }>;
  interviewStage?: "初试" | "复试" | "offer";
  stageRecommendation?: "是" | "否";
  interviewResult?: "通过" | "淘汰" | "待定" | "未到面";
  onboarded?: "待入职" | "是" | "否";
  reportMonth?: string;
  interviewReason?: string;
  reasonTags?: string[];
  interviewTimeline?: CandidateTimeline;
}

export interface VoiceAnalysis {
  id: string;
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
  recommendation: "建议推进" | "建议复核" | "暂缓推进";
  createdAt: string;
}

export interface AppState {
  currentUser: string;
  currentJobId: string;
  jobs: Job[];
  candidates: Record<string, Candidate[]>;
  voiceAnalyses: Record<string, VoiceAnalysis[]>;
}
