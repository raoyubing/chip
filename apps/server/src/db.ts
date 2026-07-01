import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppState, Candidate, CandidateEvaluation, CandidateInterviewPlan, Job, SalaryData, VoiceAnalysis, VoiceTranscriptSegment } from "./types.js";
import { seedState } from "./seed.js";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = resolve(serverRoot, process.env.DB_PATH || "data/xiaosongshu.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });

type BindValue = string | number | Uint8Array | null;
let SQL: SqlJsStatic;
let db: Database;

export async function initDb() {
  SQL = await initSqlJs();
  db = existsSync(dbPath) ? new SQL.Database(readFileSync(dbPath)) : new SQL.Database();
  run("PRAGMA foreign_keys = ON");
  run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    dept TEXT NOT NULL,
    location TEXT NOT NULL,
    experience TEXT NOT NULL,
    level TEXT NOT NULL,
    salary_range TEXT NOT NULL DEFAULT '面议',
    keywords TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    salary_data TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("jobs", "salary_range", "TEXT NOT NULL DEFAULT '面议'");
  run(`CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    score REAL NOT NULL,
    conclusion TEXT NOT NULL,
    reason TEXT NOT NULL,
    resume_text TEXT NOT NULL,
    upload_time TEXT NOT NULL,
    file_name TEXT,
    file_type TEXT,
    file_size INTEGER,
    file_blob BLOB,
    evaluation_json TEXT NOT NULL DEFAULT '{}',
    interview_plan_json TEXT NOT NULL DEFAULT '{}',
    key_point_analysis TEXT NOT NULL DEFAULT '[]',
    interview_questions TEXT NOT NULL DEFAULT '[]',
    interview_recommendation TEXT NOT NULL DEFAULT '待定',
    stage_recommendation TEXT NOT NULL DEFAULT '是',
    interview_result TEXT NOT NULL DEFAULT '待定',
    onboarded TEXT NOT NULL DEFAULT '待入职',
    report_month TEXT NOT NULL DEFAULT '',
    interview_stage TEXT NOT NULL DEFAULT '初试',
    interview_reason TEXT NOT NULL DEFAULT '',
    reason_tags TEXT NOT NULL DEFAULT '[]',
    interview_timeline TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);
  ensureColumn("candidates", "interview_recommendation", "TEXT NOT NULL DEFAULT '待定'");
  ensureColumn("candidates", "stage_recommendation", "TEXT NOT NULL DEFAULT '是'");
  ensureColumn("candidates", "interview_result", "TEXT NOT NULL DEFAULT '待定'");
  ensureColumn("candidates", "onboarded", "TEXT NOT NULL DEFAULT '待入职'");
  ensureColumn("candidates", "report_month", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("candidates", "interview_stage", "TEXT NOT NULL DEFAULT '初试'");
  ensureColumn("candidates", "interview_reason", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("candidates", "reason_tags", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn("candidates", "interview_timeline", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("candidates", "evaluation_json", "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn("candidates", "interview_plan_json", "TEXT NOT NULL DEFAULT '{}'");
  run(`CREATE TABLE IF NOT EXISTS voice_analyses (
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
  run(`CREATE TABLE IF NOT EXISTS voice_transcript_segments (
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

  const count = one<{ count: number }>("SELECT COUNT(*) AS count FROM jobs")?.count ?? 0;
  if (count === 0) seedDatabase();
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
    currentUser: getSetting("currentUser") || seedState.currentUser,
    currentJobId: currentJob?.id || "",
    jobs,
    candidates,
    voiceAnalyses,
  };
}

export function getJobs(): Job[] {
  return all<Record<string, unknown>>(
    `SELECT j.*, COUNT(c.id) AS resume_count
     FROM jobs j
     LEFT JOIN candidates c ON c.job_id = j.id
     GROUP BY j.id
     ORDER BY j.sort_order ASC, j.created_at ASC`,
  ).map(rowToJob);
}

export function getJob(id: string): Job | null {
  const row = one<Record<string, unknown>>(
    `SELECT j.*, COUNT(c.id) AS resume_count
     FROM jobs j
     LEFT JOIN candidates c ON c.job_id = j.id
     WHERE j.id = ?
     GROUP BY j.id`,
    [id],
  );
  return row ? rowToJob(row) : null;
}

export function upsertJob(job: Omit<Job, "resumeCount" | "sortOrder"> & { sortOrder?: number }) {
  const maxSort = one<{ maxSort: number }>("SELECT COALESCE(MAX(sort_order), 0) AS maxSort FROM jobs")?.maxSort ?? 0;
  run(
    `INSERT INTO jobs (id, title, dept, location, experience, level, salary_range, keywords, description, status, salary_data, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       dept = excluded.dept,
       location = excluded.location,
       experience = excluded.experience,
       level = excluded.level,
       salary_range = excluded.salary_range,
       keywords = excluded.keywords,
       description = excluded.description,
       status = excluded.status,
       salary_data = excluded.salary_data,
       updated_at = CURRENT_TIMESTAMP`,
    [job.id, job.title, job.dept, job.location, job.experience, job.level, job.salaryRange, job.keywords, job.description, job.status, job.salaryData ? JSON.stringify(job.salaryData) : null, job.sortOrder ?? maxSort + 1],
  );
  persist();
}

export function closeJob(id: string) {
  run("UPDATE jobs SET status = '已关闭', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  const nextOngoing = getJobs().find((job) => job.status === "招聘中" && job.id !== id);
  if (nextOngoing) setSettingNoPersist("currentJobId", nextOngoing.id);
  persist();
}

export function deleteJob(id: string) {
  run("DELETE FROM jobs WHERE id = ?", [id]);
  persist();
}

export function prioritizeJob(id: string) {
  transaction(() => {
    run("UPDATE jobs SET sort_order = sort_order + 1");
    run("UPDATE jobs SET sort_order = 0 WHERE id = ?", [id]);
    setSettingNoPersist("currentJobId", id);
  });
  persist();
}

export function getCandidateById(id: string): Candidate | null {
  const row = one<Record<string, unknown>>("SELECT * FROM candidates WHERE id = ?", [id]);
  return row ? rowToCandidate(row) : null;
}

export function getCandidates(jobId: string): Candidate[] {
  return all<Record<string, unknown>>("SELECT * FROM candidates WHERE job_id = ? ORDER BY created_at DESC", [jobId]).map(rowToCandidate);
}

export function insertCandidates(candidates: Candidate[]) {
  transaction(() => candidates.forEach(insertCandidateNoPersist));
  persist();
}

export function updateCandidate(candidate: Candidate) {
  const data = serializeCandidate(candidate);
  const existingFileBlob = one<Record<string, unknown>>("SELECT file_blob FROM candidates WHERE id = ?", [candidate.id])?.file_blob;
  const normalizedExistingFileBlob = normalizeBlob(existingFileBlob);
  run(
    `UPDATE candidates SET name = ?, source = ?, score = ?, conclusion = ?, reason = ?, resume_text = ?, upload_time = ?, file_name = ?, file_type = ?, file_size = ?, file_blob = ?, evaluation_json = ?, interview_plan_json = ?, key_point_analysis = ?, interview_questions = ?, interview_stage = ?, stage_recommendation = ?, interview_result = ?, onboarded = ?, report_month = ?, interview_reason = ?, reason_tags = ?, interview_timeline = ? WHERE id = ?`,
    [data.name, data.source, data.score, data.conclusion, data.reason, data.resumeText, data.uploadTime, data.fileName, data.fileType, data.fileSize, data.fileBlob ?? normalizedExistingFileBlob, data.evaluationJson, data.interviewPlanJson, data.keyPointAnalysis, data.interviewQuestions, data.interviewStage, data.stageRecommendation, data.interviewResult, data.onboarded, data.reportMonth, data.interviewReason, data.reasonTags, data.interviewTimeline, data.id],
  );
  persist();
}

export function deleteCandidate(id: string) {
  run("DELETE FROM candidates WHERE id = ?", [id]);
  persist();
}

export function getDatabasePath() {
  return dbPath;
}

export function getVoiceAnalyses(jobId: string): VoiceAnalysis[] {
  return all<Record<string, unknown>>("SELECT * FROM voice_analyses WHERE job_id = ? ORDER BY created_at DESC", [jobId]).map(rowToVoiceAnalysis);
}

export function insertVoiceAnalysis(analysis: VoiceAnalysis) {
  run(
    `INSERT INTO voice_analyses (id, job_id, candidate_id, audio_name, audio_type, audio_size, transcript, summary, job_fit_advice, communication_strengths, communication_risks, recruiter_suggestions, recruiter_review, recommendation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [analysis.id, analysis.jobId, analysis.candidateId, analysis.audioName, analysis.audioType ?? null, analysis.audioSize ?? null, analysis.transcript, analysis.summary, analysis.jobFitAdvice, JSON.stringify(analysis.communicationStrengths), JSON.stringify(analysis.communicationRisks), JSON.stringify(analysis.recruiterSuggestions), JSON.stringify(analysis.recruiterReview), analysis.recommendation, analysis.createdAt],
  );
  persist();
}

export function deleteVoiceAnalysis(id: string) {
  run("DELETE FROM voice_analyses WHERE id = ?", [id]);
  persist();
}

export function insertVoiceTranscriptSegment(segment: VoiceTranscriptSegment) {
  run(
    `INSERT INTO voice_transcript_segments (id, session_id, job_id, candidate_id, segment_index, raw_transcript, normalized_transcript, analysis_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [segment.id, segment.sessionId, segment.jobId, segment.candidateId, segment.segmentIndex, segment.rawTranscript, segment.normalizedTranscript, segment.analysisJson ?? null, segment.createdAt],
  );
  persist();
}

export function getVoiceTranscriptSegments(sessionId: string) {
  return all<Record<string, unknown>>(
    "SELECT * FROM voice_transcript_segments WHERE session_id = ? ORDER BY segment_index ASC, created_at ASC",
    [sessionId],
  ).map(rowToVoiceTranscriptSegment);
}

export function updateVoiceTranscriptSegmentAnalysis(id: string, analysisJson: string) {
  run("UPDATE voice_transcript_segments SET analysis_json = ? WHERE id = ?", [analysisJson, id]);
  persist();
}

export function resetDatabase() {
  transaction(() => {
    run("DELETE FROM candidates");
    run("DELETE FROM jobs");
    run("DELETE FROM settings");
    seedDatabase();
  });
  persist();
}

export function setSetting(key: string, value: string) {
  setSettingNoPersist(key, value);
  persist();
}

function setSettingNoPersist(key: string, value: string) {
  run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

function getSetting(key: string) {
  return one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key])?.value;
}

function seedDatabase() {
  seedState.jobs.forEach((job) => upsertJobNoPersist(job));
  Object.values(seedState.candidates).flat().forEach(insertCandidateNoPersist);
  setSettingNoPersist("currentUser", seedState.currentUser);
  setSettingNoPersist("currentJobId", seedState.currentJobId);
}

function upsertJobNoPersist(job: Job) {
  run(`INSERT INTO jobs (id, title, dept, location, experience, level, salary_range, keywords, description, status, salary_data, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [job.id, job.title, job.dept, job.location, job.experience, job.level, job.salaryRange, job.keywords, job.description, job.status, null, job.sortOrder]);
}

function insertCandidateNoPersist(candidate: Candidate) {
  const data = serializeCandidate(candidate);
  run(
    `INSERT INTO candidates (id, job_id, name, source, score, conclusion, reason, resume_text, upload_time, file_name, file_type, file_size, file_blob, evaluation_json, interview_plan_json, key_point_analysis, interview_questions, interview_stage, stage_recommendation, interview_result, onboarded, report_month, interview_reason, reason_tags, interview_timeline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.id, data.jobId, data.name, data.source, data.score, data.conclusion, data.reason, data.resumeText, data.uploadTime, data.fileName, data.fileType, data.fileSize, data.fileBlob, data.evaluationJson, data.interviewPlanJson, data.keyPointAnalysis, data.interviewQuestions, data.interviewStage, data.stageRecommendation, data.interviewResult, data.onboarded, data.reportMonth, data.interviewReason, data.reasonTags, data.interviewTimeline],
  );
}

function ensureColumn(table: string, column: string, definition: string) {
  const columns = all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((item) => item.name === column)) {
    run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function rowToJob(row: Record<string, unknown>): Job {
  return {
    id: String(row.id),
    title: String(row.title),
    dept: String(row.dept),
    location: String(row.location),
    experience: String(row.experience),
    level: String(row.level),
    salaryRange: String(row.salary_range || "面议"),
    keywords: String(row.keywords),
    description: String(row.description),
    status: row.status as Job["status"],
    resumeCount: Number(row.resume_count ?? 0),
    salaryData: row.salary_data ? normalizeSalaryData(JSON.parse(String(row.salary_data)), row) : null,
    sortOrder: Number(row.sort_order ?? 0),
  };
}

function normalizeSalaryData(raw: unknown, row: Record<string, unknown>): SalaryData {
  const legacy = (raw || {}) as Record<string, unknown>;
  if (legacy.filters && legacy.experienceBands && legacy.regionComparison && legacy.advice) {
    return legacy as unknown as SalaryData;
  }

  const p25 = Number(legacy.p25 ?? 18);
  const p50 = Number(legacy.p50 ?? 24);
  const p75 = Number(legacy.p75 ?? 30);
  const region = String(row.location || "北京");
  const experience = normalizeLegacyExperience(String(row.experience || "3-5年"));
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
      role: String(row.title || "岗位调研"),
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

function rowToCandidate(row: Record<string, unknown>): Candidate {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    name: String(row.name),
    source: String(row.source),
    score: Number(row.score),
    conclusion: String(row.conclusion),
    reason: String(row.reason),
    resumeText: String(row.resume_text),
    uploadTime: String(row.upload_time),
    fileName: row.file_name ? String(row.file_name) : null,
    fileType: row.file_type ? String(row.file_type) : null,
    fileSize: row.file_size ? Number(row.file_size) : null,
    fileDataBase64: null,
    evaluation: parseCandidateEvaluation(row.evaluation_json),
    interviewPlan: parseCandidateInterviewPlan(row.interview_plan_json),
    keyPointAnalysis: JSON.parse(String(row.key_point_analysis || "[]")),
    interviewQuestions: JSON.parse(String(row.interview_questions || "[]")),
    interviewStage: normalizeInterviewStage(row.interview_stage),
    stageRecommendation: normalizeStageRecommendation(row.stage_recommendation),
    interviewResult: String(row.interview_result || "待定") as Candidate["interviewResult"],
    onboarded: normalizeOnboarded(row.onboarded),
    reportMonth: String(row.report_month || formatReportMonth()),
    interviewReason: String(row.interview_reason || ""),
    reasonTags: JSON.parse(String(row.reason_tags || "[]")),
    interviewTimeline: JSON.parse(String(row.interview_timeline || "{}")),
  };
}

function rowToVoiceAnalysis(row: Record<string, unknown>): VoiceAnalysis {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    candidateId: String(row.candidate_id),
    audioName: String(row.audio_name),
    audioType: row.audio_type ? String(row.audio_type) : null,
    audioSize: row.audio_size ? Number(row.audio_size) : null,
    transcript: String(row.transcript),
    summary: String(row.summary),
    jobFitAdvice: String(row.job_fit_advice),
    communicationStrengths: JSON.parse(String(row.communication_strengths || "[]")),
    communicationRisks: JSON.parse(String(row.communication_risks || "[]")),
    recruiterSuggestions: JSON.parse(String(row.recruiter_suggestions || "[]")),
    recruiterReview: JSON.parse(String(row.recruiter_review || "[]")),
    recommendation: String(row.recommendation) as VoiceAnalysis["recommendation"],
    createdAt: String(row.created_at),
  };
}

function rowToVoiceTranscriptSegment(row: Record<string, unknown>): VoiceTranscriptSegment {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    jobId: String(row.job_id),
    candidateId: String(row.candidate_id),
    segmentIndex: Number(row.segment_index ?? 0),
    rawTranscript: String(row.raw_transcript || ""),
    normalizedTranscript: String(row.normalized_transcript || ""),
    analysisJson: row.analysis_json ? String(row.analysis_json) : undefined,
    createdAt: String(row.created_at || ""),
  };
}

function normalizeInterviewStage(value: unknown): NonNullable<Candidate["interviewStage"]> {
  if (value === "复试" || value === "推荐复试" || value === "初试通过") return "复试";
  if (value === "offer" || value === "复试通过" || value === "入职") return "offer";
  return "初试";
}

function normalizeStageRecommendation(value: unknown): NonNullable<Candidate["stageRecommendation"]> {
  return value === "否" ? "否" : "是";
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
  if (value instanceof Uint8Array) return value;
  return new Uint8Array(value as ArrayLike<number>);
}

function serializeCandidate(candidate: Candidate) {
  return {
    ...candidate,
    fileName: candidate.fileName ?? null,
    fileType: candidate.fileType ?? null,
    fileSize: candidate.fileSize ?? null,
    fileBlob: candidate.fileDataBase64 ? Uint8Array.from(Buffer.from(candidate.fileDataBase64, "base64")) : null,
    evaluationJson: JSON.stringify(candidate.evaluation || {}),
    interviewPlanJson: JSON.stringify(candidate.interviewPlan || {}),
    keyPointAnalysis: JSON.stringify(candidate.keyPointAnalysis || []),
    interviewQuestions: JSON.stringify(candidate.interviewQuestions || []),
    interviewStage: normalizeInterviewStage(candidate.interviewStage),
    stageRecommendation: candidate.stageRecommendation || "是",
    interviewResult: candidate.interviewResult || "待定",
    onboarded: normalizeOnboarded(candidate.onboarded),
    reportMonth: candidate.reportMonth || formatReportMonth(),
    interviewReason: candidate.interviewReason || "",
    reasonTags: JSON.stringify(candidate.reasonTags || []),
    interviewTimeline: JSON.stringify(candidate.interviewTimeline || {}),
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
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions.map((item) => ({
        title: String(item?.title || "").trim(),
        question: String(item?.question || "").trim(),
        competency: String(item?.competency || "").trim(),
        questionType: String(item?.questionType || "行为型").trim() as CandidateInterviewPlan["questions"][number]["questionType"],
        designIntent: String(item?.designIntent || "").trim(),
        strongSignals: Array.isArray(item?.strongSignals) ? item.strongSignals.map((text) => String(text).trim()).filter(Boolean) : [],
        warningSignals: Array.isArray(item?.warningSignals) ? item.warningSignals.map((text) => String(text).trim()).filter(Boolean) : [],
        followUps: Array.isArray(item?.followUps) ? item.followUps.map((text) => String(text).trim()).filter(Boolean) : [],
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

function all<T extends Record<string, unknown>>(sql: string, params: BindValue[] = []): T[] {
  const statement = db.prepare(sql);
  statement.bind(params);
  const rows: T[] = [];
  while (statement.step()) rows.push(statement.getAsObject() as T);
  statement.free();
  return rows;
}

function one<T extends Record<string, unknown>>(sql: string, params: BindValue[] = []): T | undefined {
  return all<T>(sql, params)[0];
}

function run(sql: string, params: BindValue[] = []) {
  db.run(sql, params);
}

function transaction(callback: () => void) {
  run("BEGIN");
  try {
    callback();
    run("COMMIT");
  } catch (error) {
    run("ROLLBACK");
    throw error;
  }
}

function persist() {
  writeFileSync(dbPath, Buffer.from(db.export()));
}
