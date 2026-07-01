import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import Fastify from "fastify";
import { nanoid } from "nanoid";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import wavefile from "wavefile";
import { z } from "zod";
import { createCandidate, normalizeKeywords } from "./analyzer.js";
import { extractResumeTextFromFile } from "./resume-parser.js";
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
  resetDatabase,
  setSetting,
  updateCandidate,
  updateVoiceTranscriptSegmentAnalysis,
  upsertJob,
} from "./db.js";
import type { Candidate, CandidateEvaluation, CandidateInterviewPlan, InterviewMethodKey, Job, SalaryData, SalaryFilters, VoiceAnalysis, VoiceFinalEvaluation, VoiceRecruiterCoachReport, VoiceTranscriptResult, VoiceTranscriptSegment } from "./types.js";

const server = Fastify({
  logger: true,
  bodyLimit: Number(process.env.BODY_LIMIT_BYTES || 20 * 1024 * 1024),
});
const port = Number(process.env.PORT || 5175);

loadLocalEnv();

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const deepseekTimeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 18000);
const deepseekResumeTimeoutMs = Number(process.env.DEEPSEEK_RESUME_TIMEOUT_MS || 9000);
const resumeExtractTimeoutMs = Number(process.env.RESUME_EXTRACT_TIMEOUT_MS || 12000);
const whisperModelId = process.env.WHISPER_MODEL_ID || "Xenova/whisper-tiny";
const whisperTargetLanguage = process.env.WHISPER_LANGUAGE || "zh";
const whisperChunkLength = Number(process.env.WHISPER_CHUNK_LENGTH || 20);
const whisperStrideLength = Number(process.env.WHISPER_STRIDE_LENGTH || 4);

await server.register(cors, { origin: true });
await server.register(sensible);
await initDb();

const jobSchema = z.object({
  title: z.string().min(1),
  dept: z.string().min(1),
  location: z.string().min(1),
  experience: z.string().min(1),
  level: z.string().min(1),
  salaryRange: z.string().min(1),
  keywords: z.string().min(1),
  description: z.string().min(1),
  status: z.enum(["招聘中", "暂停", "已关闭"]),
});

const resumeSchema = z.object({
  name: z.string().optional().default(""),
  source: z.string().optional().default("本地上传"),
  resumeText: z.string().optional().default(""),
  files: z
    .array(
      z.object({
        name: z.string(),
        type: z.string().optional().nullable(),
        size: z.number().optional().nullable(),
        text: z.string().optional().default(""),
        dataBase64: z.string().optional().nullable(),
      }),
    )
    .optional()
    .default([]),
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

server.get("/api/state", async () => getState());

server.post("/api/reset", async () => {
  resetDatabase();
  return getState();
});

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
  if (!body.resumeText && body.files.length === 0) throw server.httpErrors.badRequest("请提供简历文本或文件");
  if (!body.files.length && !body.name) throw server.httpErrors.badRequest("文本录入请填写候选人姓名");

  const candidates = await buildCandidatesFromResumeInput(job, body);
  insertCandidates(candidates);
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
    interviewStage: "初试",
    stageRecommendation: "是",
    interviewResult: "待定",
    reportMonth: candidate.reportMonth || formatReportMonth(),
    interviewTimeline: {
      ...(candidate.interviewTimeline || {}),
      recommendedAt: candidate.interviewTimeline?.recommendedAt || formatDateStamp(),
    },
  });
  return getState();
});

server.patch("/api/candidates/:id/interview-stage", async (request) => {
  const params = z.object({ id: z.string() }).parse(request.params);
  const body = z.object({
    interviewStage: z.enum(["初试", "复试", "offer"]),
    stageRecommendation: z.enum(["是", "否"]).default("是"),
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
  const reasonTags = normalizeReasonTags(body.reasonTags.length ? body.reasonTags : inferReasonTags(body.interviewReason, body.interviewStage, body.onboarded), body.interviewStage, body.onboarded);
  const timeline = mergeInterviewTimeline(candidate, body);
  updateCandidate({
    ...candidate,
    interviewStage: body.interviewStage,
    stageRecommendation: body.stageRecommendation,
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
  const normalizedTranscript = await normalizeVoiceTranscript(transcript);
  return {
    transcript,
    normalizedTranscript,
  } satisfies VoiceTranscriptResult;
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
    throw server.httpErrors.badRequest("未配置 DEEPSEEK_API_KEY，请先在 apps/server/.env.local 中配置。");
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

async function buildCandidatesFromResumeInput(
  job: Job,
  input: z.infer<typeof resumeSchema>,
): Promise<Candidate[]> {
  const source = input.source || "本地上传";
  if (input.files.length) {
    const built: Candidate[] = [];
    for (const file of input.files) {
      const fileNameWithoutExt = file.name.replace(/\.[^.]+$/, "");
      const extracted = await extractResumeTextSafely(file);
      const mergedText = buildResumeDraftText(extracted.text, input.resumeText);
      const normalizedResumeText = mergedText
        || `文件名：${file.name}\n文件类型：${file.type || "未知"}\n文件大小：${Math.max(1, Math.round((file.size || 0) / 1024))}KB\n系统未成功提取正文，请核验原始附件。`;
      const resumeText = shouldUseDeepSeekResumeCleanup(extracted.method, normalizedResumeText)
        ? await enrichResumeTextWithDeepSeek({
          fileName: file.name,
          fileType: file.type || "未知格式",
          resumeText: normalizedResumeText,
        })
        : normalizedResumeText;
      const candidate = createCandidate({
        id: `c_${Date.now()}_${nanoid(6)}`,
        job,
        name: input.name || inferCandidateName(fileNameWithoutExt),
        source: `${source} · ${file.name}`,
        resumeText,
        fileName: file.name,
        fileType: file.type || "未知格式",
        fileSize: file.size || 0,
        fileDataBase64: file.dataBase64 || null,
      });
      built.push(await enrichCandidateAssessmentWithDeepSeek(candidate, job));
    }
    return built;
  }

  const baseResumeText = buildResumeDraftText("", input.resumeText);
  const resumeText = shouldUseDeepSeekResumeCleanup("text", baseResumeText)
    ? await enrichResumeTextWithDeepSeek({
      fileName: input.name || "文本录入",
      fileType: "text/plain",
      resumeText: baseResumeText,
    })
    : baseResumeText;
  const candidate = createCandidate({
    id: `c_${Date.now()}_${nanoid(6)}`,
    job,
    name: input.name,
    source,
    resumeText,
  });
  return [
    await enrichCandidateAssessmentWithDeepSeek(candidate, job),
  ];
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

async function extractResumeTextSafely(file: z.infer<typeof resumeSchema>["files"][number]) {
  const fallbackText = buildResumeDraftText(file.text || "", "");
  try {
    return await withTimeout(
      extractResumeTextFromFile(file),
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

function inferCandidateName(fileName: string) {
  return (
    fileName
      .replace(/简历|个人|求职|resume|cv/gi, "")
      .replace(/[\-_（）()\[\]【】]+/g, " ")
      .trim()
      .split(/\s+/)[0] ||
    fileName ||
    "未命名候选人"
  );
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
    "JSON 字段必须包含：score(number), summary(string), strengths(string[]), weaknesses(string[]), risks(string[]), interviewFocuses(string[]).",
    "要求：",
    "1. score 为 0-100 分的综合匹配度评分。",
    "2. summary 为 100 字以内的 AI 总结。",
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
  const prompt = [
    "你是一名严谨的招聘面试设计专家，负责为候选人制定科学的面试方案。",
    "",
    "【岗位信息】",
    `- 职位名称：${job.title}`,
    `- 关键词：${job.keywords}`,
    `- 职位描述：${job.description}`,
    "",
    "【候选人信息】",
    `- 姓名：${candidate.name}`,
    `- 简历摘要：${summary}`,
    `- 匹配度评分：${candidate.score}`,
    `- 已命中关键点：${matched.length ? matched.join("、") : "暂无明确命中"}`,
    `- 未命中关键点：${missed.length ? missed.join("、") : "暂无明显缺口"}`,
    "",
    "【核心任务】",
    "请根据以上信息，完成以下四项输出：",
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
    "二、针对性面试问题（3-5个）",
    "请围绕【未命中关键点】和【风险点】，设计 3-5 个适配推荐方法的深度面试问题。",
    "每个问题必须包含：title, question, competency, questionType(行为型/情景型/认知型), designIntent, strongSignals(string[]), warningSignals(string[]), followUps(string[])。",
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
    "",
    "请严格输出 JSON，不要输出 markdown，不要输出额外解释。",
    "JSON 顶层字段必须为：recommendedMethods, summaryReason, questions, evaluationGuide, riskReview。",
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
      recommendedMethods: z.array(z.object({
        methodKey: z.enum(["structured", "behavioral", "star", "scenario", "case"]),
        label: z.string().min(1),
        reason: z.string().min(1),
      })).min(1).max(3),
      summaryReason: z.string().default(""),
      questions: z.array(z.object({
        title: z.string().min(1),
        question: z.string().min(1),
        competency: z.string().min(1),
        questionType: z.enum(["行为型", "情景型", "认知型"]),
        designIntent: z.string().min(1),
        strongSignals: z.array(z.string()).default([]),
        warningSignals: z.array(z.string()).default([]),
        followUps: z.array(z.string()).default([]),
        methodKey: z.enum(["structured", "behavioral", "star", "scenario", "case"]).optional(),
      })).min(3).max(5),
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
        designIntent: item.designIntent.trim(),
        strongSignals: item.strongSignals.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        warningSignals: item.warningSignals.map((text) => text.trim()).filter(Boolean).slice(0, 3),
        followUps: item.followUps.map((text) => text.trim()).filter(Boolean).slice(0, 3),
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

function buildFallbackInterviewPlan(candidate: Candidate, job: Job): CandidateInterviewPlan {
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched).map((item) => item.keyword);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched).map((item) => item.keyword);
  const methodKeys = inferInterviewMethodCombo(candidate, job, missed.length);
  const recommendedMethods = methodKeys.map((methodKey) => ({
    methodKey,
    label: interviewMethodLabelMap[methodKey],
    reason: buildInterviewMethodReason(methodKey, candidate, job, missed, matched),
  }));
  const focusAreas = (missed.length ? missed : candidate.evaluation?.interviewFocuses?.length ? candidate.evaluation.interviewFocuses : matched).slice(0, 4);
  const questions = focusAreas.slice(0, 4).map((focus, index) => ({
    title: `问题${index + 1}`,
    question: `请结合你过往最有代表性的经历，详细说明你在“${focus}”上的实际场景、关键动作、结果以及你的个人贡献。`,
    competency: focus,
    questionType: (methodKeys.includes("scenario") && index === focusAreas.length - 1 ? "情景型" : "行为型") as "行为型" | "情景型" | "认知型",
    designIntent: `简历中关于“${focus}”的证据仍不完整，需要通过具体案例验证真实能力边界与可迁移性。`,
    strongSignals: ["能清晰拆解背景、动作与结果", "能说明个人贡献而非团队泛化表述", "结果可量化或可被追溯验证"],
    warningSignals: ["回答停留在概念层，缺少具体案例", "无法说明本人到底做了什么", "结果描述模糊，无法提供可验证证据"],
    followUps: [`请补充你在“${focus}”中亲自负责的部分。`, "如果重做一次，你会保留什么、调整什么？", "最终结果如何衡量，谁能验证这一结果？"],
    methodKey: methodKeys[0],
  }));

  return {
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
    },
    keyPointAnalysis,
  } satisfies Candidate;
}

function buildFallbackCandidateEvaluation(candidate: Candidate, job: Job) {
  const keywords = normalizeKeywords(job.keywords);
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched).map((item) => item.keyword);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched).map((item) => item.keyword);
  return {
    score: candidate.score,
    summary: candidate.reason,
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
  };
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
  const audio = await decodeAudioTo16kMono(audioBase64, mimeType, fileName);
  const transcriber = await getWhisperTranscriber();
  if (!transcriber) {
    throw server.httpErrors.serviceUnavailable("本地语音转写模型初始化失败，请稍后再试。");
  }

  try {
    const result = await transcriber(audio, {
      chunk_length_s: whisperChunkLength,
      stride_length_s: whisperStrideLength,
      language: whisperTargetLanguage,
      task: "transcribe",
      return_timestamps: false,
    }) as { text?: string };
    return (result.text || "").replace(/\s+/g, " ").trim();
  } catch (error) {
    requestLog("voice_transcribe_error", {
      message: error instanceof Error ? error.message : String(error),
      mimeType,
      fileName,
    });
    throw server.httpErrors.badGateway("本地语音转写失败，请稍后重试。");
  }
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
    }).then((instance) => instance as unknown as WhisperTranscriber).catch((error) => {
      whisperPipelinePromise = null;
      requestLog("whisper_pipeline_init_error", {
        message: error instanceof Error ? error.message : String(error),
        model: whisperModelId,
      });
      return null;
    });
  }
  return whisperPipelinePromise;
}

async function getTransformersModule() {
  if (!transformersModulePromise) {
    transformersModulePromise = import("@huggingface/transformers").then((module) => {
      module.env.allowLocalModels = false;
      module.env.useBrowserCache = false;
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

async function decodeAudioTo16kMono(audioBase64: string, mimeType: string, fileName: string) {
  const inputBuffer = Buffer.from(audioBase64, "base64");
  const wavBuffer = await convertAudioToWavBuffer(inputBuffer, mimeType, fileName);
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
  const outputPath = `${tempBase}.wav`;
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
    throw server.httpErrors.badRequest("录音转码失败，当前 ffmpeg 组件不可用。请稍后重试或联系我继续排查。");
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

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
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

function mergeInterviewTimeline(
  candidate: Candidate,
  body: {
    interviewStage: NonNullable<Candidate["interviewStage"]>;
    interviewResult: NonNullable<Candidate["interviewResult"]>;
    onboarded: NonNullable<Candidate["onboarded"]>;
    interviewTimeline: Candidate["interviewTimeline"];
  },
) {
  const stamp = formatDateStamp();
  const current = candidate.interviewTimeline || {};
  const next = { ...current, ...(body.interviewTimeline || {}) };

  if (!next.recommendedAt && (candidate.interviewTimeline?.recommendedAt || candidate.interviewStage || candidate.stageRecommendation === "是")) {
    next.recommendedAt = candidate.interviewTimeline?.recommendedAt || stamp;
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
  if (body.onboarded !== "是" && next.onboardedAt && body.interviewStage !== "offer") {
    delete next.onboardedAt;
  }
  return next;
}

function normalizeReasonTags(tags: string[], stage: NonNullable<Candidate["interviewStage"]> = "初试", onboarded?: Candidate["onboarded"]) {
  const options = getReasonTagOptions(stage);
  const mapped = tags.map((item) => mapReasonTagByStage(item, stage, onboarded));
  if (stage === "offer" && onboarded === "待入职" && !mapped.includes("待入职")) {
    mapped.unshift("待入职");
  }
  return Array.from(new Set(mapped.filter((item): item is string => {
    if (!item) return false;
    return options.includes(item);
  }))).slice(0, 6);
}

function inferReasonTags(reason: string, stage: NonNullable<Candidate["interviewStage"]> = "初试", onboarded?: Candidate["onboarded"]) {
  const source = reason.trim();
  if (!source) return [];
  if (stage === "offer") {
    const matched: string[] = [];
    if (/薪资|工资|预算|福利|社保|公积金|补贴/.test(source)) matched.push("薪资福利");
    if (/其他offer|别家|他家|对比offer|接到.*offer/.test(source)) matched.push("接到其他offer");
    if (/身体|家庭|家里|照顾|生病|怀孕/.test(source)) matched.push("身体/家庭原因");
    if (/岗位调整|编制调整|hc调整|职位调整/.test(source)) matched.push("岗位调整");
    if (/待入职|到岗中|入职中|未到入职日/.test(source) || onboarded === "待入职") matched.push("待入职");
    if (!matched.length && source) matched.push("其他");
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
  if (value === "薪资不匹配") return "薪资福利";
  if (value === "offer流失") return "接到其他offer";
  if (value === "待入职" || onboarded === "待入职") return "待入职";
  return null;
}

const generalReasonTagOptions = ["薪资不匹配", "稳定性风险", "技能不符", "未到面", "offer流失", "求职动机不足", "通勤地点受限", "管理经验不足", "沟通表达一般"];
const offerReasonTagOptions = ["薪资福利", "接到其他offer", "身体/家庭原因", "岗位调整", "待入职", "其他"];
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

async function generateSalaryData(job: Job, filters: SalaryFilters): Promise<SalaryData> {
  return generateLocalSalaryData(job, filters);
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
            "你必须扮演数据聚合器：你的任务是汇总和分析 BOSS直聘、猎聘、前程无忧、智联招聘等网站上的公开信息，而不是创作数据。",
            "必须执行三角验证：不能只听信单一来源，请至少参考三个不同招聘网站的数据，交叉验证后再给出最终区间。",
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
        requiredSources: z.number().int().min(3).max(10),
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
  const passedTriangulation = normalizedActualSources >= Math.max(3, result.research.triangulation.requiredSources);
  if (normalizedActualSources < 3 || !passedTriangulation) {
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
    "0. 你必须主动使用我提供的搜索样本，对 BOSS直聘 / 智联 / 猎聘 / 前程无忧 等公开招聘网站结果做整理分析，而不是凭空创作数据。",
    "1. 优先并主要参考国内主流招聘网站（如 BOSS直聘、猎聘、前程无忧、智联招聘等）近3-6个月内相似岗位的招聘信息。",
    "2. 可结合公开薪酬报告、人力资源咨询公司报告（如美世、太和顾问等）做交叉验证。",
    "3. 你必须扮演“数据聚合器”，只允许汇总公开信息和推理，不允许创作或编造数据。",
    "4. 必须执行三角验证：至少参考三个不同招聘网站的数据，通过交叉验证后给出最终区间；只有数值落在交叉重叠区间内，才可以作为依据；若做不到，必须直接返回公开数据不足。",
    "5. 严禁编造数据：所有数值都必须有明确来源依据或推理逻辑，尤其是 P25 / P50 / P75。",
    "6. 输出必须严格为 JSON 对象，不要 markdown，不要解释。",
    "7. 所有金额单位统一为税前月薪整数 k（例如 25 表示 25k/月）。",
    "8. 如果搜不到足够的有效数据（少于3个独立来源），请直接输出“当前公开数据不足，无法生成高置信度报告”，绝对禁止使用本地模型或内部系数进行填补。",
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
    "搜索样本（先以这些公开搜索结果为基础，再做归纳；如果这些样本仍不足 3 个独立来源，则必须失败返回）：",
    ...searchEvidence.samples.map((sample, index) => `${index + 1}. [${sample.platform}] ${sample.title} | ${sample.link} | ${sample.snippet} | ${sample.publishWindow}`),
    "",
    "输出规则补充：",
    "1. experienceBands 请至少覆盖：无经验、1年以内、1-3年、3-5年、5-10年、10年以上。",
    `2. regionComparison 必须包含当前地区 ${filters.region}，并补充至少 2-4 个同类招聘活跃城市做比较。`,
    "3. educationComparison 请至少包含：大专、本科、硕士。",
    `4. industryComparison 必须包含当前行业 ${filters.industry}，并补充至少 3 个相近行业。`,
    "5. evidence 中请列出 4-8 条具有代表性的样本归纳，每条要写清来源平台、岗位、地区、经验、薪资区间、时间窗口和备注。",
    "6. metricSources.p25 / metricSources.p50 / metricSources.p75 必须分别写明来源标注格式，例如：P50(37K)：综合参考 BOSS 直聘 20 个相关岗位（月薪30-45K）和猎聘 15 个相关岗位（月薪32-48K）的区间，交叉验证后取中位参考值。",
    "7. research.triangulation 必须反映是否真的满足至少三个不同招聘网站交叉验证；未满足时 passed 必须为 false。",
    "8. advice.summary 要能直接给招聘者看；reasons 要解释为什么建议这个区间；keywordPremiums 要解释 JD 中哪些要求带来了溢价。",
    "9. limitations 必须如实写明数据不足、行业口径差异、城市样本不足、发布时间差异等局限性。",
  ].join("\n");
}

async function collectSalarySearchEvidence(job: Job, filters: SalaryFilters) {
  const platforms = [
    { name: "BOSS直聘", domain: "zhipin.com" },
    { name: "猎聘", domain: "liepin.com" },
    { name: "智联招聘", domain: "zhaopin.com" },
    { name: "前程无忧", domain: "51job.com" },
  ];
  const queryBase = `${filters.region} ${filters.role} ${filters.industry} ${filters.experience} ${filters.education} 招聘 薪资`;
  const samples: Array<{ platform: string; domain: string; title: string; link: string; snippet: string; publishWindow: string }> = [];

  await Promise.all(platforms.map(async (platform) => {
    const rssUrl = `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(`site:${platform.domain} ${queryBase}`)}`;
    try {
      const response = await fetch(rssUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0",
        },
      });
      const xml = await response.text();
      const matches = Array.from(xml.matchAll(/<item><title>(.*?)<\/title><link>(.*?)<\/link><description>(.*?)<\/description><pubDate>(.*?)<\/pubDate><\/item>/g));
      const platformItems = matches
        .map((item) => ({
          title: decodeHtml(item[1]),
          link: decodeHtml(item[2]),
          snippet: decodeHtml(item[3]).replace(/<[^>]+>/g, "").trim(),
          publishWindow: decodeHtml(item[4]),
        }))
        .filter((item) => item.link.includes(platform.domain))
        .slice(0, 4);
      platformItems.forEach((item) => {
        samples.push({
          platform: platform.name,
          domain: platform.domain,
          ...item,
        });
      });
    } catch (error) {
      requestLog("salary_search_collect_error", {
        platform: platform.name,
        domain: platform.domain,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  const distinctPlatforms = Array.from(new Set(samples.map((item) => item.platform)));
  return {
    queryBase,
    samples,
    distinctPlatforms,
  };
}

function buildInsufficientSalaryData(
  job: Job,
  filters: SalaryFilters,
  message: string,
  searchEvidence?: Awaited<ReturnType<typeof collectSalarySearchEvidence>>,
): SalaryData {
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
      reasons: ["当前未满足至少 3 个独立招聘平台的公开样本要求。"],
      keywordPremiums: [],
    },
    research: {
      dataWindow: "近3个月公开搜索",
      confidence: "低",
      confidenceReason: "当前公开招聘网站检索结果不足，无法完成三角验证。",
      limitations: [
        "少于 3 个独立来源时，不允许生成高置信度薪酬区间。",
        "当前实现不会用非公开样本去填补公开样本空缺。",
      ],
      triangulation: {
        requiredSources: 3,
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
        "分别检索 BOSS直聘、猎聘、智联招聘、前程无忧等公开搜索结果。",
        "要求至少 3 个独立招聘网站存在近 3 个月有效岗位样本。",
        "未满足时直接返回公开数据不足，不进行替代性填补。",
      ],
      coreSources: searchEvidence?.distinctPlatforms.length ? searchEvidence.distinctPlatforms : [],
      validationSources: [],
      sampleNotes: searchEvidence?.samples.length
        ? searchEvidence.samples.slice(0, 6).map((item) => `${item.platform}：${item.title}`)
        : ["未检索到满足条件的公开招聘平台样本。"],
      evidence: (searchEvidence?.samples || []).slice(0, 8).map((item) => ({
        source: item.platform,
        role: item.title,
        region: filters.region,
        experience: filters.experience,
        salaryRange: "未能稳定提取",
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
