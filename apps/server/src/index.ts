import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import sensible from "@fastify/sensible";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import Fastify, { type FastifyRequest } from "fastify";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import wavefile from "wavefile";
import { z } from "zod";
import { bossIndustryCodeByName, normalizeBossIndustryName } from "@xiaosongshu/shared";
import { createCandidate, normalizeKeywords } from "./analyzer.js";
import { loadLocalEnv, serverRoot } from "./env.js";
import { fileService } from "./file-service.js";
import { extractResumeTextFromFile } from "./resume-parser.js";
import { getRegionDirectory } from "./region-service.js";
import {
  closeJob,
  deleteCandidate,
  deleteJob,
  deleteVoiceAnalysis,
  getDatabasePath,
  getCandidateById,
  getCandidates,
  getJob,
  getJobs,
  getState,
  getVoiceTranscriptSegments,
  initDb,
  insertCandidates,
  insertVoiceTranscriptSegment,
  insertVoiceAnalysis,
  prioritizeJob,
  clearDatabase,
  setSetting,
  updateCandidate,
  updateVoiceTranscriptSegmentAnalysis,
  upsertJob,
} from "./db.js";
import type { Candidate, CandidateEvaluation, CandidateInterviewPlan, InterviewMethodKey, Job, SalaryData, SalaryFilters, VoiceAnalysis, VoiceFinalEvaluation, VoiceRecruiterCoachReport, VoiceTranscriptResult, VoiceTranscriptSegment } from "./types.js";

loadLocalEnv();

const server = Fastify({
  logger: true,
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 20 * 1024 * 1024),
});
const port = Number(process.env.PORT || 5175);

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const deepseekTimeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 18000);
const deepseekResumeTimeoutMs = Number(process.env.DEEPSEEK_RESUME_TIMEOUT_MS || 9000);
const resumeExtractTimeoutMs = Number(process.env.RESUME_EXTRACT_TIMEOUT_MS || 12000);
const uploadMaxFileSizeMb = Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 20);
const whisperModelId = process.env.WHISPER_MODEL_ID || "Xenova/whisper-tiny";
const whisperModelDir = resolve(serverRoot, process.env.WHISPER_MODEL_DIR || "models");
const whisperTargetLanguage = process.env.WHISPER_LANGUAGE || "zh";
const whisperChunkLength = Number(process.env.WHISPER_CHUNK_LENGTH || 20);
const whisperStrideLength = Number(process.env.WHISPER_STRIDE_LENGTH || 4);
const whisperModelDownloadCommand = "pnpm --filter @xiaosongshu/server download:whisper-model";
const salarySearchTimeoutMs = Number(process.env.SALARY_SEARCH_TIMEOUT_MS || 8000);
const bossScraperEnabled = readBooleanEnv(process.env.BOSS_SCRAPER_ENABLED, true);
const bossScraperDir = resolveServerPath(process.env.BOSS_SCRAPER_DIR || "tools/boss-zhipin-scraper");
const bossScraperScriptPath = resolveServerPath(process.env.BOSS_SCRAPER_SCRIPT_PATH || "tools/boss-zhipin-scraper/scripts/boss_cdp_raw.py");
const bossScraperPython = process.env.BOSS_SCRAPER_PYTHON
  ? resolveCommandOrServerPath(process.env.BOSS_SCRAPER_PYTHON)
  : resolveServerPath(".venv/bin/python");
const bossScraperOutputDir = resolveServerPath(process.env.BOSS_SCRAPER_OUTPUT_DIR || "data/salary-scraper");
const bossScraperCdpPort = Number(process.env.BOSS_SCRAPER_CDP_PORT || 9222);
const bossScraperPages = clampInteger(Number(process.env.BOSS_SCRAPER_PAGES || 1), 1, 10);
const bossScraperTimeoutMs = Number(process.env.BOSS_SCRAPER_TIMEOUT_MS || 180000);
await server.register(cors, { origin: true });
await server.register(sensible);
await server.register(multipart, {
  throwFileSizeLimit: true,
  limits: {
    fileSize: uploadMaxFileSizeMb * 1024 * 1024,
    files: 10,
    parts: 100,
  },
});
await initDb();

const defaultJobScoreWeights: Job["scoreWeights"] = {
  experience: 30,
  professional: 30,
  stability: 15,
  education: 10,
  business: 15,
};

const jobSchema = z.object({
  title: z.string().min(1),
  dept: z.string().min(1),
  location: z.string().min(1),
  experience: z.string().min(1),
  level: z.string().min(1),
  salaryRange: z.string().trim()
    .refine((value) => Boolean(normalizeJobSalaryRangeInput(value)), "薪资范围格式必须为 20k - 30k")
    .transform((value) => normalizeJobSalaryRangeInput(value) || value),
  keywords: z.string().min(1),
  scoreWeights: z.object({
    experience: z.number().int().min(0).max(100),
    professional: z.number().int().min(0).max(100),
    stability: z.number().int().min(0).max(100),
    education: z.number().int().min(0).max(100),
    business: z.number().int().min(0).max(100),
  }).refine((weights) => Object.values(weights).reduce((sum, item) => sum + item, 0) === 100, "AI评分模型权重总和必须等于100%").default(defaultJobScoreWeights),
  description: z.string().min(1),
  status: z.enum(["招聘中", "暂停", "已关闭"]),
});

function normalizeJobSalaryRangeInput(value: string) {
  const matched = value.match(/^(\d+)\s*k?\s*[-~—]\s*(\d+)\s*k?$/i);
  if (!matched) return "";
  const low = Number(matched[1]);
  const high = Number(matched[2]);
  if (!Number.isInteger(low) || !Number.isInteger(high) || low <= 0 || high <= 0 || high < low) return "";
  return `${low}k - ${high}k`;
}

const resumeDocumentUploadErrorMessage = "简历文件仅支持 PDF、DOC、DOCX";
const resumeDocumentAllowedExtensions = new Set(["pdf", "doc", "docx"]);
const resumeDocumentAllowedMimeTypes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function getUploadFileExtension(fileName: string) {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function isAllowedResumeDocumentFile(file: { name?: string | null; type?: string | null; contentType?: string | null }) {
  const extension = getUploadFileExtension(file.name || "");
  if (resumeDocumentAllowedExtensions.has(extension)) return true;
  return !extension && resumeDocumentAllowedMimeTypes.has((file.type || file.contentType || "").toLowerCase());
}

function buildUnsupportedResumeDocumentMessage(files: Array<{ name?: string | null }>) {
  const names = files.map((file) => file.name).filter(Boolean).slice(0, 3).join("、");
  const suffix = files.length > 3 ? " 等" : "";
  return names ? `${resumeDocumentUploadErrorMessage}：${names}${suffix}` : resumeDocumentUploadErrorMessage;
}

const scoreWeightLabels: Array<[keyof Job["scoreWeights"], string]> = [
  ["experience", "经验匹配"],
  ["professional", "专业契合度"],
  ["stability", "稳定性"],
  ["education", "学历背景"],
  ["business", "业务导向"],
];

const resumeFilePayloadSchema = z.object({
  name: z.string(),
  candidateName: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  resumeText: z.string().optional().default(""),
  type: z.string().optional().nullable(),
  content_type: z.string().optional().nullable(),
  size: z.number().optional().nullable(),
  text: z.string().optional().default(""),
  dataBase64: z.string().optional().nullable(),
  bucket: z.string().optional().nullable(),
  object_key: z.string().optional().nullable(),
  url: z.string().optional().nullable(),
  view_url: z.string().optional().nullable(),
});

const resumeSchema = z.object({
  duplicateAction: z.enum(["skip", "overwrite"]).optional().default("skip"),
  files: z.array(resumeFilePayloadSchema.extend({
    candidateName: z.string().min(1, "候选人姓名不能为空"),
    source: z.string().min(1, "来源渠道不能为空"),
    resumeText: z.string().min(1, "简历原文不能为空"),
  })).min(1, "请至少上传一份简历"),
});

const resumeParseSchema = z.object({
  files: z.array(resumeFilePayloadSchema).min(1).max(10),
});
type ResumeFileInput = z.infer<typeof resumeFilePayloadSchema>;

const fileUploadSceneSchema = z.enum(["default", "resume", "form_design", "approval_item_icon", "system_logo"]).default("default");
const uploadFileSchema = z.object({
  scene: fileUploadSceneSchema,
});
const deleteFileSchema = z.object({
  object_key: z.string().min(1).max(512),
});
const getFileViewUrlQuerySchema = z.object({
  object_key: z.string().min(1).max(512),
  purpose: z.enum(["default", "kkfile", "markdown"]).optional().default("default"),
  content_type: z.string().min(1).max(255).optional(),
});
const getFileStreamQuerySchema = z.object({
  token: z.string().min(1).max(4096),
  fullfilename: z.string().min(1).max(512).optional(),
  content_type: z.string().min(1).max(255).optional(),
});

const salaryFilterSchema = z.object({
  role: z.string().min(1),
  region: z.string().min(1),
  experience: z.string().min(1),
  industry: z.string().min(1),
  education: z.string().min(1),
});

const voiceTranscribeSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
  fileName: z.string().optional().default("voice-chunk.webm"),
  normalize: z.boolean().optional().default(false),
});

const voiceAnalysisSchema = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  audioName: z.string().trim().min(1),
  audioType: z.string().trim().optional().nullable(),
  audioSize: z.number().int().nonnegative().optional().nullable(),
  transcript: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  jobFitAdvice: z.string().trim().min(1),
  communicationStrengths: z.array(z.string().trim().min(1)).default([]),
  communicationRisks: z.array(z.string().trim().min(1)).default([]),
  recruiterSuggestions: z.array(z.string().trim().min(1)).default([]),
  recruiterReview: z.array(z.object({
    title: z.string().trim().min(1),
    level: z.enum(["良好", "注意", "待优化"]),
    text: z.string().trim().min(1),
  })).default([]),
  recommendation: z.enum(["建议推进", "建议复核", "暂缓推进"]),
});

const voiceSegmentAnalyzeSchema = z.object({
  sessionId: z.string().min(1),
  segmentId: z.string().min(1),
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  segmentIndex: z.number().int().nonnegative(),
  rawTranscript: z.string().default(""),
  normalizedTranscript: z.string().min(1),
});

const voiceFinalEvaluateSchema = z.object({
  sessionId: z.string().min(1),
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
});

const jobCopilotSchema = jobSchema.extend({
  useCase: z.enum(["jd-optimize", "interview-questions"]).default("jd-optimize"),
});

const candidateInterviewPlanSchema = z.object({
  candidateId: z.string().min(1),
});

server.get("/api/health", async () => ({ ok: true }));

server.get("/api/regions", async () => getRegionDirectory());

server.post("/api/files/upload", async (request) => {
  const file = await request.file();
  if (!file) throw server.httpErrors.badRequest("请上传文件");
  const payload = uploadFileSchema.parse({
    scene: getMultipartFieldValue(file.fields, "scene") || "default",
  });
  if (payload.scene === "resume" && !isAllowedResumeDocumentFile({ name: file.filename, type: file.mimetype })) {
    throw server.httpErrors.badRequest(resumeDocumentUploadErrorMessage);
  }
  const buffer = await file.toBuffer();
  return fileService.uploadFile({
    scene: payload.scene,
    name: file.filename,
    buffer,
    contentType: file.mimetype,
  });
});

server.delete("/api/files", async (request) => {
  const body = deleteFileSchema.parse(request.body);
  return fileService.deleteFile(body.object_key);
});

server.get("/api/files/view-url", async (request) => {
  const query = getFileViewUrlQuerySchema.parse(request.query);
  return fileService.getFileViewUrl({
    objectKey: query.object_key,
    purpose: query.purpose,
    publicBaseUrl: getRequestPublicBaseUrl(request),
    contentType: query.content_type,
  });
});

server.get("/api/files/stream", async (request, reply) => {
  const query = getFileStreamQuerySchema.parse(request.query);
  const result = await fileService.getFileStream({
    token: query.token,
    contentType: query.content_type,
  });

  reply.header("Content-Type", result.contentType);
  reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(result.fileName)}`);
  reply.header("Cache-Control", "private, no-store, max-age=0");
  if (typeof result.contentLength === "number") {
    reply.header("Content-Length", String(result.contentLength));
  }
  if (result.lastModified) {
    reply.header("Last-Modified", result.lastModified.toUTCString());
  }
  if (result.eTag) {
    reply.header("ETag", result.eTag);
  }

  return reply.send(result.body);
});

server.post("/api/resumes/parse", async (request) => {
  const body = resumeParseSchema.parse(request.body);
  const unsupportedFiles = body.files.filter((file) => !isAllowedResumeDocumentFile({ name: file.name, type: file.type, contentType: file.content_type }));
  if (unsupportedFiles.length) throw server.httpErrors.badRequest(buildUnsupportedResumeDocumentMessage(unsupportedFiles));

  const resumes = await Promise.all(body.files.map((file) => parseResumePreview(file)));
  return { resumes };
});

server.get("/api/state", async () => getState());

const clearDataHandler = async () => {
  clearDatabase();
  return getState();
};

server.post("/api/data/clear", clearDataHandler);
server.post("/api/reset", clearDataHandler);

server.post("/api/current-job", async (request) => {
  const body = z.object({ jobId: z.string().min(1) }).parse(request.body);
  if (!getJob(body.jobId)) throw server.httpErrors.notFound("职位不存在");
  prioritizeJob(body.jobId);
  return getState();
});

server.post("/api/jobs", async (request) => {
  const body = jobSchema.parse(request.body);
  const id = `job_${Date.now()}`;
  upsertJob({ id, ...body, salaryData: null });
  setSetting("currentJobId", id);
  prioritizeJob(id);
  return getState();
});

server.put("/api/jobs/:id", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const existing = getJob(params.id);
  if (!existing) throw server.httpErrors.notFound("职位不存在");
  const body = jobSchema.parse(request.body);
  upsertJob({ ...existing, ...body, salaryData: null });
  return getState();
});

server.post("/api/jobs/:id/close", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const existing = getJob(params.id);
  if (!existing) throw server.httpErrors.notFound("职位不存在");
  closeJob(params.id);
  return getState();
});

server.delete("/api/jobs/:id", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const jobs = getJobs();
  if (jobs.length <= 1) throw server.httpErrors.badRequest("至少保留一个职位");
  deleteJob(params.id);
  const nextJob = getJobs()[0];
  if (nextJob) setSetting("currentJobId", nextJob.id);
  return getState();
});

server.post("/api/jobs/:id/resumes", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const job = getJob(params.id);
  if (!job) throw server.httpErrors.notFound("职位不存在");
  const body = resumeSchema.parse(request.body);
  const unsupportedFiles = body.files.filter((file) => !isAllowedResumeDocumentFile({ name: file.name, type: file.type, contentType: file.content_type }));
  if (unsupportedFiles.length) throw server.httpErrors.badRequest(buildUnsupportedResumeDocumentMessage(unsupportedFiles));

  const candidates = await buildCandidatesFromResumeInput(job, body);
  saveCandidatesWithDuplicateHandling(candidates, job.id, body.duplicateAction);
  setSetting("currentJobId", job.id);
  return { state: getState() };
});

server.post("/api/candidates/:id/mark-interview", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  updateCandidate({
    ...candidate,
    conclusion: "已邀面试",
    score: Math.max(candidate.score, 75),
    interviewStage: "推荐",
    stageRecommendation: "待定",
    interviewResult: "待定",
    reportMonth: candidate.reportMonth || formatReportMonth(),
    interviewTimeline: candidate.interviewTimeline || {},
  });
  return getState();
});

server.post("/api/candidates/:id/talent-pool", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({ note: z.string().trim().max(500).optional() }).parse(request.body ?? {});
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  updateCandidate({
    ...candidate,
    isInTalentPool: true,
    talentPoolAt: candidate.talentPoolAt || new Date().toLocaleString("zh-CN"),
    talentPoolNote: body.note || candidate.talentPoolNote || "",
  });
  return getState();
});

server.post("/api/candidates/:id/recommend-to-job", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({
    jobId: z.string().min(1),
    duplicateAction: z.enum(["skip", "overwrite"]).optional().default("skip"),
  }).parse(request.body ?? {});
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  const targetJob = getJob(body.jobId);
  if (!targetJob) throw server.httpErrors.notFound("目标岗位不存在");
  if (targetJob.status !== "招聘中") throw server.httpErrors.badRequest("只能推荐至招聘中的岗位");

  const recommendationDate = formatBacktrackRecommendationDate();
  const remark = `由人才库于 ${recommendationDate} 回溯推荐`;
  const summary = candidate.evaluation?.summary || candidate.reason || "该候选人来自人才库回溯推荐，建议结合目标岗位重新筛选。";
  const clonedCandidate: Candidate = {
    ...candidate,
    id: `c_${Date.now()}_${nanoid(6)}`,
    jobId: targetJob.id,
    source: `人才库回溯 · ${candidate.source}`,
    conclusion: "待筛选",
    reason: summary,
    remark,
    uploadTime: new Date().toLocaleDateString("zh-CN"),
    evaluation: {
      summary,
      strengths: candidate.evaluation?.strengths || [],
      weaknesses: candidate.evaluation?.weaknesses || [],
      risks: candidate.evaluation?.risks || [],
      interviewFocuses: candidate.evaluation?.interviewFocuses || [],
      scoreDimensions: candidate.evaluation?.scoreDimensions || [],
    },
    interviewPlan: undefined,
    interviewQuestions: [],
    interviewStage: undefined,
    stageRecommendation: "待定",
    interviewResult: "待定",
    onboarded: "待入职",
    reportMonth: formatReportMonth(),
    interviewReason: "",
    reasonTags: [],
    interviewTimeline: {},
    isInTalentPool: false,
    talentPoolAt: "",
    talentPoolNote: "",
  };

  const existingCandidate = findExistingCandidateInJob(clonedCandidate, targetJob.id);
  if (existingCandidate) {
    if (body.duplicateAction === "overwrite") {
      updateCandidate(mergeCandidateResumeOverwrite(existingCandidate, clonedCandidate));
    }
    setSetting("currentJobId", targetJob.id);
    return getState();
  }

  insertCandidates([clonedCandidate]);
  setSetting("currentJobId", targetJob.id);
  return getState();
});

server.post("/api/candidates/:id/talent-revival-script", async (request) => {
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  const body = z.object({ jobId: z.string().min(1) }).parse(request.body ?? {});
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  const job = getJob(body.jobId);
  if (!job) throw server.httpErrors.notFound("目标岗位不存在");
  const script = await generateTalentRevivalScript(candidate, job);
  return { script };
});

server.patch("/api/candidates/:id/interview-stage", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({
    interviewStage: z.enum(["推荐", "初试", "复试", "offer"]),
    stageRecommendation: z.enum(["待定", "是", "否"]).default("待定"),
    interviewResult: z.enum(["通过", "淘汰", "待定", "未到面"]).default("待定"),
    onboarded: z.enum(["待入职", "是", "否"]).default("待入职"),
    reportMonth: z.string().trim().min(1).default(formatReportMonth()),
    interviewReason: z.string().default(""),
    reasonTags: z.array(z.string()).default([]),
    interviewTimeline: z.object({
      recommendedAt: z.string().optional(),
      firstInterviewPassedAt: z.string().optional(),
      secondInterviewPassedAt: z.string().optional(),
      offerAt: z.string().optional(),
      onboardedAt: z.string().optional(),
    }).default({}),
  }).parse(request.body);
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  const stageRecommendation = resolveStageRecommendation(body.interviewStage, body.stageRecommendation);
  const reasonTags = shouldManageReasonTags(body.interviewStage, body.interviewResult, body.onboarded)
    ? normalizeReasonTags(body.reasonTags.length ? body.reasonTags : inferReasonTags(body.interviewReason, body.interviewStage, body.onboarded), body.interviewStage, body.onboarded)
    : [];
  const timeline = mergeInterviewTimeline(candidate, { ...body, stageRecommendation });
  updateCandidate({
    ...candidate,
    interviewStage: body.interviewStage,
    stageRecommendation,
    interviewResult: body.interviewResult,
    onboarded: body.onboarded,
    reportMonth: body.reportMonth,
    interviewReason: body.interviewReason,
    reasonTags,
    interviewTimeline: timeline,
  });
  return getState();
});

server.delete("/api/candidates/:id", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  deleteCandidate(params.id);
  return getState();
});

server.post("/api/jobs/:id/salary/refresh", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const job = getJob(params.id);
  if (!job) throw server.httpErrors.notFound("职位不存在");
  const filters = salaryFilterSchema.parse(request.body);
  const salaryData = await generateSalaryData(job, filters);
  upsertJob({ ...job, salaryData });
  return { salaryData, state: getState() };
});

server.post("/api/salary/research", async (request) => {
  const filters = salaryFilterSchema.parse(request.body);
  const job = buildVirtualSalaryResearchJob(filters);
  const salaryData = await generateSalaryData(job, filters);
  return { salaryData };
});

server.post("/api/voice/transcribe", async (request) => {
  const body = voiceTranscribeSchema.parse(request.body);
  const transcript = await transcribeVoiceChunk(body.audioBase64, body.mimeType, body.fileName);
  const normalizedTranscript = body.normalize ? await normalizeVoiceTranscript(transcript) : transcript;
  return {
    transcript,
    normalizedTranscript,
  } satisfies VoiceTranscriptResult;
});

server.post("/api/voice/segments", async (request) => {
  const body = voiceSegmentAnalyzeSchema.parse(request.body);
  const job = getJob(body.jobId);
  if (!job) throw server.httpErrors.notFound("关联岗位不存在");
  const candidate = getCandidateById(body.candidateId);
  if (!candidate) throw server.httpErrors.notFound("关联人选不存在");

  const segment: VoiceTranscriptSegment = {
    id: body.segmentId,
    sessionId: body.sessionId,
    jobId: body.jobId,
    candidateId: body.candidateId,
    segmentIndex: body.segmentIndex,
    rawTranscript: body.rawTranscript,
    normalizedTranscript: body.normalizedTranscript,
    createdAt: new Date().toLocaleString("zh-CN"),
  };
  insertVoiceTranscriptSegment(segment);
  return { ok: true };
});

server.post("/api/voice/analyze-segment", async (request) => {
  const body = voiceSegmentAnalyzeSchema.parse(request.body);
  const job = getJob(body.jobId);
  if (!job) throw server.httpErrors.notFound("关联岗位不存在");
  const candidate = getCandidateById(body.candidateId);
  if (!candidate) throw server.httpErrors.notFound("关联人选不存在");

  const segment: VoiceTranscriptSegment = {
    id: body.segmentId,
    sessionId: body.sessionId,
    jobId: body.jobId,
    candidateId: body.candidateId,
    segmentIndex: body.segmentIndex,
    rawTranscript: body.rawTranscript,
    normalizedTranscript: body.normalizedTranscript,
    createdAt: new Date().toLocaleString("zh-CN"),
  };
  insertVoiceTranscriptSegment(segment);

  const segments = getVoiceTranscriptSegments(body.sessionId);
  const recentSegments = segments.slice(-5);
  const result = await analyzeVoiceSegmentWithDeepSeek(job, candidate, recentSegments, body.normalizedTranscript);
  updateVoiceTranscriptSegmentAnalysis(body.segmentId, JSON.stringify(result));
  return result;
});

server.post("/api/voice/final-evaluate", async (request) => {
  const body = voiceFinalEvaluateSchema.parse(request.body);
  const job = getJob(body.jobId);
  if (!job) throw server.httpErrors.notFound("关联岗位不存在");
  const candidate = getCandidateById(body.candidateId);
  if (!candidate) throw server.httpErrors.notFound("关联人选不存在");
  const segments = getVoiceTranscriptSegments(body.sessionId);
  return await evaluateFullVoiceInterviewWithDeepSeek(job, candidate, segments);
});

server.post("/api/voice-analyses", async (request) => {
  const body = voiceAnalysisSchema.parse(request.body);
  const job = getJob(body.jobId);
  if (!job) throw server.httpErrors.notFound("关联岗位不存在");
  const candidate = getCandidateById(body.candidateId);
  if (!candidate) throw server.httpErrors.notFound("关联人选不存在");
  if (candidate.jobId !== body.jobId) throw server.httpErrors.badRequest("人选与岗位不匹配");

  const analysis: VoiceAnalysis = {
    id: `voice_${Date.now()}_${nanoid(6)}`,
    jobId: body.jobId,
    candidateId: body.candidateId,
    audioName: body.audioName,
    audioType: body.audioType ?? null,
    audioSize: body.audioSize ?? null,
    transcript: body.transcript,
    summary: body.summary,
    jobFitAdvice: body.jobFitAdvice,
    communicationStrengths: body.communicationStrengths,
    communicationRisks: body.communicationRisks,
    recruiterSuggestions: body.recruiterSuggestions,
    recruiterReview: body.recruiterReview,
    recommendation: body.recommendation,
    createdAt: new Date().toLocaleString("zh-CN"),
  };

  insertVoiceAnalysis(analysis);
  return { state: getState(), analysis };
});

server.delete("/api/voice-analyses/:id", async (request) => {
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  deleteVoiceAnalysis(params.id);
  return { state: getState() };
});

server.post("/api/job-copilot", async (request) => {
  const body = jobCopilotSchema.parse(request.body);
  if (!deepseekApiKey) {
    throw server.httpErrors.badRequest("未配置 DEEPSEEK_API_KEY，请先在 apps/server/.env 或 apps/server/.env.local 中配置。");
  }

  const result = await generateJobCopilot(body);
  return result;
});

server.post("/api/candidates/:id/interview-plan", async (request) => {
  const params = z.object({ id: z.string().min(1) }).parse(request.params);
  candidateInterviewPlanSchema.parse({ candidateId: params.id });
  const candidate = getCandidateById(params.id);
  if (!candidate) throw server.httpErrors.notFound("候选人不存在");
  const job = getJob(candidate.jobId);
  if (!job) throw server.httpErrors.notFound("关联职位不存在");
  const interviewPlan = await generateCandidateInterviewPlan(candidate, job);
  updateCandidate({
    ...candidate,
    interviewPlan,
  });
  return { interviewPlan, state: getState() };
});

async function parseResumePreview(file: z.infer<typeof resumeParseSchema>["files"][number]) {
  const extracted = await extractResumeTextSafely(file);
  const fallbackText = `文件名：${file.name}\n文件类型：${file.type || file.content_type || "未知"}\n文件大小：${Math.max(1, Math.round((file.size || 0) / 1024))}KB\n系统未成功提取正文，请核验原始附件。`;
  const rawResumeText = buildResumeDraftText(extracted.text, "") || fallbackText;
  const resumeText = shouldUseDeepSeekResumeCleanup(extracted.method, rawResumeText)
    ? await enrichResumeTextWithDeepSeek({
      fileName: file.name,
      fileType: file.type || file.content_type || "未知格式",
      resumeText: rawResumeText,
    })
    : rawResumeText;

  const ruleName = inferCandidateNameFromResumeText(resumeText)
    || inferCandidateNameFromFileNameStrict(file.name.replace(/\.[^.]+$/, ""));
  const ruleSource = inferResumeSource(`${file.name}\n${resumeText}`);
  const needsDeepSeekMeta = !ruleName || !ruleSource || resumeText === fallbackText;
  const deepSeekMeta = needsDeepSeekMeta
    ? await inferResumeMetaWithDeepSeek({
      fileName: file.name,
      fileType: file.type || file.content_type || "未知格式",
      resumeText,
    })
    : {};
  const reliableName = deepSeekMeta.candidateName || ruleName;
  const candidateName = normalizeCandidateName(reliableName || inferCandidateName(file.name.replace(/\.[^.]+$/, "")));
  const source = normalizeResumeSource(deepSeekMeta.source || ruleSource) || "本地上传";
  const warnings = [
    reliableName ? "" : "未能可靠识别候选人姓名，请手动核验。",
    source === "本地上传" ? "未能从文件识别来源渠道，已默认本地上传。" : "",
    resumeText === fallbackText ? "未能提取简历正文，请手动核验或补充。" : "",
  ].filter(Boolean);

  return {
    file: {
      ...file,
      candidateName,
      source,
      resumeText,
    },
    candidateName,
    source,
    resumeText,
    extractionMethod: extracted.method,
    warnings,
  };
}

async function buildCandidatesFromResumeInput(
  job: Job,
  input: z.infer<typeof resumeSchema>,
): Promise<Candidate[]> {
  const built: Candidate[] = [];
  for (const file of input.files) {
    const resumeText = buildResumeDraftText(file.resumeText, "");
    const sourceLabel = normalizeResumeSource(file.source) || "本地上传";
    const candidate = createCandidate({
      id: `c_${Date.now()}_${nanoid(6)}`,
      job,
      name: normalizeCandidateName(file.candidateName) || inferCandidateName(file.name.replace(/\.[^.]+$/, "")),
      source: `${sourceLabel} · ${file.name}`,
      resumeText,
      fileName: file.name,
      fileType: file.type || file.content_type || "未知格式",
      fileSize: file.size || 0,
      fileDataBase64: file.object_key ? null : file.dataBase64 || null,
      fileObjectKey: file.object_key || null,
      fileUrl: file.url || null,
    });
    built.push(await enrichCandidateAssessmentWithDeepSeek(candidate, job));
  }
  return built;
}

function buildResumeDraftText(primaryText: string, supplementalText: string) {
  return [primaryText, supplementalText]
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n\n--- 补充文本 ---\n")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function shouldUseDeepSeekResumeCleanup(
  method: "client-text" | "empty" | "pdf" | "docx" | "doc" | "image" | "text" | "unknown",
  resumeText: string,
) {
  if (!deepseekApiKey) return false;
  if (!resumeText.trim()) return false;
  if (method === "image" || method === "unknown" || method === "empty") return true;
  if (/\uFFFD|□|�/.test(resumeText)) return true;
  if (/([^\n])\1{10,}/.test(resumeText)) return true;
  if (resumeText.length > 2500 && /教育经历|工作经历|项目经历|技能|证书/.test(resumeText) === false) return true;
  return false;
}

async function extractResumeTextSafely(file: ResumeFileInput) {
  const fallbackText = buildResumeDraftText(file.text || "", "");
  try {
    const resolvedFile = await resolveResumeFileForExtraction(file);
    return await withTimeout(
      extractResumeTextFromFile(resolvedFile),
      resumeExtractTimeoutMs,
      `提取文件 ${file.name} 内容超时`,
    );
  } catch (error) {
    requestLog("resume_extract_fallback", {
      fileName: file.name,
      fileType: file.type || "未知格式",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      text: fallbackText,
      method: fallbackText ? "client-text" as const : "unknown" as const,
    };
  }
}

async function resolveResumeFileForExtraction(file: ResumeFileInput) {
  const contentType = file.type || file.content_type || null;
  if (file.dataBase64 || !file.object_key) {
    return {
      name: file.name,
      type: contentType,
      size: file.size,
      text: file.text,
      dataBase64: file.dataBase64,
    };
  }

  const buffer = await fileService.readFileBuffer(file.object_key);
  return {
    name: file.name,
    type: contentType,
    size: file.size,
    text: file.text,
    dataBase64: buffer.toString("base64"),
  };
}

function inferCandidateName(fileName: string) {
  const cleaned = fileName
    .replace(/简历|个人简历|个人|求职|resume|cv|附件/gi, "")
    .replace(/[（(].*?[）)]/g, " ")
    .trim();
  const parts = cleaned
    .split(/[\s_\-—–+·、，,（）()\[\]【】]+/)
    .map(normalizeCandidateName)
    .filter(Boolean);
  const nameLikeParts = parts.filter(isLikelyChineseName);
  return nameLikeParts.at(-1) || parts.at(-1) || cleaned || fileName || "未命名候选人";
}

function inferCandidateNameFromFileNameStrict(fileName: string) {
  const cleaned = fileName
    .replace(/简历|个人简历|个人|求职|resume|cv|附件/gi, "")
    .replace(/[（(].*?[）)]/g, " ")
    .trim();
  const parts = cleaned
    .split(/[\s_\-—–+·、，,（）()\[\]【】]+/)
    .map(normalizeCandidateName)
    .filter(Boolean);
  return parts.filter(isLikelyChineseName).at(-1) || "";
}

function inferCandidateNameFromResumeText(text: string) {
  const explicitMatch = text.match(/(?:^|\n)\s*(?:姓名|候选人|应聘者|名字|Name)\s*[:：]\s*([\u4e00-\u9fa5·]{2,6}|[A-Za-z][A-Za-z\s.]{1,40})/i);
  if (explicitMatch?.[1]) return normalizeCandidateName(explicitMatch[1]);
  const header = text.split(/\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8);
  const nameLine = header
    .map((line) => normalizeCandidateName(line.replace(/[|｜].*$/, "")))
    .find(isLikelyChineseName);
  return nameLine || "";
}

function normalizeResumeSource(value?: string | null) {
  const source = String(value || "").trim();
  if (!source) return "";
  if (/boss|BOSS|直聘/i.test(source)) return "BOSS";
  if (/智联|zhaopin/i.test(source)) return "智联";
  if (/猎聘|liepin/i.test(source)) return "猎聘";
  if (/前程无忧|51job/i.test(source)) return "前程无忧";
  if (/内推|推荐/.test(source)) return "内推";
  if (/本地|上传|其他/.test(source)) return "本地上传";
  return source.slice(0, 20);
}

function inferResumeSource(text: string) {
  return normalizeResumeSource(text.match(/BOSS直聘|BOSS|智联招聘|智联|猎聘|前程无忧|51job|内推|推荐|本地上传/i)?.[0] || "");
}

function normalizeCandidateName(value: string) {
  return value
    .replace(/[^\u4e00-\u9fa5A-Za-z·.\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyChineseName(value: string) {
  if (!/^[\u4e00-\u9fa5·]{2,6}$/.test(value)) return false;
  if (/前端|后端|开发|工程师|产品|运营|设计|测试|算法|数据|长沙|北京|上海|广州|深圳|杭州|成都|武汉|南京|简历|求职|候选人/.test(value)) return false;
  return true;
}

function formatDateStamp(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function generateJobCopilot(job: z.infer<typeof jobCopilotSchema>) {
  const prompt = buildJobCopilotPrompt(job);
  const fallback = buildFallbackJobCopilotResult(job);
  const schema = z.object({
    recommendedTitle: z.string().default(""),
    optimizedDescription: z.string().default(""),
    actionSuggestions: z.array(z.string()).default([]),
    sourcingTitles: z.array(z.string()).default([]),
    interviewQuestions: z.array(z.object({
      title: z.string(),
      text: z.string(),
      probe: z.string(),
      competency: z.string().optional(),
      starFocus: z.array(z.string()).optional(),
      evaluationSignals: z.array(z.string()).optional(),
    })).default([]),
  });

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位资深招聘业务顾问和企业HRBP，擅长将职位信息整理成清晰、可落地、适合中国招聘场景的输出。请严格输出 JSON，不要输出 markdown 代码块，不要输出多余解释。",
      userPrompt: prompt,
      temperature: 0.6,
      timeoutMs: Math.max(deepseekTimeoutMs, 45000),
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_job_copilot_error", { status: response.status, text, useCase: job.useCase, title: job.title });
      return fallback;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      requestLog("deepseek_job_copilot_empty", { useCase: job.useCase, title: job.title });
      return fallback;
    }

    const parsed = safeJsonParse(content);
    const result = schema.parse(parsed);
    return {
      recommendedTitle: result.recommendedTitle || fallback.recommendedTitle,
      optimizedDescription: result.optimizedDescription || fallback.optimizedDescription,
      actionSuggestions: result.actionSuggestions.length ? result.actionSuggestions : fallback.actionSuggestions,
      sourcingTitles: result.sourcingTitles.length ? result.sourcingTitles : fallback.sourcingTitles,
      interviewQuestions: result.interviewQuestions.length ? result.interviewQuestions : fallback.interviewQuestions,
    };
  } catch (error) {
    requestLog("deepseek_job_copilot_exception", {
      message: error instanceof Error ? error.message : String(error),
      useCase: job.useCase,
      title: job.title,
    });
    return fallback;
  }
}

async function enrichResumeTextWithDeepSeek(input: {
  fileName: string;
  fileType: string;
  resumeText: string;
}) {
  const normalized = input.resumeText.trim();
  if (!normalized) return "";
  if (!deepseekApiKey) return normalized;

  const prompt = [
    "请你扮演资深招聘助理，整理候选人简历原文。",
    "目标：基于已有提取文本，输出一份尽可能完整、结构清晰、适合招聘分析存档的中文简历原文。",
    "要求：",
    "1. 严格输出 JSON，对象字段仅包含 normalizedResumeText(string)。",
    "2. 保留原始简历中的关键信息，不要编造不存在的经历。",
    "3. 可以纠正 OCR 断行、错位和明显乱码，但不要凭空补经历。",
    "4. 如果内容是中英文混排，请按简历原意整理。",
    "5. 输出适合作为“简历原文”保存，应包含基本信息、工作经历、项目经历、教育经历、技能证书等已识别内容。",
    "",
    `文件名: ${input.fileName}`,
    `文件类型: ${input.fileType}`,
    "提取到的原始文本：",
    normalized,
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位严谨的招聘文档整理助手，只负责根据已有提取文本进行清洗、归整和结构化，不允许编造候选人经历。",
      userPrompt: prompt,
      temperature: 0.2,
      timeoutMs: deepseekResumeTimeoutMs,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_resume_enrich_error", { status: response.status, text });
      return normalized;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return normalized;
    const parsed = safeJsonParse(content);
    const schema = z.object({
      normalizedResumeText: z.string().default(""),
    });
    return schema.parse(parsed).normalizedResumeText.trim() || normalized;
  } catch (error) {
    requestLog("deepseek_resume_enrich_exception", { message: error instanceof Error ? error.message : String(error) });
    return normalized;
  }
}

async function inferResumeMetaWithDeepSeek(input: {
  fileName: string;
  fileType: string;
  resumeText: string;
}): Promise<{ candidateName?: string; source?: string }> {
  if (!deepseekApiKey) return {};
  const normalized = input.resumeText.trim();
  const prompt = [
    "请你从简历文件名和简历原文中识别候选人姓名与来源渠道。",
    "严格输出 JSON，对象字段仅包含 candidateName(string) 和 source(string)。",
    "规则：",
    "1. candidateName 只能来自文件名或正文明确出现的信息，不确定则空字符串。",
    "2. source 优先识别为 BOSS、智联、猎聘、前程无忧、内推、本地上传、其他；不确定则空字符串。",
    "3. 不要编造姓名，不要把岗位名称、城市、公司名当作姓名。",
    "",
    `文件名: ${input.fileName}`,
    `文件类型: ${input.fileType}`,
    "简历原文节选：",
    normalized.slice(0, 3000),
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是严谨的招聘资料结构化助手，只做字段抽取，不做推测。",
      userPrompt: prompt,
      temperature: 0,
      timeoutMs: deepseekResumeTimeoutMs,
    });
    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_resume_meta_error", { status: response.status, text });
      return {};
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return {};
    const parsed = safeJsonParse(content);
    const schema = z.object({
      candidateName: z.string().default(""),
      source: z.string().default(""),
    });
    const result = schema.parse(parsed);
    return {
      candidateName: normalizeCandidateName(result.candidateName),
      source: normalizeResumeSource(result.source),
    };
  } catch (error) {
    requestLog("deepseek_resume_meta_exception", { message: error instanceof Error ? error.message : String(error) });
    return {};
  }
}

async function enrichCandidateAssessmentWithDeepSeek(candidate: Candidate, job: Job) {
  const fallback = buildFallbackCandidateEvaluation(candidate, job);
  if (!deepseekApiKey) {
    return applyCandidateEvaluation(candidate, fallback);
  }
  const resumeExcerpt = buildResumeAssessmentExcerpt(candidate.resumeText);

  const prompt = [
    "你是一名严谨的招聘评估专家，负责根据岗位要求对候选人简历进行严格评估。",
    "请根据以下岗位信息与候选人简历，对候选人进行全面、客观、严谨的评估。",
    "请严格输出 JSON，不要输出 markdown，不要输出额外说明。",
    "JSON 字段必须包含：score(number), scoreDimensions([{key,label,weight,score,reason}]), summary(string), strengths(string[]), weaknesses(string[]), risks(string[]), interviewFocuses(string[]).",
    "要求：",
    "1. score 为 0-100 分的综合匹配度评分，必须严格依据下方【AI评分模型配置】进行加权计算。",
    "2. scoreDimensions 必须逐项返回 experience/professional/stability/education/business 五个维度，每项 score 为该维度0-100分，weight 为配置权重，reason 用一句话说明简历依据。",
    "3. strengths 输出 3-5 点核心优势。",
    "4. weaknesses 输出 2-3 点主要劣势/差距。",
    "5. risks 输出 2-3 点风险点提示。",
    "6. interviewFocuses 输出 3-5 个关键面试考核点。",
    "7. 评估需严格依据岗位要求与简历原文，不允许编造未出现的经历。",
    "",
    "【岗位信息】",
    `职位名称：${job.title}`,
    `岗位关键词：${job.keywords}`,
    `岗位级别：${job.level}`,
    `经验要求：${job.experience}`,
    `工作地点：${job.location}`,
    `职位描述：${job.description}`,
    "",
    "【AI评分模型配置】",
    ...scoreWeightLabels.map(([key, label]) => `${label}(${key})：${job.scoreWeights[key]}%`),
    "评分要求：请先判断五个维度各自的0-100分，再按“维度分 × 权重”加权得出最终score；最终score必须接近五个维度加权求和结果。",
    "如果简历未提供某维度明确证据，该维度必须保守评分，不可用其他维度强行补足；例如学历未体现时，学历背景应低分或保守分。",
    "",
    "【候选人简历】",
    resumeExcerpt,
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位严谨、克制、客观的招聘评估专家，只能依据岗位信息与候选人简历原文做评估，不允许编造经历或夸大结论。",
      userPrompt: prompt,
      temperature: 0.2,
      timeoutMs: deepseekResumeTimeoutMs,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_candidate_assessment_error", { status: response.status, text });
      return applyCandidateEvaluation(candidate, fallback);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return applyCandidateEvaluation(candidate, fallback);
    const parsed = safeJsonParse(content);
    const schema = z.object({
      score: z.number().min(0).max(100),
      scoreDimensions: z.array(z.object({
        key: z.enum(["experience", "professional", "stability", "education", "business"]),
        label: z.string().default(""),
        weight: z.number().min(0).max(100),
        score: z.number().min(0).max(100),
        reason: z.string().default(""),
      })).default([]),
      summary: z.string().default(""),
      strengths: z.array(z.string()).default([]),
      weaknesses: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      interviewFocuses: z.array(z.string()).default([]),
    });
    const result = schema.parse(parsed);
    const evaluation: CandidateEvaluation = {
      summary: result.summary.trim() || fallback.summary,
      strengths: result.strengths.map((item) => item.trim()).filter(Boolean).slice(0, 5),
      weaknesses: result.weaknesses.map((item) => item.trim()).filter(Boolean).slice(0, 3),
      risks: result.risks.map((item) => item.trim()).filter(Boolean).slice(0, 3),
      interviewFocuses: result.interviewFocuses.map((item) => item.trim()).filter(Boolean).slice(0, 5),
      scoreDimensions: normalizeScoreDimensions(result.scoreDimensions, job),
    };
    return applyCandidateEvaluation(candidate, {
      ...fallback,
      score: clampScoreValue(result.score),
      ...evaluation,
    });
  } catch (error) {
    requestLog("deepseek_candidate_assessment_exception", { message: error instanceof Error ? error.message : String(error) });
    return applyCandidateEvaluation(candidate, fallback);
  }
}

async function generateCandidateInterviewPlan(candidate: Candidate, job: Job): Promise<CandidateInterviewPlan> {
  const fallback = buildFallbackInterviewPlan(candidate, job);
  if (!deepseekApiKey) return fallback;

  const matched = candidate.keyPointAnalysis.filter((item) => item.matched).map((item) => item.keyword);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched).map((item) => item.keyword);
  const summary = candidate.evaluation?.summary || candidate.reason;
  const resumeExcerpt = buildResumeAssessmentExcerpt(candidate.resumeText);
  const prompt = [
    "【角色设定】",
    "你是一位拥有15年以上高端岗位招聘经验的资深面试官，长期负责集团/头部企业的高管及核心岗位面试工作。",
    "你擅长通过非直接、侧面的提问方式，在不暴露真实考察意图的前提下，深挖候选人的真实能力边界与潜在风险点。",
    "你的面试风格温和但极具穿透力，善于通过细节追问区分“主导”与“参与”、“真正落地”与“听说而已”。",
    "",
    "【岗位信息】",
    `- 职位名称：${job.title}`,
    `- 岗位关键描述词：${job.keywords}`,
    `- 岗位JD：${job.description}`,
    "",
    "【候选人信息】",
    `- 姓名：${candidate.name}`,
    `- 简历摘要：${summary}`,
    `- 简历原文摘录：${resumeExcerpt}`,
    `- 匹配度评分：${candidate.score}`,
    `- 已命中关键点：${matched.length ? matched.join("、") : "暂无明确命中"}`,
    `- 未命中关键点：${missed.length ? missed.join("、") : "暂无明显缺口"}`,
    "",
    "请根据给到的岗位名称、岗位JD与岗位关键描述词，以及人选的简历进行针对性的综合分析。",
    "本次面试重点考察方向，请从JD与简历的差异点中提取3-5个方向。",
    "",
    "一、面试方法推荐",
    "根据页面展示的五个面试方法：结构化面试、行为面试、STAR深挖、情景模拟、案例分析。",
    "推荐逻辑：",
    "1. 如果匹配度 ≥ 75分，且未命中关键点 ≤ 2个 → 推荐【结构化面试】横向对比",
    "2. 如果匹配度 60-74分，且未命中关键点 3-5个 → 推荐【行为面试】验证核心能力",
    "3. 如果简历中有关键经历但描述模糊 → 追加【STAR深挖】追问",
    "4. 如果岗位需要临场应变能力 → 追加【情景模拟】",
    "5. 如果岗位级别较高或需要战略思维 → 追加【案例分析】",
    "请输出推荐组合，并给出理由。",
    "",
    "二、针对性面试问题设计",
    "请针对每一个考察方向，分别设计 3-5 个面试问题。",
    "所有问题必须满足以下要求：",
    "1. 禁止直接提问，不要使用“请介绍一下你在XX方面的经验”“请问你对XX了解多少”“请结合你的经历谈谈XX”“你认为做好XX需要具备哪些能力”等无效问法。",
    "2. 每个问题都要从候选人简历中的具体信息、行业普遍痛点、职业转型经历等角度侧面切入，让候选人在业务描述中自然暴露真实深度。",
    "3. 追问链路设计必须多样化，禁止在所有问题中重复使用同一追问句式。",
    "4. 每个问题至少搭配 2 个追问，且追问角度必须从下列角度库中轮换组合，不允许所有问题都使用同一组追问逻辑。",
    "【追问角度库】",
    "数据来源型：这个数据是怎么统计出来的？当时有系统记录还是手工台账？",
    "决策逻辑型：当时有几个备选方案？为什么选了这一个，放弃了其他？",
    "角色确认型：这个决策是您做的还是向上汇报后由上级定的？",
    "阻力应对型：推的过程中谁反对最激烈？您是怎么跟他谈的？",
    "时间线型：从启动到落地花了多久？哪个阶段花的时间最长？为什么？",
    "失败反思型：如果让您重做一遍，哪个环节您会调整？",
    "验证追问型：您刚才提到了XX，能具体展开说一下当时是怎么操作的？",
    "外部视角型：当时跟您配合的部门/外部机构是哪家？他们当时提出了什么不同意见？",
    "标准判断型：您当时判断“做成了”的标准是什么？谁定的这个标准？",
    "政策/环境关联型：这件事放在当年那个政策环境下，跟现在比有什么不同？如果现在做，您的思路会变吗？",
    "前置信号型：回头复盘时，其实最早出现什么信号时您就已经有预感了？",
    "资源约束型：如果当时没有XX资源（人/钱/时间），您会怎么绕过去？",
    "情绪/冲突记录型：您提到当时压力很大，具体是哪件事让您觉得最难扛？后来怎么过去的？",
    "5. 追问组合必须轮换搭配，例如：",
    "问题1可用“数据来源型 + 角色确认型 + 阻力应对型”",
    "问题2可用“时间线型 + 决策逻辑型 + 失败反思型”",
    "问题3可用“外部视角型 + 前置信号型 + 资源约束型”",
    "请确保不同问题的追问角度明显不同，避免模板化重复。",
    "6. 问题设计必须能够区分主导者、参与者、听闻者三类角色差异。",
    "7. 每个问题必须结合该候选人简历中的特定信息作为切入点，而不是通用问题。",
    "8. 针对每个考察方向，至少设计 1 个情景施压题，用于考察面对两难矛盾或危机时的判断力与行动力。",
    "每个问题必须包含：directionTitle, title, cutInPoint, question, competency, questionType(行为型/情景型/认知型), designIntent, followUps(string[]), strongSignals(string[]), warningSignals(string[]), judgmentSuggestion, isStressScenario(boolean), scenario, evaluationFocus(string[])。",
    "",
    "三、面试评估指引",
    "请输出 evaluationGuide，包含：baseline(string[])、positiveSignals(string[])、vetoItems(string[])。",
    "",
    "四、风险提示",
    "请对以下三个维度进行风险评估（高/中/低）：经历真实性风险、能力夸大风险、稳定性风险。",
    "如任一维度为高或中，请额外给出 1-2 条 validationTips。",
    "",
    "【输出原则】",
    "- 严格基于岗位JD和简历实际内容，不凭空假设",
    "- 问题必须针对需要验证的点，而非重复简历已有信息",
    "- 判断标准必须具体、可操作，避免模糊评价",
    "- 风险提示必须有据可依，不危言耸听",
    "- 问题必须口语化、自然，像聊天而不是考试",
    "- 不同问题的问法、切入口、追问角度必须明显变化，避免出现一眼可见的模板化重复",
    "",
    "请严格输出 JSON，不要输出 markdown，不要输出额外解释。",
    "JSON 顶层字段必须为：focusDirections, recommendedMethods, summaryReason, questions, evaluationGuide, riskReview。",
    "focusDirections 每项必须包含：title, gapReason。",
    "recommendedMethods 每项必须包含：methodKey, label, reason。",
    "methodKey 只能是：structured, behavioral, star, scenario, case。",
    "riskReview 每项必须包含：dimension, level, reason, validationTips。",
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位严谨、克制、实用导向的招聘面试设计专家。你只能基于给定岗位与候选人信息输出可执行面试方案，不允许编造经历或夸大结论。",
      userPrompt: prompt,
      temperature: 0.3,
      timeoutMs: deepseekResumeTimeoutMs,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_interview_plan_error", { status: response.status, text });
      return fallback;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsed = safeJsonParse(content);
    const schema = z.object({
      focusDirections: z.array(z.object({
        title: z.string().min(1),
        gapReason: z.string().min(1),
      })).min(3).max(5),
      recommendedMethods: z.array(z.object({
        methodKey: z.enum(["structured", "behavioral", "star", "scenario", "case"]),
        label: z.string().min(1),
        reason: z.string().min(1),
      })).min(1).max(3),
      summaryReason: z.string().default(""),
      questions: z.array(z.object({
        directionTitle: z.string().min(1).default(""),
        title: z.string().min(1),
        cutInPoint: z.string().min(1).default(""),
        question: z.string().min(1),
        competency: z.string().min(1),
        questionType: z.enum(["行为型", "情景型", "认知型"]),
        designIntent: z.string().min(1),
        strongSignals: z.array(z.string()).default([]),
        warningSignals: z.array(z.string()).default([]),
        followUps: z.array(z.string()).default([]),
        judgmentSuggestion: z.string().default(""),
        isStressScenario: z.boolean().optional().default(false),
        scenario: z.string().default(""),
        evaluationFocus: z.array(z.string()).default([]),
        methodKey: z.enum(["structured", "behavioral", "star", "scenario", "case"]).optional(),
      })).min(6).max(24),
      evaluationGuide: z.object({
        baseline: z.array(z.string()).default([]),
        positiveSignals: z.array(z.string()).default([]),
        vetoItems: z.array(z.string()).default([]),
      }),
      riskReview: z.array(z.object({
        dimension: z.enum(["经历真实性风险", "能力夸大风险", "稳定性风险"]),
        level: z.enum(["高", "中", "低"]),
        reason: z.string().min(1),
        validationTips: z.array(z.string()).default([]),
      })).length(3),
    });
    const result = schema.parse(parsed);
    return {
      focusDirections: result.focusDirections.map((item) => ({
        title: item.title.trim(),
        gapReason: item.gapReason.trim(),
      })),
      recommendedMethods: result.recommendedMethods.map((item) => ({
        methodKey: item.methodKey,
        label: item.label.trim(),
        reason: item.reason.trim(),
      })),
      summaryReason: result.summaryReason.trim(),
      questions: result.questions.map((item) => ({
        title: item.title.trim(),
        question: item.question.trim(),
        competency: item.competency.trim(),
        questionType: item.questionType,
        directionTitle: item.directionTitle.trim(),
        cutInPoint: item.cutInPoint.trim(),
        designIntent: item.designIntent.trim(),
        strongSignals: item.strongSignals.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        warningSignals: item.warningSignals.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        followUps: item.followUps.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        judgmentSuggestion: item.judgmentSuggestion.trim(),
        isStressScenario: item.isStressScenario,
        scenario: item.scenario.trim(),
        evaluationFocus: item.evaluationFocus.map((text) => text.trim()).filter(Boolean).slice(0, 4),
        methodKey: item.methodKey,
      })),
      evaluationGuide: {
        baseline: result.evaluationGuide.baseline.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        positiveSignals: result.evaluationGuide.positiveSignals.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        vetoItems: result.evaluationGuide.vetoItems.map((text) => text.trim()).filter(Boolean).slice(0, 3),
      },
      riskReview: result.riskReview.map((item) => ({
        dimension: item.dimension,
        level: item.level,
        reason: item.reason.trim(),
        validationTips: item.validationTips.map((text) => text.trim()).filter(Boolean).slice(0, 2),
      })),
    };
  } catch (error) {
    requestLog("deepseek_interview_plan_exception", { message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

async function generateTalentRevivalScript(candidate: Candidate, job: Job) {
  const fallback = buildFallbackTalentRevivalScript(candidate, job);
  if (!deepseekApiKey) return fallback;

  const matchedKeywords = candidate.keyPointAnalysis
    .filter((item) => item.matched)
    .map((item) => item.keyword)
    .slice(0, 5);
  const resumeExcerpt = buildResumeAssessmentExcerpt(candidate.resumeText).slice(0, 1800);
  const prompt = [
    "你是一名资深猎头顾问和高端人才寻访专家，擅长唤醒沉淀超过3个月的人才库候选人。",
    "",
    "【核心原则】",
    "1. 不要直接问候选人“是否在看机会”“是否考虑机会”，这太直白、像群发。",
    "2. 要告诉候选人：我为什么非要找你，而不是找别人，制造专业、克制、不可替代感。",
    "3. 话术要像真实猎头/资深HR的一对一私信：短、准、有判断、有尊重。",
    "4. 不能夸大岗位，不承诺薪资/级别/录用结果，不制造焦虑。",
    "5. 适合微信/短信直接发送，控制在120-180字。",
    "",
    "【岗位信息】",
    `职位名称：${job.title}`,
    `部门：${job.dept}`,
    `地点：${job.location}`,
    `薪资范围：${job.salaryRange}`,
    `关键考核点：${job.keywords}`,
    `职位描述：${job.description}`,
    "",
    "【候选人信息】",
    `姓名：${candidate.name}`,
    `AI摘要：${candidate.evaluation?.summary || candidate.reason}`,
    `匹配分：${candidate.score}`,
    `已命中关键词：${matchedKeywords.length ? matchedKeywords.join("、") : "暂无明确命中"}`,
    `简历摘录：${resumeExcerpt}`,
    "",
    "【任务】",
    "请生成一段“高价值猎头感”的回访唤醒话术。",
    "必须体现：",
    "- 你注意到候选人过往经历里的一个具体亮点；",
    "- 当前岗位为什么与他的某项经历高度相关；",
    "- 邀请方式要轻，不强推，只说想简短同步一个判断；",
    "- 不出现“你是否在看机会/考虑机会/换工作”等直白措辞。",
    "",
    "请严格输出 JSON，不要输出 markdown，不要输出额外说明。",
    "JSON 格式：{\"script\":\"...\"}",
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一名克制、专业、有猎头质感的人才沟通文案专家。你只输出可直接复制给候选人的私信话术 JSON。",
      userPrompt: prompt,
      temperature: 0.55,
      timeoutMs: deepseekTimeoutMs,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_talent_revival_error", { status: response.status, text, candidateId: candidate.id, jobId: job.id });
      return fallback;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsed = safeJsonParse(content);
    const result = z.object({ script: z.string().min(20).max(400) }).parse(parsed);
    return result.script.trim();
  } catch (error) {
    requestLog("deepseek_talent_revival_exception", {
      message: error instanceof Error ? error.message : String(error),
      candidateId: candidate.id,
      jobId: job.id,
    });
    return fallback;
  }
}

function buildFallbackTalentRevivalScript(candidate: Candidate, job: Job) {
  const matchedKeywords = candidate.keyPointAnalysis
    .filter((item) => item.matched)
    .map((item) => item.keyword)
    .slice(0, 2);
  const highlight = matchedKeywords.length ? matchedKeywords.join("、") : job.keywords.split(/[、,，;；\s]+/).filter(Boolean).slice(0, 2).join("、") || "过往经历";
  return `${candidate.name}您好，我这边最近在看一个${job.location}的${job.title}方向，第一时间想到您，是因为您过往经历里关于${highlight}的沉淀，和这个岗位真正要解决的问题很贴近。我不想用群发式岗位介绍打扰您，只是想把这个判断简短同步给您，您方便时我发您2分钟看一下背景即可。`;
}

function buildFallbackInterviewPlan(candidate: Candidate, job: Job): CandidateInterviewPlan {
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched).map((item) => item.keyword);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched).map((item) => item.keyword);
  const methodKeys = inferInterviewMethodCombo(candidate, job, missed.length);
  const focusAreas = (missed.length ? missed : candidate.evaluation?.interviewFocuses?.length ? candidate.evaluation.interviewFocuses : matched).slice(0, 4);
  const recommendedMethods = methodKeys.map((methodKey) => ({
    methodKey,
    label: interviewMethodLabelMap[methodKey],
    reason: buildInterviewMethodReason(methodKey, candidate, job, missed, matched),
  }));
  const focusDirections = focusAreas.slice(0, 4).map((focus) => ({
    title: focus,
    gapReason: `当前简历中关于“${focus}”的直接证据不够完整，需要通过侧面追问确认真实深度、个人贡献与结果边界。`,
  }));
  const fallbackAngles = [
    {
      title: "前置信号型 + 角色确认型 + 阻力应对型",
      questionBuilder: (focus: string) => `我看到你在“${focus}”这段经历里最后拿到了结果。回头看，其实最早出现什么信号时，你心里已经觉得这件事不能再按老办法做了？`,
      cutInBuilder: (focus: string) => `从简历中与“${focus}”相关的成果描述切入，先看候选人是否能回到问题刚露头的时刻，而不是直接背结果。`,
      followUps: ["这个判断最早是你提出来的，还是先有人提醒了你？", "当时谁最不认同你的判断？你是怎么把这件事往前推的？", "如果当时你判断错了，最大的代价会落在哪一块？"],
      evaluationFocus: ["前置信号识别", "真实角色确认", "阻力处理"],
    },
    {
      title: "时间线型 + 决策逻辑型 + 失败反思型",
      questionBuilder: (focus: string) => `如果把“${focus}”那件事按时间线摊开看，从真正启动到最后落地，中间哪一段最难啃？你当时为什么会那样安排顺序？`,
      cutInBuilder: (focus: string) => `从项目推进节奏切入，验证候选人是否真正理解先后顺序、取舍逻辑和关键瓶颈。`,
      followUps: ["你当时其实有几个备选推进方案？最后为什么选了这一条？", "哪个阶段花的时间最长，背后卡点是什么？", "如果重做一次，你会把哪一步前置或后移？为什么？"],
      evaluationFocus: ["时间线复盘", "决策逻辑", "失败反思"],
    },
    {
      title: "外部视角型 + 数据来源型 + 标准判断型",
      questionBuilder: (focus: string) => `你简历里提到“${focus}”这块成果挺亮眼。我更好奇的是，当时跟你配合最紧的部门或外部机构，最开始是不是也认可你这套做法？`,
      cutInBuilder: (focus: string) => `从外部协同方的反馈切入，验证成果不是自说自话，而是能被协作方与数据共同支撑。`,
      followUps: ["他们当时提过什么不同意见？你后来怎么处理的？", "你刚提到的那个数据，当时是系统口径还是人工整理出来的？", "你们最后判断这件事算做成了，标准是谁定的？"],
      evaluationFocus: ["外部协同", "数据来源", "成功标准"],
    },
    {
      title: "资源约束型 + 政策环境关联型 + 验证追问型",
      questionBuilder: (focus: string) => `如果把你做“${focus}”那段经历放回当时的环境里看，假设少掉一个关键资源，这件事你最先会改哪一步，而不是硬扛着往前推？`,
      cutInBuilder: (focus: string) => `从资源不足和环境约束切入，观察候选人是否具备真实的一线调整能力。`,
      followUps: ["如果当时没有足够的人/时间/预算，你会怎么绕过去？", "这件事放在当年的环境下和现在比，处理方式会有什么不同？", "你刚刚提到那一步动作，能不能具体展开说说当时是怎么做的？"],
      evaluationFocus: ["资源受限应对", "环境适应", "动作细节还原"],
    },
  ];
  const questions = focusDirections.flatMap((direction, index) => {
    const primaryAngle = fallbackAngles[index % fallbackAngles.length];
    const secondaryAngle = fallbackAngles[(index + 1) % fallbackAngles.length];
    const stressAngle = fallbackAngles[(index + 2) % fallbackAngles.length];
    return [
      {
        title: `${direction.title}侧面深挖`,
        question: primaryAngle.questionBuilder(direction.title),
        competency: direction.title,
        questionType: "行为型" as const,
        directionTitle: direction.title,
        cutInPoint: primaryAngle.cutInBuilder(direction.title),
        designIntent: `通过“${primaryAngle.title}”这一组追问逻辑，观察候选人是否能脱离模板答案，真正回到当时的业务现场。`,
        strongSignals: ["能回到当时具体场景，不急着背结果", "能讲清个人判断、动作和取舍", "追问后信息前后一致且可验证"],
        warningSignals: ["回答仍停留在大词和方法论", "追问后开始模糊角色边界", "核心数据、节点、协同对象说不清"],
        followUps: primaryAngle.followUps,
        judgmentSuggestion: "如果候选人能自然顺着不同追问角度往下展开，且不需要反复提醒就能回到细节，通常说明真实参与深度更高。",
        evaluationFocus: primaryAngle.evaluationFocus,
        methodKey: methodKeys[0],
      },
      {
        title: `${direction.title}非模板验证`,
        question: secondaryAngle.questionBuilder(direction.title),
        competency: direction.title,
        questionType: "认知型" as const,
        directionTitle: direction.title,
        cutInPoint: secondaryAngle.cutInBuilder(direction.title),
        designIntent: `换一组“${secondaryAngle.title}”追问角度，避免同一候选人在同类问题上形成答题惯性。`,
        strongSignals: ["换角度后仍能快速对齐事实和时间线", "能解释为什么那样决策", "复盘时能说明调整空间"],
        warningSignals: ["换个角度就答散了", "只能重复前一个问题里的表述", "无法解释为什么不是另一种做法"],
        followUps: secondaryAngle.followUps,
        judgmentSuggestion: "若候选人面对不同追问组合仍能保持一致且具体，说明其对经历掌控度较高；若切角度后明显失真，建议继续核验。",
        evaluationFocus: secondaryAngle.evaluationFocus,
        methodKey: methodKeys.includes("star") ? "star" : methodKeys[0],
      },
      {
        title: `${direction.title}情景施压题`,
        question: `如果你刚接手“${direction.title}”相关工作，就发现短期目标、专业判断和资源现实三件事彼此冲突，你通常先动哪一层，而不是三件事一起抓？`,
        competency: direction.title,
        questionType: "情景型" as const,
        directionTitle: direction.title,
        cutInPoint: `围绕“${direction.title}”设计两难情境，并借用“${stressAngle.title}”的追问角度观察候选人的真实判断顺序。`,
        designIntent: "考察候选人在现实约束下是否仍能做出优先级判断，而不是给出四平八稳的标准答案。",
        strongSignals: ["先拆冲突，再排优先级", "既考虑风险也考虑推进节奏", "能给出向上沟通和落地动作的顺序"],
        warningSignals: ["只讲原则，不讲动作", "一味强调个人立场，没有业务平衡", "听上去正确但没有真实落地路径"],
        followUps: stressAngle.followUps,
        judgmentSuggestion: "若候选人能在施压场景中保持结构化表达，并给出兼顾业务与专业的动作顺序，是明显加分信号。",
        isStressScenario: true,
        scenario: `围绕“${direction.title}”的两难场景：短期结果压力、资源不足与专业判断冲突同时出现。`,
        evaluationFocus: ["优先级判断", "压力下决策", "资源协调", "风险意识"],
        methodKey: methodKeys.includes("scenario") ? "scenario" : methodKeys[0],
      },
    ];
  });

  return {
    focusDirections,
    recommendedMethods,
    summaryReason: recommendedMethods.map((item) => `${item.label}：${item.reason}`).join("；"),
    questions,
    evaluationGuide: {
      baseline: [
        "能围绕核心缺口给出真实、完整且可验证的过往案例。",
        "关键问题回答中能说清个人动作、决策逻辑和结果证据。",
        "对岗位核心要求不存在明显认知偏差或动机错位。",
      ],
      positiveSignals: [
        "能主动补足简历未展开的信息，并给出量化成果。",
        "面对追问时逻辑稳定，前后信息一致。",
        "能将过往经验迁移到当前岗位的关键业务场景。",
      ],
      vetoItems: [
        "多轮追问后仍无法说明本人实际贡献。",
        "关键经历前后矛盾，或结果无法提供基本验证逻辑。",
        "对岗位核心职责明显排斥，或稳定性风险表达过高。",
      ],
    },
    riskReview: [
      {
        dimension: "经历真实性风险",
        level: candidate.score >= 75 ? "低" : "中",
        reason: matched.length >= 2 ? "简历存在一定匹配证据，但部分关键经历仍需通过面试复核细节与结果。": "简历对核心经历描述偏概括，需要重点核验案例真实性。",
        validationTips: ["要求候选人按时间线复盘完整案例。", "追问关键结果由谁确认、用什么指标衡量。"] ,
      },
      {
        dimension: "能力夸大风险",
        level: missed.length >= 3 ? "中" : "低",
        reason: missed.length >= 3 ? `当前仍有 ${missed.slice(0, 3).join("、")} 等关键要求未在简历中体现，需防止经验被过度包装。` : "已有一定关键词命中，但仍需确认方法是否真实可复用。",
        validationTips: ["对关键能力要求候选人给出本人动作与结果闭环。"] ,
      },
      {
        dimension: "稳定性风险",
        level: /跳槽|空窗|短期|频繁/.test(candidate.resumeText) ? "中" : "低",
        reason: /跳槽|空窗|短期|频繁/.test(candidate.resumeText) ? "简历文本中存在可能需要补充说明的履历连续性信息，建议核验求职动机与稳定性。": "当前未发现明显稳定性预警，但仍需面试中确认动机与城市/岗位接受度。",
        validationTips: ["追问近两次变动原因及决策逻辑。", "确认岗位地点、职责范围与长期发展预期是否一致。"] ,
      },
    ],
  };
}

const interviewMethodLabelMap: Record<InterviewMethodKey, string> = {
  structured: "结构化面试",
  behavioral: "行为面试",
  star: "STAR深挖",
  scenario: "情景模拟",
  case: "案例分析",
};

function inferInterviewMethodCombo(candidate: Candidate, job: Job, missedCount: number): InterviewMethodKey[] {
  const methods: InterviewMethodKey[] = [];
  if (candidate.score >= 75 && missedCount <= 2) {
    methods.push("structured");
  } else if (candidate.score >= 60 && candidate.score <= 74 && missedCount >= 3 && missedCount <= 5) {
    methods.push("behavioral");
  } else {
    methods.push(candidate.score < 60 ? "scenario" : "behavioral");
  }

  if (hasAmbiguousResumeEvidence(candidate)) methods.push("star");
  if (needsScenarioAssessment(job)) methods.push("scenario");
  if (needsCaseAssessment(job)) methods.push("case");
  return Array.from(new Set(methods)).slice(0, 3);
}

function buildInterviewMethodReason(
  methodKey: InterviewMethodKey,
  candidate: Candidate,
  job: Job,
  missed: string[],
  matched: string[],
) {
  switch (methodKey) {
    case "structured":
      return `当前匹配度 ${candidate.score} 分，关键缺口较少，适合用统一问题与标准横向对比，重点确认 ${missed[0] || matched[0] || "岗位核心要求"} 的真实深度。`;
    case "behavioral":
      return `当前仍有 ${missed.length || 1} 项核心点待核验，适合通过过往行为验证关键能力是否真实存在并可迁移。`;
    case "star":
      return "简历中已有相关经历线索，但表述仍偏概括，建议通过 STAR 方式深挖候选人在关键项目中的个人动作与结果。";
    case "scenario":
      return `岗位涉及现场判断、跨团队推进或复杂情境处理，建议通过模拟场景观察上手能力与优先级判断。`;
    case "case":
      return `${job.level} 级岗位更需要结构化思考与策略判断，建议通过案例分析验证候选人的分析框架与方案质量。`;
  }
}

function hasAmbiguousResumeEvidence(candidate: Candidate) {
  return candidate.score >= 70 || candidate.keyPointAnalysis.some((item) => item.matched && /建议面试中继续追问/.test(item.evidence));
}

function needsScenarioAssessment(job: Job) {
  return /推进|沟通|协同|应变|现场|冲突|业务/.test(`${job.title} ${job.keywords} ${job.description}`);
}

function needsCaseAssessment(job: Job) {
  return /经理|总监|负责人|策略|体系|规划|诊断|组织/.test(`${job.level} ${job.title} ${job.keywords} ${job.description}`);
}

function buildResumeAssessmentExcerpt(resumeText: string) {
  const normalized = resumeText.trim();
  if (normalized.length <= 5200) return normalized;
  const head = normalized.slice(0, 3600);
  const tail = normalized.slice(-1200);
  return `${head}\n\n[中间内容省略]\n\n${tail}\n\n[注：简历原文较长，以上截取了前段与结尾重点信息用于评估。]`;
}

function applyCandidateEvaluation(candidate: Candidate, evaluation: CandidateEvaluation & { score: number }) {
  const keyPointAnalysis = evaluation.interviewFocuses.length
    ? mergeInterviewFocusesIntoKeyPoints(candidate.keyPointAnalysis, evaluation.interviewFocuses)
    : candidate.keyPointAnalysis;
  return {
    ...candidate,
    score: clampScoreValue(evaluation.score),
    conclusion: mapConclusionFromScore(evaluation.score),
    reason: evaluation.summary || candidate.reason,
    evaluation: {
      summary: evaluation.summary,
      strengths: evaluation.strengths,
      weaknesses: evaluation.weaknesses,
      risks: evaluation.risks,
      interviewFocuses: evaluation.interviewFocuses,
      scoreDimensions: evaluation.scoreDimensions,
    },
    keyPointAnalysis,
  } satisfies Candidate;
}

function buildFallbackCandidateEvaluation(candidate: Candidate, job: Job) {
  const keywords = normalizeKeywords(job.keywords);
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched).map((item) => item.keyword);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched).map((item) => item.keyword);
  const dimensionScores = buildFallbackScoreDimensions(candidate, job, matched, keywords);
  const score = clampScoreValue(scoreWeightLabels.reduce(
    (sum, [key]) => sum + dimensionScores[key] * (job.scoreWeights[key] / 100),
    0,
  ));
  return {
    score,
    summary: `${candidate.reason} 当前按岗位评分模型加权后为 ${score} 分。`,
    strengths: matched.length
      ? matched.slice(0, 4).map((keyword) => `简历中已覆盖“${keyword}”相关经历，可在面试中进一步核验深度与规模。`)
      : ["简历已有一定基础信息，但岗位核心证据仍需通过面试补充判断。"],
    weaknesses: missed.length
      ? missed.slice(0, 3).map((keyword) => `“${keyword}”缺少直接证据，当前与岗位要求仍存在验证缺口。`)
      : ["主要差距暂不明显，但仍需结合案例追问确认真实贡献。"],
    risks: [
      candidate.score < 70 ? "综合匹配度未进入高推荐区间，推进前建议增加业务复核。" : "需警惕关键词命中不等于真实胜任，仍需核验案例真实性。",
      missed.length ? `当前风险集中在 ${missed.slice(0, 2).join("、")} 等关键要求的直接证据不足。` : "若项目结果缺少量化指标，可能存在经验包装风险。",
    ].slice(0, 3),
    interviewFocuses: (matched.concat(missed).length ? matched.concat(missed) : keywords).slice(0, 5),
    scoreDimensions: buildScoreDimensionsFromScores(dimensionScores, job),
  };
}

function normalizeScoreDimensions(
  dimensions: Array<{ key: keyof Job["scoreWeights"]; label: string; weight: number; score: number; reason: string }>,
  job: Job,
) {
  const scoreMap = new Map(dimensions.map((item) => [item.key, item]));
  return scoreWeightLabels.map(([key, label]) => {
    const item = scoreMap.get(key);
    return {
      key,
      label,
      weight: job.scoreWeights[key],
      score: clampScoreValue(item?.score ?? 0),
      reason: item?.reason?.trim() || "简历未提供足够直接证据，按岗位评分模型保守计分。",
    };
  });
}

function buildScoreDimensionsFromScores(scores: Record<keyof Job["scoreWeights"], number>, job: Job) {
  return scoreWeightLabels.map(([key, label]) => ({
    key,
    label,
    weight: job.scoreWeights[key],
    score: clampScoreValue(scores[key]),
    reason: buildFallbackScoreReason(key, scores[key]),
  }));
}

function buildFallbackScoreReason(key: keyof Job["scoreWeights"], score: number) {
  const level = score >= 80 ? "证据较充分" : score >= 65 ? "证据中等" : "证据偏弱";
  const reasonMap: Record<keyof Job["scoreWeights"], string> = {
    experience: `经验匹配${level}，主要依据简历年限、经历复杂度与岗位经验要求的匹配情况。`,
    professional: `专业契合度${level}，主要依据岗位关键词、专业技能和项目内容的覆盖情况。`,
    stability: `稳定性${level}，主要依据履历连续性、跳槽/空窗等风险线索。`,
    education: `学历背景${level}，主要依据简历中学历、专业、证书等硬性背景信息。`,
    business: `业务导向${level}，主要依据业务结果、指标意识、经营视角和跨团队推动线索。`,
  };
  return reasonMap[key];
}

function buildFallbackScoreDimensions(
  candidate: Candidate,
  job: Job,
  matched: string[],
  keywords: string[],
): Record<keyof Job["scoreWeights"], number> {
  const resumeText = candidate.resumeText;
  const keywordRatio = keywords.length ? matched.length / keywords.length : 0.5;
  const resumeYears = inferResumeYears(resumeText);
  const requiredYears = inferRequiredYears(job.experience);
  const experienceScore = resumeYears === null || requiredYears === null
    ? candidate.score
    : resumeYears >= requiredYears
      ? Math.min(95, 72 + Math.min(18, (resumeYears - requiredYears) * 3))
      : Math.max(45, 70 - (requiredYears - resumeYears) * 8);
  const professionalScore = clampScoreValue(52 + keywordRatio * 42 + (/主导|搭建|架构|体系|优化|落地|项目|数据|绩效|招聘|组件|工程化/.test(resumeText) ? 6 : 0));
  const stabilityScore = /频繁|短期|空窗|离职|跳槽/.test(resumeText)
    ? 62
    : /年以上|长期|稳定|任职/.test(resumeText)
      ? 84
      : 74;
  const educationScore = /博士|硕士/.test(resumeText)
    ? 90
    : /本科/.test(resumeText)
      ? 82
      : /大专|专科/.test(resumeText)
        ? 70
        : 64;
  const businessScore = /业务|增长|营收|利润|客户|市场|指标|结果|目标|成本|效率|转化|战略|经营/.test(resumeText)
    ? 84
    : /协同|推动|沟通|复盘|管理/.test(resumeText)
      ? 76
      : 66;

  return {
    experience: clampScoreValue(experienceScore),
    professional: clampScoreValue(professionalScore),
    stability: clampScoreValue(stabilityScore),
    education: clampScoreValue(educationScore),
    business: clampScoreValue(businessScore),
  };
}

function inferResumeYears(text: string) {
  const matches = Array.from(text.matchAll(/(\d{1,2})\s*年(?:以上)?/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return matches.length ? Math.max(...matches) : null;
}

function inferRequiredYears(experience: string) {
  if (/无经验|应届|校招/.test(experience)) return 0;
  const matches = Array.from(experience.matchAll(/(\d{1,2})/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return matches.length ? Math.min(...matches) : null;
}

async function analyzeVoiceSegmentWithDeepSeek(
  job: Job,
  candidate: Candidate,
  segments: VoiceTranscriptSegment[],
  latestTranscript: string,
) {
  const fallback = buildFallbackVoiceSegmentAnalysis(job, candidate, latestTranscript, segments);
  if (!deepseekApiKey) return fallback;

  const previousSummary = segments
    .slice(0, -1)
    .map((segment) => segment.analysisJson)
    .filter(Boolean)
    .map((value) => {
      try {
        const parsed = JSON.parse(String(value)) as { quickInsight?: { coreViewpoint?: string } };
        return parsed.quickInsight?.coreViewpoint || "";
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .slice(-4)
    .join("；");

  const askedQuestions = candidate.interviewPlan?.questions.map((item) => item.question).slice(0, 8) || [];
  const prompt = [
    "你是一名资深招聘评估专家。你需要在录音开启时做以下几步。",
    "",
    "一、快速提炼其中的关键信息。",
    "【岗位信息】",
    `- 职位名称：${job.title}`,
    `- 关键考核点：${job.keywords}`,
    "【候选人刚说的话】",
    latestTranscript,
    "【当前已积累的候选人信息】",
    previousSummary || candidate.reason || "暂无已提炼摘要",
    "【任务】",
    "请从这段话中提取：核心观点、关键证据、与JD关联、信号判断、信息缺口。",
    "",
    "二、根据候选人叙述的内容进行深度追问。",
    "【岗位关键考核点】",
    job.keywords,
    "【候选人简历中的疑点/缺口】",
    candidate.evaluation?.weaknesses?.join("；") || candidate.reason,
    "【候选人刚才的回答全文】",
    latestTranscript,
    "【此前已经问过的问题】",
    askedQuestions.join("；") || "暂无",
    "【任务】",
    "请判断已覆盖的考核点、未覆盖/模糊考核点，并生成下一个追问。",
    "",
    "请严格输出 JSON，不要输出 markdown，不要输出多余解释。",
    "JSON 顶层字段必须包含：",
    "quickInsight:{coreViewpoint:string,keyEvidence:string[],relatedKeywords:string[],signalType:string,signalReason:string,followUpDirection:string[]}",
    "followUp:{coveredKeywords:string[],uncoveredKeywords:string[],nextQuestion:string,objective:string,starAnchors:{situation:string,task:string,action:string,result:string},backupQuestion:string}",
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位资深招聘评估专家，只能根据岗位信息、实时转写与已知上下文输出简洁、可执行的面试判断与追问方案。",
      userPrompt: prompt,
      temperature: 0.2,
      timeoutMs: deepseekResumeTimeoutMs,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_voice_segment_error", { status: response.status, text });
      return fallback;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsed = safeJsonParse(content);
    const schema = z.object({
      quickInsight: z.object({
        coreViewpoint: z.string().default(""),
        keyEvidence: z.array(z.string()).default([]),
        relatedKeywords: z.array(z.string()).default([]),
        signalType: z.enum(["加分信号", "风险信号"]).default("风险信号"),
        signalReason: z.string().default(""),
        followUpDirection: z.array(z.string()).default([]),
      }),
      followUp: z.object({
        coveredKeywords: z.array(z.string()).default([]),
        uncoveredKeywords: z.array(z.string()).default([]),
        nextQuestion: z.string().default(""),
        objective: z.string().default(""),
        starAnchors: z.object({
          situation: z.string().default(""),
          task: z.string().default(""),
          action: z.string().default(""),
          result: z.string().default(""),
        }),
        backupQuestion: z.string().default(""),
      }),
    });
    return schema.parse(parsed);
  } catch (error) {
    requestLog("deepseek_voice_segment_exception", { message: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

async function evaluateFullVoiceInterviewWithDeepSeek(
  job: Job,
  candidate: Candidate,
  segments: VoiceTranscriptSegment[],
) : Promise<VoiceFinalEvaluation> {
  const fallback = buildFallbackVoiceFinalEvaluation(job, candidate, segments);
  if (!deepseekApiKey) return fallback;

  const fullTranscript = segments.map((segment, index) => `第${index + 1}段：${segment.normalizedTranscript}`).join("\n\n");
  const followupHistory = segments
    .map((segment) => segment.analysisJson)
    .filter(Boolean)
    .map((value) => {
      try {
        const parsed = JSON.parse(String(value)) as { followUp?: { nextQuestion?: string } };
        return parsed.followUp?.nextQuestion || "";
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("；");

  const [candidateReport, recruiterCoach] = await Promise.all([
    evaluateCandidateVoiceInterviewWithDeepSeek(job, candidate, fullTranscript, followupHistory, fallback),
    evaluateRecruiterCoachWithDeepSeek(job, candidate, fullTranscript, fallback.recruiterCoach),
  ]);

  return {
    ...candidateReport,
    recruiterCoach,
  };
}

async function evaluateCandidateVoiceInterviewWithDeepSeek(
  job: Job,
  candidate: Candidate,
  fullTranscript: string,
  followupHistory: string,
  fallback: VoiceFinalEvaluation,
): Promise<Omit<VoiceFinalEvaluation, "recruiterCoach">> {
  const prompt = [
    "你是一名资深招聘评估专家，请根据整场面试的对话记录，对该候选人进行全面评估。",
    "【岗位信息】",
    `- 职位名称：${job.title}`,
    `- 关键词：${job.keywords}`,
    `- 职位描述：${job.description}`,
    "【面试对话摘要】",
    fullTranscript,
    "【面试官已做的追问记录】",
    followupHistory || "暂无结构化追问记录",
    "【任务】",
    "请生成完整候选人评估报告，包括：AI总结、匹配情况评估、优势亮点、风险点、面试官沟通建议。",
    "严格按 JSON 输出，不要输出 markdown。",
    "JSON 顶层字段必须包含：summary, passedKeywords, pendingKeywords, score, strengths, risks, interviewerAdvice:{nextRoundFocus:string[],notRecommendedReasons:string[]}",
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位严谨克制的招聘评估专家，只能依据完整面试记录、岗位JD和候选人已知信息给出总结。",
      userPrompt: prompt,
      temperature: 0.2,
      timeoutMs: deepseekTimeoutMs,
    });
    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_voice_final_error", { status: response.status, text });
      return {
        summary: fallback.summary,
        passedKeywords: fallback.passedKeywords,
        pendingKeywords: fallback.pendingKeywords,
        score: fallback.score,
        strengths: fallback.strengths,
        risks: fallback.risks,
        interviewerAdvice: fallback.interviewerAdvice,
      };
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return {
        summary: fallback.summary,
        passedKeywords: fallback.passedKeywords,
        pendingKeywords: fallback.pendingKeywords,
        score: fallback.score,
        strengths: fallback.strengths,
        risks: fallback.risks,
        interviewerAdvice: fallback.interviewerAdvice,
      };
    }
    const parsed = safeJsonParse(content);
    const schema = z.object({
      summary: z.string().default(""),
      passedKeywords: z.array(z.string()).default([]),
      pendingKeywords: z.array(z.string()).default([]),
      score: z.number().min(0).max(100),
      strengths: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      interviewerAdvice: z.object({
        nextRoundFocus: z.array(z.string()).default([]),
        notRecommendedReasons: z.array(z.string()).default([]),
      }),
    });
    return schema.parse(parsed);
  } catch (error) {
    requestLog("deepseek_voice_final_exception", { message: error instanceof Error ? error.message : String(error) });
    return {
      summary: fallback.summary,
      passedKeywords: fallback.passedKeywords,
      pendingKeywords: fallback.pendingKeywords,
      score: fallback.score,
      strengths: fallback.strengths,
      risks: fallback.risks,
      interviewerAdvice: fallback.interviewerAdvice,
    };
  }
}

async function evaluateRecruiterCoachWithDeepSeek(
  job: Job,
  candidate: Candidate,
  fullTranscript: string,
  fallback: VoiceRecruiterCoachReport,
): Promise<VoiceRecruiterCoachReport> {
  if (!deepseekApiKey) return fallback;

  const prompt = [
    "你是一名专业的面试技巧教练，负责帮助面试官复盘自己的面试表现，提升提问与沟通效率。",
    "【岗位信息】",
    `- 职位名称：${job.title}`,
    `- 关键考核点：${job.keywords}`,
    "【面试对话记录】",
    fullTranscript || "暂无完整对话记录",
    "【核心任务】",
    "请作为面试官的复盘教练，从开场与破冰、信息采集完整度、追问深度、沟通节奏四个维度进行质检，并给出具体的改进建议。",
    "",
    "一、开场与破冰（满分100分）",
    "评估要点：1.开场是否有自我介绍和流程说明；2.是否营造轻松氛围；3.是否确认候选人求职动机。",
    "要求输出：score、evidence（引用对话原话）、issues、suggestion（给出可直接复用的话术模板）。",
    "",
    "二、信息采集完整度（满分100分）",
    "评估要点：是否覆盖薪资结构/期望、到岗时间与离职状态、求职进度/其他offer、空档期或频繁跳槽原因。",
    "要求输出：score、missingItems、suggestionLines（每条都给一句可直接使用的问法）。",
    "",
    "三、追问深度（满分100分）",
    "评估要点：是否对模糊回答追问具体案例；是否追问量化成果口径和贡献占比；是否区分个人贡献与团队贡献；是否触及STAR四维。",
    "要求输出：score、goodExamples、missedOpportunities[{moment,suggestion}]。",
    "",
    "四、沟通节奏（满分100分）",
    "评估要点：主题跳跃度、面试官讲话占比、核心考核点时间分配、收尾是否清晰并给候选人提问机会。",
    "要求输出：score、topicJumpLevel、interviewerTalkRatio、timeAllocation、advice。",
    "",
    "五、综合改进建议",
    "请浓缩为3-5条最关键的改进建议，每条不超过30字，格式为：[维度]：[具体改进点]。",
    "",
    "【输出原则】",
    "1. 每个评分必须有具体依据，优先引用对话中的原话；如录音文本未清晰区分说话人，只能基于可识别内容判断，不得编造。",
    "2. 建议必须给出可直接使用的话术，而非只指出问题。",
    "3. 所有评价只针对面试官，不评价候选人。",
    "4. 语气保持教练式、建设性。",
    "5. 严格输出 JSON，不要输出 markdown，不要输出多余解释。",
    "JSON 顶层字段必须包含：",
    "opening:{score:number,evidence:string[],issues:string[],suggestion:string}",
    "informationCompleteness:{score:number,missingItems:string[],suggestionLines:string[]}",
    "followUpDepth:{score:number,goodExamples:string[],missedOpportunities:[{moment:string,suggestion:string}]}",
    "rhythm:{score:number,topicJumpLevel:string,interviewerTalkRatio:string,timeAllocation:string,advice:string[]}",
    "conciseImprovements:string[]",
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位专业、克制、建设性的面试技巧教练。你只根据给定岗位信息和面试对话，评估面试官本人的提问方式与沟通节奏，并给出可落地的话术建议。",
      userPrompt: prompt,
      temperature: 0.2,
      timeoutMs: deepseekTimeoutMs,
    });
    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_voice_recruiter_coach_error", { status: response.status, text, candidateId: candidate.id });
      return fallback;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsed = safeJsonParse(content);
    const schema = z.object({
      opening: z.object({
        score: z.number().min(0).max(100).default(70),
        evidence: z.array(z.string()).default([]),
        issues: z.array(z.string()).default([]),
        suggestion: z.string().default(""),
      }),
      informationCompleteness: z.object({
        score: z.number().min(0).max(100).default(70),
        missingItems: z.array(z.string()).default([]),
        suggestionLines: z.array(z.string()).default([]),
      }),
      followUpDepth: z.object({
        score: z.number().min(0).max(100).default(70),
        goodExamples: z.array(z.string()).default([]),
        missedOpportunities: z.array(z.object({
          moment: z.string().default(""),
          suggestion: z.string().default(""),
        })).default([]),
      }),
      rhythm: z.object({
        score: z.number().min(0).max(100).default(70),
        topicJumpLevel: z.enum(["低", "中", "高"]).default("中"),
        interviewerTalkRatio: z.string().default("约40%"),
        timeAllocation: z.string().default("核心考核点时间分配有待继续校准。"),
        advice: z.array(z.string()).default([]),
      }),
      conciseImprovements: z.array(z.string()).default([]),
    });
    return schema.parse(parsed);
  } catch (error) {
    requestLog("deepseek_voice_recruiter_coach_exception", { message: error instanceof Error ? error.message : String(error), candidateId: candidate.id });
    return fallback;
  }
}

function buildFallbackVoiceSegmentAnalysis(
  job: Job,
  candidate: Candidate,
  latestTranscript: string,
  segments: VoiceTranscriptSegment[],
) {
  const keywords = normalizeKeywords(job.keywords);
  const related = keywords.filter((item) => latestTranscript.includes(item)).slice(0, 3);
  const evidence = latestTranscript
    .split(/(?<=[。！？；])/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /\d|负责|主导|结果|提升|团队|项目/.test(item))
    .slice(0, 3);
  const hasRisk = /不太清楚|可能|差不多|忘了|不确定|没做过/.test(latestTranscript);
  return {
    quickInsight: {
      coreViewpoint: latestTranscript.slice(0, 60) || `${candidate.name} 正在回答与岗位经历相关的问题。`,
      keyEvidence: evidence.length ? evidence : ["当前这段回答缺少明确数字和结果，建议继续追问。"],
      relatedKeywords: related,
      signalType: hasRisk ? "风险信号" as const : "加分信号" as const,
      signalReason: hasRisk ? "回答里存在模糊表达，案例和结果还不够具体。" : "回答已开始贴近岗位关键词，可继续追问案例细节。",
      followUpDirection: hasRisk ? ["追问具体案例背景", "追问结果指标"] : ["追问个人角色", "追问量化成果"],
    },
    followUp: {
      coveredKeywords: related,
      uncoveredKeywords: keywords.filter((item) => !related.includes(item)).slice(0, 3),
      nextQuestion: `你刚才提到的这段经历里，和“${related[0] || keywords[0] || job.title}”最相关的具体场景是什么？你当时的角色、动作和结果分别是什么？`,
      objective: "继续把模糊回答压实到可验证的情境、动作和结果。",
      starAnchors: {
        situation: "当时面对的业务背景和问题是什么？",
        task: "你的目标和职责边界是什么？",
        action: "你具体做了哪些动作？",
        result: "最终结果如何，有没有量化指标？",
      },
      backupQuestion: segments.length > 1 ? "如果现在让你重新做一次，你会保留什么、调整什么？为什么？" : "这段经历里最能证明你能力的一项结果指标是什么？",
    },
  };
}

function buildFallbackVoiceFinalEvaluation(
  job: Job,
  candidate: Candidate,
  segments: VoiceTranscriptSegment[],
) : VoiceFinalEvaluation {
  const fullTranscript = segments.map((item) => item.normalizedTranscript).join("\n");
  const keywords = normalizeKeywords(job.keywords);
  const passed = keywords.filter((item) => fullTranscript.includes(item)).slice(0, 4);
  const pending = keywords.filter((item) => !passed.includes(item)).slice(0, 4);
  const score = Math.max(55, Math.min(92, candidate.score || 68));
  return {
    summary: `${candidate.name} 在本场沟通中已对 ${passed.join("、") || "部分岗位要点"} 做出初步回应，${pending.length ? `但在 ${pending.join("、")} 上仍需进一步验证。` : "整体可考虑进入下一轮。"} `,
    passedKeywords: passed,
    pendingKeywords: pending,
    score,
    strengths: [
      "愿意配合回答，基础信息表达较完整。",
      passed.length ? `已触达 ${passed.slice(0, 2).join("、")} 等岗位关键点。` : "已具备初步岗位相关经验表达。",
      "可继续通过 STAR 追问验证真实贡献。",
    ],
    risks: [
      pending.length ? `${pending.join("、")} 仍缺少足够的可验证案例。` : "部分量化结果仍需进一步核验。",
      "回答中如存在模糊表达，建议在下一轮继续压实情境与结果。",
    ],
    interviewerAdvice: {
      nextRoundFocus: pending.length ? pending.map((item) => `重点验证 ${item} 的实际案例与量化结果`) : ["继续核验核心案例真实性", "补充量化成果与组织复杂度"],
      notRecommendedReasons: pending.length >= 3 ? ["多个岗位关键点尚未充分验证，暂不建议直接推进终面。"] : [],
    },
    recruiterCoach: buildFallbackRecruiterCoachReport(job, fullTranscript),
  };
}

function buildFallbackRecruiterCoachReport(
  job: Job,
  fullTranscript: string,
): VoiceRecruiterCoachReport {
  const normalized = fullTranscript.trim();
  const mentionsMotivation = /为什么.*(机会|岗位|工作)|动机|离职|求职/.test(normalized);
  const mentionsSalary = /薪资|薪酬|工资|期望/.test(normalized);
  const mentionsArrival = /到岗|入职|离职时间|交接/.test(normalized);
  const mentionsOffer = /offer|流程|进度|其他机会/.test(normalized);
  const mentionsStar = /具体|当时|怎么做|结果|数据|指标|你负责/.test(normalized);
  const keywords = normalizeKeywords(job.keywords).slice(0, 3);

  const openingIssues = [
    !mentionsMotivation ? "开场阶段未明显确认候选人求职动机。" : "",
    !/流程|今天|大概/.test(normalized) ? "未明显听到流程说明，建议先交代面试结构。" : "",
  ].filter(Boolean);

  const missingItems = [
    !mentionsSalary ? "薪资结构 / 薪资期望" : "",
    !mentionsArrival ? "到岗时间 / 离职状态" : "",
    !mentionsOffer ? "求职进度 / 其他 offer" : "",
    !/空档|离职原因|跳槽/.test(normalized) ? "空档期 / 跳槽原因" : "",
  ].filter(Boolean);

  return {
    opening: {
      score: mentionsMotivation ? 78 : 64,
      evidence: normalized ? [normalized.slice(0, 80)] : ["当前录音文本较少，开场证据不足。"],
      issues: openingIssues.length ? openingIssues : ["开场基础可用，但仍可更明确地校准流程与动机。"],
      suggestion: "建议开场先用“我先用2分钟介绍岗位和流程，之后会重点了解你的相关经历，也会留时间给你提问。开始前想先了解一下，你为什么会关注这个机会？”来建立氛围。",
    },
    informationCompleteness: {
      score: Math.max(58, 88 - missingItems.length * 8),
      missingItems: missingItems.length ? missingItems : ["当前基础信息采集相对完整，可继续补足细节口径。"],
      suggestionLines: [
        "你目前的薪资结构和你对新机会的期望区间，方便我先了解一下吗？",
        "如果流程顺利，你最早可以在什么时间到岗？当前离职或交接状态怎么样？",
        "你现在还在推进哪些机会？大概处于什么阶段？",
        "我注意到这段经历切换比较快，方便说一下当时变动的主要原因吗？",
      ].slice(0, Math.max(2, missingItems.length)),
    },
    followUpDepth: {
      score: mentionsStar ? 76 : 62,
      goodExamples: mentionsStar ? ["已出现对具体行动、结果或个人角色的追问迹象。"] : ["当前深挖案例的证据偏少，后续可加强 STAR 追问。"],
      missedOpportunities: [
        {
          moment: "当候选人提到项目成果或负责范围时，还可以继续追问量化口径和个人贡献占比。",
          suggestion: "你刚才提到这个结果提升比较明显，能具体说一下当时你的个人动作、影响范围，以及结果是怎么计算出来的吗？",
        },
        {
          moment: `围绕 ${keywords.join("、") || "岗位关键点"} 仍可继续追问更具体的实战案例。`,
          suggestion: `你刚才提到和“${keywords[0] || job.title}”相关的经历，能按背景、你的任务、具体动作和结果展开讲一个最典型的例子吗？`,
        },
      ],
    },
    rhythm: {
      score: 72,
      topicJumpLevel: "中",
      interviewerTalkRatio: "约40%-50%",
      timeAllocation: `建议把更多时间集中在 ${keywords.join("、") || "岗位关键考核点"} 的可验证案例上，避免信息点过散。`,
      advice: [
        "每次只聚焦一个主题，问完背景后再进入动作和结果，减少横跳。",
        "如果候选人回答较长，可先总结一句，再追问最关键的缺口。",
        "收尾时补一句“你还有什么想了解的”，让节奏更完整。",
      ],
    },
    conciseImprovements: [
      "[开场]：先说明流程，再确认动机",
      "[采集]：补齐薪资、到岗、offer进度",
      "[追问]：对成果数字追口径和贡献",
      "[节奏]：一次只深挖一个主题",
    ],
  };
}

function mergeInterviewFocusesIntoKeyPoints(
  current: Candidate["keyPointAnalysis"],
  focuses: string[],
): Candidate["keyPointAnalysis"] {
  const existing = new Map(current.map((item) => [item.keyword, item]));
  const merged = [...current];
  for (const focus of focuses) {
    if (existing.has(focus)) continue;
    merged.push({
      keyword: focus,
      matched: false,
      evidence: `该项为 AI 识别出的关键面试考核点，建议在面试中重点核验候选人的实际案例、动作与结果。`,
    });
  }
  return merged.slice(0, 8);
}

function mapConclusionFromScore(score: number) {
  if (score >= 85) return "强烈推荐";
  if (score >= 70) return "推荐面试";
  if (score >= 60) return "备选";
  return "暂不推荐";
}

function clampScoreValue(score: number) {
  return Math.max(0, Math.min(100, Number(score.toFixed(1))));
}

async function transcribeVoiceChunk(audioBase64: string, mimeType: string, fileName = "voice-chunk.webm") {
  const inputBuffer = Buffer.from(audioBase64, "base64");
  const wavBuffer = await convertAudioToWavBuffer(inputBuffer, mimeType, fileName);
  const transcriber = await getWhisperTranscriber();
  if (transcriber) {
    try {
      const audio = decodeWavBufferTo16kMono(wavBuffer);
      const result = await transcriber(audio, {
        chunk_length_s: whisperChunkLength,
        stride_length_s: whisperStrideLength,
        language: whisperTargetLanguage,
        task: "transcribe",
        return_timestamps: false,
      }) as { text?: string };
      const transcript = (result.text || "").replace(/\s+/g, " ").trim();
      if (transcript) return transcript;
    } catch (error) {
      requestLog("voice_transcribe_error", {
        message: error instanceof Error ? error.message : String(error),
        mimeType,
        fileName,
        model: whisperModelId,
        modelDir: whisperModelDir,
      });
    }
  }

  throw server.httpErrors.serviceUnavailable(`本地语音转写模型暂时不可用，请先执行 ${whisperModelDownloadCommand} 下载模型后重试。`);
}

async function normalizeVoiceTranscript(transcript: string) {
  const normalized = transcript.trim();
  if (!normalized) return "";
  if (!deepseekApiKey) return normalized;

  const prompt = [
    "请你扮演中文面试转写整理助手。",
    "目标：将当前这段口语化面试转写整理成更通顺、适合招聘人员阅读的实时转写文本。",
    "要求：",
    "1. 严格输出 JSON，对象字段仅包含 normalizedTranscript(string)。",
    "2. 不要总结，不要分析，不要删减核心事实，只做轻量清洗。",
    "3. 可以修正明显的断句、重复口头禅、错别字和识别噪音。",
    "4. 保持第一人称回答语义，不要改写成立场总结。",
    "5. 如果原文很短，就尽量保持原意。",
    "",
    "原始转写：",
    normalized,
  ].join("\n");

  try {
    const response = await deepseekJsonRequest({
      systemPrompt: "你是一位严谨的中文语音转写整理助手，只能基于已有转写文本做轻量清洗，不允许编造内容。",
      userPrompt: prompt,
      temperature: 0.2,
    });

    if (!response.ok) {
      const text = await response.text();
      requestLog("deepseek_voice_normalize_error", { status: response.status, text });
      return normalized;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return normalized;
    const parsed = safeJsonParse(content);
    const schema = z.object({
      normalizedTranscript: z.string().default(""),
    });
    return schema.parse(parsed).normalizedTranscript.trim() || normalized;
  } catch (error) {
    requestLog("deepseek_voice_normalize_exception", { message: error instanceof Error ? error.message : String(error) });
    return normalized;
  }
}

async function getWhisperTranscriber() {
  const transformers = await getTransformersModule();
  if (!transformers) return null;
  if (!whisperPipelinePromise) {
    whisperPipelinePromise = transformers.pipeline("automatic-speech-recognition", whisperModelId, {
      dtype: "q8",
      cache_dir: whisperModelDir,
      local_files_only: true,
    }).then((instance) => instance as unknown as WhisperTranscriber).catch((error) => {
      whisperPipelinePromise = null;
      requestLog("whisper_pipeline_init_error", {
        message: error instanceof Error ? error.message : String(error),
        model: whisperModelId,
        modelDir: whisperModelDir,
      });
      return null;
    });
  }
  return whisperPipelinePromise;
}

async function getTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@huggingface/transformers").then((module) => {
      module.env.allowLocalModels = true;
      module.env.allowRemoteModels = false;
      module.env.localModelPath = whisperModelDir;
      module.env.cacheDir = whisperModelDir;
      module.env.useBrowserCache = false;
      module.env.useFSCache = true;
      return module;
    }).catch((error) => {
      transformersModulePromise = null;
      requestLog("transformers_module_load_error", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  }
  return transformersModulePromise;
}

function decodeWavBufferTo16kMono(wavBuffer: Buffer) {
  const wav = new wavefile.WaveFile(new Uint8Array(wavBuffer));
  wav.toBitDepth("32f");
  wav.toSampleRate(16000);
  const samples = wav.getSamples(true, Float32Array) as Float32Array | Float64Array;
  return samples instanceof Float32Array ? samples : Float32Array.from(samples);
}

async function convertAudioToWavBuffer(inputBuffer: Buffer, mimeType: string, fileName: string) {
  const extension = inferAudioExtension(mimeType, fileName);
  const tempBase = resolve(process.cwd(), `.voice-${Date.now()}-${nanoid(6)}`);
  const inputPath = `${tempBase}.${extension}`;
  const outputPath = extension === "wav" ? `${tempBase}.converted.wav` : `${tempBase}.wav`;
  const { writeFile, unlink } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const ffmpegBinary = ffmpegInstaller?.path || "ffmpeg";

  await writeFile(inputPath, inputBuffer);
  try {
    await execFileAsync(ffmpegBinary, [
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      outputPath,
    ]);
    const { readFile } = await import("node:fs/promises");
    return await readFile(outputPath);
  } catch (error) {
    requestLog("voice_ffmpeg_convert_error", {
      message: error instanceof Error ? error.message : String(error),
      mimeType,
      fileName,
      ffmpegBinary,
    });
    throw server.httpErrors.badRequest("录音转码失败：当前录音文件不完整或浏览器音频格式暂不兼容，请重新开始录音后再试。");
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => undefined),
      unlink(outputPath).catch(() => undefined),
    ]);
  }
}

function inferAudioExtension(mimeType: string, fileName: string) {
  if (/webm/i.test(mimeType) || /\.webm$/i.test(fileName)) return "webm";
  if (/mp4|mpeg4|m4a/i.test(mimeType) || /\.m4a$/i.test(fileName)) return "m4a";
  if (/ogg/i.test(mimeType) || /\.ogg$/i.test(fileName)) return "ogg";
  if (/wav/i.test(mimeType) || /\.wav$/i.test(fileName)) return "wav";
  return "webm";
}

function buildJobCopilotPrompt(job: z.infer<typeof jobCopilotSchema>) {
  const baseContext = [
    `你是一名资深的招聘专家和文案撰稿人。`,
    `请基于以下职位信息生成招聘辅助内容。`,
    `输出字段必须严格为 JSON 对象，包含：recommendedTitle(string), optimizedDescription(string), actionSuggestions(string[]), sourcingTitles(string[]), interviewQuestions([{title,text,probe}])。`,
    `通用要求：`,
    `1. 语言必须为中文。`,
    `2. 不要输出 markdown，不要输出多余字段，不要输出解释性前后缀。`,
    `3. 如果信息不足，仍要基于已有信息完成专业、合理、可用的输出。`,
    `4. 输出内容必须适合中国招聘网站（ATS）直接发布或被招聘人员直接复用。`,
    ``,
    `useCase: ${job.useCase}`,
    `职位名称: ${job.title}`,
    `所属部门: ${job.dept}`,
    `工作城市: ${job.location}`,
    `经验要求: ${job.experience}`,
    `职位级别: ${job.level}`,
    `薪资范围: ${job.salaryRange}`,
    `招聘状态: ${job.status}`,
    `岗位关键词: ${job.keywords}`,
    `现有职位描述: ${job.description}`,
  ];

  if (job.useCase === "jd-optimize") {
    return [
      ...baseContext,
      ``,
      `当前任务重点是生成一份优化后的职位描述（JD）。`,
      `请确保输出满足以下要求：`,
      `1. 你需要像资深招聘专家一样写作，语气必须专业、准确、具有吸引力，能够精准吸引目标候选人。`,
      `2. optimizedDescription 必须是一份可直接用于职位描述覆盖的“专业岗位 JD 正文”，总长度控制在约 500-700 字。`,
      `3. optimizedDescription 必须严格采用标准招聘 JD 结构，并保留清晰换行，不允许写成一整段散文。`,
      `4. optimizedDescription 必须包含且严格按以下顺序组织：`,
      `岗位名称：`,
      `职责核心概述：`,
      `主要职责：`,
      `任职资格：`,
      `5. “主要职责”“任职资格”必须使用阿拉伯数字编号分点，如 1. 2. 3. 。`,
      `6. “职责核心概述”需为 1 段正式概述，不超过 2 句话，用来快速概括该岗位价值与定位。`,
      `7. 内容必须紧扣职位关键词（${job.keywords}）与核心职责（${job.description}），并符合职位名称、级别、经验要求与城市信息，不得空泛。`,
      `8. 必须使用正式、专业、企业化书面表达，禁止使用“我们正在寻找”“你将负责”“加入我们”等招聘广告式口语表达。`,
      `9. recommendedTitle 需输出规范、专业、可发布的岗位名称，不要营销化修饰。`,
      `10. actionSuggestions 输出 3-5 条，聚焦招聘动作建议，如渠道、筛选重点、画像校准。`,
      `11. sourcingTitles 必须额外输出 3 句用于社交渠道主动搜寻候选人的标题，每句单独成项，要求简洁、有搜索感、适合招聘者复制去主动触达。`,
      `12. interviewQuestions 输出 5 条，每条都必须贴近该岗位职责与考核重点，并包含 title、text、probe。`,
    ].join("\n");
  }

  return [
    ...baseContext,
    ``,
    `当前任务重点是生成推荐面试问题。`,
    `你是一名行为面试法（STAR法则）的专家。`,
    `请为“${job.title}”这个岗位生成一套结构化面试问题，并确保满足以下要求：`,
    `1. interviewQuestions 必须输出 5 个深度面试问题。`,
    `2. 问题重点要围绕 2-3 个核心能力展开，优先从以下能力中提炼最相关的维度：${inferCoreCompetencies(job).join("、")}。`,
    `3. 每个问题都必须引导候选人讲述一个具体的过往事例，适合用 STAR 法则进行追问。`,
    `4. 每个问题都必须包含：title（能力标题）、text（主问题）、probe（1-2 个追问，建议分句呈现）、competency（该题主要考察能力）、starFocus（数组，说明该题重点关注 STAR 的哪些环节）、evaluationSignals（数组，说明面试官判断通过时应看到的信号）。`,
    `5. 主问题不能空泛，要明确要求候选人说明情境、任务、行动、结果。`,
    `6. 追问要继续深挖候选人的个人贡献、决策依据、冲突处理、结果量化或复盘反思。`,
    `7. 输出必须是一份结构化的面试问题清单，适合招聘者直接复制使用。`,
    `8. starFocus 推荐从“情境澄清 / 任务定义 / 行动拆解 / 结果量化 / 复盘反思”中选择 2-3 项。`,
    `9. evaluationSignals 需给出 2-3 条简洁判断信号，帮助面试官快速识别是否通过。`,
    `10. optimizedDescription 仍需返回一版专业、简洁、适合 ATS 发布的标准 JD 正文，结构使用“岗位名称 / 职责核心概述 / 主要职责 / 任职资格”。`,
    `11. actionSuggestions 输出 3-5 条，聚焦招聘筛选与面试推进建议。`,
    `12. recommendedTitle 需输出规范、专业、可发布的岗位名称。`,
    `13. sourcingTitles 仍需输出 3 句用于社交渠道主动搜寻候选人的标题。`,
  ].join("\n");
}

function inferCoreCompetencies(job: z.infer<typeof jobCopilotSchema>) {
  const text = `${job.title} ${job.keywords} ${job.description}`.toLowerCase();
  const competencies: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/冲突|协同|跨部门|推动|沟通/, "解决冲突与跨团队协同能力"],
    [/数据|分析|指标|报表|复盘/, "数据分析与问题诊断能力"],
    [/团队搭建|管理|干部|组织|带团队/, "团队搭建与组织管理能力"],
    [/绩效|人才|招聘|发展|od|hrbp/, "人才判断与组织发展能力"],
    [/项目|落地|推进|执行|交付/, "项目推进与落地执行能力"],
    [/策略|规划|机制|体系|设计/, "策略设计与体系搭建能力"],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(text)) competencies.push(label);
  }

  return (competencies.length ? competencies : [
    "问题分析与解决能力",
    "跨团队协同与沟通能力",
    "执行推动与结果达成能力",
  ]).slice(0, 3);
}

function buildFallbackJobCopilotResult(job: z.infer<typeof jobCopilotSchema>) {
  const recommendedTitle = job.title || "目标岗位";
  const optimizedDescription = buildFallbackOptimizedDescription(job);
  const actionSuggestions = buildFallbackActionSuggestions(job);
  const sourcingTitles = buildFallbackSourcingTitles(job);
  const interviewQuestions = buildFallbackInterviewQuestions(job);

  return {
    recommendedTitle,
    optimizedDescription,
    actionSuggestions,
    sourcingTitles,
    interviewQuestions,
  };
}

function buildFallbackOptimizedDescription(job: z.infer<typeof jobCopilotSchema>) {
  const keywords = normalizeKeywords(job.keywords).slice(0, 4);
  const keywordText = keywords.length ? keywords.join("、") : "岗位核心职责";
  return [
    `岗位名称：${job.title || "目标岗位"}`,
    `职责核心概述：围绕 ${keywordText} 等核心事项，承担业务支持与结果达成责任，结合岗位所在团队的实际场景，推动组织目标与关键任务稳定落地。`,
    "主要职责：",
    `1. 结合 ${job.dept || "所属部门"} 的业务目标，承接并推进与岗位相关的重点工作，确保执行节奏、质量与结果达成。`,
    `2. 围绕 ${keywordText} 建立清晰的方法路径与协同机制，及时发现问题并提出可执行的优化方案。`,
    `3. 与相关团队保持高效沟通，推动跨部门配合、资源协调与关键节点闭环，提升整体协同效率。`,
    `4. 持续复盘岗位相关工作成效，沉淀经验做法，并根据业务变化进行策略与动作调整。`,
    "任职资格：",
    `1. 具备 ${job.experience || "相关经验"}，能够独立承担岗位职责并适应 ${job.location || "目标城市"} 的业务场景。`,
    `2. 具备与 ${keywordText} 相关的实践经验，能够在复杂场景下完成分析、推动与落地。`,
    `3. 具备良好的沟通协同能力、结果导向意识与问题解决能力，能够在压力下保持稳定输出。`,
    `4. 具备与 ${job.level || "岗位级别"} 相匹配的专业判断与执行能力，有相关行业或相近岗位经验者优先。`,
  ].join("\n");
}

function buildFallbackActionSuggestions(job: z.infer<typeof jobCopilotSchema>) {
  const keywords = normalizeKeywords(job.keywords).slice(0, 3);
  return [
    `初筛时优先核验候选人是否具备与 ${keywords.join("、") || job.title || "岗位职责"} 直接相关的完整案例。`,
    `面试中重点追问候选人在关键项目中的个人角色、动作细节与量化结果，避免只停留在职责描述层。`,
    `结合 ${job.level || "当前级别"} 要求，优先关注候选人的独立推动能力、跨团队协同能力与复盘优化能力。`,
  ];
}

function buildFallbackSourcingTitles(job: z.infer<typeof jobCopilotSchema>) {
  return [
    `${job.location || "核心城市"}招募${job.title || "目标岗位"}，聚焦${normalizeKeywords(job.keywords).slice(0, 2).join("、") || "关键职责"}经验`,
    `${job.dept || "核心团队"}诚邀${job.title || "目标岗位"}加入，期待有实战落地经验的人选`,
    `${job.title || "目标岗位"}机会开放，欢迎具备${job.experience || "相关"}经验的候选人沟通`,
  ];
}

function buildFallbackInterviewQuestions(job: z.infer<typeof jobCopilotSchema>) {
  const keywords = normalizeKeywords(job.keywords).slice(0, 4);
  const [first, second, third] = keywords.length ? keywords : ["业务理解", "项目推动", "团队协作"];
  return [
    {
      title: `${first}能力验证`,
      text: `请讲一个你过去亲自处理“${first}”相关问题的具体事例，说明当时的业务情境、你的任务目标、你采取的关键行动，以及最终取得的结果。`,
      probe: "追问1：在这个案例里，你个人承担的关键责任是什么？\n追问2：如果当时条件更复杂，你会怎么调整你的做法？",
      competency: `${first}相关核心能力`,
      starFocus: ["情境澄清", "行动拆解", "结果量化"],
      evaluationSignals: ["能清楚说明个人职责边界", "行动步骤具体可复述", "结果有明确量化或业务影响"],
    },
    {
      title: `${second || first}场景深挖`,
      text: `请分享一次你在“${second || first}”相关场景中推动复杂事项落地的过往案例，请按背景、挑战、行动和结果完整说明。`,
      probe: "追问1：过程中最大的阻力或冲突来自哪里？\n追问2：你是如何影响关键相关方并达成一致的？",
      competency: `${second || first}与协同推动能力`,
      starFocus: ["任务定义", "行动拆解", "复盘反思"],
      evaluationSignals: ["能说明关键阻力来源", "有跨团队推动动作", "能解释最终如何达成一致"],
    },
    {
      title: `${third || second || first}问题分析`,
      text: `请讲一个你在“${third || second || first}”相关工作中，面对信息不完整或目标不够清晰，仍然成功推进事情的真实案例。`,
      probe: "追问1：你当时最先确认的关键事实是什么？\n追问2：你是如何判断优先级并做出取舍的？",
      competency: `${third || second || first}问题分析能力`,
      starFocus: ["情境澄清", "任务定义", "行动拆解"],
      evaluationSignals: ["能先讲清楚问题背景", "判断逻辑清晰", "取舍依据具体合理"],
    },
    {
      title: "结果复盘与优化",
      text: "请分享一个你通过复盘与优化，把原本效果一般的工作明显改善的真实事例。请说明问题起点、你的改进动作以及结果变化。",
      probe: "追问1：你具体调整了哪些机制、流程或沟通方式？\n追问2：最终结果是如何被量化或验证的？",
      competency: "复盘优化与持续改进能力",
      starFocus: ["行动拆解", "结果量化", "复盘反思"],
      evaluationSignals: ["能讲清优化前后的差异", "改进动作有针对性", "结果变化可以被验证"],
    },
    {
      title: "岗位适配代表案例",
      text: `结合 ${job.title || "该岗位"} 的职责，请讲一个最能体现你适合该岗位的过往案例，重点说明你在其中的角色、关键贡献和业务结果。`,
      probe: "追问1：这个案例里哪项能力最能证明你能胜任当前岗位？\n追问2：如果换到更复杂的业务环境，你会如何复制这次成功经验？",
      competency: "岗位适配与综合胜任力",
      starFocus: ["任务定义", "行动拆解", "结果量化"],
      evaluationSignals: ["案例与岗位职责高度相关", "个人贡献突出", "经验具备迁移复用价值"],
    },
  ];
}

function safeJsonParse(content: string) {
  const trimmed = content.trim();
  const normalized = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()
    : trimmed;
  return JSON.parse(normalized);
}

function getRequestPublicBaseUrl(request: FastifyRequest) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const forwardedHost = request.headers["x-forwarded-host"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || request.protocol;
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : forwardedHost || request.headers.host;

  if (!host) return undefined;
  return `${protocol}://${host}`;
}

function getMultipartFieldValue(fields: unknown, key: string) {
  const field = (fields as Record<string, unknown> | undefined)?.[key];
  if (!field || Array.isArray(field)) return undefined;
  const typedField = field as { type?: string; value?: unknown };
  return typedField.type === "field" ? String(typedField.value ?? "") : undefined;
}

function requestLog(event: string, payload: Record<string, unknown>) {
  server.log.warn({ event, ...payload });
}

async function deepseekJsonRequest(input: {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? deepseekTimeoutMs);
  try {
    return await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepseekApiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: deepseekModel,
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
        temperature: input.temperature,
        response_format: { type: "json_object" },
      }),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function readBooleanEnv(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

function resolveServerPath(value: string) {
  return resolve(serverRoot, value);
}

function resolveCommandOrServerPath(value: string) {
  return /[\\/]/.test(value) || value.startsWith(".") ? resolve(serverRoot, value) : value;
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function mergeInterviewTimeline(
  candidate: Candidate,
  body: {
    interviewStage: NonNullable<Candidate["interviewStage"]>;
    stageRecommendation: NonNullable<Candidate["stageRecommendation"]>;
    interviewResult: NonNullable<Candidate["interviewResult"]>;
    onboarded: NonNullable<Candidate["onboarded"]>;
    interviewTimeline: Candidate["interviewTimeline"];
  },
) {
  const stamp = formatDateStamp();
  const current = candidate.interviewTimeline || {};
  const next = { ...current, ...(body.interviewTimeline || {}) };

  if (body.interviewStage !== "推荐" && !next.recommendedAt) {
    next.recommendedAt = candidate.interviewTimeline?.recommendedAt || stamp;
  }
  if (body.interviewStage === "推荐" && body.stageRecommendation !== "是") {
    delete next.recommendedAt;
  }
  if (body.interviewStage === "复试" && body.interviewResult !== "未到面") {
    next.firstInterviewPassedAt = next.firstInterviewPassedAt || stamp;
  }
  if (body.interviewStage === "offer") {
    next.secondInterviewPassedAt = next.secondInterviewPassedAt || stamp;
    next.offerAt = next.offerAt || stamp;
  }
  if (body.onboarded === "是") {
    next.onboardedAt = next.onboardedAt || stamp;
  }
  if (body.interviewStage === "推荐") {
    delete next.firstInterviewPassedAt;
    delete next.secondInterviewPassedAt;
    delete next.offerAt;
  }
  if (body.onboarded !== "是" && next.onboardedAt && body.interviewStage !== "offer") {
    delete next.onboardedAt;
  }
  return next;
}

function resolveStageRecommendation(
  stage: NonNullable<Candidate["interviewStage"]>,
  recommendation: NonNullable<Candidate["stageRecommendation"]>,
): NonNullable<Candidate["stageRecommendation"]> {
  if (stage !== "推荐") return "是";
  return recommendation === "否" ? "否" : "待定";
}

function normalizeReasonTags(tags: string[], stage: NonNullable<Candidate["interviewStage"]> = "初试", onboarded?: Candidate["onboarded"]) {
  const options = getReasonTagOptions(stage);
  const mapped = tags.map((item) => mapReasonTagByStage(item, stage, onboarded));
  return Array.from(new Set(mapped.filter((item): item is string => {
    if (!item) return false;
    return options.includes(item);
  }))).slice(0, 6);
}

function shouldManageReasonTags(
  stage: NonNullable<Candidate["interviewStage"]>,
  interviewResult: NonNullable<Candidate["interviewResult"]>,
  onboarded?: Candidate["onboarded"],
) {
  if (stage === "offer") return onboarded !== "是";
  return interviewResult === "淘汰" || interviewResult === "未到面";
}

function inferReasonTags(reason: string, stage: NonNullable<Candidate["interviewStage"]> = "初试", onboarded?: Candidate["onboarded"]) {
  const source = reason.trim();
  if (!source) return [];
  if (stage === "offer") {
    const matched: string[] = [];
    if (/薪资|工资|预算|福利|社保|公积金|补贴/.test(source)) matched.push("薪资不匹配");
    if (/发展|成长|晋升|平台|预期|空间|职业规划|其他offer|别家|他家|对比offer|接到.*offer/.test(source)) matched.push("发展不符合预期");
    if (/岗位调整|编制调整|hc调整|职位调整/.test(source)) matched.push("岗位调整");
    if (/部门|团队|直属|领导|汇报|组织|业务线/.test(source)) matched.push("部门对比");
    if (/身体|家庭|家里|家人|照顾|生病|怀孕|个人原因|其他/.test(source)) matched.push("其他（身体、家人等）");
    if (!matched.length && source) matched.push("其他（身体、家人等）");
    return normalizeReasonTags(matched, stage, onboarded);
  }
  const presets: Array<[RegExp, string]> = [
    [/薪资|工资|预算|报价/, "薪资不匹配"],
    [/稳定|跳槽|离职|空档/, "稳定性风险"],
    [/技能|经验|能力|匹配|不足/, "技能不符"],
    [/未到面|爽约|失联/, "未到面"],
    [/offer|入职|到岗/, "offer流失"],
    [/动机|意愿|兴趣/, "求职动机不足"],
    [/通勤|地点|距离/, "通勤地点受限"],
    [/管理|团队|带人/, "管理经验不足"],
    [/沟通|表达/, "沟通表达一般"],
  ];
  const matched = presets.filter(([pattern]) => pattern.test(source)).map(([, label]) => label);
  return matched;
}

function getReasonTagOptions(stage: NonNullable<Candidate["interviewStage"]>) {
  return stage === "offer" ? offerReasonTagOptions : generalReasonTagOptions;
}

function mapReasonTagByStage(tag: string, stage: NonNullable<Candidate["interviewStage"]>, onboarded?: Candidate["onboarded"]) {
  const value = tag.trim();
  if (!value) return null;
  if (stage !== "offer") return generalReasonTagOptions.includes(value) ? value : null;
  if (offerReasonTagOptions.includes(value)) return value;
  if (value === "薪资福利") return "薪资不匹配";
  if (value === "接到其他offer" || value === "offer流失") return "发展不符合预期";
  if (value === "身体/家庭原因" || value === "其他") return "其他（身体、家人等）";
  return null;
}

const generalReasonTagOptions = ["薪资不匹配", "稳定性风险", "技能不符", "未到面", "offer流失", "求职动机不足", "通勤地点受限", "管理经验不足", "沟通表达一般"];
const offerReasonTagOptions = ["薪资不匹配", "发展不符合预期", "岗位调整", "部门对比", "其他（身体、家人等）"];
type WhisperTranscriber = (
  audio: Float32Array,
  options: {
    chunk_length_s: number;
    stride_length_s: number;
    language: string;
    task: "transcribe";
    return_timestamps: false;
  },
) => Promise<{ text?: string }>;
type TransformersModule = typeof import("@huggingface/transformers");
let transformersModulePromise: Promise<TransformersModule | null> | null = null;
let whisperPipelinePromise: Promise<WhisperTranscriber | null> | null = null;

interface SalaryRangeSample {
  low: number;
  high: number;
  label: string;
}

interface SalarySearchSample {
  platform: string;
  domain: string;
  sourceKind?: "boss-scraper" | "public-search";
  title: string;
  link: string;
  snippet: string;
  publishWindow: string;
  salaryRange: SalaryRangeSample | null;
}

interface SalarySearchEvidence {
  queryBase: string;
  samples: SalarySearchSample[];
  distinctPlatforms: string[];
  sourceNotes: string[];
}

async function generateSalaryData(job: Job, filters: SalaryFilters): Promise<SalaryData> {
  const searchEvidence = await collectSalarySearchEvidence(job, filters);
  return buildSalaryDataFromBossZhilianEvidence(job, filters, searchEvidence);
}

function buildSalaryDataFromBossZhilianEvidence(
  job: Job,
  filters: SalaryFilters,
  searchEvidence: SalarySearchEvidence,
): SalaryData {
  const validSamples = getValidSalarySamples(searchEvidence);
  const validPlatforms = Array.from(new Set(validSamples.map((item) => item.platform)));

  if (validSamples.length < 2) {
    return buildInsufficientSalaryData(
      job,
      filters,
      "至少需要 2 条可解析薪资样本，当前公开搜索样本不足，无法生成综合报告。",
      searchEvidence,
    );
  }

  const midpointValues = validSamples.map((item) => (item.salaryRange.low + item.salaryRange.high) / 2).sort((a, b) => a - b);
  const lowValues = validSamples.map((item) => item.salaryRange.low).sort((a, b) => a - b);
  const highValues = validSamples.map((item) => item.salaryRange.high).sort((a, b) => a - b);
  const keywordPremium = getKeywordPremium(job.keywords, job.description);
  const p25 = sanitizeKNumber(quantile(midpointValues, 0.25));
  const p50 = sanitizeKNumber(quantile(midpointValues, 0.5));
  const p75 = sanitizeKNumber(quantile(midpointValues, 0.75));
  const anchor = sanitizeKNumber(p50 * (1 + keywordPremium.anchorBoost));
  const suggestedLow = sanitizeKNumber(Math.max(quantile(lowValues, 0.35), anchor * 0.9));
  const suggestedHigh = sanitizeKNumber(Math.max(suggestedLow, Math.min(Math.max(quantile(highValues, 0.65), anchor * 1.08), anchor * 1.22)));
  const sampleCounts = countSamplesByPlatform(validSamples);
  const hasBossScraperSamples = validSamples.some((item) => item.sourceKind === "boss-scraper");
  const dataWindow = hasBossScraperSamples ? "BOSS直聘 CDP 抓取 + 智联招聘公开搜索结果" : "BOSS直聘/智联招聘公开搜索结果";
  const bossSourceLabel = hasBossScraperSamples ? "BOSS直聘 CDP 明文薪资样本" : "BOSS直聘公开搜索样本";
  const hasAllPlatforms = validPlatforms.length >= salaryResearchPlatforms.length;
  const confidence = hasAllPlatforms && validSamples.length >= 8 ? "中" : "低";
  const confidenceReason = hasAllPlatforms && validSamples.length >= 8
    ? `${bossSourceLabel}和智联招聘公开样本均已覆盖，样本量达到基础参考要求；但智联侧仍基于公开搜索标题/摘要解析，因此置信度保持为中。`
    : hasAllPlatforms
      ? `${bossSourceLabel}和智联招聘均有可解析薪资样本，但样本量偏少，适合作为招聘沟通参考，不建议作为最终定薪依据。`
      : `当前仅覆盖 ${validPlatforms.join("、")} 的可解析薪资样本，未完成 BOSS直聘和智联招聘双平台交叉验证，因此置信度为低。`;
  const metricSourceSummary = buildSalaryMetricSourceSummary(validSamples, sampleCounts);

  return {
    status: "ready",
    filters,
    benchmarkRegion: filters.region,
    jobFamily: inferJobFamily(job),
    p25,
    p50,
    p75,
    suggestedLow,
    suggestedHigh,
    anchor,
    experienceBands: buildExperienceBandsFromBenchmark(p50, filters),
    regionComparison: buildRegionComparisonFromBenchmark(p50, filters),
    educationComparison: buildEducationComparisonFromBenchmark(p50, filters),
    industryComparison: buildIndustryComparisonFromBenchmark(p50, filters),
    updatedAt: new Date().toLocaleDateString("zh-CN"),
    insights: [
      { title: hasAllPlatforms ? "双平台综合" : "单平台参考", text: `当前综合 ${formatSampleCounts(sampleCounts)} 的可解析薪资样本，市场中位值约为 ${p50}k。` },
      { title: "建议锚点", text: `${filters.region}${filters.role} 建议以 ${anchor}k 作为沟通锚点，常规报价可控制在 ${suggestedLow}-${suggestedHigh}k。` },
      { title: "预算风险", text: `若预算低于 ${p25}k，在当前 ${filters.experience}、${filters.industry} 条件下，候选人转化可能承压。` },
    ],
    advice: {
      summary: `${filters.role} 在 ${filters.region}、${filters.experience}、${filters.industry}、${filters.education} 条件下，综合 ${validPlatforms.join("、")} 可解析样本后，市场中位值约 ${p50}k，建议报价区间为 ${suggestedLow}-${suggestedHigh}k。`,
      reasons: [
        `样本来源：${formatSampleCounts(sampleCounts)}，仅保留能从标题或摘要中解析出月薪区间的公开搜索结果。`,
        `P25/P50/P75 分别来自样本薪资中点的分位统计，避免单个高薪或低薪样本过度影响结论。`,
        `建议区间结合样本低位/高位分布与岗位关键词溢价进行校准。`,
      ],
      keywordPremiums: keywordPremium.reasons.length
        ? keywordPremium.reasons
        : ["当前岗位暂无明显额外关键词溢价，建议按 BOSS直聘与智联招聘综合样本区间沟通。"],
    },
    research: {
      dataWindow,
      confidence,
      confidenceReason,
      limitations: [
        hasBossScraperSamples
          ? "BOSS直聘样本通过本地已登录 Chrome CDP 调用搜索 API 获取；智联招聘样本仍来自公开搜索标题和摘要解析。"
          : "当前通过公开搜索索引返回的标题和摘要解析薪资，不登录平台、不抓取需要登录或反爬保护的详情页。",
        "招聘网站薪资口径可能包含 13 薪/14 薪、底薪+绩效、年薪等差异；当前统一折算为税前月薪 k。",
        hasBossScraperSamples
          ? "BOSS直聘 CDP 抓取依赖本机专用 Chrome 登录态；智联公开搜索结果可能受搜索引擎索引更新时间影响。"
          : "公开搜索结果可能受搜索引擎索引更新时间影响，不能完全代表平台实时全量岗位。",
      ],
      triangulation: {
        requiredSources: 2,
        actualSources: validPlatforms.length,
        passed: hasAllPlatforms,
        summary: hasAllPlatforms
          ? `已综合 ${validPlatforms.join("、")} 两个平台的可解析薪资样本。`
          : `当前仅拿到 ${validPlatforms.join("、")} 的可解析薪资样本，未完成双平台交叉验证。`,
      },
      metricSources: {
        p25: `P25(${p25}K)：${metricSourceSummary}`,
        p50: `P50(${p50}K)：${metricSourceSummary}`,
        p75: `P75(${p75}K)：${metricSourceSummary}`,
      },
      methodology: [
        hasBossScraperSamples
          ? "通过 boss-zhipin-scraper 连接本地已登录 Chrome CDP，抓取 BOSS直聘搜索 API 返回的明文薪资列表。"
          : "检索 BOSS直聘公开搜索结果。",
        "检索智联招聘公开搜索结果。",
        "从标题与摘要中解析月薪区间，剔除无法稳定识别薪资的结果。",
        "以薪资区间中点计算 P25/P50/P75，并结合岗位关键词溢价生成建议报价区间。",
      ],
      coreSources: formatSalaryCoreSources(validPlatforms, hasBossScraperSamples),
      validationSources: formatSalaryCoreSources(validPlatforms, hasBossScraperSamples),
      sampleNotes: [
        formatSampleCounts(sampleCounts),
        `检索词：${searchEvidence.queryBase}`,
        ...searchEvidence.sourceNotes.slice(0, 3),
        hasAllPlatforms
          ? "未从公开摘要中解析出薪资的结果仅作为样本不足说明，不参与分位数计算。"
          : "当前未覆盖的平台会在后续刷新时继续尝试；本次结果按低置信度单平台样本展示。",
      ],
      evidence: validSamples.slice(0, 10).map((item) => ({
        source: item.platform,
        role: item.title,
        region: filters.region,
        experience: filters.experience,
        salaryRange: item.salaryRange.label,
        publishWindow: item.publishWindow || "公开搜索结果",
        note: `${item.snippet}（${item.link}）`,
      })),
      disclaimer: hasAllPlatforms
        ? hasBossScraperSamples
          ? "当前薪酬调研基于 BOSS直聘 CDP 明文薪资样本与智联招聘公开搜索摘要解析结果，适合招聘预算参考；正式定薪前建议结合平台后台、HRBP 经验和实际候选人反馈复核。"
          : "当前薪酬调研基于 BOSS直聘与智联招聘公开搜索标题/摘要解析结果，适合招聘预算参考；正式定薪前建议结合平台后台、HRBP 经验和实际候选人反馈复核。"
        : "当前薪酬调研未完成 BOSS直聘与智联招聘双平台交叉验证，仅适合作为低置信度参考；正式定薪前建议补充另一平台后台数据、HRBP 经验和实际候选人反馈。",
    },
  };
}

function generateLocalSalaryData(job: Job, filters: SalaryFilters): SalaryData {
  const jobFamily = inferJobFamily(job);
  const baseMarket = getBaseMarketSalary(jobFamily);
  const regionMultiplier = regionMultipliers[filters.region] || regionMultipliers[job.location] || 1;
  const experienceMultiplier = experienceMultipliers[filters.experience] || 1;
  const industryMultiplier = industryMultipliers[filters.industry] || 1;
  const educationMultiplier = educationMultipliers[filters.education] || 1;
  const keywordPremium = getKeywordPremium(job.keywords, job.description);

  const p50 = Math.round(baseMarket * regionMultiplier * experienceMultiplier * industryMultiplier * educationMultiplier);
  const p25 = Math.round(p50 * 0.84);
  const p75 = Math.round(p50 * 1.22);
  const anchor = Math.round(p50 * (1 + keywordPremium.anchorBoost));
  const suggestedLow = Math.round(anchor * 0.94);
  const suggestedHigh = Math.round(anchor * 1.12);

  const experienceBands = Object.entries(experienceMultipliers).map(([label, multiplier]) => {
    const mid = Math.round(baseMarket * regionMultiplier * multiplier * industryMultiplier * educationMultiplier);
    return {
      label,
      p25: Math.round(mid * 0.84),
      p50: mid,
      p75: Math.round(mid * 1.22),
    };
  });

  const regionComparison = Object.entries(regionMultipliers).map(([city, multiplier]) => {
    const mid = Math.round(baseMarket * multiplier * experienceMultiplier * industryMultiplier * educationMultiplier);
    return {
      city,
      p25: Math.round(mid * 0.84),
      p50: mid,
      p75: Math.round(mid * 1.22),
    };
  });

  const educationComparison = Object.entries(educationMultipliers).map(([label, multiplier]) => ({
    label,
    value: Math.round(baseMarket * regionMultiplier * experienceMultiplier * industryMultiplier * multiplier),
  }));

  const industryComparison = Object.entries(industryMultipliers).map(([name, multiplier]) => ({
    name,
    value: Math.round(baseMarket * regionMultiplier * experienceMultiplier * educationMultiplier * multiplier),
  }));

  return {
    status: "ready",
    filters,
    benchmarkRegion: filters.region,
    jobFamily,
    p25,
    p50,
    p75,
    suggestedLow,
    suggestedHigh,
    anchor,
    experienceBands,
    regionComparison,
    educationComparison,
    industryComparison,
    updatedAt: new Date().toLocaleDateString("zh-CN"),
    insights: [
      { title: "建议锚点", text: `${filters.region}${filters.role} 当前建议以 ${anchor}k 作为沟通锚点，常规可控制在 ${suggestedLow}-${suggestedHigh}k。` },
      { title: "预算风险", text: `若预算低于 ${p25}k，当前 ${filters.experience}、${filters.industry} 条件下，优质候选人的转化率会明显下滑。` },
      { title: "竞争提醒", text: `${filters.education}、${filters.industry} 对该岗位存在一定溢价影响，建议结合岗位稀缺关键词预留弹性。` },
    ],
    advice: {
      summary: `${filters.role} 在 ${filters.region}、${filters.experience}、${filters.industry}、${filters.education} 条件下，市场中位值约为 ${p50}k，结合岗位职责与关键词后，建议报价区间为 ${suggestedLow}-${suggestedHigh}k。`,
      reasons: [
        `地区系数 ${regionMultiplier.toFixed(2)}：${filters.region} 对同岗位薪酬有明确拉升或回落影响。`,
        `经验系数 ${experienceMultiplier.toFixed(2)}：${filters.experience} 直接决定市场对岗位成熟度的定价。`,
        `行业系数 ${industryMultiplier.toFixed(2)}：${filters.industry} 行业对招聘竞争度和薪酬水平影响明显。`,
        `学历系数 ${educationMultiplier.toFixed(2)}：${filters.education} 会影响候选人池质量预期和报价空间。`,
      ],
      keywordPremiums: keywordPremium.reasons,
    },
    research: {
      dataWindow: "本地效果演示版",
      confidence: "低",
      confidenceReason: "当前结果为本地规则估算，主要用于页面效果预览与招聘预算讨论起点，不代表联网调研结论。",
      limitations: [
        "当前未直接抓取外部招聘网站公开样本。",
        "P25/P50/P75 由本地岗位画像与地区/经验/行业/学历系数推导，适合演示和参考，不建议直接作为最终定薪依据。",
      ],
      triangulation: {
        requiredSources: 3,
        actualSources: 0,
        passed: false,
        summary: "当前为本地效果版，未进行外部网站交叉验证。",
      },
      metricSources: {
        p25: `本地规则估算：基于 ${filters.role} 在 ${filters.region}/${filters.experience}/${filters.industry}/${filters.education} 条件下的保守区间推导。`,
        p50: `本地规则估算：基于 ${filters.role} 在 ${filters.region}/${filters.experience}/${filters.industry}/${filters.education} 条件下的中位区间推导。`,
        p75: `本地规则估算：基于 ${filters.role} 在 ${filters.region}/${filters.experience}/${filters.industry}/${filters.education} 条件下的竞争区间推导。`,
      },
      methodology: [
        "当前结果基于本地薪酬系数模型推算，用于先看页面效果与筛选交互。",
        "综合地区、经验、行业、学历和岗位关键词进行区间校准。",
        "后续如需正式调研，可再接入外部公开数据与 AI 聚合分析。",
      ],
      coreSources: ["本地岗位画像估算模型（演示版）"],
      validationSources: [],
      sampleNotes: [
        "当前为本地效果演示结果，不代表外部抓取样本。",
        "适合作为页面效果查看与预算粗估锚点。",
      ],
      evidence: [
        {
          source: "本地演示模型",
          role: filters.role,
          region: filters.region,
          experience: filters.experience,
          salaryRange: `${suggestedLow}-${suggestedHigh}k`,
          publishWindow: "演示数据",
          note: "基于职位画像、地区、经验、行业与学历系数生成的本地效果结果。",
        },
      ],
      disclaimer: "当前为本地效果演示版薪酬大盘，适合先看页面与交互效果；正式定薪前建议再接入真实公开数据调研。",
    },
  };
}

async function generateSalaryDataWithDeepSeek(
  job: Job,
  filters: SalaryFilters,
  searchEvidence: Awaited<ReturnType<typeof collectSalarySearchEvidence>>,
): Promise<SalaryData> {
  const prompt = buildSalaryResearchPrompt(job, filters, searchEvidence);
  const response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: deepseekModel,
      messages: [
        {
          role: "system",
          content: [
            "你是一位中国招聘薪酬调研顾问，擅长聚合主流招聘网站和公开薪酬报告，给出谨慎、可解释、有依据的市场薪酬建议。",
            "你必须扮演数据聚合器：你的任务是汇总和分析 BOSS直聘、智联招聘两个网站上的公开信息，而不是创作数据。",
            "必须执行双平台交叉验证：不能只听信单一来源，请同时参考 BOSS直聘和智联招聘的数据，交叉验证后再给出最终区间。",
            "严禁编造数据：所有输出数值都必须有明确来源依据或推理逻辑；如果证据不足，必须明确说明不确定性，并给出合理估算依据，而不是伪造精确数据。",
            "请严格输出 JSON 对象，不要输出 markdown 代码块，不要输出额外解释。",
            "如果无法百分百确认，请给出保守、合理、可落地的估计，并明确降低置信度，不允许编造夸张或离谱的数字。",
          ].join(" "),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.35,
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    requestLog("deepseek_salary_research_error", { status: response.status, text });
    throw server.httpErrors.badGateway(`DeepSeek 薪酬调研失败：${response.status}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw server.httpErrors.badGateway("DeepSeek 未返回有效薪酬调研内容");

  const parsed = normalizeSalaryResearchPayload(safeJsonParse(content));
  const schema = z.object({
    benchmarkRegion: z.string().min(1).default(filters.region),
    jobFamily: z.string().min(1).default(inferJobFamily(job)),
    p25: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p75: z.number().nonnegative(),
    suggestedLow: z.number().nonnegative(),
    suggestedHigh: z.number().nonnegative(),
    anchor: z.number().nonnegative(),
    updatedAt: z.string().min(1).default(new Date().toLocaleDateString("zh-CN")),
    experienceBands: z.array(z.object({
      label: z.string(),
      p25: z.number().nonnegative(),
      p50: z.number().nonnegative(),
      p75: z.number().nonnegative(),
    })).min(3),
    regionComparison: z.array(z.object({
      city: z.string(),
      p25: z.number().nonnegative(),
      p50: z.number().nonnegative(),
      p75: z.number().nonnegative(),
    })).min(3),
    educationComparison: z.array(z.object({
      label: z.string(),
      value: z.number().nonnegative(),
    })).min(3),
    industryComparison: z.array(z.object({
      name: z.string(),
      value: z.number().nonnegative(),
    })).min(4),
    insights: z.array(z.object({
      title: z.string(),
      text: z.string(),
    })).min(3).max(6),
    advice: z.object({
      summary: z.string().min(1),
      reasons: z.array(z.string()).min(3).max(6),
      keywordPremiums: z.array(z.string()).min(1).max(5),
    }),
    research: z.object({
      dataWindow: z.string().min(1),
      confidence: z.enum(["高", "中", "低"]),
      confidenceReason: z.string().min(1),
      limitations: z.array(z.string()).min(1).max(8),
      triangulation: z.object({
        requiredSources: z.number().int().min(2).max(10),
        actualSources: z.number().int().min(0).max(20),
        passed: z.boolean(),
        summary: z.string().min(1),
      }),
      metricSources: z.object({
        p25: z.string().min(1),
        p50: z.string().min(1),
        p75: z.string().min(1),
      }),
      methodology: z.array(z.string()).min(3).max(6),
      coreSources: z.array(z.string()).min(2).max(8),
      validationSources: z.array(z.string()).min(1).max(6),
      sampleNotes: z.array(z.string()).min(2).max(6),
      evidence: z.array(z.object({
        source: z.string(),
        role: z.string(),
        region: z.string(),
        experience: z.string(),
        salaryRange: z.string(),
        publishWindow: z.string(),
        note: z.string(),
      })).min(4).max(10),
      disclaimer: z.string().min(1),
    }),
  });

  const result = schema.parse(parsed);
  const normalizedActualSources = Math.max(result.research.triangulation.actualSources, result.research.coreSources.length);
  const passedTriangulation = normalizedActualSources >= Math.max(2, result.research.triangulation.requiredSources);
  if (normalizedActualSources < 2 || !passedTriangulation) {
    return buildInsufficientSalaryData(job, filters, "当前公开数据不足，无法生成高置信度报告", searchEvidence);
  }
  return {
    status: "ready",
    filters,
    benchmarkRegion: result.benchmarkRegion,
    jobFamily: result.jobFamily,
    p25: sanitizeKNumber(result.p25),
    p50: sanitizeKNumber(result.p50),
    p75: sanitizeKNumber(result.p75),
    suggestedLow: sanitizeKNumber(result.suggestedLow),
    suggestedHigh: sanitizeKNumber(result.suggestedHigh),
    anchor: sanitizeKNumber(result.anchor),
    experienceBands: result.experienceBands.map((item) => ({
      label: item.label,
      p25: sanitizeKNumber(item.p25),
      p50: sanitizeKNumber(item.p50),
      p75: sanitizeKNumber(item.p75),
    })),
    regionComparison: result.regionComparison.map((item) => ({
      city: item.city,
      p25: sanitizeKNumber(item.p25),
      p50: sanitizeKNumber(item.p50),
      p75: sanitizeKNumber(item.p75),
    })),
    educationComparison: result.educationComparison.map((item) => ({
      label: item.label,
      value: sanitizeKNumber(item.value),
    })),
    industryComparison: result.industryComparison.map((item) => ({
      name: item.name,
      value: sanitizeKNumber(item.value),
    })),
    updatedAt: result.updatedAt,
    insights: result.insights,
    advice: result.advice,
    research: {
      ...result.research,
      triangulation: {
        ...result.research.triangulation,
        actualSources: normalizedActualSources,
        passed: passedTriangulation && result.research.triangulation.passed,
      },
    },
  };
}

function normalizeSalaryResearchPayload(raw: unknown) {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const advice = (source.advice && typeof source.advice === "object" ? source.advice : {}) as Record<string, unknown>;
  const research = (source.research && typeof source.research === "object" ? source.research : {}) as Record<string, unknown>;
  const triangulation = (research.triangulation && typeof research.triangulation === "object" ? research.triangulation : {}) as Record<string, unknown>;
  const metricSources = (research.metricSources && typeof research.metricSources === "object" ? research.metricSources : {}) as Record<string, unknown>;

  return {
    ...source,
    advice: {
      ...advice,
      reasons: normalizeStringList(advice.reasons),
      keywordPremiums: normalizeStringList(advice.keywordPremiums),
    },
    research: {
      ...research,
      confidence: normalizeConfidence(research.confidence),
      confidenceReason: String(research.confidenceReason || research.confidence_reason || "模型已根据样本充分性、来源数量与一致性自动评估置信度。").trim(),
      limitations: normalizeStringList(research.limitations),
      triangulation: {
        requiredSources: normalizeInteger(triangulation.requiredSources ?? triangulation.required_sources, 3),
        actualSources: normalizeInteger(triangulation.actualSources ?? triangulation.actual_sources, 0),
        passed: normalizeBoolean(triangulation.passed),
        summary: String(triangulation.summary || "未提供三角验证摘要。").trim(),
      },
      metricSources: {
        p25: String(metricSources.p25 || source.p25Source || "未提供 P25 来源说明。").trim(),
        p50: String(metricSources.p50 || source.p50Source || "未提供 P50 来源说明。").trim(),
        p75: String(metricSources.p75 || source.p75Source || "未提供 P75 来源说明。").trim(),
      },
      methodology: normalizeStringList(research.methodology),
      coreSources: normalizeStringList(research.coreSources),
      validationSources: normalizeStringList(research.validationSources),
      sampleNotes: normalizeStringList(research.sampleNotes),
      evidence: Array.isArray(research.evidence) ? research.evidence : [],
    },
  };
}

function normalizeStringList(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          return String(obj.text || obj.note || obj.label || obj.title || obj.reason || "").trim();
        }
        return String(item ?? "").trim();
      })
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[；;\n•·]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeConfidence(value: unknown): "高" | "中" | "低" {
  const text = String(value || "").trim();
  if (!text) return "中";
  if (text === "高" || /高/.test(text)) return "高";
  if (text === "低" || /低/.test(text)) return "低";
  return "中";
}

function normalizeInteger(value: unknown, fallback: number) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.round(num));
}

function normalizeBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "是" || text === "通过";
}

function buildSalaryResearchPrompt(
  job: Job,
  filters: SalaryFilters,
  searchEvidence: Awaited<ReturnType<typeof collectSalarySearchEvidence>>,
) {
  return [
    "请基于以下岗位信息，生成一份用于招聘实际工作的中国市场薪酬调研结果。",
    "核心要求：",
    "0. 你必须主动使用我提供的搜索样本，对 BOSS直聘 / 智联招聘 两个平台公开招聘网站结果做整理分析，而不是凭空创作数据。",
    "1. 优先并主要参考 BOSS直聘和智联招聘近3-6个月内相似岗位的招聘信息。",
    "2. 可结合公开薪酬报告、人力资源咨询公司报告（如美世、太和顾问等）做交叉验证。",
    "3. 你必须扮演“数据聚合器”，只允许汇总公开信息和推理，不允许创作或编造数据。",
    "4. 必须执行双平台交叉验证：至少同时参考 BOSS直聘和智联招聘的数据，通过交叉验证后给出最终区间；只有数值落在交叉重叠区间内，才可以作为依据；若做不到，必须直接返回公开数据不足。",
    "5. 严禁编造数据：所有数值都必须有明确来源依据或推理逻辑，尤其是 P25 / P50 / P75。",
    "6. 输出必须严格为 JSON 对象，不要 markdown，不要解释。",
    "7. 所有金额单位统一为税前月薪整数 k（例如 25 表示 25k/月）。",
    "8. 如果搜不到足够的有效数据（BOSS直聘或智联招聘任一平台缺少有效样本），请直接输出“当前公开数据不足，无法生成高置信度报告”，绝对禁止使用本地模型或内部系数进行填补。",
    "9. 如果最终报告再次出现“来源：本地估算模型”或类似含义，则视为失败。",
    "10. 若信息存在不确定性，请降低 confidence，并在 confidenceReason / limitations / sampleNotes / disclaimer 中说明。",
    "",
    "JSON 字段要求：",
    "benchmarkRegion(string), jobFamily(string), p25(number), p50(number), p75(number), suggestedLow(number), suggestedHigh(number), anchor(number), updatedAt(string),",
    "experienceBands([{label,p25,p50,p75}]), regionComparison([{city,p25,p50,p75}]), educationComparison([{label,value}]), industryComparison([{name,value}]),",
    "insights([{title,text}]), advice({summary,reasons,keywordPremiums}),",
    "research({dataWindow,confidence,confidenceReason,limitations,triangulation{requiredSources,actualSources,passed,summary},metricSources{p25,p50,p75},methodology,coreSources,validationSources,sampleNotes,evidence([{source,role,region,experience,salaryRange,publishWindow,note}]),disclaimer})",
    "",
    "岗位信息：",
    `职位名称：${filters.role}`,
    `所属部门：${job.dept}`,
    `工作地点：${job.location}`,
    `筛选地区：${filters.region}`,
    `经验要求：${filters.experience}`,
    `行业：${filters.industry}`,
    `学历：${filters.education}`,
    `职位级别：${job.level}`,
    `当前岗位薪资范围：${job.salaryRange || "未填写"}`,
    `岗位关键词：${job.keywords}`,
    `岗位描述：${job.description}`,
    "",
    "搜索样本（先以这些公开搜索结果为基础，再做归纳；如果这些样本无法同时覆盖 BOSS直聘和智联招聘，则必须失败返回）：",
    ...searchEvidence.samples.map((sample, index) => `${index + 1}. [${sample.platform}] ${sample.title} | ${sample.link} | ${sample.snippet} | ${sample.publishWindow}`),
    "",
    "输出规则补充：",
    "1. experienceBands 请至少覆盖：无经验、1年以内、1-3年、3-5年、5-10年、10年以上。",
    `2. regionComparison 必须包含当前地区 ${filters.region}，并补充至少 2-4 个同类招聘活跃城市做比较。`,
    "3. educationComparison 请至少包含：大专、本科、硕士。",
    `4. industryComparison 必须包含当前行业 ${filters.industry}，并补充至少 3 个相近行业。`,
    "5. evidence 中请列出 4-8 条具有代表性的样本归纳，每条要写清来源平台、岗位、地区、经验、薪资区间、时间窗口和备注。",
    "6. metricSources.p25 / metricSources.p50 / metricSources.p75 必须分别写明来源标注格式，例如：P50(37K)：综合参考 BOSS直聘 20 个相关岗位（月薪30-45K）和智联招聘 15 个相关岗位（月薪32-48K）的区间，交叉验证后取中位参考值。",
    "7. research.triangulation 必须反映是否真的满足 BOSS直聘和智联招聘双平台交叉验证；未满足时 passed 必须为 false。",
    "8. advice.summary 要能直接给招聘者看；reasons 要解释为什么建议这个区间；keywordPremiums 要解释 JD 中哪些要求带来了溢价。",
    "9. limitations 必须如实写明数据不足、行业口径差异、城市样本不足、发布时间差异等局限性。",
  ].join("\n");
}

const salaryResearchPlatforms = [
  { name: "BOSS直聘", domain: "zhipin.com" },
  { name: "智联招聘", domain: "zhaopin.com" },
] as const;

async function collectSalarySearchEvidence(job: Job, filters: SalaryFilters): Promise<SalarySearchEvidence> {
  const platforms = salaryResearchPlatforms;
  const queryBase = `${filters.region} ${filters.role} ${filters.industry} ${filters.experience} ${filters.education} 招聘 薪资`;
  const samples: SalarySearchSample[] = [];
  const sourceNotes: string[] = [];
  const seen = new Set<string>();
  const queryVariants = [
    queryBase,
    `${filters.region} ${filters.role} ${filters.experience} 薪资`,
    `${filters.region} ${job.title} ${filters.industry} 招聘`,
  ];

  const bossScraperSamples = await collectBossSalarySamplesWithScraper(job, filters);
  bossScraperSamples.sourceNotes.forEach((note) => sourceNotes.push(note));
  bossScraperSamples.samples.forEach((sample) => addSalarySearchSample(samples, seen, sample));
  const hasBossScraperSalary = bossScraperSamples.samples.some((sample) => Boolean(sample.salaryRange));

  const publicSearchPlatforms = hasBossScraperSalary
    ? platforms.filter((platform) => platform.name !== "BOSS直聘")
    : platforms;

  await Promise.all(publicSearchPlatforms.map(async (platform) => {
    for (const query of queryVariants) {
      if (samples.filter((item) => item.platform === platform.name).length >= 8) break;
      const rssUrl = `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(`site:${platform.domain} ${query}`)}`;
      try {
        const response = await withTimeout(fetch(rssUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0",
          },
        }), salarySearchTimeoutMs, "薪酬公开样本检索超时");
        const xml = await response.text();
        const platformItems = parseBingRssItems(xml)
          .filter((item) => item.link.includes(platform.domain))
          .slice(0, 6);
        platformItems.forEach((item) => {
          const identity = `${platform.name}:${item.link || item.title}`;
          if (seen.has(identity)) return;
          seen.add(identity);
          const text = `${item.title} ${item.snippet}`;
          samples.push({
            platform: platform.name,
            domain: platform.domain,
            sourceKind: "public-search",
            ...item,
            salaryRange: extractSalaryRangeFromText(text),
          });
        });
      } catch (error) {
        requestLog("salary_search_collect_error", {
          platform: platform.name,
          domain: platform.domain,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }));

  const distinctPlatforms = Array.from(new Set(samples.map((item) => item.platform)));
  return {
    queryBase,
    samples,
    distinctPlatforms,
    sourceNotes,
  };
}

function addSalarySearchSample(samples: SalarySearchSample[], seen: Set<string>, sample: SalarySearchSample) {
  const identity = `${sample.platform}:${sample.link || sample.title}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  samples.push(sample);
}

async function collectBossSalarySamplesWithScraper(
  job: Job,
  filters: SalaryFilters,
): Promise<{ samples: SalarySearchSample[]; sourceNotes: string[] }> {
  if (!bossScraperEnabled) {
    return { samples: [], sourceNotes: ["BOSS直聘 CDP 抓取未启用，已降级使用公开搜索结果。"] };
  }

  if (!existsSync(bossScraperScriptPath)) {
    requestLog("boss_scraper_missing", {
      scriptPath: bossScraperScriptPath,
      installCommand: "pnpm download:boss-scraper",
    });
    return { samples: [], sourceNotes: ["BOSS直聘 CDP 抓取工具未安装，已降级使用公开搜索结果。"] };
  }

  const { execFile } = await import("node:child_process");
  const { mkdir, readFile } = await import("node:fs/promises");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const keyword = buildBossScraperKeyword(job, filters);
  const experienceCode = getBossExperienceCode(filters.experience);
  const degreeCode = getBossDegreeCode(filters.education);
  const industryCode = getBossIndustryCode(filters.industry);

  await mkdir(bossScraperOutputDir, { recursive: true });

  const pythonBin = existsSync(bossScraperPython) ? bossScraperPython : "python3";
  const runScraper = async (useIndustry: boolean): Promise<{ samples: SalarySearchSample[]; sourceNotes: string[] }> => {
    const outputPath = resolve(bossScraperOutputDir, `boss_jobs_${Date.now()}_${nanoid(8)}.json`);
    const args = [
      bossScraperScriptPath,
      "--keyword",
      keyword,
      "--city",
      filters.region,
      "--pages",
      String(bossScraperPages),
      "--no-detail",
      "--output",
      outputPath,
      "--cdp-port",
      String(bossScraperCdpPort),
    ];
    if (experienceCode) args.push("--experience", experienceCode);
    if (degreeCode) args.push("--degree", degreeCode);
    if (useIndustry && industryCode) args.push("--industry", industryCode);

    let execError: unknown = null;
    try {
      await execFileAsync(pythonBin, args, {
        cwd: bossScraperDir,
        timeout: bossScraperTimeoutMs,
        maxBuffer: 1024 * 1024 * 12,
        env: process.env,
      });
    } catch (error) {
      execError = error;
    }

    try {
      const payload = JSON.parse(await readFile(outputPath, "utf-8")) as {
        scraped_at?: string;
        jobs?: unknown[];
      };
      const scrapedAt = payload.scraped_at || new Date().toISOString();
      const samples = (Array.isArray(payload.jobs) ? payload.jobs : [])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item) => bossScraperJobToSalarySample(item, scrapedAt))
        .filter((item): item is SalarySearchSample => Boolean(item));

      return {
        samples,
        sourceNotes: [
          execError
            ? `BOSS直聘通过 boss-zhipin-scraper CDP 工具保留 ${samples.length} 条列表样本；抓取进程后续异常退出，已使用已落盘样本。`
            : `BOSS直聘通过 boss-zhipin-scraper CDP 工具抓取 ${samples.length} 条列表样本。`,
        ],
      };
    } catch (error) {
      requestLog("boss_scraper_collect_error", {
        message: execError instanceof Error ? execError.message : error instanceof Error ? error.message : String(error),
        scriptPath: bossScraperScriptPath,
        cdpPort: bossScraperCdpPort,
        industryCode: useIndustry ? industryCode : undefined,
      });
      return {
        samples: [],
        sourceNotes: ["BOSS直聘 CDP 抓取失败，可能未安装工具、Python 依赖缺失，或专用 Chrome 未登录；已降级使用公开搜索结果。"],
      };
    }
  };

  const industryResult = await runScraper(Boolean(industryCode));
  const industrySalarySamples = industryResult.samples.filter((sample) => Boolean(sample.salaryRange));
  if (industryCode && industrySalarySamples.length < 2) {
    const relaxedResult = await runScraper(false);
    return {
      samples: relaxedResult.samples,
      sourceNotes: [
        `BOSS直聘行业筛选已尝试选择 ${filters.industry}（industry=${industryCode}），但可解析薪资样本不足，已自动放宽行业筛选。`,
        ...relaxedResult.sourceNotes,
      ],
    };
  }

  return {
    samples: industryResult.samples,
    sourceNotes: industryCode
      ? [
        `BOSS直聘行业筛选已选择 ${filters.industry}（industry=${industryCode}）。`,
        ...industryResult.sourceNotes,
      ]
      : industryResult.sourceNotes,
  };
}

function bossScraperJobToSalarySample(job: Record<string, unknown>, scrapedAt: string): SalarySearchSample | null {
  const title = String(job.title || "").trim();
  const salary = String(job.salary || "").trim();
  const link = String(job.job_link || "").trim();
  if (!title && !link) return null;
  const company = String(job.boss_name || "").trim();
  const location = String(job.location || "").trim();
  const tags = String(job.tags || "").trim();
  const skills = String(job.skills || job.job_labels || "").trim();
  const companyScale = String(job.company_scale || "").trim();
  const companyIndustry = String(job.company_industry || "").trim();
  const scrapedDate = new Date(scrapedAt);
  const scrapedStamp = Number.isNaN(scrapedDate.getTime()) ? formatDateStamp() : formatDateStamp(scrapedDate);
  const snippet = [
    company ? `公司：${company}` : "",
    companyIndustry ? `行业：${companyIndustry}` : "",
    salary ? `薪资：${salary}` : "",
    location ? `地点：${location}` : "",
    tags ? `要求：${tags}` : "",
    skills ? `技能：${skills}` : "",
    companyScale ? `规模：${companyScale}` : "",
  ].filter(Boolean).join("；");

  return {
    platform: "BOSS直聘",
    domain: "zhipin.com",
    sourceKind: "boss-scraper",
    title: company ? `${title} - ${company}` : title,
    link: link || `zhipin://job/${String(job.job_id || title)}`,
    snippet,
    publishWindow: `CDP抓取 ${scrapedStamp}`,
    salaryRange: extractSalaryRangeFromText(salary || `${title} ${snippet}`),
  };
}

function buildBossScraperKeyword(job: Job, filters: SalaryFilters) {
  const role = filters.role.trim() || job.title.trim();
  if (role) return role;
  return normalizeKeywords(job.keywords)[0] || "招聘";
}

function getBossExperienceCode(value: string) {
  const map: Record<string, string> = {
    无经验: "101",
    "1年以内": "103",
    "1-3年": "104",
    "3-5年": "105",
    "5-10年": "106",
    "10年以上": "107",
  };
  return map[value] || "";
}

function getBossDegreeCode(value: string) {
  const map: Record<string, string> = {
    大专: "202",
    本科: "203",
    硕士: "204",
    博士: "205",
  };
  return map[value] || "";
}

function getBossIndustryCode(value: string) {
  if (!value.trim()) return "";
  return bossIndustryCodeByName[normalizeBossIndustryName(value)] || "";
}

function parseBingRssItems(xml: string) {
  return Array.from(xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g))
    .map((match) => {
      const itemXml = match[1];
      return {
        title: decodeHtml(extractRssTag(itemXml, "title")),
        link: decodeHtml(extractRssTag(itemXml, "link")),
        snippet: decodeHtml(extractRssTag(itemXml, "description")).replace(/<[^>]+>/g, "").trim(),
        publishWindow: decodeHtml(extractRssTag(itemXml, "pubDate")),
      };
    })
    .filter((item) => item.title && item.link);
}

function extractRssTag(xml: string, tag: string) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return stripCdata(match?.[1] || "");
}

function stripCdata(text: string) {
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function extractSalaryRangeFromText(text: string): SalaryRangeSample | null {
  const normalized = text
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .replace(/－|—|–|~|～/g, "-");
  const annualMatch = normalized.match(/年薪\s*(\d+(?:\.\d+)?)\s*(万)?\s*[-至到]\s*(\d+(?:\.\d+)?)\s*万/i);
  if (annualMatch) {
    const low = Number(annualMatch[1]) * 10 / 12;
    const high = Number(annualMatch[3]) * 10 / 12;
    return normalizeSalaryRange(low, high, `${annualMatch[1]}-${annualMatch[3]}万/年`);
  }

  const rangePattern = /(\d+(?:\.\d+)?)\s*([kK千万元]?)\s*[-至到]\s*(\d+(?:\.\d+)?)\s*([kK千万元])(?:\/?月|每月|月)?(?:\s*[·x×*]\s*\d{1,2}\s*薪)?/g;
  for (const match of normalized.matchAll(rangePattern)) {
    const firstUnit = match[2] || match[4];
    const secondUnit = match[4];
    const low = convertSalaryUnit(Number(match[1]), firstUnit);
    const high = convertSalaryUnit(Number(match[3]), secondUnit);
    const range = normalizeSalaryRange(low, high, match[0].trim());
    if (range) return range;
  }

  return null;
}

function convertSalaryUnit(value: number, unit: string) {
  if (!Number.isFinite(value)) return 0;
  if (unit === "万") return value * 10;
  if (unit === "元") return value >= 1000 ? value / 1000 : 0;
  return value;
}

function normalizeSalaryRange(low: number, high: number, label: string): SalaryRangeSample | null {
  let normalizedLow = Math.min(low, high);
  let normalizedHigh = Math.max(low, high);
  if (!Number.isFinite(normalizedLow) || !Number.isFinite(normalizedHigh)) return null;
  if (normalizedLow <= 0 || normalizedHigh <= 0) return null;
  if (normalizedHigh > 200) return null;
  if (normalizedHigh < 3) return null;
  normalizedLow = Math.max(1, Math.round(normalizedLow * 10) / 10);
  normalizedHigh = Math.max(normalizedLow, Math.round(normalizedHigh * 10) / 10);
  return {
    low: normalizedLow,
    high: normalizedHigh,
    label,
  };
}

function getValidSalarySamples(searchEvidence: SalarySearchEvidence) {
  return searchEvidence.samples.filter((item): item is SalarySearchSample & { salaryRange: SalaryRangeSample } => Boolean(item.salaryRange));
}

function quantile(values: number[], percentile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function countSamplesByPlatform(samples: Array<SalarySearchSample & { salaryRange: SalaryRangeSample }>) {
  return samples.reduce<Record<string, number>>((acc, sample) => {
    acc[sample.platform] = (acc[sample.platform] || 0) + 1;
    return acc;
  }, {});
}

function formatSampleCounts(counts: Record<string, number>) {
  return salaryResearchPlatforms
    .map((platform) => `${platform.name} ${counts[platform.name] || 0} 条`)
    .join("、");
}

function formatSalaryCoreSources(platforms: string[], hasBossScraperSamples: boolean) {
  return platforms.map((platform) => (
    platform === "BOSS直聘" && hasBossScraperSamples ? "BOSS直聘（boss-zhipin-scraper CDP）" : platform
  ));
}

function buildSalaryMetricSourceSummary(samples: Array<SalarySearchSample & { salaryRange: SalaryRangeSample }>, counts: Record<string, number>) {
  const ranges = samples
    .slice(0, 6)
    .map((item) => `${item.platform} ${item.salaryRange.label}`)
    .join("；");
  return `综合 ${formatSampleCounts(counts)} 可解析样本的薪资中点分布计算；代表区间：${ranges}`;
}

function buildExperienceBandsFromBenchmark(p50: number, filters: SalaryFilters) {
  const currentMultiplier = experienceMultipliers[filters.experience] || 1;
  return Object.entries(experienceMultipliers).map(([label, multiplier]) => {
    const mid = Math.round(p50 * multiplier / currentMultiplier);
    return {
      label,
      p25: Math.round(mid * 0.84),
      p50: mid,
      p75: Math.round(mid * 1.22),
    };
  });
}

function buildRegionComparisonFromBenchmark(p50: number, filters: SalaryFilters) {
  const currentMultiplier = regionMultipliers[filters.region] || 1;
  const entries = uniqueMetricEntries([[filters.region, currentMultiplier], ...Object.entries(regionMultipliers)]);
  return entries.map(([city, multiplier]) => {
    const mid = Math.round(p50 * multiplier / currentMultiplier);
    return {
      city,
      p25: Math.round(mid * 0.84),
      p50: mid,
      p75: Math.round(mid * 1.22),
    };
  });
}

function buildEducationComparisonFromBenchmark(p50: number, filters: SalaryFilters) {
  const currentMultiplier = educationMultipliers[filters.education] || 1;
  return uniqueMetricEntries([[filters.education, currentMultiplier], ...Object.entries(educationMultipliers)]).map(([label, multiplier]) => ({
    label,
    value: Math.round(p50 * multiplier / currentMultiplier),
  }));
}

function buildIndustryComparisonFromBenchmark(p50: number, filters: SalaryFilters) {
  const currentMultiplier = industryMultipliers[filters.industry] || 1;
  return uniqueMetricEntries([[filters.industry, currentMultiplier], ...Object.entries(industryMultipliers)]).map(([name, multiplier]) => ({
    name,
    value: Math.round(p50 * multiplier / currentMultiplier),
  }));
}

function uniqueMetricEntries(entries: Array<[string, number]>) {
  const seen = new Set<string>();
  return entries.filter(([name]) => {
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

function buildInsufficientSalaryData(
  job: Job,
  filters: SalaryFilters,
  message: string,
  searchEvidence?: SalarySearchEvidence,
): SalaryData {
  const hasBossScraperSamples = Boolean(searchEvidence?.samples.some((item) => item.sourceKind === "boss-scraper"));
  return {
    status: "insufficient_data",
    errorMessage: message,
    filters,
    benchmarkRegion: filters.region,
    jobFamily: inferJobFamily(job),
    p25: 0,
    p50: 0,
    p75: 0,
    suggestedLow: 0,
    suggestedHigh: 0,
    anchor: 0,
    experienceBands: [],
    regionComparison: [],
    educationComparison: [],
    industryComparison: [],
    updatedAt: new Date().toLocaleDateString("zh-CN"),
    insights: [
      { title: "公开数据不足", text: message },
    ],
    advice: {
      summary: message,
      reasons: ["当前未满足 BOSS直聘和智联招聘两个平台均有可解析薪资样本的要求。"],
      keywordPremiums: [],
    },
    research: {
      dataWindow: hasBossScraperSamples ? "BOSS直聘 CDP 抓取 + 智联招聘公开搜索结果" : "BOSS直聘/智联招聘公开搜索结果",
      confidence: "低",
      confidenceReason: "当前 BOSS直聘或智联招聘的公开搜索结果不足，无法完成双平台交叉验证。",
      limitations: [
        "当前要求 BOSS直聘与智联招聘均存在可解析薪资样本。",
        hasBossScraperSamples
          ? "BOSS直聘已接入 boss-zhipin-scraper CDP 抓取；智联招聘仍使用公开搜索标题/摘要解析。"
          : "当前实现只使用公开搜索标题/摘要，不登录平台、不抓取需要权限的详情页。",
      ],
      triangulation: {
        requiredSources: 2,
        actualSources: searchEvidence?.distinctPlatforms.length ?? 0,
        passed: false,
        summary: message,
      },
      metricSources: {
        p25: message,
        p50: message,
        p75: message,
      },
      methodology: [
        hasBossScraperSamples
          ? "通过 boss-zhipin-scraper 连接本地已登录 Chrome CDP 抓取 BOSS直聘列表薪资。"
          : "检索 BOSS直聘公开搜索结果。",
        "检索智联招聘公开搜索结果。",
        "从搜索结果标题与摘要中解析月薪区间。",
        "未满足双平台均有可解析薪资样本时直接返回公开数据不足。",
      ],
      coreSources: searchEvidence?.distinctPlatforms.length ? formatSalaryCoreSources(searchEvidence.distinctPlatforms, hasBossScraperSamples) : [],
      validationSources: [],
      sampleNotes: searchEvidence?.samples.length
        ? [
            ...searchEvidence.sourceNotes.slice(0, 3),
            ...searchEvidence.samples.slice(0, 6).map((item) => `${item.platform}：${item.title}`),
          ]
        : [
            ...(searchEvidence?.sourceNotes || []).slice(0, 3),
            "未检索到满足条件的公开招聘平台样本。",
          ],
      evidence: (searchEvidence?.samples || []).slice(0, 8).map((item) => ({
        source: item.platform,
        role: item.title,
        region: filters.region,
        experience: filters.experience,
        salaryRange: item.salaryRange?.label || "未能稳定提取",
        publishWindow: item.publishWindow,
        note: `${item.snippet}（${item.link}）`,
      })),
      disclaimer: message,
    },
  };
}

function buildVirtualSalaryResearchJob(filters: SalaryFilters): Job {
  return {
    id: `salary_research_${Date.now()}`,
    title: filters.role,
    dept: filters.industry || "独立薪酬调研",
    location: filters.region,
    experience: filters.experience,
    level: "调研岗位",
	    salaryRange: "待调研",
	    keywords: `${filters.role}、${filters.industry}、${filters.education}`,
	    scoreWeights: defaultJobScoreWeights,
	    description: `这是一个独立的薪酬调研请求，目标岗位为${filters.role}，地区为${filters.region}，经验要求为${filters.experience}，行业为${filters.industry}，学历为${filters.education}。请仅基于公开招聘信息与公开报告完成市场薪酬研究。`,
    status: "招聘中",
    resumeCount: 0,
    salaryData: null,
    sortOrder: 0,
  };
}

function decodeHtml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function sanitizeKNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.round(value));
}

const regionMultipliers: Record<string, number> = {
  北京: 1.12,
  上海: 1.1,
  深圳: 1.06,
  广州: 1.01,
  杭州: 1.04,
  成都: 0.92,
  武汉: 0.89,
};

const experienceMultipliers: Record<string, number> = {
  无经验: 0.56,
  "1年以内": 0.65,
  "1-3年": 0.84,
  "3-5年": 1,
  "5-10年": 1.22,
  "10年以上": 1.45,
};

const industryMultipliers: Record<string, number> = {
  互联网: 1.12,
  "互联网/AI": 1.12,
  "消费品/零售": 0.94,
  制造业: 0.91,
  金融: 1.08,
  教育: 0.88,
  医疗健康: 1.03,
  企业服务: 1,
};

const educationMultipliers: Record<string, number> = {
  大专: 0.95,
  本科: 1,
  硕士: 1.08,
};

function inferJobFamily(job: Job) {
  const text = `${job.title} ${job.keywords} ${job.description}`;
  if (/前端|后端|开发|算法|测试|架构|工程师/i.test(text)) return "技术";
  if (/hr|招聘|人力|组织|人才|绩效/i.test(text)) return "人力资源";
  if (/运营|渠道|增长|社群|用户/i.test(text)) return "运营";
  if (/销售|商务|客户/i.test(text)) return "销售";
  return "通用职能";
}

function getBaseMarketSalary(jobFamily: string) {
  const base: Record<string, number> = {
    技术: 36,
    人力资源: 24,
    运营: 18,
    销售: 22,
    通用职能: 20,
  };
  return base[jobFamily] || 20;
}

function getKeywordPremium(keywords: string, description: string) {
  const text = `${keywords} ${description}`;
  const premiumRules = [
    { pattern: /架构|组件库|技术选型|工程化/i, boost: 0.08, reason: "岗位包含架构/工程化能力，市场通常给予更高报价。" },
    { pattern: /团队搭建|管理者|干部|组织诊断/i, boost: 0.06, reason: "岗位涉及组织与团队搭建，对复合能力要求更高。" },
    { pattern: /数据可视化|echarts|bi|增长/i, boost: 0.05, reason: "岗位带有数据分析或可视化要求，人才供给相对更窄。" },
    { pattern: /人才发展|绩效|od|招聘/i, boost: 0.04, reason: "岗位要求兼具招聘与组织发展能力，存在复合型溢价。" },
  ];

  const matched = premiumRules.filter((rule) => rule.pattern.test(text));
  return {
    anchorBoost: matched.reduce((sum, rule) => sum + rule.boost, 0),
    reasons: matched.map((rule) => rule.reason),
  };
}

await server.listen({ port, host: "0.0.0.0" });
server.log.info({ dbPath: getDatabasePath() }, "SQLite database ready");

function formatReportMonth(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}年${month}月`;
}

function formatBacktrackRecommendationDate(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}年${month}月${day}日`;
}

function findExistingCandidateInJob(sourceCandidate: Candidate, targetJobId: string) {
  const matchedCandidates = getCandidates(targetJobId).filter((candidate) => isSameCandidateResume(candidate, sourceCandidate));
  return matchedCandidates.sort((left, right) => getExistingCandidatePriority(right) - getExistingCandidatePriority(left))[0] || null;
}

function saveCandidatesWithDuplicateHandling(candidates: Candidate[], jobId: string, duplicateAction: "skip" | "overwrite") {
  const newCandidates: Candidate[] = [];
  candidates.forEach((candidate) => {
    const existingCandidate = findExistingCandidateInJob(candidate, jobId);
    if (!existingCandidate) {
      newCandidates.push(candidate);
      return;
    }
    if (duplicateAction === "overwrite") {
      updateCandidate(mergeCandidateResumeOverwrite(existingCandidate, candidate));
    }
  });
  if (newCandidates.length) insertCandidates(newCandidates);
}

function mergeCandidateResumeOverwrite(existingCandidate: Candidate, incomingCandidate: Candidate): Candidate {
  return {
    ...existingCandidate,
    name: incomingCandidate.name || existingCandidate.name,
    source: incomingCandidate.source || existingCandidate.source,
    score: incomingCandidate.score,
    conclusion: incomingCandidate.conclusion || existingCandidate.conclusion,
    reason: incomingCandidate.reason || existingCandidate.reason,
    remark: incomingCandidate.remark || existingCandidate.remark,
    resumeText: incomingCandidate.resumeText || existingCandidate.resumeText,
    uploadTime: incomingCandidate.uploadTime || existingCandidate.uploadTime,
    fileName: incomingCandidate.fileName ?? existingCandidate.fileName,
    fileType: incomingCandidate.fileType ?? existingCandidate.fileType,
    fileSize: incomingCandidate.fileSize ?? existingCandidate.fileSize,
    fileDataBase64: incomingCandidate.fileDataBase64 ?? existingCandidate.fileDataBase64,
    fileObjectKey: incomingCandidate.fileObjectKey ?? existingCandidate.fileObjectKey,
    fileUrl: incomingCandidate.fileUrl ?? existingCandidate.fileUrl,
    evaluation: incomingCandidate.evaluation || existingCandidate.evaluation,
    interviewPlan: incomingCandidate.interviewPlan || existingCandidate.interviewPlan,
    keyPointAnalysis: incomingCandidate.keyPointAnalysis?.length ? incomingCandidate.keyPointAnalysis : existingCandidate.keyPointAnalysis,
    interviewQuestions: incomingCandidate.interviewQuestions?.length ? incomingCandidate.interviewQuestions : existingCandidate.interviewQuestions,
  };
}

function isSameCandidateResume(candidate: Candidate, sourceCandidate: Candidate) {
  if (candidate.id === sourceCandidate.id) return true;
  if (candidate.fileObjectKey && sourceCandidate.fileObjectKey && candidate.fileObjectKey === sourceCandidate.fileObjectKey) return true;
  if (candidate.fileUrl && sourceCandidate.fileUrl && candidate.fileUrl === sourceCandidate.fileUrl) return true;

  const sameName = normalizeCandidateIdentityText(candidate.name) === normalizeCandidateIdentityText(sourceCandidate.name);
  if (!sameName) return false;

  const candidateResumeText = normalizeCandidateIdentityText(candidate.resumeText);
  const sourceResumeText = normalizeCandidateIdentityText(sourceCandidate.resumeText);
  if (candidateResumeText && sourceResumeText && candidateResumeText === sourceResumeText) return true;

  const candidateFileName = normalizeCandidateIdentityText(candidate.fileName || "");
  const sourceFileName = normalizeCandidateIdentityText(sourceCandidate.fileName || "");
  if (candidateFileName && sourceFileName && candidateFileName === sourceFileName && candidate.fileSize && sourceCandidate.fileSize && candidate.fileSize === sourceCandidate.fileSize) {
    return true;
  }

  const candidateContacts = extractCandidateIdentityContacts(candidate.resumeText);
  const sourceContacts = extractCandidateIdentityContacts(sourceCandidate.resumeText);
  if (candidateContacts.length && sourceContacts.length) {
    return candidateContacts.some((contact) => sourceContacts.includes(contact));
  }

  return sameName;
}

function getExistingCandidatePriority(candidate: Candidate) {
  let priority = 0;
  if (!candidate.source.startsWith("人才库回溯")) priority += 30;
  if (candidate.isInTalentPool) priority += 12;
  if (candidate.interviewStage && candidate.interviewStage !== "推荐") priority += 10;
  if (candidate.conclusion !== "待筛选") priority += 6;
  if (candidate.fileObjectKey || candidate.fileUrl) priority += 4;
  if (candidate.evaluation?.summary || candidate.keyPointAnalysis?.length) priority += 3;
  return priority;
}

function normalizeCandidateIdentityText(value: string) {
  return value.replace(/\s+/g, "").trim().toLowerCase();
}

function extractCandidateIdentityContacts(text: string) {
  const phoneMatches = text.match(/1[3-9]\d{9}/g) || [];
  const emailMatches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return Array.from(new Set([...phoneMatches, ...emailMatches].map((item) => item.toLowerCase())));
}
