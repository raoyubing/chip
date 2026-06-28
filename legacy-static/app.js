const DB_NAME = "xiaosongshuRecruitmentWorkbenchDB";
const DB_VERSION = 1;
const DB_STORE = "workbench";
const DB_STATE_KEY = "state";
const LEGACY_STORAGE_KEYS = ["xiaosongshuRecruitmentWorkbenchState", "recruitmentWorkbenchState"];

const sampleState = {
  currentUser: "饶玉冰",
  currentJobId: "job_001",
  jobs: [
    {
      id: "job_001",
      title: "HRBP",
      dept: "人力行政中心",
      location: "北京",
      experience: "3-5年",
      level: "经理",
      keywords: "绩效、团队搭建、人才发展",
      description:
        "深入理解公司业务，作为业务团队战略伙伴提供组织诊断、人才盘点、绩效推动与管理者赋能支持，牵引关键岗位招聘与团队搭建。",
      status: "招聘中",
      isPinned: true,
      resumeCount: 5,
      salaryData: null,
    },
    {
      id: "job_002",
      title: "前端开发工程师",
      dept: "数字化产品部",
      location: "上海",
      experience: "3-5年",
      level: "高级专员",
      keywords: "Vue、数据可视化、工程化、组件库",
      description:
        "负责企业级后台产品前端架构与核心页面开发，沉淀通用组件与可视化能力，持续优化性能、可维护性与用户体验。",
      status: "招聘中",
      isPinned: false,
      resumeCount: 4,
      salaryData: null,
    },
    {
      id: "job_003",
      title: "招聘运营专员",
      dept: "人力行政中心",
      location: "深圳",
      experience: "1-3年",
      level: "专员",
      keywords: "渠道运营、候选人体验、数据分析",
      description:
        "负责招聘渠道维护、候选人流程跟进与招聘数据看板更新，协助提升交付效率和候选人体验。",
      status: "暂停",
      isPinned: false,
      resumeCount: 3,
      salaryData: null,
    },
  ],
  candidates: {
    job_001: [
      {
        id: "c1",
        name: "赖雯",
        source: "智联",
        score: 72.4,
        conclusion: "推荐面试",
        reason:
          "具备业务支持与绩效落地经验，能独立承接组织诊断；团队搭建经验与岗位要求匹配度较高。",
        resumeText:
          "赖雯｜6年 HRBP 经验\n曾服务互联网平台业务线，支持 300+ 人组织，负责绩效管理、人才盘点、干部梯队建设与关键岗位招聘。熟悉 OKR 推进、组织氛围调研和管理者辅导。",
        uploadTime: "2026/6/12",
      },
      {
        id: "c2",
        name: "何锦程",
        source: "BOSS直聘",
        score: 86.8,
        conclusion: "强烈推荐",
        reason:
          "兼具 HRBP 与 COE 项目经验，主导过新业务团队从 0 到 1 搭建，关键词覆盖充分。",
        resumeText:
          "何锦程｜8年人力资源经验\n先后任职消费品与科技公司 HRBP，支持销售与研发团队。主导人才发展项目、绩效制度迭代、组织效能提升专项，新业务团队半年扩张 80 人。",
        uploadTime: "2026/6/13",
      },
      {
        id: "c3",
        name: "赵宁",
        source: "猎聘",
        score: 64.5,
        conclusion: "备选",
        reason:
          "招聘交付能力较强，但业务诊断、人才发展深度略弱，可作为后备候选人保持沟通。",
        resumeText:
          "赵宁｜5年招聘与 HRBP 经验\n负责中后台岗位招聘、员工关系与入离调转流程。熟悉招聘渠道管理，参与过绩效沟通与员工访谈。",
        uploadTime: "2026/6/14",
      },
      {
        id: "c4",
        name: "陈思琪",
        source: "内推",
        score: 78.1,
        conclusion: "推荐面试",
        reason:
          "拥有组织发展与管理者赋能项目经验，候选人表达清晰，适合业务快速变化环境。",
        resumeText:
          "陈思琪｜7年 OD/HRBP 经验\n负责组织诊断、岗位体系梳理与绩效复盘，联合业务负责人完成组织调整与人才梯队建设。",
        uploadTime: "2026/6/15",
      },
      {
        id: "c5",
        name: "宋天宇",
        source: "脉脉",
        score: 55.2,
        conclusion: "暂不推荐",
        reason:
          "过往以招聘执行为主，战略伙伴与人才发展经验不足，与经理级 HRBP 岗位存在差距。",
        resumeText:
          "宋天宇｜4年招聘经验\n负责职能岗位招聘、简历筛选、面试安排与 offer 跟进，熟悉招聘流程管理和渠道维护。",
        uploadTime: "2026/6/16",
      },
    ],
    job_002: [
      {
        id: "c6",
        name: "王奕然",
        source: "拉勾",
        score: 88.2,
        conclusion: "强烈推荐",
        reason:
          "企业后台、组件库和 ECharts 经验完整，近期项目与岗位职责高度匹配。",
        resumeText:
          "王奕然｜6年前端开发\n精通 Vue、TypeScript、Vite 与 ECharts，负责多个管理后台与 BI 看板，搭建过内部组件库。",
        uploadTime: "2026/6/10",
      },
      {
        id: "c7",
        name: "林蔚",
        source: "BOSS直聘",
        score: 73.6,
        conclusion: "推荐面试",
        reason:
          "具备工程化经验，数据可视化项目较少但学习曲线可控。",
        resumeText:
          "林蔚｜4年前端经验\n负责 SaaS 后台页面、权限系统与低代码表单模块，熟悉 React、Vue 与前端性能优化。",
        uploadTime: "2026/6/11",
      },
      {
        id: "c8",
        name: "周晗",
        source: "智联",
        score: 61.9,
        conclusion: "备选",
        reason: "页面开发扎实，但工程化和复杂后台架构经验不足。",
        resumeText:
          "周晗｜3年前端开发\n主要负责官网、活动页与轻量后台功能开发，熟悉 HTML、CSS、JavaScript 和 Vue。",
        uploadTime: "2026/6/12",
      },
      {
        id: "c9",
        name: "许墨",
        source: "内推",
        score: 79.4,
        conclusion: "推荐面试",
        reason: "组件抽象和可视化经验较好，可重点验证业务理解与协作能力。",
        resumeText:
          "许墨｜5年前端经验\n负责供应链后台、图表看板与组件库建设，熟悉 ECharts、状态管理与前端测试。",
        uploadTime: "2026/6/13",
      },
    ],
    job_003: [
      {
        id: "c10",
        name: "李佳琪",
        source: "智联",
        score: 82.5,
        conclusion: "推荐面试",
        reason: "渠道维护与流程运营经验成熟，数据意识较强。",
        resumeText:
          "李佳琪｜3年招聘运营经验\n负责招聘渠道预算、职位发布、候选人流程跟进与周报分析，熟练使用 Excel 与 ATS 系统。",
        uploadTime: "2026/6/08",
      },
      {
        id: "c11",
        name: "秦朗",
        source: "校园招聘",
        score: 57.7,
        conclusion: "备选",
        reason: "基础执行能力尚可，但独立运营经验偏少。",
        resumeText:
          "秦朗｜1年 HR 实习/招聘助理经验\n参与校园招聘、面试邀约、候选人接待与基础数据维护。",
        uploadTime: "2026/6/09",
      },
      {
        id: "c12",
        name: "孟瑶",
        source: "BOSS直聘",
        score: 69.3,
        conclusion: "推荐面试",
        reason: "熟悉多渠道运营和候选人体验优化，可进一步验证数据分析深度。",
        resumeText:
          "孟瑶｜2年招聘运营经验\n维护线上渠道、招聘社群与候选人触达 SOP，参与招聘漏斗分析和流程优化。",
        uploadTime: "2026/6/10",
      },
    ],
  },
};

const viewTitles = {
  dashboard: "工作台概览",
  jobs: "职位管理",
  candidates: "简历甄选",
  salary: "薪酬调研",
};

let state = structuredClone(sampleState);
let dbInstance = null;
let activeView = "dashboard";
let selectedCandidateId = null;
let chartInstances = [];
let saveQueue = Promise.resolve();

const app = document.querySelector("#app");
const jobSelect = document.querySelector("#jobSelect");
const jobSwitcher = document.querySelector(".job-switcher");
const modalRoot = document.querySelector("#modalRoot");

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("当前浏览器不支持 IndexedDB"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB 被其他页面占用，请关闭重复窗口后重试"));
  });
}

function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readonly");
    const request = transaction.objectStore(DB_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 读取事务中断"));
  });
}

function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB 写入事务中断"));
  });
}

function readLegacyState() {
  try {
    for (const key of LEGACY_STORAGE_KEYS) {
      const cached = localStorage.getItem(key);
      if (!cached) continue;
      return JSON.parse(cached);
    }
  } catch (error) {
    console.warn("读取旧 localStorage 数据失败", error);
  }
  return null;
}

function clearLegacyState() {
  try {
    LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
  } catch (error) {
    console.warn("清理旧 localStorage 数据失败", error);
  }
}

async function loadState() {
  try {
    dbInstance = await openDatabase();
    const cached = await idbGet(dbInstance, DB_STATE_KEY);
    if (cached) {
      clearLegacyState();
      return mergeDefaults(cached);
    }

    const legacyState = readLegacyState();
    const initialState = legacyState ? mergeDefaults(legacyState) : structuredClone(sampleState);
    await persistState(initialState);
    clearLegacyState();
    return initialState;
  } catch (error) {
    console.error("IndexedDB 初始化失败", error);
    toast("本地数据库初始化失败，当前仅使用临时内存数据");
    return mergeDefaults(readLegacyState() || structuredClone(sampleState));
  }
}

function mergeDefaults(parsed) {
  const next = { ...structuredClone(sampleState), ...parsed };
  next.jobs = Array.isArray(parsed.jobs) && parsed.jobs.length ? parsed.jobs : sampleState.jobs;
  next.candidates = { ...sampleState.candidates, ...(parsed.candidates || {}) };
  next.jobs.forEach((job) => {
    if (!next.candidates[job.id]) next.candidates[job.id] = [];
    if (typeof job.salaryData === "undefined") job.salaryData = null;
    job.resumeCount = next.candidates[job.id].length;
  });
  if (!next.jobs.some((job) => job.id === next.currentJobId)) {
    next.currentJobId = next.jobs[0]?.id || "";
  }
  return next;
}

async function persistState(nextState) {
  if (!dbInstance) dbInstance = await openDatabase();
  await idbSet(dbInstance, DB_STATE_KEY, structuredClone(nextState));
  clearLegacyState();
}

function saveState() {
  state.jobs.forEach((job) => {
    job.resumeCount = getCandidates(job.id).length;
  });
  const snapshot = structuredClone(state);
  saveQueue = saveQueue.then(() => persistState(snapshot)).catch((error) => {
    console.error("IndexedDB 保存失败", error);
    toast("本地数据库保存失败，请稍后重试");
  });
}

function getCurrentJob() {
  return state.jobs.find((job) => job.id === state.currentJobId) || state.jobs[0];
}

function getCandidates(jobId = state.currentJobId) {
  return state.candidates[jobId] || [];
}

function prioritizeJob(jobId) {
  const index = state.jobs.findIndex((job) => job.id === jobId);
  if (index <= 0) return;
  const [selectedJob] = state.jobs.splice(index, 1);
  state.jobs.unshift(selectedJob);
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value) {
  return `${value.toLocaleString("zh-CN")}k`;
}

function scoreBadge(score) {
  if (score >= 85) return "green";
  if (score >= 70) return "gold";
  if (score >= 60) return "gray";
  return "red";
}

function statusBadge(status) {
  return status === "招聘中" ? "green" : status === "暂停" ? "gold" : "gray";
}

function setView(view) {
  activeView = view;
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.view === view);
  });
  document.querySelector("#viewTitle").textContent = viewTitles[view];
  selectedCandidateId = null;
  render();
}

function render() {
  disposeCharts();
  renderJobSelect();
  jobSwitcher.hidden = !["jobs", "candidates"].includes(activeView);
  document.querySelector("#currentUser").textContent = state.currentUser;
  document.querySelector("#userAvatar").textContent = state.currentUser.slice(0, 1);

  const views = {
    dashboard: renderDashboard,
    jobs: renderJobs,
    candidates: renderCandidates,
    salary: renderSalary,
  };
  views[activeView]();
}

function renderJobSelect() {
  jobSelect.innerHTML = state.jobs
    .map(
      (job) =>
        `<option value="${job.id}" ${job.id === state.currentJobId ? "selected" : ""}>${escapeHtml(
          job.title,
        )} · ${escapeHtml(job.location)}</option>`,
    )
    .join("");
}

function renderDashboard() {
  const totalJobs = state.jobs.length;
  const activeJobs = state.jobs.filter((job) => job.status === "招聘中").length;
  const candidates = Object.values(state.candidates).flat();
  const avgScore = candidates.length
    ? (candidates.reduce((sum, candidate) => sum + candidate.score, 0) / candidates.length).toFixed(1)
    : "0.0";
  const recommended = candidates.filter((candidate) => candidate.score >= 70).length;
  const currentJob = getCurrentJob();

  app.innerHTML = `
    <div class="grid cols-4">
      ${statCard("开放职位", totalJobs, `${activeJobs} 个招聘中`)}
      ${statCard("累计简历", candidates.length, "IndexedDB 实时统计")}
      ${statCard("平均匹配分", avgScore, "基于模拟甄选结果")}
      ${statCard("推荐候选人", recommended, "分数 ≥ 70")}
    </div>

    <div class="grid cols-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h3>招聘漏斗</h3>
            <p>按当前本地数据自动汇总各岗位候选人状态</p>
          </div>
          <button class="btn ghost" data-action="seed-candidate">模拟新增简历</button>
        </div>
        <div id="funnelChart" class="chart"></div>
      </section>

      <section class="card pad">
        <div class="row-between">
          <div>
            <h3 class="card-title">当前重点职位</h3>
            <p class="helper-text">${escapeHtml(currentJob.dept)} · ${escapeHtml(currentJob.location)}</p>
          </div>
          <span class="badge ${statusBadge(currentJob.status)}">${escapeHtml(currentJob.status)}</span>
        </div>
        <div class="job-card active" style="margin-top: 14px;">
          <div class="job-topline">
            <div>
              <h4>${escapeHtml(currentJob.title)}</h4>
              <span class="meta">${escapeHtml(currentJob.level)} · ${escapeHtml(currentJob.experience)}</span>
            </div>
            <strong>${getCandidates(currentJob.id).length} 份</strong>
          </div>
          <div class="kv">${currentJob.keywords
            .split("、")
            .map((keyword) => `<span>${escapeHtml(keyword)}</span>`)
            .join("")}</div>
          <p class="desc">${escapeHtml(currentJob.description)}</p>
          <div class="toolbar-left">
            <button class="btn primary" data-view-jump="candidates">查看候选人</button>
            <button class="btn" data-view-jump="salary">查看薪酬调研</button>
          </div>
        </div>
      </section>
    </div>

    <div class="grid cols-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h3>岗位简历量</h3>
            <p>用于快速识别交付压力与渠道质量</p>
          </div>
        </div>
        <div id="jobBarChart" class="chart small"></div>
      </section>

      <section class="card pad">
        <div class="row-between">
          <h3 class="card-title">近期动态</h3>
          <button class="btn" data-action="reset-demo">重置示例数据</button>
        </div>
        <div class="timeline" style="margin-top: 16px;">
          ${renderTimeline(candidates)}
        </div>
      </section>
    </div>
  `;

  drawFunnel(candidates);
  drawJobBars();
}

function statCard(label, value, extra) {
  return `
    <section class="card stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-extra">${extra}</div>
    </section>
  `;
}

function renderTimeline(candidates) {
  return candidates
    .slice()
    .sort((a, b) => new Date(b.uploadTime) - new Date(a.uploadTime))
    .slice(0, 5)
    .map(
      (candidate) => `
      <div class="timeline-item">
        <div class="timeline-time">${escapeHtml(candidate.uploadTime)}</div>
        <div class="timeline-card">
          <strong>${escapeHtml(candidate.name)} · ${escapeHtml(candidate.conclusion)}</strong>
          <span class="meta">来源：${escapeHtml(candidate.source)}，匹配分 ${candidate.score}</span>
        </div>
      </div>
    `,
    )
    .join("");
}

function renderJobs() {
  const currentJob = getCurrentJob();
  app.innerHTML = `
    <section class="card pad">
      <div class="toolbar">
        <div>
          <h3 class="card-title">职位池</h3>
          <p class="helper-text">管理招聘职位，并同步更新本地候选人归属。</p>
        </div>
        <div class="toolbar-right">
          <button class="btn" data-action="export-json">导出数据</button>
          <button class="btn primary" data-action="open-job-modal">新增职位</button>
        </div>
      </div>
    </section>

    <div class="grid cols-2">
      <section class="card pad">
        <div class="job-list">
          ${state.jobs.map(renderJobCard).join("")}
        </div>
      </section>

      <section class="card pad">
        <div class="detail-panel">
          <div class="row-between">
            <div>
              <h3 class="card-title">${escapeHtml(currentJob.title)}</h3>
              <span class="meta">${escapeHtml(currentJob.dept)} · ${escapeHtml(currentJob.location)}</span>
            </div>
            <span class="badge ${statusBadge(currentJob.status)}">${escapeHtml(currentJob.status)}</span>
          </div>
          <div class="salary-summary">
            <div class="salary-metric"><span>职级</span><strong>${escapeHtml(currentJob.level)}</strong></div>
            <div class="salary-metric"><span>经验</span><strong>${escapeHtml(currentJob.experience)}</strong></div>
            <div class="salary-metric"><span>简历</span><strong>${getCandidates(currentJob.id).length}</strong></div>
          </div>
          <div>
            <span class="meta">关键词</span>
            <div class="kv" style="margin-top: 8px;">${currentJob.keywords
              .split("、")
              .map((keyword) => `<span>${escapeHtml(keyword)}</span>`)
              .join("")}</div>
          </div>
          <div>
            <span class="meta">职位描述</span>
            <p class="desc" style="margin-top: 8px;">${escapeHtml(currentJob.description)}</p>
          </div>
          <div class="toolbar-left">
            <button class="btn primary" data-action="edit-current-job">编辑职位</button>
            <button class="btn danger" data-action="delete-current-job">删除职位</button>
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderJobCard(job) {
  return `
    <article class="job-card ${job.id === state.currentJobId ? "active" : ""}" data-job-id="${job.id}">
      <div class="job-topline">
        <div>
          <h4>${escapeHtml(job.title)}</h4>
          <span class="meta">${escapeHtml(job.dept)} · ${escapeHtml(job.location)}</span>
        </div>
        <span class="badge ${statusBadge(job.status)}">${escapeHtml(job.status)}</span>
      </div>
      <div class="kv">
        <span>${escapeHtml(job.experience)}</span>
        <span>${escapeHtml(job.level)}</span>
        <span>${getCandidates(job.id).length} 份简历</span>
      </div>
      <p class="desc">${escapeHtml(job.description)}</p>
    </article>
  `;
}

function renderCandidates() {
  const currentJob = getCurrentJob();
  const candidates = getCandidates();
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) || candidates[0] || null;
  selectedCandidateId = selectedCandidate?.id || null;

  app.innerHTML = `
    <section class="card pad">
      <div class="toolbar">
        <div>
          <h3 class="card-title">${escapeHtml(currentJob.title)} · 简历甄选</h3>
          <p class="helper-text">本页面使用岗位关键词与模拟评分规则生成筛选结论。</p>
        </div>
        <div class="toolbar-right">
          <button class="btn" data-action="sort-candidates">按分数排序</button>
          <button class="btn primary" data-action="open-candidate-modal">上传/录入简历</button>
        </div>
      </div>
    </section>

    <div class="grid cols-2">
      <section class="card pad">
        ${
          candidates.length
            ? `<div class="candidate-list">${candidates.map(renderCandidateCard).join("")}</div>`
            : `<div class="empty"><div><strong>暂无简历</strong><br />点击“上传/录入简历”添加候选人。</div></div>`
        }
      </section>

      <section class="card pad">
        ${selectedCandidate ? renderCandidateDetail(selectedCandidate) : renderEmptyDetail()}
      </section>
    </div>
  `;
}

function renderCandidateCard(candidate) {
  return `
    <article class="candidate-card ${candidate.id === selectedCandidateId ? "selected" : ""}" data-candidate-id="${candidate.id}">
      <div class="score-ring" style="--score: ${candidate.score};"><span>${candidate.score}</span></div>
      <div class="candidate-body">
        <div class="candidate-topline">
          <div>
            <h4>${escapeHtml(candidate.name)}</h4>
            <span class="meta">${escapeHtml(candidate.source)} · 上传 ${escapeHtml(candidate.uploadTime)}</span>
          </div>
          <span class="badge ${scoreBadge(candidate.score)}">${escapeHtml(candidate.conclusion)}</span>
        </div>
        <p class="reason">${escapeHtml(candidate.reason)}</p>
        <button class="btn ghost" data-candidate-id="${candidate.id}" data-action="select-candidate">查看详情</button>
      </div>
    </article>
  `;
}

function renderCandidateDetail(candidate) {
  return `
    <div class="detail-panel">
      <div class="row-between">
        <div>
          <h3 class="card-title">${escapeHtml(candidate.name)}</h3>
          <span class="meta">来源：${escapeHtml(candidate.source)} · ${escapeHtml(candidate.uploadTime)}</span>
        </div>
        <span class="badge ${scoreBadge(candidate.score)}">${candidate.score} 分</span>
      </div>
      <div class="salary-summary">
        <div class="salary-metric"><span>筛选结论</span><strong>${escapeHtml(candidate.conclusion)}</strong></div>
        <div class="salary-metric"><span>推荐强度</span><strong>${candidate.score >= 85 ? "高" : candidate.score >= 70 ? "中高" : "观察"}</strong></div>
        <div class="salary-metric"><span>来源渠道</span><strong>${escapeHtml(candidate.source)}</strong></div>
      </div>
      <div>
        <span class="meta">推荐理由</span>
        <p class="desc" style="margin-top: 8px;">${escapeHtml(candidate.reason)}</p>
      </div>
      ${candidate.keyPointAnalysis ? renderKeyPointAnalysis(candidate.keyPointAnalysis) : ""}
      ${candidate.interviewQuestions ? renderCandidateInterviewQuestions(candidate.interviewQuestions) : ""}
      <div>
        <span class="meta">简历文本</span>
        <div class="resume-box" style="margin-top: 8px;">${escapeHtml(candidate.resumeText)}</div>
      </div>
      <div class="toolbar-left">
        <button class="btn primary" data-action="mark-interview">标记面试</button>
        <button class="btn danger" data-action="delete-candidate">删除候选人</button>
      </div>
    </div>
  `;
}

function renderEmptyDetail() {
  return `<div class="empty"><div><strong>暂无候选人详情</strong><br />上传或录入简历后可查看甄选结论。</div></div>`;
}

function renderSalary() {
  const currentJob = getCurrentJob();
  const salaryData = currentJob.salaryData || generateSalaryData(currentJob);
  currentJob.salaryData = salaryData;
  saveState();

  app.innerHTML = `
    <section class="card pad">
      <div class="toolbar">
        <div>
          <h3 class="card-title">${escapeHtml(currentJob.title)} · 薪酬调研</h3>
          <p class="helper-text">调研数据为本地模拟缓存，可刷新生成，用于离线演示。</p>
        </div>
        <div class="toolbar-right">
          <button class="btn" data-action="refresh-salary">刷新模拟数据</button>
          <button class="btn primary" data-action="apply-salary-note">生成薪酬建议</button>
        </div>
      </div>
    </section>

    <div class="grid cols-3">
      <section class="card stat-card">
        <div class="stat-label">市场 P25</div>
        <div class="stat-value">${formatMoney(salaryData.p25)}</div>
        <div class="stat-extra">保守招聘预算</div>
      </section>
      <section class="card stat-card">
        <div class="stat-label">市场 P50</div>
        <div class="stat-value">${formatMoney(salaryData.p50)}</div>
        <div class="stat-extra">建议薪酬锚点</div>
      </section>
      <section class="card stat-card">
        <div class="stat-label">市场 P75</div>
        <div class="stat-value">${formatMoney(salaryData.p75)}</div>
        <div class="stat-extra">竞争性 offer 上沿</div>
      </section>
    </div>

    <div class="grid cols-2">
      <section class="card">
        <div class="card-header">
          <div>
            <h3>城市薪酬带宽</h3>
            <p>单位：千元 / 月，按岗位画像模拟</p>
          </div>
        </div>
        <div id="salaryRangeChart" class="chart"></div>
      </section>

      <section class="card">
        <div class="card-header">
          <div>
            <h3>渠道报价分布</h3>
            <p>展示不同招聘渠道候选人的期望薪资区间</p>
          </div>
        </div>
        <div id="salaryPieChart" class="chart"></div>
      </section>
    </div>

    <section class="card pad">
      <div class="row-between">
        <div>
          <h3 class="card-title">薪酬策略建议</h3>
          <p class="helper-text">结合职位级别、城市、简历评分与市场分位生成。</p>
        </div>
        <span class="badge green">${escapeHtml(salaryData.updatedAt)} 更新</span>
      </div>
      <div class="salary-list" style="margin-top: 14px;">
        ${salaryData.insights.map((item) => `<div class="timeline-card"><strong>${escapeHtml(item.title)}</strong><span class="meta">${escapeHtml(item.text)}</span></div>`).join("")}
      </div>
    </section>
  `;

  drawSalaryRange(salaryData);
  drawSalaryPie(salaryData);
}

function generateSalaryData(job) {
  const baseByLevel = {
    专员: 18,
    高级专员: 28,
    经理: 36,
    总监: 58,
  };
  const cityFactor = {
    北京: 1.16,
    上海: 1.14,
    深圳: 1.1,
    广州: 1.02,
    杭州: 1.08,
  };
  const base = Math.round((baseByLevel[job.level] || 30) * (cityFactor[job.location] || 1));
  const hash = [...job.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const drift = (hash % 7) - 3;
  const p50 = Math.max(12, base + drift);
  const p25 = Math.round(p50 * 0.82);
  const p75 = Math.round(p50 * 1.24);
  const cities = ["北京", "上海", "深圳", "杭州", "广州"].map((city, index) => {
    const factor = Object.values(cityFactor)[index] || 1;
    const median = Math.round((baseByLevel[job.level] || 30) * factor + drift);
    return {
      city,
      low: Math.round(median * 0.78),
      mid: median,
      high: Math.round(median * 1.28),
    };
  });
  const channels = [
    { name: "猎聘", value: Math.round(p50 * 1.22) },
    { name: "BOSS直聘", value: Math.round(p50 * 1.02) },
    { name: "智联", value: Math.round(p50 * 0.92) },
    { name: "内推", value: Math.round(p50 * 1.08) },
  ];

  return {
    p25,
    p50,
    p75,
    cities,
    channels,
    updatedAt: new Date().toLocaleDateString("zh-CN"),
    insights: [
      {
        title: "建议锚点",
        text: `${job.location}${job.title} 可优先以 P50（${formatMoney(p50)}）作为沟通锚点，优秀候选人上浮至 P75。`,
      },
      {
        title: "预算风险",
        text: `若预算低于 ${formatMoney(p25)}，预计会显著降低高匹配候选人的邀约转化率。`,
      },
      {
        title: "谈薪策略",
        text: `结合 ${job.keywords} 等核心要求，对评分 85+ 候选人建议保留 8%-12% 弹性空间。`,
      },
    ],
  };
}

function openJobModal(job = null) {
  const isEdit = Boolean(job);
  openModal(`
    <form id="jobForm">
      <div class="modal-head">
        <h3>${isEdit ? "编辑职位" : "新增职位"}</h3>
        <button class="btn" type="button" data-action="close-modal">关闭</button>
      </div>
      <div class="modal-body form-grid">
        ${field("title", "职位名称", job?.title || "", "例如：HRBP")}
        ${field("dept", "所属部门", job?.dept || "", "例如：人力行政中心")}
        ${field("location", "工作城市", job?.location || "", "例如：北京")}
        ${field("experience", "经验要求", job?.experience || "", "例如：3-5年")}
        ${field("level", "职位级别", job?.level || "", "例如：经理")}
        <label class="form-field">
          <span>招聘状态</span>
          <select name="status">
            ${["招聘中", "暂停", "已关闭"].map((status) => `<option ${status === (job?.status || "招聘中") ? "selected" : ""}>${status}</option>`).join("")}
          </select>
        </label>
        ${field("keywords", "岗位关键词", job?.keywords || "", "绩效、团队搭建、人才发展", true)}
        <label class="form-field full">
          <span>职位描述</span>
          <textarea name="description" required placeholder="请输入详细职责文本">${escapeHtml(job?.description || "")}</textarea>
        </label>

        <section class="job-tool-card full" aria-labelledby="jdOptimizerTitle">
          <div class="job-tool-head">
            <div>
              <h4 id="jdOptimizerTitle">JD优化器</h4>
              <p>基于当前职位信息，离线生成更适合发布的岗位卖点与职责表达。</p>
            </div>
            <button class="btn ghost" type="button" data-tool-action="optimize-jd">生成优化建议</button>
          </div>
          <div id="jdOptimizerResult" class="tool-result empty-mini">点击生成后，将展示岗位标题、关键词和职位描述优化建议。</div>
        </section>

        <section class="job-tool-card full" aria-labelledby="interviewQuestionTitle">
          <div class="job-tool-head">
            <div>
              <h4 id="interviewQuestionTitle">推荐面试问题</h4>
              <p>围绕关键词、经验要求与岗位职责，生成结构化面试追问。</p>
            </div>
            <button class="btn ghost" type="button" data-tool-action="generate-questions">生成问题</button>
          </div>
          <div id="interviewQuestionResult" class="tool-result empty-mini">点击生成后，将展示可直接用于面试的行为问题与追问。</div>
        </section>
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-action="close-modal">取消</button>
        <button class="btn primary" type="submit">保存职位</button>
      </div>
    </form>
  `);

  const form = document.querySelector("#jobForm");
  form.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tool-action]");
    if (!button) return;
    const payload = getJobFormPayload(form);
    if (button.dataset.toolAction === "optimize-jd") {
      const result = renderJdOptimization(payload);
      const resultNode = document.querySelector("#jdOptimizerResult");
      resultNode.classList.remove("empty-mini");
      resultNode.innerHTML = result.html;
      resultNode.dataset.optimizedDescription = result.description;
      toast("已生成岗位优化建议");
    }
    if (button.dataset.toolAction === "apply-jd-description") {
      const resultNode = document.querySelector("#jdOptimizerResult");
      const optimizedDescription = resultNode.dataset.optimizedDescription;
      if (!optimizedDescription) {
        toast("请先生成优化建议");
        return;
      }
      form.elements.description.value = optimizedDescription;
      form.elements.description.focus();
      toast("已覆盖到职位描述");
    }
    if (button.dataset.toolAction === "generate-questions") {
      document.querySelector("#interviewQuestionResult").classList.remove("empty-mini");
      document.querySelector("#interviewQuestionResult").innerHTML = renderInterviewQuestions(payload);
      toast("已生成推荐面试问题");
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = getJobFormPayload(event.currentTarget);
    if (isEdit) {
      Object.assign(job, payload, { salaryData: null });
      toast("职位已更新");
    } else {
      const id = `job_${Date.now()}`;
      state.jobs.unshift({
        id,
        ...payload,
        isPinned: false,
        resumeCount: 0,
        salaryData: null,
      });
      state.candidates[id] = [];
      state.currentJobId = id;
      toast("职位已新增");
    }
    saveState();
    closeModal();
    render();
  });
}

function getJobFormPayload(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function normalizeKeywords(keywords = "") {
  return keywords
    .split(/[、,，;；\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function renderJdOptimization(job) {
  const keywords = normalizeKeywords(job.keywords);
  const primaryKeywords = keywords.slice(0, 3);
  const title = `${job.title || "目标岗位"}｜${job.location || "核心城市"}｜${job.level || "关键岗位"}`;
  const highlights = [
    `聚焦 ${primaryKeywords.join("、") || "核心能力"}，明确候选人需要解决的关键业务问题。`,
    `突出 ${job.dept || "业务部门"} 的协同场景，强化岗位价值和成长空间。`,
    `将“${job.experience || "相关"}经验”转化为可验证的项目、指标和团队协作要求。`,
  ];
  const optimizedDescription = `负责${job.dept || "相关业务"}${job.title || "岗位"}工作，围绕${primaryKeywords.join("、") || "关键任务"}建立清晰推进机制；结合业务目标完成诊断、方案设计、跨团队协同与结果复盘，持续提升组织效率和交付质量。`;

  return {
    description: optimizedDescription,
    html: `
      <div class="tool-block">
        <span class="tool-label">推荐标题</span>
        <strong>${escapeHtml(title)}</strong>
      </div>
      <div class="tool-block">
        <span class="tool-label">关键词优化</span>
        <div class="kv">${(primaryKeywords.length ? primaryKeywords : ["业务理解", "协同推进", "结果复盘"]).map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}</div>
      </div>
      <div class="tool-block">
        <div class="row-between">
          <span class="tool-label">优化描述</span>
          <button class="btn ghost compact" type="button" data-tool-action="apply-jd-description">一键覆盖职位描述</button>
        </div>
        <p>${escapeHtml(optimizedDescription)}</p>
      </div>
      <ol class="tool-list">
        ${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ol>
    `,
  };
}

function renderInterviewQuestions(job) {
  const keywords = normalizeKeywords(job.keywords);
  const questionKeywords = keywords.length ? keywords : ["业务理解", "项目推动", "团队协作"];
  const questions = questionKeywords.slice(0, 5).map((keyword, index) => ({
    title: `${index + 1}. ${keyword}能力验证`,
    text: `请分享一个你在“${keyword}”相关场景中主导或深度参与的案例：目标是什么、你做了哪些关键动作、最终结果如何？`,
    probe: `追问：如果重新做一次，你会如何优化节奏、资源协调或结果衡量方式？`,
  }));
  questions.push({
    title: `${questions.length + 1}. 岗位匹配度验证`,
    text: `结合你对 ${job.title || "该岗位"} 的理解，你认为入职前 90 天最应该优先解决哪三个问题？`,
    probe: `追问：你会用哪些指标判断自己已经产生价值？`,
  });

  return `
    <div class="question-list">
      ${questions
        .map(
          (question) => `
            <article class="question-item">
              <strong>${escapeHtml(question.title)}</strong>
              <p>${escapeHtml(question.text)}</p>
              <span>${escapeHtml(question.probe)}</span>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function field(name, label, value, placeholder, full = false) {
  return `
    <label class="form-field ${full ? "full" : ""}">
      <span>${label}</span>
      <input name="${name}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" required />
    </label>
  `;
}

function renderKeyPointAnalysis(items) {
  return `
    <div>
      <span class="meta">关键考核点分析</span>
      <div class="analysis-list" style="margin-top: 8px;">
        ${items
          .map(
            (item) => `
              <div class="analysis-item">
                <div class="row-between">
                  <strong>${escapeHtml(item.keyword)}</strong>
                  <span class="badge ${item.matched ? "green" : "gray"}">${item.matched ? "已覆盖" : "待核验"}</span>
                </div>
                <p>${escapeHtml(item.evidence)}</p>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderCandidateInterviewQuestions(questions) {
  return `
    <div>
      <span class="meta">个性化面试问题</span>
      <div class="question-list" style="margin-top: 8px;">
        ${questions
          .map(
            (question, index) => `
              <article class="question-item">
                <strong>${index + 1}. ${escapeHtml(question.title)}</strong>
                <p>${escapeHtml(question.text)}</p>
                <span>${escapeHtml(question.probe)}</span>
              </article>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function openCandidateModal() {
  openModal(`
    <form id="candidateForm">
      <div class="modal-head">
        <h3>上传/录入简历</h3>
        <button class="btn" type="button" data-action="close-modal">关闭</button>
      </div>
      <div class="modal-body form-grid">
        ${field("name", "候选人姓名（文本录入时必填）", "", "例如：张悦；批量上传可留空")}
        ${field("source", "来源渠道", "本地上传", "例如：智联 / BOSS直聘 / 内推")}
        <label class="form-field full">
          <span>上传简历文件（支持单个或多个）</span>
          <input class="file-input" name="resumeFiles" type="file" multiple accept=".txt,.md,.pdf,.doc,.docx,.rtf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.heif,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
          <small class="helper-text">离线模式下可读取 TXT/Markdown 文本内容；PDF、Word、图片会记录文件信息并基于文件名与岗位关键点做初步分析。后续如接入解析库，可提取全文。</small>
        </label>
        <label class="form-field full">
          <span>简历文本</span>
          <textarea name="resumeText" placeholder="也可以直接粘贴简历文本；若同时上传文件，会作为补充文本参与分析"></textarea>
        </label>
      </div>
      <div class="modal-foot">
        <button class="btn" type="button" data-action="close-modal">取消</button>
        <button class="btn primary" type="submit">分析并生成候选人</button>
      </div>
    </form>
  `);

  document.querySelector("#candidateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = formData.get("name").trim();
    const source = formData.get("source").trim() || "本地上传";
    const resumeText = formData.get("resumeText").trim();
    const files = Array.from(form.elements.resumeFiles.files || []);

    if (!resumeText && !files.length) {
      toast("请粘贴简历文本或上传简历文件");
      return;
    }
    if (!files.length && !name) {
      toast("文本录入请填写候选人姓名");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = "分析中...";

    try {
      const currentJob = getCurrentJob();
      const candidateInputs = files.length
        ? await Promise.all(files.map((file) => buildCandidateInputFromFile(file, { name, source, resumeText })))
        : [{ name, source, resumeText, fileMeta: null }];
      const candidates = candidateInputs.map((input) => createCandidateFromInput(input, currentJob));

      state.candidates[state.currentJobId].unshift(...candidates);
      selectedCandidateId = candidates[0]?.id || null;
      saveState();
      closeModal();
      render();
      toast(`已分析 ${candidates.length} 份简历`);
    } catch (error) {
      console.error("简历分析失败", error);
      toast("简历分析失败，请重试");
      submitButton.disabled = false;
      submitButton.textContent = "分析并生成候选人";
    }
  });
}

function buildCandidateInputFromFile(file, fallback) {
  return readResumeFile(file).then((fileText) => {
    const fileName = file.name.replace(/\.[^.]+$/, "");
    const textParts = [fileText, fallback.resumeText].filter(Boolean);
    const resumeText = textParts.length
      ? textParts.join("\n\n--- 补充文本 ---\n")
      : `文件名：${file.name}
文件类型：${file.type || "未知"}
文件大小：${Math.max(1, Math.round(file.size / 1024))}KB
离线预览：当前浏览器未提取该文件正文，请在面试前核验原始文件。`;
    return {
      name: fallback.name || inferCandidateName(fileName),
      source: fallback.source || "本地上传",
      resumeText,
      fileMeta: {
        name: file.name,
        type: file.type || "未知格式",
        size: file.size,
      },
    };
  });
}

function readResumeFile(file) {
  const textLike = /^(text\/|application\/(json|xml))/.test(file.type) || /\.(txt|md|csv|json|rtf)$/i.test(file.name);
  if (!textLike) return Promise.resolve("");
  return file.text().catch(() => "");
}

function inferCandidateName(fileName) {
  return fileName
    .replace(/简历|个人|求职|resume|cv/gi, "")
    .replace(/[\-_（）()\[\]【】]+/g, " ")
    .trim()
    .split(/\s+/)[0]
    || fileName
    || "未命名候选人";
}

function createCandidateFromInput(input, job) {
  const result = evaluateResume(input.resumeText, job);
  return {
    id: `c_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name: input.name,
    source: input.fileMeta ? `${input.source} · ${input.fileMeta.name}` : input.source,
    score: result.score,
    conclusion: result.conclusion,
    reason: result.reason,
    resumeText: input.resumeText,
    uploadTime: new Date().toLocaleDateString("zh-CN"),
    fileMeta: input.fileMeta,
    keyPointAnalysis: result.keyPointAnalysis,
    interviewQuestions: result.interviewQuestions,
  };
}

function evaluateResume(text, job) {
  const normalizedText = text || "";
  const keywords = normalizeKeywords(job.keywords);
  const keyPoints = keywords.length ? keywords : [job.title, job.level, job.experience].filter(Boolean);
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

function buildKeyPointAnalysis(keyPoints, resumeText, job) {
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

function buildPersonalInterviewQuestions(keyPointAnalysis, job, conclusion) {
  const missed = keyPointAnalysis.filter((item) => !item.matched).slice(0, 2);
  const matched = keyPointAnalysis.filter((item) => item.matched).slice(0, 3);
  const source = missed.length ? missed : matched;
  const questions = source.map((item) => ({
    title: `${item.keyword} 深度追问`,
    text: `请结合过往经历讲一个与“${item.keyword}”相关的完整案例，你的角色、关键动作和结果分别是什么？`,
    probe: item.matched
      ? "追问：这个结果如何量化？如果扩大到更复杂团队，你会怎么复制？"
      : "追问：如果入职后必须快速补齐这一点，你的前 30 天行动计划是什么？",
  }));
  questions.push({
    title: `${job.title} 岗位适配`,
    text: `基于你对该岗位的理解，你认为当前最关键的业务挑战是什么？你会如何切入？`,
    probe: `追问：如果最终结论是“${conclusion}”，你认为自己最能支撑这个判断的证据是什么？`,
  });
  return questions;
}

function openModal(html) {
  modalRoot.innerHTML = `<div class="modal">${html}</div>`;
  modalRoot.hidden = false;
}

function closeModal() {
  modalRoot.hidden = true;
  modalRoot.innerHTML = "";
}

function toast(message) {
  const oldToast = document.querySelector(".toast");
  oldToast?.remove();
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), 2200);
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `recruitment-workbench-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function resetDemo() {
  if (!confirm("确认重置为初始示例数据？当前本地数据会被覆盖。")) return;
  state = structuredClone(sampleState);
  saveState();
  selectedCandidateId = null;
  render();
  toast("示例数据已重置");
}

function addSeedCandidate() {
  const names = ["韩若曦", "梁旭", "苏瑾", "穆辰", "顾言"];
  const job = getCurrentJob();
  const name = names[Math.floor(Math.random() * names.length)];
  const resumeText = `${name}｜${job.experience}相关经验\n曾负责${job.keywords}相关工作，参与业务协同、流程优化与关键项目推动，具备较好的沟通与落地能力。`;
  const result = evaluateResume(resumeText, job);
  state.candidates[job.id].unshift({
    id: `c_${Date.now()}`,
    name,
    source: "模拟导入",
    score: result.score,
    conclusion: result.conclusion,
    reason: result.reason,
    resumeText,
    uploadTime: new Date().toLocaleDateString("zh-CN"),
  });
  saveState();
  render();
  toast("已模拟新增一份简历");
}

function drawFunnel(candidates) {
  const chart = initChart("funnelChart");
  if (!chart) return;
  const recommended = candidates.filter((candidate) => candidate.score >= 70).length;
  const interview = candidates.filter((candidate) => candidate.conclusion.includes("推荐")).length;
  const high = candidates.filter((candidate) => candidate.score >= 85).length;
  chart.setOption({
    color: ["#0F4C3A", "#1A6B4A", "#65A47D", "#A8CDB8"],
    tooltip: { trigger: "item" },
    series: [
      {
        type: "funnel",
        left: "8%",
        top: 24,
        bottom: 24,
        width: "84%",
        minSize: "30%",
        maxSize: "100%",
        sort: "descending",
        label: { color: "#18231f", fontWeight: 700 },
        itemStyle: { borderColor: "#fff", borderWidth: 2 },
        data: [
          { name: "简历入库", value: candidates.length },
          { name: "初筛通过", value: Math.max(recommended, interview) },
          { name: "推荐面试", value: interview },
          { name: "强匹配", value: high },
        ],
      },
    ],
  });
}

function drawJobBars() {
  const chart = initChart("jobBarChart");
  if (!chart) return;
  chart.setOption({
    color: ["#1A6B4A"],
    grid: { left: 36, right: 18, top: 28, bottom: 48 },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      data: state.jobs.map((job) => job.title),
      axisLabel: { color: "#66736e" },
      axisLine: { lineStyle: { color: "#dce5e1" } },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      axisLabel: { color: "#66736e" },
      splitLine: { lineStyle: { color: "#edf2f0" } },
    },
    series: [
      {
        name: "简历数",
        type: "bar",
        barWidth: 32,
        borderRadius: [8, 8, 0, 0],
        data: state.jobs.map((job) => getCandidates(job.id).length),
      },
    ],
  });
}

function drawSalaryRange(data) {
  const chart = initChart("salaryRangeChart");
  if (!chart) return;
  chart.setOption({
    color: ["#A8CDB8", "#1A6B4A", "#0F4C3A"],
    tooltip: { trigger: "axis" },
    legend: { top: 8, textStyle: { color: "#66736e" } },
    grid: { left: 38, right: 18, top: 52, bottom: 38 },
    xAxis: {
      type: "category",
      data: data.cities.map((item) => item.city),
      axisLine: { lineStyle: { color: "#dce5e1" } },
    },
    yAxis: {
      type: "value",
      axisLabel: { formatter: "{value}k", color: "#66736e" },
      splitLine: { lineStyle: { color: "#edf2f0" } },
    },
    series: [
      { name: "低位", type: "bar", data: data.cities.map((item) => item.low) },
      { name: "中位", type: "bar", data: data.cities.map((item) => item.mid) },
      { name: "高位", type: "bar", data: data.cities.map((item) => item.high) },
    ],
  });
}

function drawSalaryPie(data) {
  const chart = initChart("salaryPieChart");
  if (!chart) return;
  chart.setOption({
    color: ["#0F4C3A", "#1A6B4A", "#65A47D", "#A8CDB8"],
    tooltip: { trigger: "item", formatter: "{b}: {c}k" },
    series: [
      {
        type: "pie",
        radius: ["46%", "72%"],
        center: ["50%", "54%"],
        label: { formatter: "{b}\n{c}k", color: "#18231f" },
        data: data.channels,
      },
    ],
  });
}

function initChart(id) {
  const element = document.getElementById(id);
  if (!element || !window.echarts) return null;
  const chart = echarts.init(element);
  chartInstances.push(chart);
  return chart;
}

function disposeCharts() {
  chartInstances.forEach((chart) => chart.dispose());
  chartInstances = [];
}

window.addEventListener("resize", () => {
  chartInstances.forEach((chart) => chart.resize());
});

jobSelect.addEventListener("change", (event) => {
  state.currentJobId = event.target.value;
  prioritizeJob(state.currentJobId);
  saveState();
  selectedCandidateId = null;
  render();
});

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

app.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  const jobCard = event.target.closest("[data-job-id]");
  const viewJump = event.target.closest("[data-view-jump]");

  if (viewJump) {
    setView(viewJump.dataset.viewJump);
    return;
  }

  if (jobCard && !actionTarget) {
    state.currentJobId = jobCard.dataset.jobId;
    prioritizeJob(state.currentJobId);
    saveState();
    render();
    return;
  }

  if (!actionTarget) return;

  const action = actionTarget.dataset.action;
  const currentJob = getCurrentJob();
  const candidates = getCandidates();

  const handlers = {
    "open-job-modal": () => openJobModal(),
    "edit-current-job": () => openJobModal(currentJob),
    "open-candidate-modal": () => openCandidateModal(),
    "export-json": () => exportJson(),
    "reset-demo": () => resetDemo(),
    "seed-candidate": () => addSeedCandidate(),
    "delete-current-job": () => {
      if (state.jobs.length <= 1) {
        toast("至少保留一个职位");
        return;
      }
      if (!confirm(`确认删除职位“${currentJob.title}”？关联候选人也会删除。`)) return;
      state.jobs = state.jobs.filter((job) => job.id !== currentJob.id);
      delete state.candidates[currentJob.id];
      state.currentJobId = state.jobs[0].id;
      saveState();
      render();
      toast("职位已删除");
    },
    "select-candidate": () => {
      selectedCandidateId = actionTarget.dataset.candidateId;
      render();
    },
    "sort-candidates": () => {
      state.candidates[state.currentJobId] = candidates.slice().sort((a, b) => b.score - a.score);
      selectedCandidateId = state.candidates[state.currentJobId][0]?.id || null;
      saveState();
      render();
      toast("已按匹配分排序");
    },
    "mark-interview": () => {
      const candidate = candidates.find((item) => item.id === selectedCandidateId);
      if (!candidate) return;
      candidate.conclusion = "已邀面试";
      candidate.score = Math.max(candidate.score, 75);
      saveState();
      render();
      toast("已标记为面试");
    },
    "delete-candidate": () => {
      if (!selectedCandidateId) return;
      if (!confirm("确认删除该候选人？")) return;
      state.candidates[state.currentJobId] = candidates.filter((candidate) => candidate.id !== selectedCandidateId);
      selectedCandidateId = null;
      saveState();
      render();
      toast("候选人已删除");
    },
    "refresh-salary": () => {
      currentJob.salaryData = generateSalaryData({ ...currentJob, id: `${currentJob.id}_${Date.now()}` });
      saveState();
      render();
      toast("薪酬调研数据已刷新");
    },
    "apply-salary-note": () => {
      const data = currentJob.salaryData || generateSalaryData(currentJob);
      toast(`建议以 ${formatMoney(data.p50)} 作为薪资沟通锚点`);
    },
  };

  handlers[action]?.();
});

modalRoot.addEventListener("click", (event) => {
  if (event.target === modalRoot || event.target.closest('[data-action="close-modal"]')) {
    closeModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modalRoot.hidden) closeModal();
});

async function initApp() {
  app.innerHTML = `<section class="card pad"><p class="helper-text">正在加载 IndexedDB 本地数据库...</p></section>`;
  state = await loadState();
  render();
}

initApp();
