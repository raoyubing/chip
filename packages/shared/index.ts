export type JobStatus = "招聘中" | "暂停" | "已关闭";

export interface SalaryFilters {
  role: string;
  region: string;
  experience: string;
  industry: string;
  education: string;
}

export type RegionLevel = "province" | "city" | "district";

export interface RegionNode {
  code: string;
  name: string;
  level: RegionLevel;
  children: RegionNode[];
}

// BOSS 直聘「公司行业」筛选，2026-07-12 从已登录职位搜索页读取。
// 页面只允许选择二级行业，因此前端也只提交这些可被 BOSS 识别的名称。
export const bossIndustryGroups = [
  { code: "100000", name: "互联网/AI", options: [
    ["100020", "互联网"], ["100001", "电子商务"], ["100021", "计算机软件"], ["100007", "生活服务(O2O)"],
    ["100015", "企业服务"], ["100006", "医疗健康"], ["100002", "游戏"], ["100003", "社交网络与媒体"],
    ["100028", "人工智能"], ["100029", "云计算"], ["100012", "在线教育"], ["100023", "计算机服务"],
    ["100005", "大数据"], ["100004", "广告营销"], ["100030", "物联网"], ["100017", "新零售"], ["100016", "信息安全"],
  ] },
  { code: "101400", name: "电子/通信/半导体", options: [
    ["101405", "半导体/芯片"], ["101406", "电子/硬件开发"], ["101402", "通信/网络设备"], ["101401", "智能硬件/消费电子"],
    ["101403", "运营商/增值服务"], ["101404", "计算机硬件"], ["101407", "电子/半导体/集成电路"],
  ] },
  { code: "101100", name: "服务业", options: [
    ["101101", "餐饮"], ["101111", "美容"], ["101112", "美发"], ["101102", "酒店/民宿"], ["101107", "休闲/娱乐"],
    ["101113", "运动/健身"], ["101114", "保健/养生"], ["101109", "家政服务"], ["101103", "旅游/景区"],
    ["101105", "婚庆/摄影"], ["101110", "宠物服务"], ["101108", "回收/维修"], ["101104", "美容/美发"], ["101106", "其他生活服务"],
  ] },
  { code: "101000", name: "消费品/批发/零售", options: [
    ["101011", "批发/零售"], ["101012", "进出口贸易"], ["101001", "食品/饮料/烟酒"], ["101003", "服装/纺织"],
    ["101009", "家具/家居"], ["101010", "家用电器"], ["101002", "日化"], ["101006", "珠宝/首饰"],
    ["101004", "家具/家电/家居"], ["101013", "其他消费品"],
  ] },
  { code: "100700", name: "房地产/建筑", options: [
    ["100704", "装修装饰"], ["100708", "房屋建筑工程"], ["100709", "土木工程"], ["100710", "机电工程"],
    ["100707", "物业管理"], ["100706", "房地产中介/租赁"], ["100705", "建筑材料"], ["100701", "房地产开发经营"],
    ["100703", "建筑设计"], ["100711", "建筑工程咨询服务"], ["100712", "土地与公共设施管理"], ["100702", "工程施工"],
  ] },
  { code: "100300", name: "教育培训", options: [
    ["100303", "培训/辅导机构"], ["100305", "职业培训"], ["100301", "学前教育"], ["100302", "学校/学历教育"], ["100304", "学术/科研"],
  ] },
  { code: "100100", name: "广告/传媒/文化/体育", options: [
    ["100104", "文化艺术/娱乐"], ["100105", "体育"], ["100101", "广告/公关/会展"], ["100103", "广播/影视"], ["100102", "新闻/出版"],
  ] },
  { code: "100900", name: "制造业", options: [
    ["100906", "通用设备"], ["100907", "专用设备"], ["100908", "电气机械/器材"], ["100909", "金属制品"],
    ["100910", "非金属矿物制品"], ["100911", "橡胶/塑料制品"], ["100912", "化学原料/化学制品"], ["100913", "仪器仪表"],
    ["100914", "自动化设备"], ["100904", "印刷/包装/造纸"], ["100905", "铁路/船舶/航空/航天制造"],
    ["100915", "计算机/通信/其他电子设备"], ["100916", "新材料"], ["100901", "机械设备/机电/重工"],
    ["100902", "仪器仪表/工业自动化"], ["100903", "原材料及加工/模具"], ["100917", "其他制造业"],
  ] },
  { code: "100600", name: "专业服务", options: [
    ["100601", "咨询"], ["100605", "财务/审计/税务"], ["100604", "人力资源服务"], ["100602", "法律"],
    ["100609", "检测/认证/知识产权"], ["100603", "翻译"], ["100608", "其他专业服务"],
  ] },
  { code: "100400", name: "制药/医疗", options: [
    ["100402", "医疗服务"], ["100404", "医美服务"], ["100403", "医疗器械"], ["100405", "IVD"],
    ["100401", "生物/制药"], ["100406", "医药批发零售"], ["100407", "医疗研发外包"],
  ] },
  { code: "100800", name: "汽车", options: [
    ["100804", "新能源汽车"], ["100805", "汽车智能网联"], ["100806", "汽车经销商"], ["100807", "汽车后市场"],
    ["100801", "汽车研发/制造"], ["100802", "汽车零部件"], ["100808", "摩托车/自行车制造"], ["100803", "4S店/后市场"],
  ] },
  { code: "100500", name: "交通运输/物流", options: [
    ["100505", "即时配送"], ["100506", "快递"], ["100507", "公路物流"], ["100508", "同城货运"], ["100509", "跨境物流"],
    ["100510", "装卸搬运和仓储业"], ["100511", "客运服务"], ["100512", "港口/铁路/公路/机场"],
    ["100501", "交通/运输"], ["100502", "物流/仓储"],
  ] },
  { code: "101200", name: "能源/化工/环保", options: [
    ["101208", "光伏"], ["101209", "储能"], ["101210", "动力电池"], ["101211", "风电"], ["101212", "其他新能源"],
    ["101207", "环保"], ["101202", "化工"], ["101205", "电力/热力/燃气/水利"], ["101201", "石油/石化"],
    ["101203", "矿产/地质"], ["101204", "采掘/冶炼"], ["101206", "新能源"],
  ] },
  { code: "100200", name: "金融", options: [
    ["100206", "互联网金融"], ["100201", "银行"], ["100207", "投资/融资"], ["100203", "证券/期货"], ["100204", "基金"],
    ["100202", "保险"], ["100208", "租赁/拍卖/典当/担保"], ["100205", "信托"], ["100209", "财富管理"], ["100210", "其他金融业"],
  ] },
  { code: "101300", name: "政府/非营利组织/其他", options: [
    ["101303", "农/林/牧/渔"], ["101302", "非营利组织"], ["101301", "政府/公共事业"], ["101304", "其他行业"],
  ] },
] as const;

export const bossIndustryCodeByName: Readonly<Record<string, string>> = Object.fromEntries(
  bossIndustryGroups.flatMap((group) => group.options.map(([code, name]) => [name, code])),
);

export const bossIndustryLegacyAliases: Readonly<Record<string, string>> = {
  "互联网/AI": "互联网",
  AI: "人工智能",
  "消费品/零售": "批发/零售",
  制造业: "其他制造业",
  金融: "其他金融业",
  教育: "培训/辅导机构",
};

export function normalizeBossIndustryName(value: string) {
  const normalized = value.trim();
  if (bossIndustryCodeByName[normalized]) return normalized;
  return bossIndustryLegacyAliases[normalized] || "互联网";
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

export interface JobScoreWeights {
  experience: number;
  professional: number;
  stability: number;
  education: number;
  business: number;
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
  scoreWeights: JobScoreWeights;
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
  scoreDimensions?: Array<{
    key: keyof JobScoreWeights;
    label: string;
    weight: number;
    score: number;
    reason: string;
  }>;
}

export type InterviewMethodKey = "structured" | "behavioral" | "star" | "scenario" | "case";

export interface CandidateInterviewPlanQuestion {
  title: string;
  question: string;
  competency: string;
  questionType: "行为型" | "情景型" | "认知型";
  directionTitle?: string;
  cutInPoint?: string;
  designIntent: string;
  strongSignals: string[];
  warningSignals: string[];
  followUps: string[];
  judgmentSuggestion?: string;
  isStressScenario?: boolean;
  scenario?: string;
  evaluationFocus?: string[];
  methodKey?: InterviewMethodKey;
}

export interface CandidateInterviewPlan {
  focusDirections: Array<{
    title: string;
    gapReason: string;
  }>;
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
  remark?: string;
  resumeText: string;
  uploadTime: string;
  fileName?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  fileDataBase64?: string | null;
  fileObjectKey?: string | null;
  fileUrl?: string | null;
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
  interviewStage?: "推荐" | "初试" | "复试" | "offer";
  stageRecommendation?: "待定" | "是" | "否";
  interviewResult?: "通过" | "淘汰" | "待定" | "未到面";
  onboarded?: "待入职" | "是" | "否";
  reportMonth?: string;
  interviewReason?: string;
  reasonTags?: string[];
  interviewTimeline?: CandidateTimeline;
  isInTalentPool?: boolean;
  talentPoolAt?: string;
  talentPoolNote?: string;
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

export interface VoiceTranscriptSegment {
  id: string;
  sessionId: string;
  jobId: string;
  candidateId: string;
  segmentIndex: number;
  rawTranscript: string;
  normalizedTranscript: string;
  analysisJson?: string;
  createdAt: string;
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
  candidateName?: string | null;
  source?: string | null;
  resumeText?: string;
  type?: string | null;
  content_type?: string | null;
  size?: number | null;
  text?: string;
  dataBase64?: string | null;
  bucket?: string | null;
  object_key?: string | null;
  url?: string | null;
  view_url?: string | null;
}

export interface ParsedResumePayload {
  file: ResumeFilePayload;
  candidateName: string;
  source: string;
  resumeText: string;
  extractionMethod: string;
  warnings?: string[];
}

export type FileUploadScene = "default" | "resume" | "form_design" | "approval_item_icon" | "system_logo";

export interface UploadedFile {
  id: string;
  name: string;
  size: number;
  content_type?: string | null;
  bucket: string;
  object_key: string;
  url?: string | null;
  view_url?: string | null;
}

export interface FileViewUrl {
  object_key: string;
  url: string;
  expires_in: number;
  mode?: "direct" | "proxy";
}
