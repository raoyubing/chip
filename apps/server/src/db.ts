import { asc, desc, eq, ne } from "drizzle-orm";
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalizeRegionToCity } from "@xiaosongshu/shared";
import type { AppState, AuthRole, Candidate, CandidateEvaluation, CandidateInterviewPlan, Job, RecruitmentBatch, SalaryData, VoiceAnalysis, VoiceTranscriptSegment } from "./types.js";
import { demoState } from "./demo-data.js";
import * as dbSchema from "./db/schema.js";
import { serverRoot } from "./env.js";

type AppDatabase = SQLJsDatabase<typeof dbSchema>;
type JobRow = typeof dbSchema.jobs.$inferSelect;
type CandidateRow = typeof dbSchema.candidates.$inferSelect;
type VoiceAnalysisRow = typeof dbSchema.voiceAnalyses.$inferSelect;
type VoiceTranscriptSegmentRow = typeof dbSchema.voiceTranscriptSegments.$inferSelect;
type AuthUserRow = typeof dbSchema.authUsers.$inferSelect;
type AuthSessionRow = typeof dbSchema.authSessions.$inferSelect;
type JobUpsertInput = Omit<Job, "resumeCount" | "sortOrder" | "currentBatchId" | "recruitmentBatches"> & {
  sortOrder?: number;
  currentBatchId?: string;
  recruitmentBatches?: RecruitmentBatch[];
};

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
    .map((row) => {
      const job = rowToJob(row, 0);
      return { ...job, resumeCount: getCandidateCount(row.id, job.currentBatchId) };
    });
}

export function getJob(id: string): Job | null {
  const row = getDb().select().from(dbSchema.jobs).where(eq(dbSchema.jobs.id, id)).get();
  if (!row) return null;
  const job = rowToJob(row, 0);
  return { ...job, resumeCount: getCandidateCount(row.id, job.currentBatchId) };
}

export function upsertJob(job: JobUpsertInput) {
  const recruitmentContext = buildJobRecruitmentContext(job);
  const existing = getDb().select({ id: dbSchema.jobs.id }).from(dbSchema.jobs).where(eq(dbSchema.jobs.id, job.id)).get();
  if (existing) {
    getDb()
      .update(dbSchema.jobs)
      .set({
        profileGroupId: job.profileGroupId || job.id,
        title: job.title,
        dept: job.dept,
        location: normalizeRegionToCity(job.location),
        experience: job.experience,
        level: job.level,
        salaryRange: job.salaryRange,
        demandType: job.demandType,
        plannedHeadcount: normalizePlannedHeadcount(job.plannedHeadcount),
        keywords: job.keywords,
        scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
        description: job.description,
        status: job.status,
        currentBatchId: recruitmentContext.currentBatchId,
        recruitmentBatches: JSON.stringify(recruitmentContext.recruitmentBatches),
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
        profileGroupId: job.profileGroupId || job.id,
        title: job.title,
        dept: job.dept,
        location: normalizeRegionToCity(job.location),
        experience: job.experience,
        level: job.level,
        salaryRange: job.salaryRange,
        demandType: job.demandType,
        plannedHeadcount: normalizePlannedHeadcount(job.plannedHeadcount),
        keywords: job.keywords,
        scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
        description: job.description,
        status: job.status,
        currentBatchId: recruitmentContext.currentBatchId,
        recruitmentBatches: JSON.stringify(recruitmentContext.recruitmentBatches),
        salaryData: job.salaryData ? JSON.stringify(job.salaryData) : null,
        sortOrder: job.sortOrder ?? maxSort + 1,
      })
      .run();
  }
  syncCandidateRecruitmentMonthsNoPersist(job.id, recruitmentContext.recruitmentBatches);
  persist();
}

function syncCandidateRecruitmentMonthsNoPersist(jobId: string, recruitmentBatches: RecruitmentBatch[]) {
  recruitmentBatches.forEach((batch) => {
    sqliteDb.run(
      "UPDATE candidates SET report_month = ? WHERE job_id = ? AND recruitment_batch_id = ?",
      [batch.targetMonth, jobId, batch.id],
    );
  });
}

export function closeJob(id: string) {
  const job = getJob(id);
  if (!job) return;
  const closedAt = new Date().toISOString();
  const recruitmentBatches = job.recruitmentBatches.map((batch) => batch.id === job.currentBatchId ? {
    ...batch,
    status: "已关闭" as const,
    closedAt,
    profileSnapshot: buildJobProfileSnapshot(job),
  } : batch);
  getDb().update(dbSchema.jobs).set({
    status: "已关闭",
    recruitmentBatches: JSON.stringify(recruitmentBatches),
    updatedAt: closedAt,
  }).where(eq(dbSchema.jobs.id, id)).run();
  const nextOngoing = getJobs().find((job) => job.status === "招聘中" && job.id !== id);
  if (nextOngoing) setSettingNoPersist("currentJobId", nextOngoing.id);
  persist();
}

export function reopenJob(id: string, targetMonth: string, demandType: Job["demandType"], plannedHeadcount: number) {
  const job = getJob(id);
  if (!job || job.status !== "已关闭") return null;
  const sequence = Math.max(0, ...job.recruitmentBatches.map((batch) => batch.sequence)) + 1;
  const batch = createRecruitmentBatch(job, sequence, targetMonth, "招聘中", demandType, plannedHeadcount);
  const recruitmentBatches = [...job.recruitmentBatches, batch];
  getDb().update(dbSchema.jobs).set({
    status: "招聘中",
    demandType,
    plannedHeadcount: batch.plannedHeadcount,
    currentBatchId: batch.id,
    recruitmentBatches: JSON.stringify(recruitmentBatches),
    updatedAt: batch.startedAt,
  }).where(eq(dbSchema.jobs.id, id)).run();
  setSettingNoPersist("currentJobId", id);
  persist();
  return batch;
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
  updateCandidateNoPersist(candidate);
  persist();
}

export function updateCandidates(candidates: Candidate[]) {
  if (!candidates.length) return;
  candidates.forEach(updateCandidateNoPersist);
  persist();
}

function updateCandidateNoPersist(candidate: Candidate) {
  const data = serializeCandidate(candidate);
  const existingFile = getDb()
    .select({ fileBlob: dbSchema.candidates.fileBlob })
    .from(dbSchema.candidates)
    .where(eq(dbSchema.candidates.id, candidate.id))
    .get();

  getDb()
    .update(dbSchema.candidates)
    .set({
      recruitmentBatchId: data.recruitmentBatchId,
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
      removedFromScreening: data.removedFromScreening,
      removedFromTalentPool: data.removedFromTalentPool,
    })
    .where(eq(dbSchema.candidates.id, data.id))
    .run();
}

export function deleteCandidate(id: string) {
  getDb().delete(dbSchema.candidates).where(eq(dbSchema.candidates.id, id)).run();
  persist();
}

export function removeCandidateFromScreening(id: string) {
  getDb().update(dbSchema.candidates).set({ removedFromScreening: 1 }).where(eq(dbSchema.candidates.id, id)).run();
  persist();
}

export function removeCandidateFromTalentPool(id: string) {
  getDb()
    .update(dbSchema.candidates)
    .set({
      isInTalentPool: 0,
      talentPoolAt: "",
      talentPoolNote: "",
      removedFromTalentPool: 1,
    })
    .where(eq(dbSchema.candidates.id, id))
    .run();
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

export interface StoredAuthUser {
  username: "admin" | "guest";
  role: AuthRole;
  passwordHash: string;
  passwordUpdatedAt: string;
}

export interface StoredAuthSession {
  tokenHash: string;
  username: "admin" | "guest";
  expiresAt: string;
  createdAt: string;
}

export function getAuthUser(username: string): StoredAuthUser | null {
  const row = getDb().select().from(dbSchema.authUsers).where(eq(dbSchema.authUsers.username, username)).get();
  return row ? rowToAuthUser(row) : null;
}

export function listAuthUsers(): StoredAuthUser[] {
  return getDb().select().from(dbSchema.authUsers).orderBy(asc(dbSchema.authUsers.username)).all().map(rowToAuthUser);
}

export function setAuthUserPasswordHash(username: "admin" | "guest", passwordHash: string) {
  getDb()
    .update(dbSchema.authUsers)
    .set({ passwordHash, passwordUpdatedAt: new Date().toISOString() })
    .where(eq(dbSchema.authUsers.username, username))
    .run();
  getDb().delete(dbSchema.authSessions).where(eq(dbSchema.authSessions.username, username)).run();
  persist();
}

export function createAuthSession(session: StoredAuthSession) {
  getDb().insert(dbSchema.authSessions).values(session).run();
  persist();
}

export function getAuthSession(tokenHash: string): StoredAuthSession | null {
  const row = getDb().select().from(dbSchema.authSessions).where(eq(dbSchema.authSessions.tokenHash, tokenHash)).get();
  if (!row) return null;
  if (Date.parse(row.expiresAt) <= Date.now()) {
    deleteAuthSession(tokenHash);
    return null;
  }
  return rowToAuthSession(row);
}

export function deleteAuthSession(tokenHash: string) {
  getDb().delete(dbSchema.authSessions).where(eq(dbSchema.authSessions.tokenHash, tokenHash)).run();
  persist();
}

export function deleteAuthSessionsForUser(username: "admin" | "guest") {
  getDb().delete(dbSchema.authSessions).where(eq(dbSchema.authSessions.username, username)).run();
  persist();
}

function rowToAuthUser(row: AuthUserRow): StoredAuthUser {
  return {
    username: row.username as StoredAuthUser["username"],
    role: row.role as AuthRole,
    passwordHash: row.passwordHash,
    passwordUpdatedAt: row.passwordUpdatedAt,
  };
}

function rowToAuthSession(row: AuthSessionRow): StoredAuthSession {
  return {
    tokenHash: row.tokenHash,
    username: row.username as StoredAuthSession["username"],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
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
  const recruitmentContext = buildJobRecruitmentContext(job);
  const existing = getDb().select({ id: dbSchema.jobs.id }).from(dbSchema.jobs).where(eq(dbSchema.jobs.id, job.id)).get();
  const row = {
    id: job.id,
    profileGroupId: job.profileGroupId || job.id,
    title: job.title,
    dept: job.dept,
    location: normalizeRegionToCity(job.location),
    experience: job.experience,
    level: job.level,
    salaryRange: job.salaryRange,
    demandType: job.demandType,
    plannedHeadcount: normalizePlannedHeadcount(job.plannedHeadcount),
    keywords: job.keywords,
    scoreWeights: JSON.stringify(normalizeJobScoreWeights(job.scoreWeights)),
    description: job.description,
    status: job.status,
    currentBatchId: recruitmentContext.currentBatchId,
    recruitmentBatches: JSON.stringify(recruitmentContext.recruitmentBatches),
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
      recruitmentBatchId: data.recruitmentBatchId,
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
      removedFromScreening: data.removedFromScreening,
      removedFromTalentPool: data.removedFromTalentPool,
    })
    .run();
}

function getCandidateCount(jobId: string, recruitmentBatchId: string) {
  return getDb()
    .select({
      recruitmentBatchId: dbSchema.candidates.recruitmentBatchId,
      removedFromScreening: dbSchema.candidates.removedFromScreening,
    })
    .from(dbSchema.candidates)
    .where(eq(dbSchema.candidates.jobId, jobId))
    .all()
    .filter((candidate) => candidate.recruitmentBatchId === recruitmentBatchId && !Boolean(candidate.removedFromScreening))
    .length;
}

function rowToJob(row: JobRow, resumeCount: number): Job {
  const recruitmentBatches = normalizeRecruitmentBatches(row.recruitmentBatches, {
    ...row,
    location: normalizeRegionToCity(row.location),
    demandType: normalizeRecruitmentDemandType(row.demandType),
    scoreWeights: normalizeJobScoreWeights(row.scoreWeights),
    status: isJobStatus(row.status) ? row.status : "已关闭",
  });
  const currentBatchId = recruitmentBatches.some((batch) => batch.id === row.currentBatchId)
    ? row.currentBatchId
    : recruitmentBatches.find((batch) => batch.status !== "已关闭")?.id || recruitmentBatches.at(-1)?.id || "";
  return {
    id: row.id,
    profileGroupId: row.profileGroupId || row.id,
    title: row.title,
    dept: row.dept,
    location: normalizeRegionToCity(row.location),
    experience: row.experience,
    level: row.level,
    salaryRange: row.salaryRange || "面议",
    demandType: normalizeRecruitmentDemandType(row.demandType),
    plannedHeadcount: normalizePlannedHeadcount(row.plannedHeadcount),
    keywords: row.keywords,
    scoreWeights: normalizeJobScoreWeights(row.scoreWeights),
    description: row.description,
    status: row.status as Job["status"],
    currentBatchId,
    recruitmentBatches,
    resumeCount,
    salaryData: row.salaryData ? normalizeSalaryData(JSON.parse(row.salaryData), row) : null,
    sortOrder: row.sortOrder ?? 0,
  };
}

type JobProfileSource = Pick<Job, "title" | "dept" | "location" | "experience" | "level" | "salaryRange" | "keywords" | "scoreWeights" | "description">;
type RecruitmentBatchFallback = JobProfileSource & {
  id: string;
  demandType: Job["demandType"];
  plannedHeadcount: number;
  status: Job["status"];
  createdAt?: string;
  updatedAt?: string;
};

function buildJobProfileSnapshot(job: JobProfileSource) {
  return {
    title: job.title,
    dept: job.dept,
    location: normalizeRegionToCity(job.location),
    experience: job.experience,
    level: job.level,
    salaryRange: job.salaryRange,
    keywords: job.keywords,
    scoreWeights: normalizeJobScoreWeights(job.scoreWeights),
    description: job.description,
  };
}

function buildJobRecruitmentContext(job: JobUpsertInput | Job) {
  const recruitmentBatches = normalizeRecruitmentBatches(job.recruitmentBatches || [], job);
  const currentBatchId = recruitmentBatches.some((batch) => batch.id === job.currentBatchId)
    ? String(job.currentBatchId)
    : recruitmentBatches.find((batch) => batch.status !== "已关闭")?.id || recruitmentBatches[recruitmentBatches.length - 1]?.id || "";
  const now = new Date().toISOString();
  return {
    currentBatchId,
    recruitmentBatches: recruitmentBatches.map((batch) => batch.id === currentBatchId ? {
      ...batch,
      demandType: job.status === "已关闭" ? batch.demandType : job.demandType,
      plannedHeadcount: job.status === "已关闭" ? batch.plannedHeadcount : normalizePlannedHeadcount(job.plannedHeadcount),
      status: job.status,
      closedAt: job.status === "已关闭" ? batch.closedAt || now : undefined,
      profileSnapshot: job.status === "已关闭" ? batch.profileSnapshot : buildJobProfileSnapshot(job),
    } : batch),
  };
}

function normalizeRecruitmentBatches(value: unknown, fallback: RecruitmentBatchFallback): RecruitmentBatch[] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  const fallbackProfile = buildJobProfileSnapshot(fallback);
  const batches = Array.isArray(parsed) ? parsed.map((item, index) => {
    const source = item && typeof item === "object" ? item as Partial<RecruitmentBatch> : {};
    const sequence = Number.isInteger(source.sequence) && Number(source.sequence) > 0 ? Number(source.sequence) : index + 1;
    const startedAt = String(source.startedAt || fallback.createdAt || new Date().toISOString());
    const profileSource = source.profileSnapshot && typeof source.profileSnapshot === "object"
      ? { ...fallbackProfile, ...source.profileSnapshot }
      : fallbackProfile;
    return {
      id: String(source.id || `${fallback.id}_batch_${sequence}`),
      sequence,
      label: String(source.label || `第${sequence}批`),
      targetMonth: String(source.targetMonth || formatRecruitmentMonth(startedAt)),
      demandType: normalizeRecruitmentDemandType(source.demandType || fallback.demandType),
      plannedHeadcount: normalizePlannedHeadcount(source.plannedHeadcount ?? fallback.plannedHeadcount),
      status: isJobStatus(source.status) ? source.status : fallback.status,
      startedAt,
      closedAt: source.closedAt ? String(source.closedAt) : undefined,
      profileSnapshot: buildJobProfileSnapshot(profileSource),
    };
  }) : [];
  if (batches.length) return batches.sort((left, right) => left.sequence - right.sequence);
  const startedAt = fallback.createdAt || new Date().toISOString();
  return [{
    id: `${fallback.id}_batch_1`,
    sequence: 1,
    label: "第1批",
    targetMonth: formatRecruitmentMonth(startedAt),
    demandType: fallback.demandType,
    plannedHeadcount: normalizePlannedHeadcount(fallback.plannedHeadcount),
    status: fallback.status,
    startedAt,
    closedAt: fallback.status === "已关闭" ? fallback.updatedAt || startedAt : undefined,
    profileSnapshot: fallbackProfile,
  }];
}

function createRecruitmentBatch(job: Job, sequence: number, targetMonth: string, status: Job["status"], demandType = job.demandType, plannedHeadcount = job.plannedHeadcount): RecruitmentBatch {
  const startedAt = new Date().toISOString();
  return {
    id: `${job.id}_batch_${sequence}_${randomUUID()}`,
    sequence,
    label: `第${sequence}批`,
    targetMonth: targetMonth || formatRecruitmentMonth(startedAt),
    demandType,
    plannedHeadcount: normalizePlannedHeadcount(plannedHeadcount),
    status,
    startedAt,
    profileSnapshot: buildJobProfileSnapshot(job),
  };
}

function formatRecruitmentMonth(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return `${validDate.getFullYear()}年${String(validDate.getMonth() + 1).padStart(2, "0")}月`;
}

function isJobStatus(value: unknown): value is Job["status"] {
  return value === "招聘中" || value === "暂停" || value === "已关闭";
}

function normalizeRecruitmentDemandType(value: unknown): Job["demandType"] {
  return value === "离职替补" || value === "计划内提前" || value === "计划内新增" || value === "计划外新增" ? value : "";
}

function normalizePlannedHeadcount(value: unknown) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 999);
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

function parseJsonArray(value: unknown): unknown[] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function parseStringArray(value: unknown): string[] {
  return parseJsonArray(value).map((item) => String(item).trim()).filter(Boolean);
}

function parseCandidateKeyPointAnalysis(value: unknown): Candidate["keyPointAnalysis"] {
  return parseJsonArray(value)
    .map((item) => {
      const source = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        keyword: String(source.keyword || "").trim(),
        matched: Boolean(source.matched),
        evidence: String(source.evidence || "").trim(),
      };
    })
    .filter((item) => item.keyword || item.evidence);
}

function parseCandidateTimeline(value: unknown): Candidate["interviewTimeline"] {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Candidate["interviewTimeline"]
    : {};
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
  const region = normalizeRegionToCity(row.location || "北京");
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
  const removedFromTalentPool = Boolean(row.removedFromTalentPool);
  const onboarded = normalizeOnboarded(row.onboarded);
  const isAutomaticallyArchived = row.conclusion === "已邀面试" || onboarded === "是";
  return {
    id: row.id,
    jobId: row.jobId,
    recruitmentBatchId: row.recruitmentBatchId || undefined,
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
    keyPointAnalysis: parseCandidateKeyPointAnalysis(row.keyPointAnalysis),
    interviewQuestions: parseJsonArray(row.interviewQuestions) as Candidate["interviewQuestions"],
    interviewStage: normalizeInterviewStage(row.interviewStage),
    stageRecommendation: normalizeStageRecommendation(row.stageRecommendation),
    interviewResult: String(row.interviewResult || "待定") as Candidate["interviewResult"],
    onboarded,
    reportMonth: row.reportMonth || formatReportMonth(),
    interviewReason: row.interviewReason || "",
    reasonTags: parseStringArray(row.reasonTags),
    interviewTimeline: parseCandidateTimeline(row.interviewTimeline),
    isInTalentPool: !removedFromTalentPool && (Boolean(row.isInTalentPool) || isAutomaticallyArchived),
    talentPoolAt: row.talentPoolAt || "",
    talentPoolNote: row.talentPoolNote || "",
    removedFromScreening: Boolean(row.removedFromScreening),
    removedFromTalentPool,
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
  const job = getJob(candidate.jobId);
  const recruitmentBatchId = candidate.recruitmentBatchId || job?.currentBatchId || "";
  const recruitmentMonth = job?.recruitmentBatches.find((batch) => batch.id === recruitmentBatchId)?.targetMonth;
  return {
    ...candidate,
    recruitmentBatchId,
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
    reportMonth: recruitmentMonth || candidate.reportMonth || formatReportMonth(),
    interviewReason: candidate.interviewReason || "",
    reasonTags: JSON.stringify(candidate.reasonTags || []),
    interviewTimeline: JSON.stringify(candidate.interviewTimeline || {}),
    isInTalentPool: candidate.isInTalentPool ? 1 : 0,
    talentPoolAt: candidate.talentPoolAt || "",
    talentPoolNote: candidate.talentPoolNote || "",
    removedFromScreening: candidate.removedFromScreening ? 1 : 0,
    removedFromTalentPool: candidate.removedFromTalentPool ? 1 : 0,
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
    const scoreDimensionKeys = new Set(["experience", "professional", "stability", "education", "business"]);
    const scoreDimensions = Array.isArray(parsed.scoreDimensions)
      ? parsed.scoreDimensions
        .map((item) => ({
          key: String(item?.key || ""),
          label: String(item?.label || "").trim(),
          weight: Number(item?.weight || 0),
          score: Number(item?.score || 0),
          reason: String(item?.reason || "").trim(),
        }))
        .filter((item) => scoreDimensionKeys.has(item.key)) as NonNullable<CandidateEvaluation["scoreDimensions"]>
      : [];
    if (!summary && !strengths.length && !weaknesses.length && !risks.length && !interviewFocuses.length && !scoreDimensions.length) return undefined;
    return { summary, strengths, weaknesses, risks, interviewFocuses, scoreDimensions };
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
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS auth_users (
    username TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    password_hash TEXT NOT NULL DEFAULT '',
    password_updated_at TEXT NOT NULL DEFAULT ''
  );`);
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES auth_users(username) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  sqliteDb.run("INSERT OR IGNORE INTO auth_users (username, role) VALUES ('admin', 'admin');");
  sqliteDb.run("INSERT OR IGNORE INTO auth_users (username, role) VALUES ('guest', 'guest');");
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    profile_group_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    dept TEXT NOT NULL,
    location TEXT NOT NULL,
    experience TEXT NOT NULL,
    level TEXT NOT NULL,
	    salary_range TEXT NOT NULL DEFAULT '面议',
	    demand_type TEXT NOT NULL DEFAULT '',
	    planned_headcount INTEGER NOT NULL DEFAULT 1,
	    keywords TEXT NOT NULL,
	    score_weights TEXT NOT NULL DEFAULT '{"experience":30,"professional":30,"stability":15,"education":10,"business":15}',
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    current_batch_id TEXT NOT NULL DEFAULT '',
    recruitment_batches TEXT NOT NULL DEFAULT '[]',
    salary_data TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	  );`);
	  ensureColumn("jobs", "profile_group_id", "TEXT NOT NULL DEFAULT ''");
	  ensureColumn("jobs", "salary_range", "TEXT NOT NULL DEFAULT '面议'");
	  ensureColumn("jobs", "demand_type", "TEXT NOT NULL DEFAULT ''");
	  ensureColumn("jobs", "planned_headcount", "INTEGER NOT NULL DEFAULT 1");
	  ensureColumn("jobs", "score_weights", `TEXT NOT NULL DEFAULT '{"experience":30,"professional":30,"stability":15,"education":10,"business":15}'`);
  ensureColumn("jobs", "current_batch_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("jobs", "recruitment_batches", "TEXT NOT NULL DEFAULT '[]'");
  sqliteDb.run("UPDATE jobs SET profile_group_id = id WHERE profile_group_id IS NULL OR profile_group_id = ''");
  sqliteDb.run(`CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    recruitment_batch_id TEXT NOT NULL DEFAULT '',
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
    removed_from_screening INTEGER NOT NULL DEFAULT 0,
    removed_from_talent_pool INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("candidates", "recruitment_batch_id", "TEXT NOT NULL DEFAULT ''");
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
  ensureColumn("candidates", "removed_from_screening", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("candidates", "removed_from_talent_pool", "INTEGER NOT NULL DEFAULT 0");
  ensureRecruitmentBatchAssignments();
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

function ensureRecruitmentBatchAssignments() {
  const statement = sqliteDb.prepare(`SELECT
    id, title, dept, location, experience, level, salary_range, demand_type, planned_headcount, keywords, score_weights,
    description, status, current_batch_id, recruitment_batches, created_at, updated_at
    FROM jobs`);
  const jobs: Record<string, unknown>[] = [];
  while (statement.step()) jobs.push(statement.getAsObject());
  statement.free();

  jobs.forEach((row) => {
    const fallback: RecruitmentBatchFallback = {
      id: String(row.id || ""),
      title: String(row.title || ""),
      dept: String(row.dept || ""),
      location: normalizeRegionToCity(String(row.location || "")),
      experience: String(row.experience || ""),
      level: String(row.level || ""),
      salaryRange: String(row.salary_range || "面议"),
      demandType: normalizeRecruitmentDemandType(row.demand_type),
      plannedHeadcount: normalizePlannedHeadcount(row.planned_headcount),
      keywords: String(row.keywords || ""),
      scoreWeights: normalizeJobScoreWeights(row.score_weights),
      description: String(row.description || ""),
      status: isJobStatus(row.status) ? row.status : "已关闭",
      createdAt: String(row.created_at || ""),
      updatedAt: String(row.updated_at || ""),
    };
    const recruitmentBatches = normalizeRecruitmentBatches(row.recruitment_batches, fallback);
    const storedCurrentBatchId = String(row.current_batch_id || "");
    const currentBatchId = recruitmentBatches.some((batch) => batch.id === storedCurrentBatchId)
      ? storedCurrentBatchId
      : recruitmentBatches.find((batch) => batch.status !== "已关闭")?.id || recruitmentBatches[recruitmentBatches.length - 1]?.id || "";
    sqliteDb.run(
      "UPDATE jobs SET current_batch_id = ?, recruitment_batches = ? WHERE id = ?",
      [currentBatchId, JSON.stringify(recruitmentBatches), fallback.id],
    );
    sqliteDb.run(
      "UPDATE candidates SET recruitment_batch_id = ? WHERE job_id = ? AND (recruitment_batch_id IS NULL OR recruitment_batch_id = '')",
      [currentBatchId, fallback.id],
    );
    syncCandidateRecruitmentMonthsNoPersist(fallback.id, recruitmentBatches);
  });
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
