export type JobStatus = "招聘中" | "暂停" | "已关闭";

export interface SalaryFilters {
  role: string;
  region: string;
  experience: string;
  industry: string;
  education: string;
}

export interface SalaryData {
  status?: "ready" | "insufficient_data";
  errorMessage?: string;
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
  research: {
    dataWindow: string;
    confidence: "高" | "中" | "低";
    confidenceReason: string;
    limitations: string[];
    triangulation: {
      requiredSources: number;
      actualSources: number;
      passed: boolean;
      summary: string;
    };
    metricSources: {
      p25: string;
      p50: string;
      p75: string;
    };
    methodology: string[];
    coreSources: string[];
    validationSources: string[];
    sampleNotes: string[];
    evidence: Array<{
      source: string;
      role: string;
      region: string;
      experience: string;
      salaryRange: string;
      publishWindow: string;
      note: string;
    }>;
    disclaimer: string;
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

export interface CandidateEvaluation {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  risks: string[];
  interviewFocuses: string[];
}

export type InterviewMethodKey = "structured" | "behavioral" | "star" | "scenario" | "case";

export interface CandidateInterviewPlanQuestion {
  title: string;
  question: string;
  competency: string;
  questionType: "行为型" | "情景型" | "认知型";
  designIntent: string;
  strongSignals: string[];
  warningSignals: string[];
  followUps: string[];
  methodKey?: InterviewMethodKey;
}

export interface CandidateInterviewPlan {
  recommendedMethods: Array<{
    methodKey: InterviewMethodKey;
    label: string;
    reason: string;
  }>;
  summaryReason: string;
  questions: CandidateInterviewPlanQuestion[];
  evaluationGuide: {
    baseline: string[];
    positiveSignals: string[];
    vetoItems: string[];
  };
  riskReview: Array<{
    dimension: "经历真实性风险" | "能力夸大风险" | "稳定性风险";
    level: "高" | "中" | "低";
    reason: string;
    validationTips: string[];
  }>;
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
  evaluation?: CandidateEvaluation;
  interviewPlan?: CandidateInterviewPlan;
  keyPointAnalysis: Array<{ keyword: string; matched: boolean; evidence: string }>;
  interviewQuestions: Array<{
    title: string;
    text: string;
    probe: string;
    competency?: string;
    starFocus?: string[];
    evaluationSignals?: string[];
  }>;
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

export interface VoiceSegmentInsight {
  coreViewpoint: string;
  keyEvidence: string[];
  relatedKeywords: string[];
  signalType: "加分信号" | "风险信号";
  signalReason: string;
  followUpDirection: string[];
}

export interface VoiceFollowUpPlan {
  coveredKeywords: string[];
  uncoveredKeywords: string[];
  nextQuestion: string;
  objective: string;
  starAnchors: {
    situation: string;
    task: string;
    action: string;
    result: string;
  };
  backupQuestion: string;
}

export interface VoiceRecruiterCoachReport {
  opening: {
    score: number;
    evidence: string[];
    issues: string[];
    suggestion: string;
  };
  informationCompleteness: {
    score: number;
    missingItems: string[];
    suggestionLines: string[];
  };
  followUpDepth: {
    score: number;
    goodExamples: string[];
    missedOpportunities: Array<{
      moment: string;
      suggestion: string;
    }>;
  };
  rhythm: {
    score: number;
    topicJumpLevel: "低" | "中" | "高";
    interviewerTalkRatio: string;
    timeAllocation: string;
    advice: string[];
  };
  conciseImprovements: string[];
}

export interface VoiceFinalEvaluation {
  summary: string;
  passedKeywords: string[];
  pendingKeywords: string[];
  score: number;
  strengths: string[];
  risks: string[];
  interviewerAdvice: {
    nextRoundFocus: string[];
    notRecommendedReasons: string[];
  };
  recruiterCoach: VoiceRecruiterCoachReport;
}

export interface VoiceTranscriptResult {
  transcript: string;
  normalizedTranscript: string;
}

export interface AppState {
  currentUser: string;
  currentJobId: string;
  jobs: Job[];
  candidates: Record<string, Candidate[]>;
  voiceAnalyses: Record<string, VoiceAnalysis[]>;
}

export interface ResumeFilePayload {
  name: string;
  type?: string | null;
  size?: number | null;
  text?: string;
  dataBase64?: string | null;
}
