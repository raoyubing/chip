import { request } from "./client";

export interface RecruitmentReviewIssue {
  problem: string;
  dataEvidence: string[];
  remarkEvidence: string[];
  internalCauses: string[];
  externalCauses: string[];
  solutions: string[];
  ownerSuggestions: string[];
}

export interface RecruitmentReviewPayload {
  granularity: "month" | "quarter" | "year";
  selectedPeriod: string;
  scopeLabel: string;
  jobScope: {
    id: string;
    label: string;
  };
  snapshot: Record<string, unknown>;
  jobs: Array<{
    id: string;
    title: string;
    department: string;
    location: string;
    experience: string;
    level: string;
    salaryRange: string;
    keywords: string;
    description: string;
    status: "招聘中" | "暂停" | "已关闭";
  }>;
  remarks: Array<{
    candidateRef: string;
    jobTitle: string;
    stage: string;
    occurredAt?: string;
    remark: string;
  }>;
  externalEvidence: Array<{
    jobTitle: string;
    location: string;
    currentSalaryRange: string;
    p25: number;
    p50: number;
    p75: number;
    confidence: "高" | "中" | "低";
    updatedAt: string;
    sourceSummary: string;
  }>;
  externalSignals: Array<{
    type: "competing_offer";
    evidence: string;
    count?: number;
  }>;
  forceRefresh?: boolean;
}

export interface RecruitmentReviewResult {
  generatedAt: string;
  scopeLabel: string;
  cached: boolean;
  analysisMode: "deepseek" | "rules";
  notice: string;
  issues: RecruitmentReviewIssue[];
}

export const analyticsApi = {
  generateRecruitmentReview: (payload: RecruitmentReviewPayload) =>
    request<RecruitmentReviewResult>("/api/analytics/recruitment-review", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};
