import { asc, desc, eq, ne } from "drizzle-orm";
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppState, Candidate, CandidateEvaluation, CandidateInterviewPlan, Job, SalaryData, VoiceAnalysis, VoiceTranscriptSegment } from "./types.js";
import { demoState } from "./demo-data.js";
import * as dbSchema from "./db/schema.js";
import { serverRoot } from "./env.js";

type AppDatabase = SQLJsDatabase<typeof dbSchema>;
type JobRow = typeof dbSchema.jobs.$inferSelect;
type CandidateRow = typeof dbSchema.candidates.$inferSelect;
type VoiceAnalysisRow = typeof dbSchema.voiceAnalyses.$inferSelect;
type VoiceTranscriptSegmentRow = typeof dbSchema.voiceTranscriptSegments.$inferSelect;

const defaultJobScoreWeights: Job["scoreWeights"] = {
  experience: 30,
  professional: 30,
  stability: 15,
  education: 10,
  business: 15,
};

let SQL: SqlJsStatic;
let sqliteDb: Database;
let appDb: AppDatabase | null = null;
let resolvedDbPath: string | null = null;

export async function initDb() {
  SQL = await initSqlJs();
  const dbPath = getDatabasePath();
  mkdirSync(dirname(dbPath), { recursive: true });
  sqliteDb = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  appDb = drizzle(sqliteDb, { schema: dbSchema });
  ensureSchema();
  persist();
}

export function getState(): AppState {
  const jobs = getJobs();
  const candidates: Record<string, Candidate[]> = {};
  const voiceAnalyses: Record<string, VoiceAnalysis[]> = {};
  jobs.forEach((job) => {
    candidates[job.id] = getCandidates(job.id);
    voiceAnalyses[job.id] = getVoiceAnalyses(job.id);
  });
  const savedCurrentJobId = getSetting("currentJobId");
  const currentJob = jobs.find((job) => job.id === savedCurrentJobId && job.status === "招聘中") || jobs.find((job) => job.status === "招聘中") || jobs[0];
  if (currentJob && currentJob.id !== savedCurrentJobId) setSettingNoPersist("currentJobId", currentJob.id);
  return {
    currentUser: getSetting("currentUser") || getDefaultCurrentUser(),
    currentJobId: currentJob?.id || "",
    jobs,
    candidates,
    voiceAnalyses,
  };
}

export function getJobs(): Job[] {
  return getDb()
    .select()
    .from(dbSchema.jobs)
    .orderBy(asc(dbSchema.jobs.sortOrder), asc(dbSchema.jobs.createdAt))
    .all()
    .map((row) => rowToJob(row, getCandidateCount(row.id)));
}

export function getJob(id: string): Job | null {
  const row = getDb().select().from(dbSchema.jobs).where(eq(dbSchema.jobs.id, id)).get();
  return row ? rowToJob(row, getCandidateCount(row.id)) : null;
}

export function upsertJob(job: Omit<Job, "resumeCount" | "sortOrder"> & { sortOrder?: number }) {
  const existing = getDb().select({ id: dbSchema.jobs.id }).from(dbSchema.jobs).where(eq(dbSchema.jobs.id, job.id)).get();
  if (existing) {
    getDb()
      .update(dbSchema.jobs)
      .set({
        title: job.title,
        dept: job.dept,
        location: job.location,
        experience: job.experience,
        level: job.level,
        salaryRange: job.salaryRange,
        keywords: job.keywords,
        scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
        description: job.description,
        status: job.status,
        salaryData: job.salaryData ? JSON.stringify(job.salaryData) : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(dbSchema.jobs.id, job.id))
      .run();
  } else {
    const maxSort = getDb()
      .select({ sortOrder: dbSchema.jobs.sortOrder })
      .from(dbSchema.jobs)
      .all()
      .reduce((maxValue, row) => Math.max(maxValue, row.sortOrder), 0);
    getDb()
      .insert(dbSchema.jobs)
      .values({
        id: job.id,
        title: job.title,
        dept: job.dept,
        location: job.location,
        experience: job.experience,
        level: job.level,
        salaryRange: job.salaryRange,
        keywords: job.keywords,
        scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
        description: job.description,
        status: job.status,
        salaryData: job.salaryData ? JSON.stringify(job.salaryData) : null,
        sortOrder: job.sortOrder ?? maxSort + 1,
      })
      .run();
  }
  persist();
}

export function closeJob(id: string) {
  getDb().update(dbSchema.jobs).set({ status: "已关闭", updatedAt: new Date().toISOString() }).where(eq(dbSchema.jobs.id, id)).run();
  const nextOngoing = getJobs().find((job) => job.status === "招聘中" && job.id !== id);
  if (nextOngoing) setSettingNoPersist("currentJobId", nextOngoing.id);
  persist();
}

export function deleteJob(id: string) {
  getDb().delete(dbSchema.jobs).where(eq(dbSchema.jobs.id, id)).run();
  persist();
}

export function prioritizeJob(id: string) {
  const rows = getDb().select({ id: dbSchema.jobs.id, sortOrder: dbSchema.jobs.sortOrder }).from(dbSchema.jobs).all();
  rows.forEach((row) => {
    getDb().update(dbSchema.jobs).set({ sortOrder: row.sortOrder + 1 }).where(eq(dbSchema.jobs.id, row.id)).run();
  });
  getDb().update(dbSchema.jobs).set({ sortOrder: 0 }).where(eq(dbSchema.jobs.id, id)).run();
  setSettingNoPersist("currentJobId", id);
  persist();
}

export function getCandidateById(id: string): Candidate | null {
  const row = getDb().select().from(dbSchema.candidates).where(eq(dbSchema.candidates.id, id)).get();
  return row ? rowToCandidate(row) : null;
}

export function getCandidates(jobId: string): Candidate[] {
  return getDb()
    .select()
    .from(dbSchema.candidates)
    .where(eq(dbSchema.candidates.jobId, jobId))
    .orderBy(desc(dbSchema.candidates.createdAt))
    .all()
    .map(rowToCandidate);
}

export function insertCandidates(candidates: Candidate[]) {
  candidates.forEach(insertCandidateNoPersist);
  persist();
}

export function updateCandidate(candidate: Candidate) {
  const data = serializeCandidate(candidate);
  const existingFile = getDb()
    .select({ fileBlob: dbSchema.candidates.fileBlob })
    .from(dbSchema.candidates)
    .where(eq(dbSchema.candidates.id, candidate.id))
    .get();

  getDb()
    .update(dbSchema.candidates)
    .set({
      name: data.name,
      source: data.source,
      score: data.score,
      conclusion: data.conclusion,
      reason: data.reason,
      remark: data.remark,
      resumeText: data.resumeText,
      uploadTime: data.uploadTime,
      fileName: data.fileName,
      fileType: data.fileType,
      fileSize: data.fileSize,
      fileBlob: data.fileBlob ?? normalizeBlob(existingFile?.fileBlob),
      fileObjectKey: data.fileObjectKey,
      fileUrl: data.fileUrl,
      evaluationJson: data.evaluationJson,
      interviewPlanJson: data.interviewPlanJson,
      keyPointAnalysis: data.keyPointAnalysis,
      interviewQuestions: data.interviewQuestions,
      interviewStage: data.interviewStage,
      stageRecommendation: data.stageRecommendation,
      interviewResult: data.interviewResult,
      onboarded: data.onboarded,
      reportMonth: data.reportMonth,
      interviewReason: data.interviewReason,
      reasonTags: data.reasonTags,
      interviewTimeline: data.interviewTimeline,
      isInTalentPool: data.isInTalentPool,
      talentPoolAt: data.talentPoolAt,
      talentPoolNote: data.talentPoolNote,
    })
    .where(eq(dbSchema.candidates.id, data.id))
    .run();
  persist();
}

export function deleteCandidate(id: string) {
  getDb().delete(dbSchema.candidates).where(eq(dbSchema.candidates.id, id)).run();
  persist();
}

export function getDatabasePath() {
  if (!resolvedDbPath) {
    resolvedDbPath = resolve(serverRoot, process.env.DB_PATH || "data/xiaosongshu.sqlite");
  }
  return resolvedDbPath;
}

function getDefaultCurrentUser() {
  return process.env.DEFAULT_CURRENT_USER || "本地用户";
}

export function getVoiceAnalyses(jobId: string): VoiceAnalysis[] {
  return getDb()
    .select()
    .from(dbSchema.voiceAnalyses)
    .where(eq(dbSchema.voiceAnalyses.jobId, jobId))
    .orderBy(desc(dbSchema.voiceAnalyses.createdAt))
    .all()
    .map(rowToVoiceAnalysis);
}

export function insertVoiceAnalysis(analysis: VoiceAnalysis) {
  getDb()
    .insert(dbSchema.voiceAnalyses)
    .values({
      id: analysis.id,
      jobId: analysis.jobId,
      candidateId: analysis.candidateId,
      audioName: analysis.audioName,
      audioType: analysis.audioType ?? null,
      audioSize: analysis.audioSize ?? null,
      transcript: analysis.transcript,
      summary: analysis.summary,
      jobFitAdvice: analysis.jobFitAdvice,
      communicationStrengths: JSON.stringify(analysis.communicationStrengths),
      communicationRisks: JSON.stringify(analysis.communicationRisks),
      recruiterSuggestions: JSON.stringify(analysis.recruiterSuggestions),
      recruiterReview: JSON.stringify(analysis.recruiterReview),
      recommendation: analysis.recommendation,
      createdAt: analysis.createdAt,
    })
    .run();
  persist();
}

export function deleteVoiceAnalysis(id: string) {
  getDb().delete(dbSchema.voiceAnalyses).where(eq(dbSchema.voiceAnalyses.id, id)).run();
  persist();
}

export function insertVoiceTranscriptSegment(segment: VoiceTranscriptSegment) {
  getDb()
    .insert(dbSchema.voiceTranscriptSegments)
    .values({
      id: segment.id,
      sessionId: segment.sessionId,
      jobId: segment.jobId,
      candidateId: segment.candidateId,
      segmentIndex: segment.segmentIndex,
      rawTranscript: segment.rawTranscript,
      normalizedTranscript: segment.normalizedTranscript,
      analysisJson: segment.analysisJson ?? null,
      createdAt: segment.createdAt,
    })
    .run();
  persist();
}

export function getVoiceTranscriptSegments(sessionId: string) {
  return getDb()
    .select()
    .from(dbSchema.voiceTranscriptSegments)
    .where(eq(dbSchema.voiceTranscriptSegments.sessionId, sessionId))
    .orderBy(asc(dbSchema.voiceTranscriptSegments.segmentIndex), asc(dbSchema.voiceTranscriptSegments.createdAt))
    .all()
    .map(rowToVoiceTranscriptSegment);
}

export function updateVoiceTranscriptSegmentAnalysis(id: string, analysisJson: string) {
  getDb().update(dbSchema.voiceTranscriptSegments).set({ analysisJson }).where(eq(dbSchema.voiceTranscriptSegments.id, id)).run();
  persist();
}

export function clearDatabase() {
  clearDatabaseNoPersist();
  persist();
}

export function loadDemoData(options: { reset?: boolean } = {}) {
  if (options.reset) clearDatabaseNoPersist();
  const demoCandidates = Object.values(demoState.candidates).flat();
  demoState.jobs.forEach((job) => upsertJobNoPersist(job));
  demoCandidates.forEach((candidate) => {
    getDb().delete(dbSchema.candidates).where(eq(dbSchema.candidates.id, candidate.id)).run();
    insertCandidateNoPersist(candidate);
  });
  setSettingNoPersist("currentUser", demoState.currentUser);
  setSettingNoPersist("currentJobId", demoState.currentJobId);
  persist();
}

function clearDatabaseNoPersist() {
  getDb().delete(dbSchema.voiceTranscriptSegments).run();
  getDb().delete(dbSchema.voiceAnalyses).run();
  getDb().delete(dbSchema.candidates).run();
  getDb().delete(dbSchema.jobs).run();
  getDb().delete(dbSchema.settings).run();
}

export function setSetting(key: string, value: string) {
  setSettingNoPersist(key, value);
  persist();
}

function setSettingNoPersist(key: string, value: string) {
  const existing = getDb().select({ key: dbSchema.settings.key }).from(dbSchema.settings).where(eq(dbSchema.settings.key, key)).get();
  if (existing) {
    getDb().update(dbSchema.settings).set({ value }).where(eq(dbSchema.settings.key, key)).run();
  } else {
    getDb().insert(dbSchema.settings).values({ key, value }).run();
  }
}

function getSetting(key: string) {
  return getDb().select({ value: dbSchema.settings.value }).from(dbSchema.settings).where(eq(dbSchema.settings.key, key)).get()?.value;
}

function upsertJobNoPersist(job: Job) {
  const existing = getDb().select({ id: dbSchema.jobs.id }).from(dbSchema.jobs).where(eq(dbSchema.jobs.id, job.id)).get();
  const row = {
    id: job.id,
    title: job.title,
    dept: job.dept,
    location: job.location,
    experience: job.experience,
    level: job.level,
    salaryRange: job.salaryRange,
    keywords: job.keywords,
    scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
    description: job.description,
    status: job.status,
    salaryData: job.salaryData ? JSON.stringify(job.salaryData) : null,
    sortOrder: job.sortOrder,
  };

  if (existing) {
    getDb().update(dbSchema.jobs).set(row).where(eq(dbSchema.jobs.id, job.id)).run();
  } else {
    getDb().insert(dbSchema.jobs).values(row).run();
  }
}

function insertCandidateNoPersist(candidate: Candidate) {
  const data = serializeCandidate(candidate);
  getDb()
    .insert(dbSchema.candidates)
    .values({
      id: data.id,
      jobId: data.jobId,
      name: data.name,
      source: data.source,
      score: data.score,
      conclusion: data.conclusion,
      reason: data.reason,
      remark: data.remark,
      resumeText: data.resumeText,
      uploadTime: data.uploadTime,
      fileName: data.fileName,
      fileType: data.fileType,
      fileSize: data.fileSize,
      fileBlob: data.fileBlob,
      fileObjectKey: data.fileObjectKey,
      fileUrl: data.fileUrl,
      evaluationJson: data.evaluationJson,
      interviewPlanJson: data.interviewPlanJson,
      keyPointAnalysis: data.keyPointAnalysis,
      interviewQuestions: data.interviewQuestions,
      interviewStage: data.interviewStage,
      stageRecommendation: data.stageRecommendation,
      interviewResult: data.interviewResult,
      onboarded: data.onboarded,
      reportMonth: data.reportMonth,
      interviewReason: data.interviewReason,
      reasonTags: data.reasonTags,
      interviewTimeline: data.interviewTimeline,
      isInTalentPool: data.isInTalentPool,
      talentPoolAt: data.talentPoolAt,
      talentPoolNote: data.talentPoolNote,
    })
    .run();
}

function getCandidateCount(jobId: string) {
  return getDb().select({ id: dbSchema.candidates.id }).from(dbSchema.candidates).where(eq(dbSchema.candidates.jobId, jobId)).all().length;
}

function rowToJob(row: JobRow, resumeCount: number): Job {
  return {
    id: row.id,
    title: row.title,
    dept: row.dept,
    location: row.location,
    experience: row.experience,
    level: row.level,
    salaryRange: row.salaryRange || "面议",
    keywords: row.keywords,
    scoreWeights: normalizeJobScoreWeights(row.scoreWeights),
    description: row.description,
    status: row.status as Job["status"],
    resumeCount,
    salaryData: row.salaryData ? normalizeSalaryData(JSON.parse(row.salaryData), row) : null,
    sortOrder: row.sortOrder ?? 0,
  };
}

function normalizeJobScoreWeights(value: unknown): Job["scoreWeights"] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  const source = parsed && typeof parsed === "object" ? parsed as Partial<Job["scoreWeights"]> : {};
  const next: Job["scoreWeights"] = {
    experience: normalizeWeightValue(source.experience, defaultJobScoreWeights.experience),
    professional: normalizeWeightValue(source.professional, defaultJobScoreWeights.professional),
    stability: normalizeWeightValue(source.stability, defaultJobScoreWeights.stability),
    education: normalizeWeightValue(source.education, defaultJobScoreWeights.education),
    business: normalizeWeightValue(source.business, defaultJobScoreWeights.business),
  };
  const total = Object.values(next).reduce((sum, item) => sum + item, 0);
  if (total !== 100) return { ...defaultJobScoreWeights };
  return next;
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeWeightValue(value: unknown, fallback: number) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numberValue)));
}

function normalizeSalaryData(raw: unknown, row: JobRow): SalaryData {
  const legacy = (raw || {}) as Record<string, unknown>;
  if (legacy.filters && legacy.experienceBands && legacy.regionComparison && legacy.advice) {
    return legacy as unknown as SalaryData;
  }

  const p25 = Number(legacy.p25 ?? 18);
  const p50 = Number(legacy.p50 ?? 24);
  const p75 = Number(legacy.p75 ?? 30);
  const region = row.location || "北京";
  const experience = normalizeLegacyExperience(row.experience || "3-5年");
  const regionComparison = Array.isArray(legacy.cities)
    ? (legacy.cities as Array<Record<string, unknown>>).map((item) => ({
        city: String(item.city || region),
        p25: Number(item.low ?? p25),
        p50: Number(item.mid ?? p50),
        p75: Number(item.high ?? p75),
      }))
    : [
        { city: region, p25, p50, p75 },
        { city: "北京", p25: Math.round(p25 * 1.08), p50: Math.round(p50 * 1.08), p75: Math.round(p75 * 1.08) },
        { city: "上海", p25: Math.round(p25 * 1.05), p50: Math.round(p50 * 1.05), p75: Math.round(p75 * 1.05) },
      ];

  return {
    filters: {
      role: row.title || "岗位调研",
      region,
      experience,
      industry: "企业服务",
      education: "本科",
    },
    benchmarkRegion: region,
    jobFamily: "通用职能",
    p25,
    p50,
    p75,
    suggestedLow: p50,
    suggestedHigh: Math.round(p75 * 1.02),
    anchor: p50,
    experienceBands: [
      { label: "1-3年", p25: Math.round(p25 * 0.75), p50: Math.round(p50 * 0.8), p75: Math.round(p75 * 0.8) },
      { label: "3-5年", p25, p50, p75 },
      { label: "5-10年", p25: Math.round(p25 * 1.16), p50: Math.round(p50 * 1.18), p75: Math.round(p75 * 1.2) },
    ],
    regionComparison,
    educationComparison: [
      { label: "大专", value: Math.round(p50 * 0.95) },
      { label: "本科", value: p50 },
      { label: "硕士", value: Math.round(p50 * 1.08) },
      { label: "博士", value: Math.round(p50 * 1.15) },
    ],
    industryComparison: [
      { name: "互联网", value: Math.round(p50 * 1.12) },
      { name: "企业服务", value: p50 },
      { name: "制造业", value: Math.round(p50 * 0.91) },
      { name: "金融", value: Math.round(p50 * 1.08) },
    ],
    updatedAt: String(legacy.updatedAt || new Date().toLocaleDateString("zh-CN")),
    insights: Array.isArray(legacy.insights) ? (legacy.insights as SalaryData["insights"]) : [],
    advice: {
      summary: `${region} 当前岗位已有历史薪酬缓存，建议用 ${p50}k 作为沟通参考锚点。`,
      reasons: ["这是旧版薪酬缓存数据，系统已自动兼容为新版结构。"],
      keywordPremiums: [],
    },
    research: {
      dataWindow: "历史缓存",
      confidence: "低",
      confidenceReason: "当前仅为旧版本地缓存兼容结果，缺少外部招聘网站与报告的交叉验证。",
      limitations: ["未保留原始招聘网站样本明细。", "P25/P50/P75 无法追溯到外部来源，只能作为过渡参考。"],
      triangulation: {
        requiredSources: 3,
        actualSources: 0,
        passed: false,
        summary: "当前旧版缓存未满足三角验证要求，建议重新生成调研结果。",
      },
      metricSources: {
        p25: "历史缓存兼容值，缺少外部来源追溯。",
        p50: "历史缓存兼容值，缺少外部来源追溯。",
        p75: "历史缓存兼容值，缺少外部来源追溯。",
      },
      methodology: ["当前为旧版缓存兼容结果，尚未包含外部薪酬聚合调研。"],
      coreSources: [],
      validationSources: [],
      sampleNotes: ["建议重新点击“刷新薪酬大盘”，生成最新调研结果。"],
      evidence: [],
      disclaimer: "该数据来自旧版本地缓存兼容结果，适合过渡查看，不建议直接作为正式定薪依据。",
    },
  };
}

function normalizeLegacyExperience(value: string) {
  if (/无经验|应届|校招/.test(value)) return "无经验";
  if (/1-3/.test(value)) return "1-3年";
  if (/3-5/.test(value)) return "3-5年";
  if (/5-10/.test(value)) return "5-10年";
  if (/10/.test(value)) return "10年以上";
  return "3-5年";
}

function rowToCandidate(row: CandidateRow): Candidate {
  return {
    id: row.id,
    jobId: row.jobId,
    name: row.name,
    source: row.source,
    score: Number(row.score),
    conclusion: row.conclusion,
    reason: row.reason,
    remark: row.remark || "",
    resumeText: row.resumeText,
    uploadTime: row.uploadTime,
    fileName: row.fileName,
    fileType: row.fileType,
    fileSize: row.fileSize,
    fileDataBase64: null,
    fileObjectKey: row.fileObjectKey,
    fileUrl: row.fileUrl,
    evaluation: parseCandidateEvaluation(row.evaluationJson),
    interviewPlan: parseCandidateInterviewPlan(row.interviewPlanJson),
    keyPointAnalysis: JSON.parse(row.keyPointAnalysis || "[]"),
    interviewQuestions: JSON.parse(row.interviewQuestions || "[]"),
    interviewStage: normalizeInterviewStage(row.interviewStage),
    stageRecommendation: normalizeStageRecommendation(row.stageRecommendation),
    interviewResult: String(row.interviewResult || "待定") as Candidate["interviewResult"],
    onboarded: normalizeOnboarded(row.onboarded),
    reportMonth: row.reportMonth || formatReportMonth(),
    interviewReason: row.interviewReason || "",
    reasonTags: JSON.parse(row.reasonTags || "[]"),
    interviewTimeline: JSON.parse(row.interviewTimeline || "{}"),
    isInTalentPool: Boolean(row.isInTalentPool),
    talentPoolAt: row.talentPoolAt || "",
    talentPoolNote: row.talentPoolNote || "",
  };
}

function rowToVoiceAnalysis(row: VoiceAnalysisRow): VoiceAnalysis {
  return {
    id: row.id,
    jobId: row.jobId,
    candidateId: row.candidateId,
    audioName: row.audioName,
    audioType: row.audioType,
    audioSize: row.audioSize,
    transcript: row.transcript,
    summary: row.summary,
    jobFitAdvice: row.jobFitAdvice,
    communicationStrengths: JSON.parse(row.communicationStrengths || "[]"),
    communicationRisks: JSON.parse(row.communicationRisks || "[]"),
    recruiterSuggestions: JSON.parse(row.recruiterSuggestions || "[]"),
    recruiterReview: JSON.parse(row.recruiterReview || "[]"),
    recommendation: row.recommendation as VoiceAnalysis["recommendation"],
    createdAt: row.createdAt,
  };
}

function rowToVoiceTranscriptSegment(row: VoiceTranscriptSegmentRow): VoiceTranscriptSegment {
  return {
    id: row.id,
    sessionId: row.sessionId,
    jobId: row.jobId,
    candidateId: row.candidateId,
    segmentIndex: row.segmentIndex,
    rawTranscript: row.rawTranscript || "",
    normalizedTranscript: row.normalizedTranscript || "",
    analysisJson: row.analysisJson ?? undefined,
    createdAt: row.createdAt || "",
  };
}

function normalizeInterviewStage(value: unknown): NonNullable<Candidate["interviewStage"]> {
  if (value === "推荐" || value === "推荐简历") return "推荐";
  if (value === "复试" || value === "推荐复试" || value === "初试通过") return "复试";
  if (value === "offer" || value === "复试通过" || value === "入职") return "offer";
  if (value === "初试" || value === "推荐初试") return "初试";
  return "推荐";
}

function normalizeStageRecommendation(value: unknown): NonNullable<Candidate["stageRecommendation"]> {
  if (value === "待定") return "待定";
  if (value === "是" || value === "否") return value;
  return "待定";
}

function normalizeOnboarded(value: unknown): NonNullable<Candidate["onboarded"]> {
  if (value === "是" || value === "否") return value;
  return "待入职";
}

function formatReportMonth(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}年${month}月`;
}

function normalizeBlob(value: unknown) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(value as ArrayLike<number>);
}

function serializeCandidate(candidate: Candidate) {
  return {
    ...candidate,
    fileName: candidate.fileName ?? null,
    fileType: candidate.fileType ?? null,
    fileSize: candidate.fileSize ?? null,
    fileBlob: candidate.fileDataBase64 ? Buffer.from(candidate.fileDataBase64, "base64") : null,
    fileObjectKey: candidate.fileObjectKey ?? null,
    fileUrl: candidate.fileUrl ?? null,
    remark: candidate.remark || "",
    evaluationJson: JSON.stringify(candidate.evaluation || {}),
    interviewPlanJson: JSON.stringify(candidate.interviewPlan || {}),
    keyPointAnalysis: JSON.stringify(candidate.keyPointAnalysis || []),
    interviewQuestions: JSON.stringify(candidate.interviewQuestions || []),
    interviewStage: normalizeInterviewStage(candidate.interviewStage),
    stageRecommendation: normalizeStageRecommendation(candidate.stageRecommendation),
    interviewResult: candidate.interviewResult || "待定",
    onboarded: normalizeOnboarded(candidate.onboarded),
    reportMonth: candidate.reportMonth || formatReportMonth(),
    interviewReason: candidate.interviewReason || "",
    reasonTags: JSON.stringify(candidate.reasonTags || []),
    interviewTimeline: JSON.stringify(candidate.interviewTimeline || {}),
    isInTalentPool: candidate.isInTalentPool ? 1 : 0,
    talentPoolAt: candidate.talentPoolAt || "",
    talentPoolNote: candidate.talentPoolNote || "",
  };
}

function parseCandidateEvaluation(raw: unknown): CandidateEvaluation | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(String(raw || "{}")) as Partial<CandidateEvaluation>;
    const summary = String(parsed.summary || "").trim();
    const strengths = Array.isArray(parsed.strengths) ? parsed.strengths.map((item) => String(item).trim()).filter(Boolean) : [];
    const weaknesses = Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map((item) => String(item).trim()).filter(Boolean) : [];
    const risks = Array.isArray(parsed.risks) ? parsed.risks.map((item) => String(item).trim()).filter(Boolean) : [];
    const interviewFocuses = Array.isArray(parsed.interviewFocuses) ? parsed.interviewFocuses.map((item) => String(item).trim()).filter(Boolean) : [];
    if (!summary && !strengths.length && !weaknesses.length && !risks.length && !interviewFocuses.length) return undefined;
    return { summary, strengths, weaknesses, risks, interviewFocuses };
  } catch {
    return undefined;
  }
}

function parseCandidateInterviewPlan(raw: unknown): CandidateInterviewPlan | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(String(raw || "{}")) as Partial<CandidateInterviewPlan>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const recommendedMethods = Array.isArray(parsed.recommendedMethods)
      ? parsed.recommendedMethods
        .map((item) => ({
          methodKey: String(item?.methodKey || "") as CandidateInterviewPlan["recommendedMethods"][number]["methodKey"],
          label: String(item?.label || "").trim(),
          reason: String(item?.reason || "").trim(),
        }))
        .filter((item) => item.methodKey && item.label)
      : [];
    const focusDirections = Array.isArray(parsed.focusDirections)
      ? parsed.focusDirections
        .map((item) => ({
          title: String(item?.title || "").trim(),
          gapReason: String(item?.gapReason || "").trim(),
        }))
        .filter((item) => item.title && item.gapReason)
      : [];
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.map((item) => ({
        title: String(item?.title || "").trim(),
        question: String(item?.question || "").trim(),
        competency: String(item?.competency || "").trim(),
        questionType: String(item?.questionType || "行为型").trim() as CandidateInterviewPlan["questions"][number]["questionType"],
        directionTitle: String(item?.directionTitle || "").trim() || undefined,
        cutInPoint: String(item?.cutInPoint || "").trim() || undefined,
        designIntent: String(item?.designIntent || "").trim(),
        strongSignals: Array.isArray(item?.strongSignals) ? item.strongSignals.map((text) => String(text).trim()).filter(Boolean) : [],
        warningSignals: Array.isArray(item?.warningSignals) ? item.warningSignals.map((text) => String(text).trim()).filter(Boolean) : [],
        followUps: Array.isArray(item?.followUps) ? item.followUps.map((text) => String(text).trim()).filter(Boolean) : [],
        judgmentSuggestion: String(item?.judgmentSuggestion || "").trim() || undefined,
        isStressScenario: Boolean(item?.isStressScenario),
        scenario: String(item?.scenario || "").trim() || undefined,
        evaluationFocus: Array.isArray(item?.evaluationFocus) ? item.evaluationFocus.map((text) => String(text).trim()).filter(Boolean) : [],
        methodKey: item?.methodKey ? String(item.methodKey) as CandidateInterviewPlan["questions"][number]["methodKey"] : undefined,
      })).filter((item) => item.title && item.question)
      : [];
    const evaluationGuide = parsed.evaluationGuide && typeof parsed.evaluationGuide === "object"
      ? {
        baseline: Array.isArray(parsed.evaluationGuide.baseline) ? parsed.evaluationGuide.baseline.map((text) => String(text).trim()).filter(Boolean) : [],
        positiveSignals: Array.isArray(parsed.evaluationGuide.positiveSignals) ? parsed.evaluationGuide.positiveSignals.map((text) => String(text).trim()).filter(Boolean) : [],
        vetoItems: Array.isArray(parsed.evaluationGuide.vetoItems) ? parsed.evaluationGuide.vetoItems.map((text) => String(text).trim()).filter(Boolean) : [],
      }
      : { baseline: [], positiveSignals: [], vetoItems: [] };
    const riskReview = Array.isArray(parsed.riskReview)
      ? parsed.riskReview.map((item) => ({
        dimension: String(item?.dimension || "").trim() as CandidateInterviewPlan["riskReview"][number]["dimension"],
        level: String(item?.level || "低").trim() as CandidateInterviewPlan["riskReview"][number]["level"],
        reason: String(item?.reason || "").trim(),
        validationTips: Array.isArray(item?.validationTips) ? item.validationTips.map((text) => String(text).trim()).filter(Boolean) : [],
      })).filter((item) => item.dimension && item.reason)
      : [];
    const summaryReason = String(parsed.summaryReason || "").trim();
    if (!recommendedMethods.length && !questions.length && !summaryReason) return undefined;
    return {
      focusDirections,
      recommendedMethods,
      summaryReason,
      questions,
      evaluationGuide,
      riskReview,
    };
  } catch {
    return undefined;
  }
}

function getDb() {
  if (!appDb) {
    throw new Error("Database is not initialized");
  }
  return appDb;
}

function ensureSchema() {
  sqliteDb.run("PRAGMA foreign_keys = ON");
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    dept TEXT NOT NULL,
    location TEXT NOT NULL,
    experience TEXT NOT NULL,
    level TEXT NOT NULL,
	    salary_range TEXT NOT NULL DEFAULT '面议',
	    keywords TEXT NOT NULL,
	    score_weights TEXT NOT NULL DEFAULT '{"experience":30,"professional":30,"stability":15,"education":10,"business":15}',
	    description TEXT NOT NULL,
    status TEXT NOT NULL,
    salary_data TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	  );`);
	  ensureColumn("jobs", "salary_range", "TEXT NOT NULL DEFAULT '面议'");
	  ensureColumn("jobs", "score_weights", `TEXT NOT NULL DEFAULT '{"experience":30,"professional":30,"stability":15,"education":10,"business":15}'`);
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL,
    conclusion TEXT NOT NULL,
    reason TEXT NOT NULL,
    remark TEXT NOT NULL DEFAULT '',
    resume_text TEXT NOT NULL,
    upload_time TEXT NOT NULL,
    file_name TEXT,
    file_type TEXT,
    file_size INTEGER,
    file_blob BLOB,
    file_object_key TEXT,
    file_url TEXT,
    evaluation_json TEXT NOT NULL DEFAULT '{}',
    interview_plan_json TEXT NOT NULL DEFAULT '{}',
    key_point_analysis TEXT NOT NULL DEFAULT '[]',
    interview_questions TEXT NOT NULL DEFAULT '[]',
    interview_recommendation TEXT NOT NULL DEFAULT '待定',
	    stage_recommendation TEXT NOT NULL DEFAULT '待定',
    interview_result TEXT NOT NULL DEFAULT '待定',
    onboarded TEXT NOT NULL DEFAULT '待入职',
    report_month TEXT NOT NULL DEFAULT '',
	    interview_stage TEXT NOT NULL DEFAULT '推荐',
    interview_reason TEXT NOT NULL DEFAULT '',
    reason_tags TEXT NOT NULL DEFAULT '[]',
    interview_timeline TEXT NOT NULL DEFAULT '{}',
    is_in_talent_pool INTEGER NOT NULL DEFAULT 0,
    talent_pool_at TEXT NOT NULL DEFAULT '',
    talent_pool_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("candidates", "interview_recommendation", "TEXT NOT NULL DEFAULT '待定'");
	  ensureColumn("candidates", "stage_recommendation", "TEXT NOT NULL DEFAULT '待定'");
  ensureColumn("candidates", "interview_result", "TEXT NOT NULL DEFAULT '待定'");
  ensureColumn("candidates", "onboarded", "TEXT NOT NULL DEFAULT '待入职'");
  ensureColumn("candidates", "report_month", "TEXT NOT NULL DEFAULT ''");
	  ensureColumn("candidates", "interview_stage", "TEXT NOT NULL DEFAULT '推荐'");
  ensureColumn("candidates", "interview_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("candidates", "reason_tags", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("candidates", "interview_timeline", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("candidates", "evaluation_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("candidates", "interview_plan_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("candidates", "file_object_key", "TEXT");
  ensureColumn("candidates", "file_url", "TEXT");
  ensureColumn("candidates", "remark", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("candidates", "is_in_talent_pool", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("candidates", "talent_pool_at", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("candidates", "talent_pool_note", "TEXT NOT NULL DEFAULT ''");
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS voice_analyses (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    audio_name TEXT NOT NULL,
    audio_type TEXT,
    audio_size INTEGER,
    transcript TEXT NOT NULL,
    summary TEXT NOT NULL,
    job_fit_advice TEXT NOT NULL,
    communication_strengths TEXT NOT NULL DEFAULT '[]',
    communication_risks TEXT NOT NULL DEFAULT '[]',
    recruiter_suggestions TEXT NOT NULL DEFAULT '[]',
    recruiter_review TEXT NOT NULL DEFAULT '[]',
    recommendation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("voice_analyses", "recruiter_review", "TEXT NOT NULL DEFAULT '[]'");
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS voice_transcript_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL,
    raw_transcript TEXT NOT NULL,
    normalized_transcript TEXT NOT NULL,
    analysis_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("voice_transcript_segments", "analysis_json", "TEXT");
}

function ensureColumn(table: string, column: string, definition: string) {
  const statement = sqliteDb.prepare(`PRAGMA table_info(${table})`);
  const columns: string[] = [];
  while (statement.step()) {
    columns.push(String(statement.getAsObject().name));
  }
  statement.free();
  if (!columns.includes(column)) {
    sqliteDb.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function persist() {
  writeFileSync(getDatabasePath(), Buffer.from(sqliteDb.export()));
}
