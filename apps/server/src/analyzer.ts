import type { Candidate, Job } from "./types.js";

export function normalizeKeywords(keywords = "") {
  return keywords
    .split(/[、,，;；\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

export function evaluateResume(text: string, job: Job) {
  const normalizedText = text || "";
  const keyPoints = normalizeKeywords(job.keywords).length ? normalizeKeywords(job.keywords) : [job.title, job.level, job.experience].filter(Boolean);
  const matched = keyPoints.filter((keyword) => normalizedText.includes(keyword));
  const baseScore = 54 + matched.length * 9;
  const seniorityBonus = /主导|负责|搭建|管理|优化|架构|推动|落地|复盘|协同/.test(normalizedText) ? 8 : 0;
  const documentBonus = /文件名：|文件类型：/.test(normalizedText) ? 2 : 0;
  const lengthBonus = Math.min(10, Math.floor(normalizedText.length / 80));
  const score = Math.min(96, Number((baseScore + seniorityBonus + documentBonus + lengthBonus + Math.random() * 5).toFixed(1)));
  const conclusion = score >= 85 ? "强烈推荐" : score >= 70 ? "推荐面试" : score >= 60 ? "备选" : "暂不推荐";
  const keyPointAnalysis = buildKeyPointAnalysis(keyPoints, normalizedText, job);
  const interviewQuestions = buildPersonalInterviewQuestions(keyPointAnalysis, job, conclusion);
  const reason = matched.length
    ? `简历命中 ${matched.join("、")} 等核心考核点，结合 ${job.title} 的职责要求，系统给出“${conclusion}”。`
    : `简历未明显覆盖 ${job.keywords} 等核心考核点，建议结合原始附件补充核验后再推进。`;
  return { score, conclusion, reason, keyPointAnalysis, interviewQuestions };
}

export function createCandidate(input: {
  id: string;
  job: Job;
  name: string;
  source: string;
  resumeText: string;
  fileName?: string | null;
  fileType?: string | null;
  fileSize?: number | null;
  fileDataBase64?: string | null;
}): Candidate {
  const result = evaluateResume(input.resumeText, input.job);
  return {
    id: input.id,
    jobId: input.job.id,
    name: input.name,
    source: input.source,
    score: result.score,
    conclusion: result.conclusion,
    reason: result.reason,
    resumeText: input.resumeText,
    uploadTime: new Date().toLocaleDateString("zh-CN"),
    fileName: input.fileName ?? null,
    fileType: input.fileType ?? null,
    fileSize: input.fileSize ?? null,
    fileDataBase64: input.fileDataBase64 ?? null,
    keyPointAnalysis: result.keyPointAnalysis,
    interviewQuestions: result.interviewQuestions,
    reasonTags: inferDefaultReasonTags(result.reason),
    interviewTimeline: {},
  };
}

function buildKeyPointAnalysis(keyPoints: string[], resumeText: string, job: Job) {
  return keyPoints.slice(0, 6).map((keyword) => {
    const matched = resumeText.includes(keyword);
    return {
      keyword,
      matched,
      evidence: matched
        ? `简历内容已出现“${keyword}”，建议面试中继续追问其项目规模、个人贡献和结果指标。`
        : `暂未识别到“${keyword}”的直接证据，建议围绕 ${job.title} 的实际场景补充验证。`,
    };
  });
}

function buildPersonalInterviewQuestions(
  keyPointAnalysis: Array<{ keyword: string; matched: boolean; evidence: string }>,
  job: Job,
  conclusion: string,
) {
  const missed = keyPointAnalysis.filter((item) => !item.matched).slice(0, 2);
  const matched = keyPointAnalysis.filter((item) => item.matched).slice(0, 3);
  const source = missed.length ? missed : matched;
  const questions = source.map((item) => ({
    title: `${item.keyword} 深度追问`,
    text: `请结合过往经历讲一个与“${item.keyword}”相关的完整案例，你的角色、关键动作和结果分别是什么？`,
    probe: item.matched
      ? "追问：这个结果如何量化？如果扩大到更复杂团队，你会怎么复制？"
      : "追问：如果入职后必须快速补齐这一点，你的前 30 天行动计划是什么？",
    competency: `${item.keyword}相关能力`,
    starFocus: item.matched ? ["任务定义", "行动拆解", "结果量化"] : ["情境澄清", "行动拆解", "复盘反思"],
    evaluationSignals: item.matched
      ? ["能讲清个人贡献", "结果可量化或可验证", "经验具备可复制性"]
      : ["能提出明确补齐路径", "行动计划具体", "有清晰优先级判断"],
  }));
  questions.push({
    title: `${job.title} 岗位适配`,
    text: "基于你对该岗位的理解，你认为当前最关键的业务挑战是什么？你会如何切入？",
    probe: `追问：如果最终结论是“${conclusion}”，你认为自己最能支撑这个判断的证据是什么？`,
    competency: "岗位理解与综合适配能力",
    starFocus: ["情境澄清", "任务定义", "行动拆解"],
    evaluationSignals: ["能准确理解岗位挑战", "切入路径有逻辑", "能给出支持结论的直接证据"],
  });
  return questions;
}

function inferDefaultReasonTags(reason: string) {
  const tags = ([
    [/薪资|预算/, "薪资不匹配"],
    [/经验|能力|匹配/, "技能不符"],
    [/管理|团队/, "管理经验不足"],
  ] as Array<[RegExp, string]>)
    .filter(([pattern]) => pattern.test(reason))
    .map(([, label]) => label);
  return tags.slice(0, 3);
}
