import type { AppState, Candidate, Job } from "./types.js";

const jobs: Job[] = [
  {
    id: "job_001",
    title: "HRBP",
    dept: "人力行政中心",
    location: "北京",
    experience: "3-5年",
    level: "经理",
    salaryRange: "25-35k",
    keywords: "绩效、团队搭建、人才发展",
    description: "深入理解公司业务，作为业务团队战略伙伴提供组织诊断、人才盘点、绩效推动与管理者赋能支持，牵引关键岗位招聘与团队搭建。",
    status: "招聘中",
    resumeCount: 5,
    salaryData: null,
    sortOrder: 1,
  },
  {
    id: "job_002",
    title: "前端开发工程师",
    dept: "数字化产品部",
    location: "上海",
    experience: "3-5年",
    level: "高级专员",
    salaryRange: "28-45k",
    keywords: "Vue、数据可视化、工程化、组件库",
    description: "负责企业级后台产品前端架构与核心页面开发，沉淀通用组件与可视化能力，持续优化性能、可维护性与用户体验。",
    status: "招聘中",
    resumeCount: 4,
    salaryData: null,
    sortOrder: 2,
  },
  {
    id: "job_003",
    title: "招聘运营专员",
    dept: "人力行政中心",
    location: "深圳",
    experience: "1-3年",
    level: "专员",
    salaryRange: "12-18k",
    keywords: "渠道运营、候选人体验、数据分析",
    description: "负责招聘渠道维护、候选人流程跟进与招聘数据看板更新，协助提升交付效率和候选人体验。",
    status: "暂停",
    resumeCount: 3,
    salaryData: null,
    sortOrder: 3,
  },
];

const candidates: Record<string, Candidate[]> = {
  job_001: [
    candidate("c1", "job_001", "赖雯", "智联", 72.4, "推荐面试", "具备业务支持与绩效落地经验，能独立承接组织诊断；团队搭建经验与岗位要求匹配度较高。", "赖雯｜6年 HRBP 经验\n曾服务互联网平台业务线，支持 300+ 人组织，负责绩效管理、人才盘点、干部梯队建设与关键岗位招聘。熟悉 OKR 推进、组织氛围调研和管理者辅导。", "2026/6/12"),
    candidate("c2", "job_001", "何锦程", "BOSS直聘", 86.8, "强烈推荐", "兼具 HRBP 与 COE 项目经验，主导过新业务团队从 0 到 1 搭建，关键词覆盖充分。", "何锦程｜8年人力资源经验\n先后任职消费品与科技公司 HRBP，支持销售与研发团队。主导人才发展项目、绩效制度迭代、组织效能提升专项，新业务团队半年扩张 80 人。", "2026/6/13"),
    candidate("c3", "job_001", "赵宁", "猎聘", 64.5, "备选", "招聘交付能力较强，但业务诊断、人才发展深度略弱，可作为后备候选人保持沟通。", "赵宁｜5年招聘与 HRBP 经验\n负责中后台岗位招聘、员工关系与入离调转流程。熟悉招聘渠道管理，参与过绩效沟通与员工访谈。", "2026/6/14"),
    candidate("c4", "job_001", "陈思琪", "内推", 78.1, "推荐面试", "拥有组织发展与管理者赋能项目经验，候选人表达清晰，适合业务快速变化环境。", "陈思琪｜7年 OD/HRBP 经验\n负责组织诊断、岗位体系梳理与绩效复盘，联合业务负责人完成组织调整与人才梯队建设。", "2026/6/15"),
    candidate("c5", "job_001", "宋天宇", "脉脉", 55.2, "暂不推荐", "过往以招聘执行为主，战略伙伴与人才发展经验不足，与经理级 HRBP 岗位存在差距。", "宋天宇｜4年招聘经验\n负责职能岗位招聘、简历筛选、面试安排与 offer 跟进，熟悉招聘流程管理和渠道维护。", "2026/6/16"),
  ],
  job_002: [
    candidate("c6", "job_002", "王奕然", "拉勾", 88.2, "强烈推荐", "企业后台、组件库和 ECharts 经验完整，近期项目与岗位职责高度匹配。", "王奕然｜6年前端开发\n精通 Vue、TypeScript、Vite 与 ECharts，负责多个管理后台与 BI 看板，搭建过内部组件库。", "2026/6/10"),
    candidate("c7", "job_002", "林蔚", "BOSS直聘", 73.6, "推荐面试", "具备后台开发经验，数据可视化能力较好，工程化深度可面试确认。", "林蔚｜4年前端开发\n参与 CRM 后台、可视化报表与权限系统开发，熟悉 React、Vue 与前端性能优化。", "2026/6/11"),
    candidate("c8", "job_002", "周启航", "猎聘", 61.9, "备选", "工程经验尚可，但组件库和架构主导经验不足。", "周启航｜3年前端开发\n负责业务页面开发、接口联调与基础组件封装，参与过小规模图表需求。", "2026/6/12"),
    candidate("c9", "job_002", "许安琪", "内推", 81.4, "推荐面试", "工程化与组件抽象经验较突出，适合进一步验证复杂项目推进能力。", "许安琪｜5年前端工程师\n主导中台组件库升级、Vite 构建优化和多端管理后台重构，熟悉 ECharts 与大屏可视化。", "2026/6/13"),
  ],
  job_003: [
    candidate("c10", "job_003", "李佳琪", "智联", 75.6, "推荐面试", "渠道维护与流程运营经验成熟，数据意识较强。", "李佳琪｜3年招聘运营经验\n负责招聘渠道预算、职位发布、候选人流程跟进与周报分析，熟练使用 Excel 与 ATS 系统。", "2026/6/08"),
    candidate("c11", "job_003", "秦朗", "校园招聘", 57.7, "备选", "基础执行能力尚可，但独立运营经验偏少。", "秦朗｜1年 HR 实习/招聘助理经验\n参与校园招聘、面试邀约、候选人接待与基础数据维护。", "2026/6/09"),
    candidate("c12", "job_003", "孟瑶", "BOSS直聘", 69.3, "推荐面试", "熟悉多渠道运营和候选人体验优化，可进一步验证数据分析深度。", "孟瑶｜2年招聘运营经验\n维护线上渠道、招聘社群与候选人触达 SOP，参与招聘漏斗分析和流程优化。", "2026/6/10"),
  ],
};

export const seedState: AppState = {
  currentUser: "饶玉冰",
  currentJobId: "job_001",
  jobs,
  candidates,
  voiceAnalyses: {},
};

function candidate(
  id: string,
  jobId: string,
  name: string,
  source: string,
  score: number,
  conclusion: string,
  reason: string,
  resumeText: string,
  uploadTime: string,
): Candidate {
  const interviewTag = conclusion === "暂不推荐" ? ["技能不符"] : conclusion === "备选" ? ["求职动机不足"] : ["技能不符"];
  return {
    id,
    jobId,
    name,
    source,
    score,
    conclusion,
    reason,
    resumeText,
    uploadTime,
    fileName: null,
    fileType: null,
    fileSize: null,
    keyPointAnalysis: [],
    interviewQuestions: [],
    reasonTags: interviewTag,
    interviewTimeline: {},
  };
}
