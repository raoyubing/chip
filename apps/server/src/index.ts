import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import Fastify from "fastify";
import { nanoid } from "nanoid";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { createCandidate } from "./analyzer.js";
import {
  closeJob,
  deleteCandidate,
  deleteJob,
  getCandidateById,
  getCandidates,
  getJob,
  getJobs,
  getState,
  initDb,
  insertCandidates,
  prioritizeJob,
  resetDatabase,
  setSetting,
  updateCandidate,
  upsertJob,
} from "./db.js";
import type { Candidate, Job, SalaryData, SalaryFilters } from "./types.js";

const server = Fastify({ logger: true });
const port = Number(process.env.PORT || 5174);

loadLocalEnv();

const deepseekApiKey = process.env.DEEPSEEK_API_KEY || "";
const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const deepseekModel = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";

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
  region: z.string().min(1),
  experience: z.string().min(1),
  industry: z.string().min(1),
  education: z.string().min(1),
});

const jobCopilotSchema = jobSchema.extend({
  useCase: z.enum(["jd-optimize", "interview-questions"]).default("jd-optimize"),
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

  const candidates = buildCandidatesFromResumeInput(job, body);
  insertCandidates(candidates);
  setSetting("currentJobId", job.id);
  return { candidates, state: getState() };
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
  const salaryData = generateSalaryData(job, filters);
  upsertJob({ ...job, salaryData });
  return { salaryData, state: getState() };
});

server.post("/api/job-copilot", async (request) => {
  const body = jobCopilotSchema.parse(request.body);
  if (!deepseekApiKey) {
    throw server.httpErrors.badRequest("未配置 DEEPSEEK_API_KEY，请先在 apps/server/.env.local 中配置。");
  }

  const result = await generateJobCopilot(body);
  return result;
});

function buildCandidatesFromResumeInput(
  job: Job,
  input: z.infer<typeof resumeSchema>,
): Candidate[] {
  const source = input.source || "本地上传";
  if (input.files.length) {
    return input.files.map((file) => {
      const fileNameWithoutExt = file.name.replace(/\.[^.]+$/, "");
      const textParts = [file.text, input.resumeText].filter(Boolean);
      const resumeText = textParts.length
        ? textParts.join("\n\n--- 补充文本 ---\n")
        : `文件名：${file.name}\n文件类型：${file.type || "未知"}\n文件大小：${Math.max(1, Math.round((file.size || 0) / 1024))}KB\n离线预览：当前未提取该文件正文，请在面试前核验原始文件。`;
      return createCandidate({
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
    });
  }

  return [
    createCandidate({
      id: `c_${Date.now()}_${nanoid(6)}`,
      job,
      name: input.name,
      source,
      resumeText: input.resumeText,
    }),
  ];
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
          content: "你是一位资深招聘业务顾问和企业HRBP，擅长将职位信息整理成清晰、可落地、适合中国招聘场景的输出。请严格输出 JSON，不要输出 markdown 代码块，不要输出多余解释。",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.6,
      response_format: {
        type: "json_object",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    requestLog("deepseek_error", { status: response.status, text });
    throw server.httpErrors.badGateway(`DeepSeek 请求失败：${response.status}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw server.httpErrors.badGateway("DeepSeek 未返回有效内容");

  const parsed = safeJsonParse(content);
  const schema = z.object({
    recommendedTitle: z.string().default(""),
    optimizedDescription: z.string().default(""),
    actionSuggestions: z.array(z.string()).default([]),
    interviewQuestions: z.array(z.object({
      title: z.string(),
      text: z.string(),
      probe: z.string(),
    })).default([]),
  });
  return schema.parse(parsed);
}

function buildJobCopilotPrompt(job: z.infer<typeof jobCopilotSchema>) {
  const baseContext = [
    `请基于以下职位信息生成招聘辅助内容。`,
    `输出字段必须严格为 JSON 对象，包含：recommendedTitle(string), optimizedDescription(string), actionSuggestions(string[]), interviewQuestions([{title,text,probe}])。`,
    `通用要求：`,
    `1. 语言必须为中文。`,
    `2. 不要输出 markdown，不要输出多余字段，不要输出解释性前后缀。`,
    `3. 如果信息不足，仍要基于已有信息完成专业、合理、可用的输出。`,
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
      `其中 optimizedDescription 必须是一份可直接用于职位描述覆盖的“专业岗位 JD 正文”，必须严格遵守以下规则：`,
      `1. 必须使用正式、专业、企业化书面表达，禁止使用“我们正在寻找”“你将负责”“加入我们”等口语化或招聘广告式写法。`,
      `2. 不要写成一整段大白话，必须按标准 JD 结构输出，并保留清晰换行。`,
      `3. optimizedDescription 必须严格按以下顺序组织：`,
      `岗位概述：`,
      `岗位职责：`,
      `任职要求：`,
      `优先条件：`,
      `4. “岗位职责”“任职要求”“优先条件”下均需使用阿拉伯数字编号分点，如 1. 2. 3. 。`,
      `5. “岗位概述”需为 1 段正式概述，不超过 2 句话；其余模块必须是条目式表达。`,
      `6. 内容必须和岗位级别、经验要求、关键词、当前职责一致，强调真实招聘场景，不要空泛。`,
      `7. recommendedTitle 需输出规范、专业、可发布的岗位名称，不要营销化修饰。`,
      `8. actionSuggestions 输出 3-5 条，聚焦招聘动作建议，如渠道、筛选重点、画像校准。`,
      `9. interviewQuestions 输出 5 条，每条都必须贴近该岗位职责与考核重点，并包含 title、text、probe。`,
    ].join("\n");
  }

  return [
    ...baseContext,
    ``,
    `当前任务重点是生成推荐面试问题。`,
    `1. optimizedDescription 仍需返回一版专业、简洁的标准 JD 正文，结构同样使用“岗位概述 / 岗位职责 / 任职要求 / 优先条件”。`,
    `2. interviewQuestions 输出 5 条，必须贴近岗位关键词、经验要求、职责描述，并包含 title、text、probe。`,
    `3. 问题要体现结构化面试思路，避免空泛问法。`,
    `4. actionSuggestions 输出 3-5 条，聚焦招聘筛选与面试推进建议。`,
    `5. recommendedTitle 需输出规范、专业、可发布的岗位名称。`,
  ].join("\n");
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

function generateSalaryData(job: Job, filters: SalaryFilters): SalaryData {
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
      { title: "建议锚点", text: `${filters.region}${job.title} 当前建议以 ${anchor}k 作为沟通锚点，常规可控制在 ${suggestedLow}-${suggestedHigh}k。` },
      { title: "预算风险", text: `若预算低于 ${p25}k，当前 ${filters.experience}、${filters.industry} 条件下，优质候选人的转化率会明显下滑。` },
      { title: "竞争提醒", text: `${filters.education}、${filters.industry} 对该岗位存在一定溢价影响，建议结合岗位稀缺关键词预留弹性。` },
    ],
    advice: {
      summary: `${job.title} 在 ${filters.region}、${filters.experience}、${filters.industry}、${filters.education} 条件下，市场中位值约为 ${p50}k，结合岗位职责与关键词后，建议报价区间为 ${suggestedLow}-${suggestedHigh}k。`,
      reasons: [
        `地区系数 ${regionMultiplier.toFixed(2)}：${filters.region} 对同岗位薪酬有明确拉升或回落影响。`,
        `经验系数 ${experienceMultiplier.toFixed(2)}：${filters.experience} 直接决定市场对岗位成熟度的定价。`,
        `行业系数 ${industryMultiplier.toFixed(2)}：${filters.industry} 行业对招聘竞争度和薪酬水平影响明显。`,
        `学历系数 ${educationMultiplier.toFixed(2)}：${filters.education} 会影响候选人池质量预期和报价空间。`,
      ],
      keywordPremiums: keywordPremium.reasons,
    },
  };
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

function formatReportMonth(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}年${month}月`;
}
