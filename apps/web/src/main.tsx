import React, { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as echarts from "echarts";
import { api, type JobCopilotResult, type JobPayload, type ResumeUploadPayload } from "./api";
import type { AppState, Candidate, CandidateInterviewPlan, CandidateInterviewPlanQuestion, InterviewMethodKey, Job, ResumeFilePayload, SalaryData, SalaryFilters, VoiceAnalysis, VoiceFinalEvaluation, VoiceFollowUpPlan, VoiceRecruiterCoachReport, VoiceSegmentInsight } from "./types";
import "./styles.css";

const views = [
  ["dashboard", "工作台概览", "◎"],
  ["jobs", "职位管理", "▦"],
  ["candidates", "简历甄选", "◉"],
  ["interviews", "面试管理", "◌"],
  ["voice", "访音解析", "◇"],
  ["salary", "薪酬调研", "⌁"],
] as const;

type View = (typeof views)[number][0];

type VoiceSessionStatus = "idle" | "listening" | "paused" | "stopped";
type VoiceRecommendation = "建议推进" | "建议复核" | "暂缓推进";
type VoiceReviewLevel = "良好" | "注意" | "待优化";

interface VoiceRealtimeAnalysis {
  summary: string;
  jobFitAdvice: string;
  communicationStrengths: string[];
  communicationRisks: string[];
  recruiterSuggestions: string[];
  recruiterReview: Array<{ title: string; level: VoiceReviewLevel; text: string }>;
  recommendation: VoiceRecommendation;
}

interface VoiceAiLiveState {
  quickInsight: VoiceSegmentInsight;
  followUp: VoiceFollowUpPlan;
}

type Modal =
  | { type: "job"; job?: Job }
  | { type: "resume" }
  | null;

type AnalyticsGranularity = "month" | "quarter" | "year";

const durationPyramidTones = [
  { top: "#92C8AE", left: "#1A6B4A", right: "#2E7D59" },
  { top: "#A8D2BC", left: "#3B8866", right: "#5C9E7D" },
  { top: "#BEDDCD", left: "#5A9A79", right: "#79B093" },
  { top: "#D6EADF", left: "#89B99F", right: "#A3CAB3" },
];
const durationPyramidWidths = ["100%", "86%", "74%", "62%"];

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [activeInterviewStage, setActiveInterviewStage] = useState<InterviewStage>("初试");
  const [activeInterviewJobId, setActiveInterviewJobId] = useState<string>("all");
  const [activeInterviewMonth, setActiveInterviewMonth] = useState<string>("all");
  const [salaryData, setSalaryData] = useState<SalaryData | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    api.state().then(setState).catch((error) => showToast(`加载失败：${error.message}`));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (message: string) => setToast(message);

  const currentJob = useMemo(() => {
    if (!state) return null;
    return state.jobs.find((job) => job.id === state.currentJobId) || state.jobs[0] || null;
  }, [state]);

  const currentCandidates = currentJob && state ? state.candidates[currentJob.id] || [] : [];
  const interviewCandidates = useMemo(() => {
    if (!state) return [] as Candidate[];
    const sourceJobs = activeInterviewJobId === "all"
      ? state.jobs.filter((job) => job.status === "招聘中")
      : state.jobs.filter((job) => job.id === activeInterviewJobId);

    return sourceJobs.flatMap((job) =>
      (state.candidates[job.id] || []).map((candidate) => ({ ...candidate, jobId: job.id }))
    );
  }, [state, activeInterviewJobId]);

  const setRemoteState = (next: AppState) => {
    setState(next);
    const candidates = next.candidates[next.currentJobId] || [];
    setSelectedCandidateId((id) => (id && candidates.some((candidate) => candidate.id === id) ? id : candidates[0]?.id || null));
  };

  async function changeJob(jobId: string) {
    const next = await api.setCurrentJob(jobId);
    setRemoteState(next);
    setActiveInterviewJobId(jobId);
  }

  async function deleteJob(job: Job) {
    if (!window.confirm(`确认删除职位“${job.title}”？关联候选人也会删除。`)) return;
    const next = await api.deleteJob(job.id);
    setRemoteState(next);
    showToast("职位已删除");
  }

  async function closeJob(job: Job) {
    if (!window.confirm(`确认关闭职位“${job.title}”？关闭后将从进行中岗位下拉中移除，但历史数据会保留。`)) return false;
    const next = await api.closeJob(job.id);
    setRemoteState(next);
    showToast("职位已关闭并归档");
    return true;
  }

  async function resetDemo() {
    if (!window.confirm("确认重置为初始示例数据？当前 SQLite 数据会被覆盖。")) return;
    const next = await api.reset();
    setRemoteState(next);
    showToast("示例数据已重置");
  }

  async function markInterview(candidateId?: string) {
    const targetCandidateId = candidateId || selectedCandidateId || currentCandidates[0]?.id;
    if (!targetCandidateId) return;
    const next = await api.markInterview(targetCandidateId);
    setRemoteState(next);
    setSelectedCandidateId(targetCandidateId);
    setActiveInterviewStage("初试");
    setActiveInterviewJobId(currentJob?.id || "all");
    setActiveInterviewMonth("all");
    setActiveView("interviews");
    showToast("已标记为面试，已进入初试");
  }

  async function deleteCandidate() {
    if (!selectedCandidateId || !window.confirm("确认删除该候选人？")) return;
    const next = await api.deleteCandidate(selectedCandidateId);
    setRemoteState(next);
    showToast("候选人已删除");
  }

  async function updateInterviewStage(
    candidateId: string,
    interviewStage: NonNullable<Candidate["interviewStage"]>,
    stageRecommendation: NonNullable<Candidate["stageRecommendation"]>,
    interviewResult: NonNullable<Candidate["interviewResult"]>,
    onboarded: NonNullable<Candidate["onboarded"]>,
    reportMonth: string,
    interviewReason: string,
    reasonTags: string[],
    interviewTimeline: NonNullable<Candidate["interviewTimeline"]>,
  ) {
    const next = await api.updateInterviewStage(candidateId, { interviewStage, stageRecommendation, interviewResult, onboarded, reportMonth, interviewReason, reasonTags, interviewTimeline });
    setRemoteState(next);
    showToast("面试阶段已保存");
  }

  async function refreshSalary(filters: SalaryFilters) {
    const result = await api.researchSalary(filters);
    setSalaryData(result.salaryData);
    showToast("薪酬调研数据已刷新");
  }

  const ongoingJobs = state?.jobs.filter((job) => job.status === "招聘中") || [];

  useEffect(() => {
    if (!ongoingJobs.length) {
      setActiveInterviewJobId("all");
      return;
    }
    if (activeInterviewJobId !== "all" && !ongoingJobs.some((job) => job.id === activeInterviewJobId)) {
      setActiveInterviewJobId("all");
    }
  }, [activeInterviewJobId, ongoingJobs]);

  if (!state || !currentJob) {
    return <div className="loading">正在连接本地 SQLite 服务...</div>;
  }

  const title = views.find(([view]) => view === activeView)?.[1] || "工作台概览";
  const showJobSwitcher = activeView === "jobs" || activeView === "candidates";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><SquirrelLogo /></div>
          <div><h1>小松鼠</h1><p>Workbench</p></div>
        </div>
        <nav className="nav" aria-label="主导航">
          {views.map(([view, label, icon]) => (
            <button key={view} className={`nav-item ${activeView === view ? "active" : ""}`} onClick={() => setActiveView(view)}>
              <span className="nav-icon">{icon}</span><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer"><span className="online-dot" /><span>SQLite 本地服务</span></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><p className="eyebrow">Recruitment Workbench</p><h2>{title}</h2></div>
          <div className="user-panel">
            {showJobSwitcher && (
              <JobSearchSwitcher
                jobs={ongoingJobs}
                currentJob={currentJob.status === "招聘中" ? currentJob : ongoingJobs[0] || null}
                onChange={changeJob}
              />
            )}
            <div className="avatar">{state.currentUser.slice(0, 1)}</div>
            <div><strong>{state.currentUser}</strong><span>HR 负责人</span></div>
          </div>
        </header>

        <section className="content">
          {activeView === "dashboard" && <Dashboard state={state} currentJob={currentJob} onJump={setActiveView} onReset={resetDemo} onSelectJob={changeJob} />}
          {activeView === "jobs" && <JobsView state={state} currentJob={currentJob} onSelect={changeJob} onEdit={(job) => setModal({ type: "job", job })} onCreate={() => setModal({ type: "job" })} onCloseJob={closeJob} onDelete={deleteJob} />}
          {activeView === "candidates" && <CandidatesView candidates={currentCandidates} selectedId={selectedCandidateId} onSelect={setSelectedCandidateId} onUpload={() => setModal({ type: "resume" })} onMark={markInterview} onDelete={deleteCandidate} currentJob={currentJob} onStateChange={setRemoteState} />}
          {activeView === "interviews" && <InterviewsView jobs={ongoingJobs} selectedJobId={activeInterviewJobId} onJobChange={setActiveInterviewJobId} selectedMonth={activeInterviewMonth} onMonthChange={setActiveInterviewMonth} activeStage={activeInterviewStage} candidates={interviewCandidates} onStageChange={setActiveInterviewStage} onSaveStage={updateInterviewStage} />}
          {activeView === "voice" && (
            <VoiceParseView
              jobs={state.jobs}
              currentJob={currentJob}
              candidatesByJob={state.candidates}
              voiceAnalysesByJob={state.voiceAnalyses}
              onStateChange={setRemoteState}
              onToast={showToast}
            />
          )}
          {activeView === "salary" && <SalaryView data={salaryData} onRefresh={refreshSalary} />}
        </section>
      </main>

      {modal?.type === "job" && <JobModal job={modal.job} onClose={() => setModal(null)} onSaved={(next) => { setModal(null); setRemoteState(next); showToast(modal.job ? "职位已更新" : "职位已新增"); }} />}
      {modal?.type === "resume" && <ResumeModal job={currentJob} onClose={() => setModal(null)} onSaved={(next) => { setModal(null); setRemoteState(next); showToast("简历分析完成"); }} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function JobSearchSwitcher({
  jobs,
  currentJob,
  onChange,
  label = "当前进行中岗位",
  placeholder = "输入岗位名称搜索",
}: {
  jobs: Job[];
  currentJob: Job | null;
  onChange: (id: string) => void;
  label?: string;
  placeholder?: string;
}) {
  const selectedLabel = currentJob ? formatJobOption(currentJob) : "";
  const inputId = useId();
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keepAllOnFocusRef = useRef(false);

  useEffect(() => {
    if (!open) setQuery(selectedLabel);
  }, [open, selectedLabel]);

  const keyword = query.trim().toLowerCase();
  const filteredJobs = keyword && !showAll
    ? jobs.filter((job) => `${job.title} ${job.dept} ${job.location}`.toLowerCase().includes(keyword))
    : jobs;

  const selectJob = (job: Job) => {
    setQuery(formatJobOption(job));
    setOpen(false);
    setShowAll(false);
    onChange(job.id);
  };

  const commitFirstMatch = () => {
    if (filteredJobs[0]) selectJob(filteredJobs[0]);
  };

  const toggleAllJobs = () => {
    if (!jobs.length) return;
    const shouldOpen = !open || !showAll;
    keepAllOnFocusRef.current = shouldOpen;
    setOpen(shouldOpen);
    setShowAll(shouldOpen);
    if (shouldOpen) inputRef.current?.focus();
  };

  return (
    <div className="job-switcher job-search">
      <label htmlFor={inputId}>{label}</label>
      <div className="job-search-box">
        <input
          ref={inputRef}
          id={inputId}
          value={query}
          placeholder={jobs.length ? placeholder : "暂无可选岗位"}
          disabled={!jobs.length}
          autoComplete="off"
          onFocus={() => {
            setOpen(true);
            if (!keepAllOnFocusRef.current) setShowAll(false);
            keepAllOnFocusRef.current = false;
          }}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); setShowAll(false); }}
          onBlur={() => window.setTimeout(() => { setOpen(false); setShowAll(false); }, 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitFirstMatch();
            }
          }}
        />
        <button
          type="button"
          className="job-search-arrow"
          aria-label="展开岗位列表"
          disabled={!jobs.length}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleAllJobs}
        >
          ⌄
        </button>
        {open && jobs.length > 0 && (
          <div className="job-search-menu">
            {filteredJobs.length ? filteredJobs.map((job) => (
              <button
                type="button"
                key={job.id}
                className={`job-search-option ${job.id === currentJob?.id ? "active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectJob(job)}
              >
                <strong>{job.title}</strong>
                <span>{job.dept} · {job.location}</span>
              </button>
            )) : <div className="job-search-empty">未找到匹配岗位</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function EditableOptionSwitcher({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const keepAllOnFocusRef = useRef(false);
  const mergedOptions = Array.from(new Set([value, ...options].filter(Boolean)));

  useEffect(() => {
    if (!open) setQuery(value);
  }, [open, value]);

  const keyword = query.trim().toLowerCase();
  const filteredOptions = keyword && !showAll
    ? mergedOptions.filter((option) => option.toLowerCase().includes(keyword))
    : mergedOptions;

  const selectOption = (option: string) => {
    setQuery(option);
    setOpen(false);
    setShowAll(false);
    onChange(option);
  };

  const commitQuery = () => {
    const next = query.trim();
    if (!next) return;
    if (filteredOptions[0]) {
      selectOption(filteredOptions[0]);
      return;
    }
    setQuery(next);
    setOpen(false);
    setShowAll(false);
    onChange(next);
  };

  const toggleAllOptions = () => {
    if (!mergedOptions.length) return;
    const shouldOpen = !open || !showAll;
    keepAllOnFocusRef.current = shouldOpen;
    setOpen(shouldOpen);
    setShowAll(shouldOpen);
    if (shouldOpen) inputRef.current?.focus();
  };

  return (
    <div className="job-switcher job-search">
      <label>{label}</label>
      <div className="job-search-box">
        <input
          ref={inputRef}
          value={query}
          placeholder={placeholder}
          autoComplete="off"
          onFocus={() => {
            setOpen(true);
            if (!keepAllOnFocusRef.current) setShowAll(false);
            keepAllOnFocusRef.current = false;
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            onChange(event.target.value);
            setOpen(true);
            setShowAll(false);
          }}
          onBlur={() => window.setTimeout(() => {
            const next = query.trim();
            if (next) onChange(next);
            setOpen(false);
            setShowAll(false);
          }, 120)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitQuery();
            }
          }}
        />
        <button
          type="button"
          className="job-search-arrow"
          aria-label={`展开${label}列表`}
          disabled={!mergedOptions.length}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggleAllOptions}
        >
          ⌄
        </button>
        {open && mergedOptions.length > 0 && (
          <div className="job-search-menu">
            {filteredOptions.length ? filteredOptions.map((option) => (
              <button
                type="button"
                key={option}
                className={`job-search-option ${option === value ? "active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option)}
              >
                <strong>{option}</strong>
              </button>
            )) : <div className="job-search-empty">未找到匹配选项，可直接输入使用</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function formatJobOption(job: Job) {
  return `${job.title} · ${job.location}`;
}

function Dashboard({ state, currentJob, onJump, onReset, onSelectJob }: { state: AppState; currentJob: Job; onJump: (view: View) => void; onReset: () => void; onSelectJob: (jobId: string) => Promise<void> }) {
  const candidates = Object.values(state.candidates).flat();
  const [granularity, setGranularity] = useState<AnalyticsGranularity>("month");
  const periodOptions = useMemo(() => getAnalyticsPeriodOptions(candidates, granularity), [candidates, granularity]);
  const [selectedPeriod, setSelectedPeriod] = useState<string>(() => getLatestPeriodValue(candidates, "month") || "");
  const [focusJobId, setFocusJobId] = useState(currentJob.id);
  const [insightJobId, setInsightJobId] = useState<string>("all");
  const [selectedChannel, setSelectedChannel] = useState<string>("");

  useEffect(() => {
    if (!selectedPeriod || !periodOptions.some((option) => option.value === selectedPeriod)) {
      setSelectedPeriod(periodOptions[0]?.value || "");
    }
  }, [periodOptions, selectedPeriod]);

  useEffect(() => {
    setFocusJobId(currentJob.id);
  }, [currentJob.id]);

  const filteredCandidates = useMemo(() => {
    return candidates.filter((candidate) => getCandidatePeriodValue(candidate, granularity) === selectedPeriod);
  }, [candidates, granularity, selectedPeriod]);

  const overview = buildRecruitmentAnalytics(filteredCandidates);
  const activeJobs = state.jobs.filter((job) => job.status === "招聘中");
  const previousPeriod = getPreviousPeriodValue(selectedPeriod, granularity);
  const previousCandidates = useMemo(() => {
    if (!previousPeriod) return [] as Candidate[];
    return candidates.filter((candidate) => getCandidatePeriodValue(candidate, granularity) === previousPeriod);
  }, [candidates, granularity, previousPeriod]);
  const completedOffers = filteredCandidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "是").length;
  const pendingOffers = filteredCandidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "待入职").length;
  const insightCandidates = filterCandidatesByJobScope(filteredCandidates, insightJobId);
  const issueReview = buildIssueReview(insightCandidates);
  const channelAnalytics = buildChannelAnalytics(insightCandidates);
  const durationAnalytics = buildStageDurationAnalytics(insightCandidates);
  const durationBottleneck = durationAnalytics.rows
    .filter((item) => item.averageDays !== null)
    .sort((a, b) => Number(b.averageDays) - Number(a.averageDays))[0] || null;
  const durationAttention = durationAnalytics.rows.filter((item) => item.level === "risk" || item.level === "watch").slice(0, 2);
  const durationAbnormalRows = durationAnalytics.rows
    .filter((item) => item.level === "risk" || item.level === "watch")
    .sort((a, b) => {
      const aValue = a.averageDays ?? -1;
      const bValue = b.averageDays ?? -1;
      return bValue - aValue;
    })
    .slice(0, 3);
  const durationEmptyRows = durationAnalytics.rows.filter((item) => item.level === "empty").slice(0, 1);
  const durationPyramidRows = durationAnalytics.rows.slice(0, 4);
  const actionPlan = buildRecruitmentActionPlan({ activeJobs: insightJobId === "all" ? activeJobs : activeJobs.filter((job) => job.id === insightJobId), channelAnalytics, durationAnalytics, issueReview });
  const currentComparisonCandidates = filterCandidatesByJobScope(filteredCandidates, insightJobId);
  const previousComparisonCandidates = filterCandidatesByJobScope(previousCandidates, insightJobId);
  const periodComparison = buildPeriodComparison(currentComparisonCandidates, previousComparisonCandidates);
  const focusJob = state.jobs.find((job) => job.id === focusJobId) || currentJob;
  const focusJobAnalysis = buildFocusJobAnalysis(focusJob, filteredCandidates.filter((candidate) => candidate.jobId === focusJob.id));
  const pendingOnboardAnalytics = buildPendingOnboardReasonAnalytics(filteredCandidates, state.jobs);
  const insightJobOptions = activeJobs.filter((job) => (state.candidates[job.id] || []).some((candidate) => getCandidatePeriodValue(candidate, granularity) === selectedPeriod));

  useEffect(() => {
    if (insightJobId !== "all" && !activeJobs.some((job) => job.id === insightJobId)) {
      setInsightJobId("all");
    }
  }, [activeJobs, insightJobId]);

  useEffect(() => {
    if (!channelAnalytics.rows.length) {
      setSelectedChannel("");
      return;
    }
    if (!channelAnalytics.rows.some((item) => item.source === selectedChannel)) {
      setSelectedChannel(channelAnalytics.rows[0]?.source || "");
    }
  }, [channelAnalytics.rows, selectedChannel]);

  return (
    <>
      <div className="grid cols-4 dashboard-summary-grid">
        <section className="card dashboard-summary-card"><span className="dashboard-summary-label">招聘中岗位</span><strong className="dashboard-summary-value">{activeJobs.length}</strong><span className="dashboard-summary-extra">{selectedPeriod === "all" ? "当前在招" : `${formatAnalyticsGranularity(granularity)}筛选视角`}</span></section>
        <section className="card dashboard-summary-card"><span className="dashboard-summary-label">推荐简历总数</span><strong className="dashboard-summary-value">{overview.resumeTotal}</strong><span className="dashboard-summary-extra">{selectedPeriod === "all" ? "全部周期汇总" : `周期：${selectedPeriod}`}</span></section>
        <section className="card dashboard-summary-card"><span className="dashboard-summary-label">最终录用人数</span><strong className="dashboard-summary-value">{overview.hiredCount}</strong><span className="dashboard-summary-extra">{pendingOffers ? `${pendingOffers} 位待入职` : "已含入职转化"}</span></section>
        <section className="card dashboard-summary-card"><span className="dashboard-summary-label">实际入职人数</span><strong className="dashboard-summary-value">{completedOffers}</strong><span className="dashboard-summary-extra">{overview.resumeTotal ? `录用转化 ${formatPercent(overview.hiredCount, overview.resumeTotal)}` : "暂无数据"}</span></section>
      </div>

      <section className="card pad analytics-toolbar-card">
        <div className="toolbar analytics-toolbar">
          <div>
            <h3 className="card-title">招聘周期复盘</h3>
            <p className="helper-text">关联面试管理中的统计月份，用于月度、季度、年度招聘复盘与阶段漏斗分析。</p>
          </div>
          <div className="toolbar-right analytics-filters">
            <div className="segmented-control">
              {([
                ["month", "月数据"],
                ["quarter", "季度数据"],
                ["year", "年数据"],
              ] as Array<[AnalyticsGranularity, string]>).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`segment ${granularity === value ? "active" : ""}`}
                  onClick={() => setGranularity(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="interview-filter-field">
              <span>{granularity === "month" ? "统计月份" : granularity === "quarter" ? "统计季度" : "统计年份"}</span>
              <select value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>
                {periodOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <button className="btn ghost" onClick={onReset}>重置示例数据</button>
          </div>
        </div>
      </section>

      <section className="card pad analytics-toolbar-card">
        <div className="analytics-table-head">
          <div>
            <h3 className="card-title">{formatComparisonLabel(granularity)}</h3>
            <p className="helper-text">{selectedPeriod || "当前周期"} 对比 {previousPeriod || "上期暂无数据"}，仅看各环节通过率变化，避免被简历量淡旺季波动干扰。</p>
          </div>
          <div className="toolbar-right analytics-filters">
            <label className="interview-filter-field analytics-scope-field">
              <span>复盘范围</span>
              <select value={insightJobId} onChange={(event) => setInsightJobId(event.target.value)}>
                <option value="all">全部岗位</option>
                {insightJobOptions.map((job) => <option key={job.id} value={job.id}>{formatJobOption(job)}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="analytics-comparison-grid">
          {periodComparison.metrics.map((item) => (
            <article className={`analytics-comparison-card ${item.tone}`} key={item.label}>
              <span>{item.label}</span>
              <strong>{item.type === "rate" ? `${item.current.toFixed(1)}%` : item.current}</strong>
              <small>上期 {item.type === "rate" ? `${item.previous.toFixed(1)}%` : item.previous}</small>
              <em>{item.delta === 0 ? "持平" : `${item.delta > 0 ? "+" : ""}${item.type === "rate" ? `${item.delta.toFixed(1)}%` : item.delta}`}</em>
            </article>
          ))}
        </div>
        <div className="analytics-focus-summary">{periodComparison.summary}</div>
      </section>

      <div className="grid cols-2 analytics-grid">
        <section className="card pad analytics-funnel-card">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">招聘流程分析</h3>
              <p className="helper-text">按当前筛选周期统计招聘各阶段数量、占比与阶段通过率。</p>
            </div>
          </div>
          <div className="analytics-funnel-table-wrap">
            <table className="table analytics-funnel-table">
              <thead>
                <tr>
                  <th>招聘流程项目</th>
                  <th>数量</th>
                  <th>与简历总数比</th>
                  <th>各环节通过率</th>
                  <th>通过率说明</th>
                  <th>备注</th>
                </tr>
              </thead>
              <tbody>
                {overview.rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td><strong>{row.count}</strong></td>
                    <td>{row.share}</td>
                    <td>{row.conversion || "—"}</td>
                    <td>{row.conversionHint || "—"}</td>
                    <td>{row.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card analytics-landscape-card">
          <CardHeader title="招聘通过情况漏斗分析图" desc={selectedPeriod === "all" ? "全部周期汇总" : `${formatAnalyticsGranularity(granularity)}：${selectedPeriod}`} />
          <RecruitmentAnalyticsChart rows={overview.chartRows} />
        </section>
      </div>

      <div className="grid dashboard-job-analysis-stack">
        <div className="grid cols-2 dashboard-job-overview-grid">
          <section className="card"><CardHeader title="职位简历量" desc="所有在招岗位的简历量情况" /><JobBarChart jobs={activeJobs} /></section>
          <section className="card pad pending-onboard-card">
            <CardHeader title="复试通过后未入职原因占比" desc="按部门与面试管理 offer 标签统计全部岗位未入职原因；上表看部门问题分布，下图看整体原因占比。" />
            {pendingOnboardAnalytics.total ? (
              <div className="pending-onboard-layout">
                <div className="table-wrap pending-onboard-table-wrap">
                  <table className="table pending-onboard-table">
                    <thead>
                      <tr>
                        <th>部门</th>
                        {pendingOnboardAnalytics.reasonColumns.map((label) => <th key={label}>{label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {pendingOnboardAnalytics.departmentRows.map((row) => (
                        <tr key={row.department}>
                          <td><strong>{row.department}</strong></td>
                          {row.counts.map((count, index) => <td key={`${row.department}-${pendingOnboardAnalytics.reasonColumns[index]}`}>{count}</td>)}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td><strong>合计</strong></td>
                        {pendingOnboardAnalytics.totalRow.counts.map((count, index) => <td key={`total-${pendingOnboardAnalytics.reasonColumns[index]}`}><strong>{count}</strong></td>)}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <div className="pending-onboard-chart-wrap">
                  <div className="pending-onboard-total">
                    <span>标签总次数</span>
                    <strong>{pendingOnboardAnalytics.total}</strong>
                  </div>
                  <PendingOnboardDonutChart data={pendingOnboardAnalytics.chartData} />
                </div>
              </div>
            ) : (
              <div className="empty"><div><strong>暂无未入职数据</strong><br />当前筛选周期内暂未出现复试后仍未入职的人选。</div></div>
            )}
          </section>
        </div>
        <section className="card pad">
          <div className="row-between">
            <div>
              <h3 className="card-title">岗位简历数据分析</h3>
              <p className="helper-text">{focusJob.dept} · {focusJob.location}</p>
            </div>
            <Badge color={statusColor(focusJob.status)}>{focusJob.status}</Badge>
          </div>
          <div className="dashboard-focus-switcher">
            <JobSearchSwitcher
              jobs={activeJobs}
              currentJob={focusJob}
              onChange={(jobId) => {
                setFocusJobId(jobId);
                void onSelectJob(jobId);
              }}
            />
          </div>
          <div className="analytics-focus-panel">
            <div className="job-topline">
              <div>
                <h4>{focusJob.title}</h4>
                <span className="meta">{focusJob.salaryRange} · {focusJob.location} · {focusJob.experience}</span>
              </div>
              <strong>{focusJobAnalysis.resumeCount} 份</strong>
            </div>
            <KeywordList keywords={focusJob.keywords} />
            <div className="analytics-focus-grid">
              <section className="analytics-focus-card">
                <strong>岗位画像</strong>
                <ul>
                  <li>岗位级别：{focusJob.level}</li>
                  <li>重点考核点：{splitKeywords(focusJob.keywords).slice(0, 3).join("、") || "未填写"}</li>
                  <li>JD强度：{focusJobAnalysis.jdComplexity}</li>
                  <li>市场供给：{focusJobAnalysis.marketSignal}</li>
                </ul>
              </section>
              <section className="analytics-focus-card">
                <strong>简历表现</strong>
                <ul>
                  <li>推荐面试率：{focusJobAnalysis.inviteRate}</li>
                  <li>初试通过率：{focusJobAnalysis.firstPassRate}</li>
                  <li>复试通过率：{focusJobAnalysis.retestPassRate}</li>
                  <li>录用转化率：{focusJobAnalysis.hireRate}</li>
                </ul>
              </section>
              <section className="analytics-focus-card">
                <strong>影响因素分析</strong>
                <ul>{focusJobAnalysis.factors.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
              <section className="analytics-focus-card">
                <strong>招聘建议</strong>
                <ul>{focusJobAnalysis.suggestions.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
            </div>
            <div className="analytics-focus-summary">{focusJobAnalysis.summary}</div>
            <div className="toolbar-left">
              <button className="btn primary" onClick={() => onJump("candidates")}>查看候选人</button>
              <button className="btn" onClick={() => onJump("interviews")}>查看面试管理</button>
              <button className="btn" onClick={() => onJump("salary")}>查看薪酬调研</button>
            </div>
          </div>
        </section>
      </div>

      <div className="grid cols-1 dashboard-review-grid">
        <section className="card pad analytics-review-board">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">招聘问题复盘</h3>
              <p className="helper-text">聚焦未到面、淘汰、待入职与入职失败原因，支持后续复盘与动作调整。</p>
            </div>
          </div>
          <div className="analytics-review-layout">
            <div className="analytics-review-left">
              <section className="analytics-issue-card">
                <strong>流程风险分布</strong>
                <div className="analytics-issue-stats analytics-issue-stats-wide">
                  <div><span>未到面</span><strong>{issueReview.noShowCount}</strong></div>
                  <div><span>淘汰</span><strong>{issueReview.rejectedCount}</strong></div>
                  <div><span>待入职</span><strong>{issueReview.pendingOnboardCount}</strong></div>
                  <div><span>未入职</span><strong>{issueReview.failedOnboardCount}</strong></div>
                </div>
              </section>
              <section className="analytics-issue-card">
                <strong>高频问题标签</strong>
                <div className="analytics-tag-list">
                  {issueReview.topReasons.length ? issueReview.topReasons.map((item) => (
                    <span key={item.label}>{item.label} · {item.count}</span>
                  )) : <span>暂无可复盘原因</span>}
                </div>
              </section>
            </div>
            <div className="analytics-review-right">
              <section className="analytics-issue-card">
                <strong>复盘建议</strong>
                <ul>
                  {issueReview.suggestions.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </section>
              <section className="analytics-issue-card analytics-issue-summary-card">
                <strong>本期结论</strong>
                <p>{issueReview.summary}</p>
              </section>
            </div>
          </div>
        </section>
      </div>

      <div className="grid cols-2 dashboard-insight-grid">
        <section className="card pad analytics-funnel-card">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">渠道转化分析</h3>
              <p className="helper-text">按当前复盘范围查看招聘渠道的入库、面试推进、offer 与入职表现。</p>
            </div>
            {channelAnalytics.rows.length ? (
              <div className="toolbar-right analytics-filters">
                <label className="interview-filter-field analytics-scope-field">
                  <span>选择渠道</span>
                  <select value={selectedChannel} onChange={(event) => setSelectedChannel(event.target.value)}>
                    {channelAnalytics.rows.map((item) => <option key={item.source} value={item.source}>{item.source}</option>)}
                  </select>
                </label>
              </div>
            ) : null}
          </div>
          {channelAnalytics.rows.length ? (
            <>
              <div className="analytics-channel-grid">
                {channelAnalytics.rows.filter((item) => item.source === selectedChannel).map((item) => (
                  <article className="analytics-channel-card" key={item.source}>
                    <div className="analytics-channel-head">
                      <strong>{item.source}</strong>
                      <Badge color={item.onboardedCount > 0 ? "green" : item.firstPassCount > 0 ? "gold" : "gray"}>{item.resumeCount} 份</Badge>
                    </div>
                    <div className="analytics-channel-metrics">
                      <div><span>推荐初试</span><strong>{item.invitedCount}</strong></div>
                      <div><span>初试通过</span><strong>{item.firstPassCount}</strong></div>
                      <div><span>入职</span><strong>{item.onboardedCount}</strong></div>
                    </div>
                    <div className="analytics-channel-side">
                      <div className="analytics-channel-rates">
                        <span>推荐率 {item.inviteRate}</span>
                        <span>初试通过率 {item.firstPassRate}</span>
                        <span>入职转化 {item.onboardRate}</span>
                      </div>
                      <div className="analytics-channel-note">{item.summary}</div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : <div className="empty"><div><strong>暂无渠道数据</strong><br />请先上传简历并进入后续流程。</div></div>}
        </section>

        <section className="card pad analytics-funnel-card">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">阶段耗时分析</h3>
              <p className="helper-text">按当前复盘范围看每个招聘阶段平均耗时，快速识别最影响交付节奏的流程卡点。</p>
            </div>
          </div>
          <div className="analytics-duration-layout">
            <div className="analytics-duration-pyramid">
              {durationPyramidRows.map((item, index) => (
                <div className={`analytics-duration-tier tier-${index + 1}`} key={item.key}>
                  <div className={`analytics-duration-copy ${index % 2 === 1 ? "right" : "left"}`}>
                    <strong>{item.label}</strong>
                    <span>{item.averageDays !== null ? `平均 ${item.averageDays} 天 · ${item.sampleCount} 人样本` : "当前样本不足"}</span>
                  </div>
                  <article
                    className={`analytics-duration-step level-${item.level}`}
                    style={{
                      "--step-width": durationPyramidWidths[index] || durationPyramidWidths[durationPyramidWidths.length - 1],
                      "--duration-top": durationPyramidTones[index]?.top || durationPyramidTones[durationPyramidTones.length - 1].top,
                      "--duration-left": durationPyramidTones[index]?.left || durationPyramidTones[durationPyramidTones.length - 1].left,
                      "--duration-right": durationPyramidTones[index]?.right || durationPyramidTones[durationPyramidTones.length - 1].right,
                    } as React.CSSProperties}
                  >
                    <div className="analytics-duration-step-top" />
                    <div className="analytics-duration-step-face">
                      <strong>{String(index + 1).padStart(2, "0")}</strong>
                    </div>
                  </article>
                </div>
              ))}
            </div>
            <div className="analytics-duration-notes">
              <section className="analytics-duration-summary">
                <span className="analytics-duration-kicker">异常数据分析</span>
                <strong>{durationBottleneck ? `${durationBottleneck.label} 是当前主要卡点` : "当前阶段耗时样本不足"}</strong>
                <p>{durationAnalytics.summary}</p>
                <div className="analytics-duration-points">
                  {durationAbnormalRows.length ? durationAbnormalRows.map((item) => (
                    <div className="analytics-duration-inline" key={item.key}>
                      <div className="analytics-duration-point-head">
                        <span>{item.label}</span>
                        <em>{item.averageDays !== null ? `${item.averageDays}天` : "样本不足"}</em>
                      </div>
                      <strong>{item.note}</strong>
                      <p>{item.sampleCount ? `当前已沉淀 ${item.sampleCount} 个流程样本，可继续结合岗位与月份拆看异常来源。` : "当前没有形成有效样本，建议先补齐该阶段的时间记录。"}</p>
                    </div>
                  )) : durationEmptyRows.length ? durationEmptyRows.map((item) => (
                    <div className="analytics-duration-inline" key={item.key}>
                      <div className="analytics-duration-point-head">
                        <span>{item.label}</span>
                        <em>样本不足</em>
                      </div>
                      <strong>当前还没有形成可判断的耗时异常。</strong>
                      <p>建议优先补齐该阶段的时间记录，再结合岗位和月份观察是否存在流程波动。</p>
                    </div>
                  )) : (
                    <div className="analytics-duration-inline">
                      <div className="analytics-duration-point-head">
                        <span>当前流程稳定</span>
                        <em>无明显异常</em>
                      </div>
                      <strong>各阶段耗时整体处于可控区间。</strong>
                      <p>建议继续按岗位与月份观察，重点关注简历量突然变化时的流程波动。</p>
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </section>
      </div>

      <div className="grid cols-2 dashboard-action-grid">
        <section className="card pad analytics-funnel-card">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">原因标签标准化</h3>
              <p className="helper-text">按当前复盘范围沉淀淘汰、未到面、offer 流失等原因，方便快速归因。</p>
            </div>
          </div>
          <div className="analytics-issue-card">
            <strong>高频标签</strong>
            <div className="analytics-tag-list">
              {issueReview.topReasons.length ? issueReview.topReasons.map((item) => (
                <span key={item.label}>{item.label} · {item.count}</span>
              )) : <span>暂无可复盘标签</span>}
            </div>
          </div>
          <div className="analytics-issue-card">
            <strong>标准标签建议</strong>
        <div className="analytics-tag-list">
              {generalReasonTagOptions.map((item) => <span key={item}>{item}</span>)}
            </div>
          </div>
        </section>

        <section className="card pad analytics-funnel-card">
          <div className="analytics-table-head">
            <div>
              <h3 className="card-title">本期行动建议清单</h3>
              <p className="helper-text">结合当前复盘范围的数据，直接告诉你下周该优先推进哪些招聘动作。</p>
            </div>
          </div>
          <div className="analytics-action-list">
            {actionPlan.length ? actionPlan.map((item) => (
              <article className="analytics-action-card" key={item.title}>
                <div className="row-between">
                  <strong>{item.title}</strong>
                  <Badge color={item.priority === "P1" ? "red" : item.priority === "P2" ? "gold" : "green"}>{item.priority}</Badge>
                </div>
                <p>{item.text}</p>
              </article>
            )) : <div className="empty"><div><strong>暂无行动建议</strong><br />请先沉淀更多简历与面试结果。</div></div>}
          </div>
        </section>
      </div>
    </>
  );
}

function JobsView({
  state,
  currentJob,
  onSelect,
  onEdit,
  onCreate,
  onCloseJob,
  onDelete,
}: {
  state: AppState;
  currentJob: Job;
  onSelect: (id: string) => void;
  onEdit: (job: Job) => void;
  onCreate: () => void;
  onCloseJob: (job: Job) => Promise<boolean>;
  onDelete: (job: Job) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<Job["status"] | "全部">("招聘中");
  const [selectedJobId, setSelectedJobId] = useState(currentJob.id);
  const filters: Array<Job["status"] | "全部"> = ["招聘中", "暂停", "已关闭", "全部"];
  const visibleJobs = useMemo(
    () => (statusFilter === "全部" ? state.jobs : state.jobs.filter((job) => job.status === statusFilter)),
    [state.jobs, statusFilter],
  );
  const selectedJob = state.jobs.find((job) => job.id === selectedJobId) || currentJob;

  useEffect(() => {
    if (!visibleJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(visibleJobs[0]?.id || currentJob.id);
    }
  }, [currentJob.id, selectedJobId, visibleJobs]);

  const selectJob = (job: Job) => {
    setSelectedJobId(job.id);
    if (job.status === "招聘中") onSelect(job.id);
  };

  const handleCloseJob = async (job: Job) => {
    const closed = await onCloseJob(job);
    if (!closed) return;
    setStatusFilter("已关闭");
    setSelectedJobId(job.id);
  };

  return (
    <>
      <section className="card pad">
        <div className="toolbar">
          <div>
            <h3 className="card-title">职位池</h3>
            <p className="helper-text">默认聚焦招聘中岗位，已关闭岗位会归档保留。</p>
          </div>
          <div className="toolbar-right">
            <button className="btn" onClick={() => downloadJson(state)}>导出数据</button>
            <button className="btn primary" onClick={onCreate}>新增职位</button>
          </div>
        </div>
        <div className="filter-tabs">
          {filters.map((filter) => (
            <button key={filter} className={`filter-tab ${statusFilter === filter ? "active" : ""}`} onClick={() => setStatusFilter(filter)}>
              {filter}<span>{filter === "全部" ? state.jobs.length : state.jobs.filter((job) => job.status === filter).length}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid cols-2">
        <section className="card pad">
          {visibleJobs.length ? (
            <div className="job-list">
              {visibleJobs.map((job) => (
                <article className={`job-card ${job.id === selectedJob.id ? "active" : ""}`} key={job.id} onClick={() => selectJob(job)}>
                  <div className="job-topline">
                    <div>
                      <h4>{job.title}</h4>
                      <span className="meta">{job.dept} · {job.location}</span>
                    </div>
                    <Badge color={statusColor(job.status)}>{job.status}</Badge>
                  </div>
                  <div className="kv"><span>{job.salaryRange}</span><span>{job.location}</span><span>{job.experience}</span></div>
                  <p className="desc job-card-desc">{job.description}</p>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty"><div><strong>暂无{statusFilter}岗位</strong><br />可切换筛选或新增职位。</div></div>
          )}
        </section>

        <section className="card pad">
          <div className="detail-panel">
            <div className="row-between">
              <div>
                <h3 className="card-title">{selectedJob.title}</h3>
                <span className="meta">{selectedJob.dept} · {selectedJob.location}</span>
              </div>
              <Badge color={statusColor(selectedJob.status)}>{selectedJob.status}</Badge>
            </div>
            <div className="salary-summary">
              <Metric label="薪资范围" value={selectedJob.salaryRange} />
              <Metric label="工作地点" value={selectedJob.location} />
              <Metric label="经验年限" value={selectedJob.experience} />
            </div>
            <div><span className="meta">关键词</span><KeywordList keywords={selectedJob.keywords} /></div>
            <div><span className="meta">职位描述</span><p className="desc spaced-small">{selectedJob.description}</p></div>
            <div className="toolbar-left">
              <button className="btn primary" onClick={() => onEdit(selectedJob)}>编辑职位</button>
              {selectedJob.status !== "已关闭" && <button className="btn" onClick={() => handleCloseJob(selectedJob)}>关闭招聘</button>}
              <button className="btn danger" onClick={() => onDelete(selectedJob)}>删除职位</button>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function CandidatesView({ candidates, selectedId, onSelect, onUpload, onMark, onDelete, currentJob, onStateChange }: { candidates: Candidate[]; selectedId: string | null; onSelect: (id: string) => void; onUpload: () => void; onMark: (id: string) => void; onDelete: () => void; currentJob: Job; onStateChange: (state: AppState) => void }) {
  const selected = candidates.find((candidate) => candidate.id === selectedId) || candidates[0] || null;
  const [detailTab, setDetailTab] = useState<CandidateDetailTab>("overview");

  useEffect(() => {
    setDetailTab("overview");
  }, [selected?.id]);

  const selectCandidate = (id: string, tab: CandidateDetailTab = "overview") => {
    onSelect(id);
    setDetailTab(tab);
  };

  return <>
    <section className="card pad"><div className="toolbar"><div><h3 className="card-title">{currentJob.title} · 简历甄选</h3><p className="helper-text">按当前职位查看候选人，并基于岗位关键考核点生成分析。</p></div><div className="toolbar-right"><button className="btn primary" onClick={onUpload}>上传/录入简历</button></div></div></section>
    <div className="candidate-layout"><section className="card pad">{candidates.length ? <div className="candidate-list">{candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} selected={candidate.id === selected?.id} onSelect={() => selectCandidate(candidate.id)} onOpenResume={() => selectCandidate(candidate.id, "resume")} />)}</div> : <div className="empty"><div><strong>暂无简历</strong><br />点击“上传/录入简历”添加候选人。</div></div>}</section><section key={selected?.id || "empty"} className="card pad candidate-detail-card">{selected ? <CandidateDetail candidate={selected} activeTab={detailTab} onTabChange={setDetailTab} onMark={onMark} onDelete={onDelete} onStateChange={onStateChange} currentJob={currentJob} /> : <div className="empty"><div><strong>暂无候选人详情</strong><br />上传或录入简历后可查看甄选结论。</div></div>}</section></div>
  </>;
}

function CandidateCard({ candidate, selected, onSelect, onOpenResume }: { candidate: Candidate; selected: boolean; onSelect: () => void; onOpenResume: () => void }) {
  const profileTags = extractCandidateProfileTags(candidate);
  return (
    <article
      className={`candidate-card ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="score-ring" style={{ "--score": candidate.score } as React.CSSProperties}><span>{candidate.score}</span></div>
      <div className="candidate-body">
        <div className="candidate-topline"><div><h4>{candidate.name}</h4>{profileTags.length > 0 && <div className="candidate-profile-tags">{profileTags.map((tag) => <span key={`${tag.label}-${tag.value}`}>{tag.label}：{tag.value}</span>)}</div>}</div><Badge color={scoreColor(candidate.score)}>{candidate.conclusion}</Badge></div>
        <p className="reason">{candidate.reason}</p>
        <button className="btn ghost" type="button" onClick={(event) => { event.stopPropagation(); onOpenResume(); }}>查看简历</button>
      </div>
    </article>
  );
}

function extractCandidateProfileTags(candidate: Candidate) {
  const text = `${candidate.resumeText} ${candidate.reason}`;
  const salary = text.match(/(?:期望薪资|薪资期望|薪酬期望|期望|薪资)[:：]?\s*([0-9]{1,3}\s*[kK万千][-~—至到]?\s*[0-9]{0,3}\s*[kK万千]?|面议)/)?.[1]?.replace(/\s+/g, "");
  const experience = text.match(/([0-9]{1,2})\s*(?:年|年以上|年\+)(?:工作经验|经验|相关经验)?/)?.[0]?.replace(/\s+/g, "");
  const certificate = text.match(/(CPA|CFA|ACCA|PMP|FRM|司法考试|法律职业资格|人力资源管理师|心理咨询师|教师资格证|中级会计|高级会计|注册会计师)/i)?.[0];
  return [
    salary ? { label: "期望薪资", value: salary } : null,
    experience ? { label: "工作年限", value: experience } : null,
    certificate ? { label: "专业证书", value: certificate.toUpperCase() } : null,
  ].filter((tag): tag is { label: string; value: string } => Boolean(tag));
}

type InterviewQuestionItem = Candidate["interviewQuestions"][number];

const interviewMethods: Array<{ key: InterviewMethodKey; label: string; desc: string }> = [
  { key: "structured", label: "结构化面试", desc: "固定维度评分，适合多人横向对比" },
  { key: "behavioral", label: "行为面试", desc: "验证过往经历真实性和稳定表现" },
  { key: "star", label: "STAR 深挖", desc: "拆解具体项目的情境、任务、行动、结果" },
  { key: "scenario", label: "情景模拟", desc: "模拟岗位真实场景，看现场判断和推进" },
  { key: "case", label: "案例分析", desc: "适合中高阶岗位，观察业务拆解能力" },
];

type CandidateDetailTab = "overview" | "interview" | "resume";

function CandidateDetail({ candidate, activeTab, onTabChange, onMark, onDelete, onStateChange, currentJob }: { candidate: Candidate; activeTab: CandidateDetailTab; onTabChange: (tab: CandidateDetailTab) => void; onMark: (id: string) => void; onDelete: () => void; onStateChange: (state: AppState) => void; currentJob: Job }) {
  const [copied, setCopied] = useState(false);
  const [methodKey, setMethodKey] = useState<InterviewMethodKey>(() => getInterviewRecommendation(candidate).methodKey);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState("");
  const overview = buildCandidateOverview(candidate);
  const matchedCount = overview.matched.length;
  const interviewPlan = candidate.interviewPlan;
  const recommendation = getInterviewRecommendation(candidate, currentJob, interviewPlan);
  const interviewPack = buildInterviewPack(candidate, methodKey, currentJob, interviewPlan);

  useEffect(() => {
    setMethodKey(getInterviewRecommendation(candidate, currentJob, candidate.interviewPlan).methodKey);
    setCopied(false);
    setPlanError("");
  }, [candidate.id, candidate.interviewPlan, currentJob.id]);

  useEffect(() => {
    if (candidate.interviewPlan || activeTab !== "interview") return;
    void generateInterviewPlan();
  }, [activeTab, candidate.id]);

  const generateInterviewPlan = async () => {
    setPlanLoading(true);
    setPlanError("");
    try {
      const result = await api.generateCandidateInterviewPlan(candidate.id);
      onStateChange(result.state);
    } catch (error) {
      setPlanError(error instanceof Error ? error.message : "面试方案生成失败，请稍后重试");
    } finally {
      setPlanLoading(false);
    }
  };

  const copyInterviewPack = async () => {
    await navigator.clipboard.writeText(formatCandidateInterviewPack(candidate, interviewPack, recommendation));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="detail-panel candidate-detail-panel">
      <section className="candidate-summary">
        <div className="row-between">
          <div>
            <h3 className="candidate-name">{candidate.name}</h3>
            <span className="meta">来源：{candidate.source} · {candidate.uploadTime}</span>
          </div>
          <Badge color={scoreColor(candidate.score)}>{candidate.score} 分</Badge>
        </div>
        <div className="salary-summary compact">
          <Metric label="筛选结论" value={candidate.conclusion} />
          <Metric label="推荐强度" value={candidate.score >= 85 ? "高" : candidate.score >= 70 ? "中高" : "观察"} />
          <Metric label="关键点命中" value={`${matchedCount}/${candidate.keyPointAnalysis.length || 0}`} />
        </div>
      </section>

      <div className="detail-tabs" role="tablist" aria-label="候选人详情分区">
        {[
          ["overview", "评估总览"],
          ["interview", "面试问题"],
          ["resume", "简历原文"],
        ].map(([key, label]) => (
          <button key={key} type="button" role="tab" className={`detail-tab ${activeTab === key ? "active" : ""}`} onClick={() => onTabChange(key as CandidateDetailTab)}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <div className="tab-panel overview-panel">
          <section className="analysis-result">
            <div className="analysis-score-card">
              <div className="score-ring large" style={{ "--score": candidate.score } as React.CSSProperties}><span>{candidate.score}</span></div>
              <Badge color={scoreColor(candidate.score)}>{candidate.conclusion}</Badge>
            </div>
            <div className="match-bars">
              {overview.dimensions.map((dimension) => (
                <div className="match-bar" key={dimension.label}>
                  <div className="row-between"><strong>{dimension.label}</strong><span>{dimension.value}</span></div>
                  <div className="bar-track"><i style={{ width: `${dimension.value}%` }} /></div>
                </div>
              ))}
            </div>
          </section>
          <section className="ai-summary-card">
            <div className="ai-label">AI 总结</div>
            <p>{overview.summary}</p>
          </section>
          <div className="ai-grid">
            <section className="ai-point-card"><strong>推荐理由</strong><p>{overview.recommendation}</p></section>
            <section className="ai-point-card"><strong>优势</strong><ul>{overview.strengths.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section className="ai-point-card"><strong>劣势</strong><ul>{overview.weaknesses.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section className="ai-point-card risk"><strong>风险点</strong><ul>{overview.risks.map((item) => <li key={item}>{item}</li>)}</ul></section>
          </div>
          <section>
            <div className="row-between section-title-row"><span className="meta">关键面试考核点</span><span className="helper-text">已命中 {matchedCount} 项</span></div>
            <div className="analysis-list compact spaced-small">
              {candidate.keyPointAnalysis.map((item) => (
                <div className="analysis-item" key={item.keyword}>
                  <div className="row-between"><strong>{item.keyword}</strong><Badge color={item.matched ? "green" : "gray"}>{item.matched ? "已覆盖" : "待核验"}</Badge></div>
                  <p>{item.evidence}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {activeTab === "interview" && (
        <div className="tab-panel interview-panel">
          <section className="interview-pack">
            <div className="row-between">
              <div><span className="meta">面试方法与问题生成</span><p className="helper-text">AI 会基于岗位 JD、简历摘要、命中/未命中关键点和风险项生成更严谨的面试方案。</p></div>
              <div className="toolbar-right compact-actions">
                <button className="btn" type="button" onClick={generateInterviewPlan} disabled={planLoading}>{planLoading ? "生成中..." : interviewPlan ? "重新生成" : "生成方案"}</button>
                <button className="btn ghost compact" type="button" onClick={copyInterviewPack} disabled={planLoading}>{copied ? "已复制" : "一键复制"}</button>
              </div>
            </div>
            <div className="method-tabs compact">
              {interviewMethods.map((method) => (
                <button key={method.key} type="button" className={`method-tab ${methodKey === method.key ? "active" : ""}`} onClick={() => { setMethodKey(method.key); setCopied(false); }}>
                  <strong>{method.label}</strong><span>{method.desc}</span>
                </button>
              ))}
            </div>
            <div className="interview-method-summary"><strong>{interviewPack.methodLabel}</strong><span>{interviewPack.focus}</span></div>
            <div className="recommendation-note"><strong>系统推荐：{interviewMethods.find((method) => method.key === recommendation.methodKey)?.label}</strong><span>{recommendation.reason}</span></div>
            {interviewPlan?.recommendedMethods?.length ? <div className="interview-method-ai"><strong>推荐组合</strong><div className="question-chip-row">{interviewPlan.recommendedMethods.map((method) => <span key={method.methodKey} className={`question-chip ${method.methodKey === methodKey ? "" : "soft"}`}>{method.label}</span>)}</div><p>{interviewPlan.summaryReason}</p></div> : null}
            {planError ? <div className="tool-error">{planError}</div> : null}
            <div className="question-list spaced-small">
              {interviewPack.questions.map((question, index) => (
                <article className="question-item" key={`${question.title}-${index}`}>
                  <strong>{index + 1}. {question.title}</strong>
                  {"question" in question ? (
                    <>
                      <div className="question-chip-row">
                        <span className="question-chip">{question.competency}</span>
                        <span className="question-chip soft">{question.questionType}</span>
                      </div>
                      <p>{question.question}</p>
                      <div className="question-meta-grid">
                        <div className="question-meta-group">
                          <span className="question-probe-label">设计意图</span>
                          <span className="question-probe-text">{question.designIntent}</span>
                        </div>
                        <div className="question-meta-group">
                          <span className="question-probe-label">优秀答案特征</span>
                          <ul className="question-signal-list">
                            {question.strongSignals.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </div>
                        <div className="question-meta-group">
                          <span className="question-probe-label">警示信号</span>
                          <ul className="question-signal-list warning">
                            {question.warningSignals.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </div>
                      </div>
                      <span className="question-probe-label">建议追问</span>
                      <span className="question-probe-text">{question.followUps.join("\n")}</span>
                    </>
                  ) : (
                    <>
                      {question.competency ? <div className="question-chip-row"><span className="question-chip">{question.competency}</span></div> : null}
                      <p>{question.text}</p>
                      {question.starFocus?.length ? (
                        <div className="question-meta-group">
                          <span className="question-probe-label">STAR关注点</span>
                          <div className="question-chip-row">
                            {question.starFocus.map((item) => <span className="question-chip soft" key={item}>{item}</span>)}
                          </div>
                        </div>
                      ) : null}
                      <span className="question-probe-label">追问</span>
                      <span className="question-probe-text">{normalizeProbeText(question.probe)}</span>
                      {question.evaluationSignals?.length ? (
                        <div className="question-meta-group">
                          <span className="question-probe-label">判断信号</span>
                          <ul className="question-signal-list">
                            {question.evaluationSignals.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  )}
                </article>
              ))}
            </div>
          </section>
          <section>
            <span className="meta">面试评估指引</span>
            <div className="evaluation-list spaced-small">
              {interviewPack.evaluationMethods.map((method) => <article className="evaluation-item" key={method.title}><strong>{method.title}</strong><p>{method.text}</p></article>)}
              {interviewPlan?.riskReview?.length ? (
                <article className="evaluation-item risk-review-item">
                  <strong>风险提示</strong>
                  <div className="risk-review-list">
                    {interviewPlan.riskReview.map((item) => (
                      <div key={item.dimension} className="risk-review-row">
                        <div className="row-between"><span>{item.dimension}</span><Badge color={item.level === "高" ? "red" : item.level === "中" ? "orange" : "green"}>{item.level}</Badge></div>
                        <p>{item.reason}</p>
                        {item.validationTips.length ? <small>{item.validationTips.join("；")}</small> : null}
                      </div>
                    ))}
                  </div>
                </article>
              ) : null}
            </div>
          </section>
        </div>
      )}

      {activeTab === "resume" && (
        <div className="tab-panel">
          <div className="row-between section-title-row"><span className="meta">简历文本</span><span className="helper-text">{candidate.fileName || candidate.source}</span></div>
          <div className="resume-box spaced-small">{candidate.resumeText}</div>
        </div>
      )}

      <div className="toolbar-left detail-actions"><button className="btn primary" type="button" onClick={() => onMark(candidate.id)}>标记面试</button><button className="btn danger" type="button" onClick={onDelete}>删除候选人</button></div>
    </div>
  );
}


function buildCandidateOverview(candidate: Candidate) {
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched);
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched);
  const matchedKeywords = matched.map((item) => item.keyword);
  const missedKeywords = missed.map((item) => item.keyword);
  const evaluation = candidate.evaluation;
  const keywordRatio = candidate.keyPointAnalysis.length ? Math.round((matched.length / candidate.keyPointAnalysis.length) * 100) : Math.round(candidate.score * 0.68);
  const dimensions = [
    { label: "岗位关键词", value: clampScore(keywordRatio || candidate.score) },
    { label: "经验匹配", value: clampScore(candidate.score + (matched.length ? 6 : -8)) },
    { label: "专业技能", value: clampScore(candidate.score + (matched.length >= 2 ? 4 : -6)) },
    { label: "软性素质", value: clampScore(candidate.score + (/协同|推动|沟通|管理|团队/.test(candidate.resumeText) ? 8 : -4)) },
  ];
  const strengths = evaluation?.strengths?.length
    ? evaluation.strengths
    : matchedKeywords.length
    ? matchedKeywords.slice(0, 3).map((keyword) => `简历已覆盖“${keyword}”，可作为面试重点深挖。`)
    : ["简历信息仍偏概括，需要通过面试补充验证核心能力。"];
  const weaknesses = evaluation?.weaknesses?.length
    ? evaluation.weaknesses
    : missedKeywords.length
    ? missedKeywords.slice(0, 3).map((keyword) => `“${keyword}”暂无直接证据，建议面试中优先追问。`)
    : ["主要关键点均有覆盖，但仍需核验项目规模、个人贡献和结果真实性。"];
  const risks = evaluation?.risks?.length
    ? evaluation.risks
    : [
    candidate.score < 70 ? "综合匹配分未达到高推荐区间，建议谨慎推进或增加业务复核。" : "需避免只看简历关键词命中，仍要确认候选人的真实贡献边界。",
    missedKeywords.length ? `待核验项集中在 ${missedKeywords.slice(0, 2).join("、")}，存在上手后能力落差风险。` : "若候选人案例结果无法量化，可能存在经验包装风险。",
  ];
  return {
    matched,
    missed,
    dimensions,
    summary: evaluation?.summary || `我先看岗位匹配度：${candidate.name} 综合匹配 ${candidate.score} 分，结论为“${candidate.conclusion}”。${matchedKeywords.length ? `已命中 ${matchedKeywords.slice(0, 3).join("、")} 等关键点` : "核心关键点直接证据不足"}，${missedKeywords.length ? `但 ${missedKeywords.slice(0, 2).join("、")} 仍需进一步核验。` : "整体证据较完整，适合进入深度面试。"}`,
    recommendation: candidate.reason,
    strengths,
    weaknesses,
    risks,
    interviewFocuses: evaluation?.interviewFocuses?.length ? evaluation.interviewFocuses : candidate.keyPointAnalysis.map((item) => item.keyword).slice(0, 5),
  };
}

function clampScore(value: number) {
  return Math.max(8, Math.min(100, Math.round(value)));
}

function getInterviewRecommendation(candidate: Candidate, currentJob?: Job | null, interviewPlan?: CandidateInterviewPlan): { methodKey: InterviewMethodKey; reason: string } {
  if (interviewPlan?.recommendedMethods?.length) {
    return {
      methodKey: interviewPlan.recommendedMethods[0].methodKey,
      reason: interviewPlan.recommendedMethods[0].reason || interviewPlan.summaryReason,
    };
  }
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched);
  const missedText = missed.slice(0, 2).map((item) => item.keyword).join("、");
  const jobText = `${currentJob?.title || ""} ${currentJob?.keywords || ""} ${currentJob?.description || ""}`;
  if (candidate.score >= 85) {
    return { methodKey: "star", reason: `匹配分 ${candidate.score} 较高，适合用 STAR 深挖项目真实性、个人贡献和结果指标。` };
  }
  if (missed.length >= 3) {
    return { methodKey: candidate.score >= 60 ? "behavioral" : "structured", reason: `关键考核点仍有 ${missed.length} 项待核验，建议优先验证 ${missedText} 等核心缺口。` };
  }
  if (/经理|总监|负责人|策略|体系|规划/.test(jobText)) {
    return { methodKey: "case", reason: "岗位级别和职责更偏策略判断，建议优先通过案例分析验证分析框架与管理思维。" };
  }
  if (candidate.score < 65) {
    return { methodKey: "scenario", reason: `匹配分 ${candidate.score} 偏观察，简历证据不足时更适合用情景模拟看现场拆解和落地能力。` };
  }
  return { methodKey: "behavioral", reason: `该候选人已有一定匹配证据，适合用行为面试验证过往经历是否真实、稳定且可复用。` };
}

function buildInterviewPack(candidate: Candidate, methodKey: InterviewMethodKey, currentJob?: Job | null, interviewPlan?: CandidateInterviewPlan) {
  if (interviewPlan) {
    return buildInterviewPackFromPlan(candidate, methodKey, interviewPlan);
  }
  const missed = candidate.keyPointAnalysis.filter((item) => !item.matched);
  const matched = candidate.keyPointAnalysis.filter((item) => item.matched);
  const primary = missed[0]?.keyword || matched[0]?.keyword || "岗位核心能力";
  const secondary = missed[1]?.keyword || matched[1]?.keyword || "跨团队协同";
  const strength = matched.map((item) => item.keyword).join("、") || "已有相关经验";
  const gap = missed.map((item) => item.keyword).join("、") || "结果真实性与可迁移性";

  const packs: Record<InterviewMethodKey, { methodLabel: string; focus: string; questions: Candidate["interviewQuestions"]; evaluationMethods: Array<{ title: string; text: string }> }> = {
    structured: {
      methodLabel: "结构化面试",
      focus: "用统一问题和评分维度减少主观偏差，适合多个候选人横向对比。",
      questions: [
        { title: `${primary}标准验证`, text: `请围绕“${primary}”说明你最能代表该能力的一段经历，包括目标、动作和结果。`, probe: "追问：如果按 1-5 分自评，你认为证据最强和最弱的地方分别是什么？" },
        { title: `${secondary}横向对比`, text: `请描述一次你需要在“${secondary}”相关场景中协调资源或推动他人的经历。`, probe: "追问：请给出周期、参与方、关键阻力和最终指标。" },
        { title: "岗位动机与稳定性", text: "你为什么选择这个岗位？未来一年最想在这个岗位上解决什么问题？", probe: "追问：如果入职后三个月遇到预期落差，你会如何调整？" },
      ],
      evaluationMethods: [
        { title: "评分方式", text: "每题按 1-5 分评分：证据完整性、个人贡献、结果量化、岗位相关性四项取平均。" },
        { title: "适配判断", text: `若 ${primary} 与 ${secondary} 均能给出清晰案例且结果可验证，可判断为进入下一轮；若只能泛泛描述，建议保留观察。` },
        { title: "风险提示", text: `重点关注 ${gap}，避免仅凭表达流畅度判断匹配。` },
      ],
    },
    behavioral: {
      methodLabel: "行为面试",
      focus: "从过去行为预测未来表现，重点验证真实经历、重复能力和稳定表现。",
      questions: [
        { title: `${primary}真实行为`, text: `请讲一个你过去实际处理“${primary}”相关问题的案例。`, probe: "追问：当时你亲自做了哪些动作？哪些结果可以被第三方验证？" },
        { title: "压力与冲突处理", text: "请分享一次你和业务方、同事或上级判断不一致的经历。", probe: "追问：你如何推进共识？最终是否改变了原方案？" },
        { title: "失败复盘", text: "请讲一次结果没有达到预期的经历，你后来做了什么调整？", probe: "追问：如果重新来一次，你会删掉或新增哪一步？" },
      ],
      evaluationMethods: [
        { title: "评估重点", text: "看候选人是否能讲出具体时间、角色、动作、阻力和结果，而不是停留在方法论。" },
        { title: "适配判断", text: `若过往行为能反复体现 ${strength}，且对失败有复盘，可判断岗位适配度较高。` },
        { title: "风险提示", text: "如果候选人大量使用“我们”但无法说明个人贡献，需要继续追问其实际负责边界。" },
      ],
    },
    star: {
      methodLabel: "STAR 深挖",
      focus: "用情境、任务、行动、结果拆解关键项目，适合强匹配候选人的深度验证。",
      questions: candidate.interviewQuestions.length ? candidate.interviewQuestions : [
        { title: `${primary}项目深挖`, text: `请选择一个最能体现“${primary}”的项目，按背景、任务、行动、结果完整复盘。`, probe: "追问：你的个人贡献占比是多少？结果指标如何沉淀或复用？" },
      ],
      evaluationMethods: [
        { title: "S 情境", text: "判断业务背景是否真实复杂，候选人是否理解问题本质而不只是执行任务。" },
        { title: "T 任务", text: "判断目标是否清晰，是否有明确成功标准和优先级。" },
        { title: "A 行动", text: "判断候选人个人动作是否关键，是否体现方法、影响力和资源协调。" },
        { title: "R 结果", text: "判断结果是否量化、可归因、可复盘；若结果模糊，需要谨慎推进。" },
      ],
    },
    scenario: {
      methodLabel: "情景模拟",
      focus: "给候选人岗位真实场景，观察现场拆解、优先级判断和落地路径。",
      questions: [
        { title: `${primary}现场模拟`, text: `假设入职后你发现“${primary}”相关问题影响业务进度，你会如何在两周内诊断并推进？`, probe: "追问：第一天你会找谁？第一周产出什么？如何判断有效？" },
        { title: "资源不足场景", text: "如果业务方希望快速见效，但资源、人手和数据都不完整，你会如何取舍？", probe: "追问：哪些动作必须做，哪些可以延后？" },
        { title: "跨部门协同场景", text: `如果 ${secondary} 遇到阻力，你会如何推动相关方达成一致？`, probe: "追问：如果关键负责人不配合，你的备选方案是什么？" },
      ],
      evaluationMethods: [
        { title: "评估重点", text: "看候选人是否能先定义问题、再排优先级、最后给出可落地动作，而不是直接给结论。" },
        { title: "适配判断", text: "能说清利益相关方、时间节奏、阶段产出和风险预案，说明上手能力较强。" },
        { title: "风险提示", text: "如果方案过于宏观、缺少第一步动作或没有衡量指标，建议降低推荐等级。" },
      ],
    },
    case: {
      methodLabel: "案例分析",
      focus: "通过业务案例观察逻辑结构、数据意识、判断质量和方案完整度。",
      questions: [
        { title: `${primary}案例拆解`, text: `给你一个案例：团队在“${primary}”上连续两个月未达预期，你会如何分析原因？`, probe: "追问：你需要哪些数据？如何区分人、流程、机制和外部因素？" },
        { title: "方案设计", text: "请基于刚才的诊断，设计一个 30 天改善方案。", probe: "追问：里程碑、负责人、风险点和验收标准分别是什么？" },
        { title: "高阶判断", text: "如果短期指标变好但长期组织成本上升，你会如何平衡？", probe: "追问：你会向管理层如何呈现取舍？" },
      ],
      evaluationMethods: [
        { title: "评估重点", text: "看候选人是否有结构化框架、数据假设、因果判断和优先级，而不是罗列动作。" },
        { title: "适配判断", text: `若能结合 ${strength} 提出可验证方案，说明具备较好的岗位迁移潜力。` },
        { title: "风险提示", text: "如果只给经验答案、无法解释为什么这样做，说明抽象能力和复杂问题处理能力仍需验证。" },
      ],
    },
  };

  return packs[methodKey];
}

function buildInterviewPackFromPlan(candidate: Candidate, methodKey: InterviewMethodKey, interviewPlan: CandidateInterviewPlan) {
  const method = interviewMethods.find((item) => item.key === methodKey);
  const matchedQuestions = interviewPlan.questions.filter((item) => !item.methodKey || item.methodKey === methodKey);
  const questions = (matchedQuestions.length ? matchedQuestions : interviewPlan.questions).map((item) => ({
    ...item,
  }));
  const evaluationMethods = [
    {
      title: "通过面试的底线标准",
      text: interviewPlan.evaluationGuide.baseline.join("；"),
    },
    {
      title: "优先录用信号",
      text: interviewPlan.evaluationGuide.positiveSignals.join("；"),
    },
    {
      title: "一票否决项",
      text: interviewPlan.evaluationGuide.vetoItems.join("；"),
    },
  ].filter((item) => item.text);
  const matchedMethodReason = interviewPlan.recommendedMethods.find((item) => item.methodKey === methodKey)?.reason || interviewPlan.summaryReason;
  return {
    methodLabel: method?.label || "AI 面试方案",
    focus: matchedMethodReason,
    questions,
    evaluationMethods,
  };
}

function formatCandidateInterviewPack(candidate: Candidate, interviewPack: ReturnType<typeof buildInterviewPack>, recommendation: ReturnType<typeof getInterviewRecommendation>) {
  const header = [
    `候选人：${candidate.name}`,
    `来源：${candidate.source}`,
    `初筛结论：${candidate.conclusion}`,
    `匹配分：${candidate.score}`,
    `推荐理由：${candidate.reason}`,
    `面试方法：${interviewPack.methodLabel}`,
    `方法重点：${interviewPack.focus}`,
    `系统推荐依据：${recommendation.reason}`,
  ].join("\n");
  const questions = interviewPack.questions
    .map((question, index) => [
      `${index + 1}. ${question.title}`,
      "question" in question
        ? [
          `考察能力：${question.competency}`,
          `问题类型：${question.questionType}`,
          `问题：${question.question}`,
          `设计意图：${question.designIntent}`,
          `优秀答案特征：${question.strongSignals.join("；")}`,
          `警示信号：${question.warningSignals.join("；")}`,
          `建议追问：\n${question.followUps.join("\n")}`,
        ].join("\n")
        : [
          question.competency ? `考察能力：${question.competency}` : "",
          `问题：${question.text}`,
          question.starFocus?.length ? `STAR关注点：${question.starFocus.join("、")}` : "",
          `追问：\n${normalizeProbeText(question.probe)}`,
          question.evaluationSignals?.length ? `判断信号：${question.evaluationSignals.join("；")}` : "",
        ].filter(Boolean).join("\n"),
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  const methods = interviewPack.evaluationMethods
    .map((method, index) => `${index + 1}. ${method.title}：${method.text}`)
    .join("\n");
  return `${header}\n\n面试问题：\n${questions}\n\n参考评估意见：\n${methods}`;
}

const interviewStages = ["初试", "复试", "offer"] as const;
type InterviewStage = (typeof interviewStages)[number];

function InterviewsView({ jobs, selectedJobId, onJobChange, selectedMonth, onMonthChange, candidates, activeStage, onStageChange, onSaveStage }: { jobs: Job[]; selectedJobId: string; onJobChange: (jobId: string) => void; selectedMonth: string; onMonthChange: (month: string) => void; candidates: Candidate[]; activeStage: InterviewStage; onStageChange: (stage: InterviewStage) => void; onSaveStage: (candidateId: string, interviewStage: NonNullable<Candidate["interviewStage"]>, stageRecommendation: NonNullable<Candidate["stageRecommendation"]>, interviewResult: NonNullable<Candidate["interviewResult"]>, onboarded: NonNullable<Candidate["onboarded"]>, reportMonth: string, interviewReason: string, reasonTags: string[], interviewTimeline: NonNullable<Candidate["interviewTimeline"]>) => Promise<void> }) {
  const monthOptions = Array.from(new Set(candidates.map((candidate) => normalizeReportMonth(candidate.reportMonth || formatReportMonth())))).sort((a, b) => b.localeCompare(a, "zh-Hans-CN"));
  const showJobColumn = selectedJobId === "all";
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const [tableScrollState, setTableScrollState] = useState({ clientWidth: 0, scrollWidth: 0, scrollLeft: 0 });
  const interviewCandidates = candidates
    .filter((candidate) => isInterviewCandidate(candidate))
    .filter((candidate) => selectedMonth === "all" || normalizeReportMonth(candidate.reportMonth || formatReportMonth()) === selectedMonth)
    .filter((candidate) => (candidate.interviewStage || "初试") === activeStage);

  const selectedJob = selectedJobId === "all" ? null : jobs.find((job) => job.id === selectedJobId) || null;
  const maxTableScrollLeft = Math.max(tableScrollState.scrollWidth - tableScrollState.clientWidth, 0);

  useEffect(() => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;

    let frame = 0;

    const measure = () => {
      const next = {
        clientWidth: wrap.clientWidth,
        scrollWidth: wrap.scrollWidth,
        scrollLeft: wrap.scrollLeft,
      };
      setTableScrollState((prev) => (
        prev.clientWidth === next.clientWidth
        && prev.scrollWidth === next.scrollWidth
        && prev.scrollLeft === next.scrollLeft
      ) ? prev : next);
    };

    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };

    scheduleMeasure();

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(wrap);
    const table = wrap.querySelector(".interview-table");
    if (table instanceof Element) {
      resizeObserver.observe(table);
    }

    wrap.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      wrap.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeStage, interviewCandidates.length, selectedJobId, selectedMonth, showJobColumn]);

  const handleTableScrollbarChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextScrollLeft = Number(event.target.value);
    if (tableWrapRef.current) {
      tableWrapRef.current.scrollLeft = nextScrollLeft;
    }
    setTableScrollState((prev) => ({ ...prev, scrollLeft: nextScrollLeft }));
  };

  return (
    <>
      <section className="card pad">
        <div className="toolbar">
          <div>
            <h3 className="card-title">{selectedJob ? `${selectedJob.title} · 面试管理` : "面试管理"}</h3>
            <p className="helper-text">支持按岗位与统计月份组合筛选；可查看单岗位全周期，也可查看某月全部在招岗位的人选。</p>
          </div>
          <div className="toolbar-right interview-filters">
            <label className="interview-filter-field">
              <span>当前进行中岗位</span>
              <select value={selectedJobId} onChange={(event) => onJobChange(event.target.value)}>
                <option value="all">全部</option>
                {jobs.map((job) => <option key={job.id} value={job.id}>{formatJobOption(job)}</option>)}
              </select>
            </label>
            <label className="interview-filter-field">
              <span>统计月份</span>
              <select value={selectedMonth} onChange={(event) => onMonthChange(event.target.value)}>
                <option value="all">全部</option>
                {monthOptions.map((month) => <option key={month} value={month}>{month}</option>)}
              </select>
            </label>
          </div>
        </div>
        <div className="stage-filter-tabs">
          {interviewStages.map((stage) => (
            <button key={stage} type="button" className={`stage-filter ${activeStage === stage ? "active" : ""}`} onClick={() => onStageChange(stage)}>
              {stage}<span>{candidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.interviewStage || "初试") === stage).length}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card interview-table-card">
        <div className="table-wrap interview-table-wrap" ref={tableWrapRef}>
          {interviewCandidates.length ? (
            <table className="table interview-table">
              <thead><tr><th>候选人</th><th>统计月份</th>{showJobColumn && <th>岗位</th>}<th>来源</th><th>{activeStage}</th><th>{activeStage === "offer" ? "入职" : "面试结果"}</th><th>标签</th><th>备注</th><th>操作</th></tr></thead>
              <tbody>
                {interviewCandidates.map((candidate) => <InterviewStageRow key={candidate.id} candidate={candidate} jobs={jobs} showJobColumn={showJobColumn} activeStage={activeStage} onSaveStage={onSaveStage} />)}
              </tbody>
            </table>
          ) : (
            <div className="empty"><div><strong>暂无面试人选</strong><br />请先在“简历甄选”中点击“标记面试”。</div></div>
          )}
        </div>
        {interviewCandidates.length > 0 && maxTableScrollLeft > 0 && (
          <div className="interview-scrollbar-shell">
            <span className="interview-scrollbar-label">左右滑动查看完整表格</span>
            <input
              aria-label="面试表格横向滚动"
              className="interview-scrollbar"
              type="range"
              min={0}
              max={maxTableScrollLeft}
              step={1}
              value={Math.min(tableScrollState.scrollLeft, maxTableScrollLeft)}
              onChange={handleTableScrollbarChange}
            />
          </div>
        )}
      </section>
    </>
  );
}

function InterviewStageRow({ candidate, jobs, showJobColumn, activeStage, onSaveStage }: { candidate: Candidate; jobs: Job[]; showJobColumn: boolean; activeStage: InterviewStage; onSaveStage: (candidateId: string, interviewStage: NonNullable<Candidate["interviewStage"]>, stageRecommendation: NonNullable<Candidate["stageRecommendation"]>, interviewResult: NonNullable<Candidate["interviewResult"]>, onboarded: NonNullable<Candidate["onboarded"]>, reportMonth: string, interviewReason: string, reasonTags: string[], interviewTimeline: NonNullable<Candidate["interviewTimeline"]>) => Promise<void> }) {
  const overview = buildCandidateOverview(candidate);
  const job = jobs.find((item) => item.id === candidate.jobId) || null;
  const defaultReason = candidate.interviewReason || overview.recommendation || overview.risks[0];
  const currentReasonTagOptions = getReasonTagOptions(activeStage);
  const defaultReasonTags = normalizeStageReasonTags(candidate.reasonTags?.length ? candidate.reasonTags : inferReasonTags(defaultReason, activeStage, candidate.onboarded), activeStage, candidate.onboarded);
  const [stage, setStage] = useState<NonNullable<Candidate["interviewStage"]>>(candidate.interviewStage || "初试");
  const [stageRecommendation, setStageRecommendation] = useState<NonNullable<Candidate["stageRecommendation"]>>(candidate.stageRecommendation || "是");
  const [interviewResult, setInterviewResult] = useState<NonNullable<Candidate["interviewResult"]>>(candidate.interviewResult || "待定");
  const [onboarded, setOnboarded] = useState<NonNullable<Candidate["onboarded"]>>(candidate.onboarded || "待入职");
  const [reportMonth, setReportMonth] = useState(candidate.reportMonth || formatReportMonth());
  const [reason, setReason] = useState(defaultReason);
  const [reasonTags, setReasonTags] = useState<string[]>(defaultReasonTags);
  const [targetStage, setTargetStage] = useState<NonNullable<Candidate["interviewStage"]>>(candidate.interviewStage || "初试");
  const [editingFlow, setEditingFlow] = useState(false);
  const [saving, setSaving] = useState(false);
  const timeline = useMemo(
    () => buildInterviewTimeline(candidate, stage, interviewResult, onboarded),
    [candidate, interviewResult, onboarded, stage],
  );

  useEffect(() => {
    const currentStage = candidate.interviewStage || "初试";
    setStage(currentStage);
    setTargetStage(currentStage);
    setEditingFlow(false);
    setStageRecommendation(candidate.stageRecommendation || "是");
    setInterviewResult(candidate.interviewResult || "待定");
    setOnboarded(candidate.onboarded || "待入职");
    setReportMonth(candidate.reportMonth || formatReportMonth());
    setReason(candidate.interviewReason || buildCandidateOverview(candidate).recommendation || buildCandidateOverview(candidate).risks[0]);
    setReasonTags(normalizeStageReasonTags(candidate.reasonTags?.length ? candidate.reasonTags : inferReasonTags(candidate.interviewReason || candidate.reason || "", activeStage, candidate.onboarded), activeStage, candidate.onboarded));
  }, [candidate.id, candidate.interviewStage, candidate.stageRecommendation, candidate.interviewResult, candidate.onboarded, candidate.reportMonth, candidate.interviewReason, candidate.reasonTags, candidate.reason]);

  const save = async () => {
    setSaving(true);
    try {
      const nextStage = stage !== "offer" && interviewResult === "通过" ? nextInterviewStage(stage) : stage;
      const nextResult = nextStage !== stage ? "待定" : interviewResult;
      const nextTimeline = buildInterviewTimeline(candidate, nextStage, nextResult, onboarded);
      await onSaveStage(candidate.id, nextStage, stageRecommendation, nextResult, onboarded, normalizeReportMonth(reportMonth), reason, reasonTags, nextTimeline);
      setStage(nextStage);
      setTargetStage(nextStage);
      setInterviewResult(nextResult);
    } finally {
      setSaving(false);
    }
  };

  const adjustFlow = async () => {
    setSaving(true);
    try {
      const nextTimeline = buildInterviewTimeline(candidate, targetStage, interviewResult, onboarded);
      await onSaveStage(candidate.id, targetStage, stageRecommendation, interviewResult, onboarded, normalizeReportMonth(reportMonth), reason, reasonTags, nextTimeline);
      setStage(targetStage);
      setEditingFlow(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr>
      <td><strong>{candidate.name}</strong><span className="meta">{candidate.uploadTime}</span></td>
      <td>
        <input className="month-input" value={reportMonth} onChange={(event) => setReportMonth(event.target.value)} onBlur={() => setReportMonth((value) => normalizeReportMonth(value))} placeholder="2026年06月" />
      </td>
      {showJobColumn && <td><strong>{job?.title || "未知岗位"}</strong></td>}
      <td>{candidate.source.split(" · ")[0]}</td>
      <td>
        <select className="decision-select recommendation-select" value={stageRecommendation} onChange={(event) => setStageRecommendation(event.target.value as NonNullable<Candidate["stageRecommendation"]>)}>
          {["是", "否"].map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
      </td>
      <td>
        {activeStage === "offer" ? (
          <select className="decision-select recommendation-select" value={onboarded} onChange={(event) => setOnboarded(event.target.value as NonNullable<Candidate["onboarded"]>)}>
            {["待入职", "是", "否"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        ) : (
          <select className="decision-select recommendation-select" value={interviewResult} onChange={(event) => setInterviewResult(event.target.value as NonNullable<Candidate["interviewResult"]>)}>
            {["通过", "淘汰", "待定", "未到面"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        )}
      </td>
      <td>
        <ReasonTagsDropdown value={reasonTags} options={currentReasonTagOptions} onChange={setReasonTags} />
      </td>
      <td>
        <div className="decision-reason-block">
          <textarea className="decision-reason interview-remark" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="可填写面试判断、跟进情况、风险说明等备注" />
          <div className="timeline-brief">
            {timeline.recommendedAt && <span>推荐初试：{timeline.recommendedAt}</span>}
            {timeline.firstInterviewPassedAt && <span>初试通过：{timeline.firstInterviewPassedAt}</span>}
            {timeline.secondInterviewPassedAt && <span>复试通过：{timeline.secondInterviewPassedAt}</span>}
            {timeline.offerAt && <span>offer确认：{timeline.offerAt}</span>}
            {timeline.onboardedAt && <span>已入职：{timeline.onboardedAt}</span>}
          </div>
        </div>
      </td>
      <td>
        <div className="interview-actions">
          <button className="btn compact" type="button" disabled={saving} onClick={save}>{saving ? "保存中" : "保存"}</button>
          <button className="btn compact ghost" type="button" disabled={saving} onClick={() => setEditingFlow((value) => !value)}>{editingFlow ? "收起" : "修改流程"}</button>
          {editingFlow && (
            <div className="flow-edit-panel">
              <label>
                <span>回退/调整至</span>
                <select className="decision-select stage-select" value={targetStage} onChange={(event) => setTargetStage(event.target.value as NonNullable<Candidate["interviewStage"]>)}>
                  {interviewStages.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <div className="interview-action-row">
                <button className="btn compact primary" type="button" disabled={saving} onClick={adjustFlow}>确认调整</button>
                <button className="btn compact" type="button" disabled={saving} onClick={() => { setTargetStage(stage); setEditingFlow(false); }}>取消</button>
              </div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

function ReasonTagsDropdown({ value, options, onChange }: { value: string[]; options: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const toggleTag = (tag: string) => {
    onChange(value.includes(tag) ? value.filter((item) => item !== tag) : [...value, tag].slice(0, 6));
  };

  return (
    <div className={`reason-tags-dropdown ${open ? "open" : ""}`} ref={wrapRef}>
      <button type="button" className="reason-tags-trigger" onClick={() => setOpen((current) => !current)}>
        <strong>{value.length ? value.join("、") : "选择标签"}</strong>
      </button>
      {open && (
        <div className="reason-tags-menu">
          {options.map((item) => {
            const checked = value.includes(item);
            return (
              <label key={item} className={`reason-tags-option ${checked ? "active" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggleTag(item)} />
                <span>{item}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}


function nextInterviewStage(stage: NonNullable<Candidate["interviewStage"]>) {
  const index = interviewStages.indexOf(stage);
  return interviewStages[Math.min(index + 1, interviewStages.length - 1)];
}

const generalReasonTagOptions = ["薪资不匹配", "稳定性风险", "技能不符", "未到面", "offer流失", "求职动机不足", "通勤地点受限", "管理经验不足", "沟通表达一般"];
const offerReasonTagOptions = ["薪资福利", "接到其他offer", "身体/家庭原因", "岗位调整", "待入职", "其他"];

function getReasonTagOptions(stage: InterviewStage) {
  return stage === "offer" ? offerReasonTagOptions : generalReasonTagOptions;
}

function normalizeStageReasonTags(tags: string[], stage: InterviewStage, onboarded?: Candidate["onboarded"]) {
  const options = getReasonTagOptions(stage);
  const mapped = tags.map((tag) => mapReasonTagByStage(tag, stage, onboarded));
  if (stage === "offer" && onboarded === "待入职" && !mapped.includes("待入职")) {
    mapped.unshift("待入职");
  }
  return Array.from(new Set(mapped.filter((item): item is string => {
    if (!item) return false;
    return options.includes(item);
  }))).slice(0, 6);
}

function mapReasonTagByStage(tag: string, stage: InterviewStage, onboarded?: Candidate["onboarded"]) {
  const value = tag.trim();
  if (!value) return null;
  if (stage !== "offer") return generalReasonTagOptions.includes(value) ? value : null;
  if (offerReasonTagOptions.includes(value)) return value;
  if (value === "薪资不匹配") return "薪资福利";
  if (value === "offer流失") return "接到其他offer";
  if (value === "待入职" || onboarded === "待入职") return "待入职";
  return null;
}

function inferReasonTags(reason: string, stage: InterviewStage = "初试", onboarded?: Candidate["onboarded"]) {
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
    return normalizeStageReasonTags(matched, stage, onboarded);
  }
  return generalReasonTagOptions
    .filter((item) => source.includes(item.replace(/性|一般/g, "")) || source.includes(item))
    .slice(0, 6);
}

function buildInterviewTimeline(
  candidate: Candidate,
  stage: NonNullable<Candidate["interviewStage"]>,
  interviewResult: NonNullable<Candidate["interviewResult"]>,
  onboarded: NonNullable<Candidate["onboarded"]>,
) {
  const stamp = formatDateISO();
  const next = { ...(candidate.interviewTimeline || {}) };
  if ((candidate.stageRecommendation || "是") === "是" || candidate.interviewStage || candidate.conclusion === "已邀面试") {
    next.recommendedAt = next.recommendedAt || stamp;
  }
  if ((stage === "复试" || stage === "offer") && interviewResult !== "未到面") {
    next.firstInterviewPassedAt = next.firstInterviewPassedAt || stamp;
  }
  if (stage === "offer") {
    if (interviewResult !== "未到面") {
      next.secondInterviewPassedAt = next.secondInterviewPassedAt || stamp;
    }
    next.offerAt = next.offerAt || stamp;
  }
  if (onboarded === "是") {
    next.onboardedAt = next.onboardedAt || stamp;
  }
  if (stage !== "offer") {
    delete next.secondInterviewPassedAt;
    delete next.offerAt;
  }
  if (onboarded !== "是") {
    delete next.onboardedAt;
  }
  return next;
}

function formatReportMonth(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}年${month}月`;
}

function formatDateISO(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function normalizeReportMonth(value: string) {
  const compact = value.trim();
  const matched = compact.match(/^(\d{4})\s*(?:年|-|\/)\s*(\d{1,2})\s*(?:月)?$/);
  if (!matched) return compact || formatReportMonth();
  return `${matched[1]}年${matched[2].padStart(2, "0")}月`;
}

function formatPercent(value: number, total: number) {
  if (!total) return "0.00%";
  return `${((value / total) * 100).toFixed(2)}%`;
}

function parseReportMonth(value?: string) {
  const normalized = normalizeReportMonth(value || formatReportMonth());
  const matched = normalized.match(/^(\d{4})年(\d{2})月$/);
  if (!matched) return { year: "未知", month: "00", quarter: "未知季度", normalized };
  const year = matched[1];
  const month = matched[2];
  const quarterIndex = Math.ceil(Number(month) / 3);
  return {
    year,
    month,
    quarter: `${year}年Q${quarterIndex}`,
    normalized,
  };
}

function parseFlexibleDate(value?: string | null) {
  if (!value) return null;
  const normalized = value.trim().replace(/\./g, "/").replace(/-/g, "/").replace(/年/g, "/").replace(/月/g, "").replace(/日/g, "");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function daysBetween(start?: string | null, end?: string | null) {
  const startDate = parseFlexibleDate(start);
  const endDate = parseFlexibleDate(end);
  if (!startDate || !endDate) return null;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)));
}

function parsePercent(value: string) {
  return Number(value.replace("%", "")) || 0;
}

function formatAnalyticsGranularity(granularity: AnalyticsGranularity) {
  if (granularity === "month") return "月度";
  if (granularity === "quarter") return "季度";
  return "年度";
}

function formatComparisonLabel(granularity: AnalyticsGranularity) {
  if (granularity === "month") return "本月 vs 上月";
  if (granularity === "quarter") return "本季度 vs 上季度";
  return "本年 vs 上一年";
}

function getCandidatePeriodValue(candidate: Candidate, granularity: AnalyticsGranularity) {
  const parsed = parseReportMonth(candidate.reportMonth);
  if (granularity === "month") return parsed.normalized;
  if (granularity === "quarter") return parsed.quarter;
  return `${parsed.year}年`;
}

function getAnalyticsPeriodOptions(candidates: Candidate[], granularity: AnalyticsGranularity) {
  return Array.from(new Set(candidates.map((candidate) => getCandidatePeriodValue(candidate, granularity))))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a, "zh-Hans-CN"))
    .map((value) => ({ value, label: value }));
}

function getLatestPeriodValue(candidates: Candidate[], granularity: AnalyticsGranularity) {
  return getAnalyticsPeriodOptions(candidates, granularity)[0]?.value || "";
}

function getPreviousPeriodValue(period: string, granularity: AnalyticsGranularity) {
  if (!period) return "";
  if (granularity === "month") {
    const matched = period.match(/^(\d{4})年(\d{2})月$/);
    if (!matched) return "";
    const date = new Date(Number(matched[1]), Number(matched[2]) - 2, 1);
    return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月`;
  }
  if (granularity === "quarter") {
    const matched = period.match(/^(\d{4})年Q([1-4])$/);
    if (!matched) return "";
    const year = Number(matched[1]);
    const quarter = Number(matched[2]);
    return quarter > 1 ? `${year}年Q${quarter - 1}` : `${year - 1}年Q4`;
  }
  const matched = period.match(/^(\d{4})年$/);
  return matched ? `${Number(matched[1]) - 1}年` : "";
}

function filterCandidatesByJobScope(candidates: Candidate[], jobId: string) {
  if (jobId === "all") return candidates;
  return candidates.filter((candidate) => candidate.jobId === jobId);
}

function percentValue(value: number, total: number) {
  if (!total) return 0;
  return Number((((value / total) * 100)).toFixed(1));
}

function buildPeriodComparison(currentCandidates: Candidate[], previousCandidates: Candidate[]) {
  const currentOverview = buildRecruitmentAnalytics(currentCandidates);
  const previousOverview = buildRecruitmentAnalytics(previousCandidates);
  const currentInvited = currentCandidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
  const previousInvited = previousCandidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
  const currentAttendedFirst = currentCandidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.interviewStage === "初试" || candidate.interviewStage === "复试" || candidate.interviewStage === "offer") && candidate.interviewResult !== "未到面").length;
  const previousAttendedFirst = previousCandidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.interviewStage === "初试" || candidate.interviewStage === "复试" || candidate.interviewStage === "offer") && candidate.interviewResult !== "未到面").length;
  const currentFirstPass = currentCandidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
  const previousFirstPass = previousCandidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
  const currentRetestPass = currentCandidates.filter((candidate) => candidate.interviewStage === "offer").length;
  const previousRetestPass = previousCandidates.filter((candidate) => candidate.interviewStage === "offer").length;
  const currentOnboarded = currentCandidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "是").length;
  const previousOnboarded = previousCandidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "是").length;

  const metrics = [
    { label: "面试邀约出席率", current: percentValue(currentAttendedFirst, currentInvited), previous: percentValue(previousAttendedFirst, previousInvited), type: "rate" as const },
    { label: "初试通过率", current: percentValue(currentFirstPass, currentAttendedFirst), previous: percentValue(previousFirstPass, previousAttendedFirst), type: "rate" as const },
    { label: "复试通过率", current: percentValue(currentRetestPass, currentFirstPass), previous: percentValue(previousRetestPass, previousFirstPass), type: "rate" as const },
    { label: "offer入职率", current: percentValue(currentOnboarded, currentRetestPass), previous: percentValue(previousOnboarded, previousRetestPass), type: "rate" as const },
  ].map((item) => {
    const delta = Number((item.current - item.previous).toFixed(1));
    return {
      ...item,
      delta,
      tone: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    };
  });

  const biggestDrop = [...metrics].sort((a, b) => a.delta - b.delta)[0];
  const biggestGain = [...metrics].sort((a, b) => b.delta - a.delta)[0];
  const summary = previousOverview.resumeTotal || currentOverview.resumeTotal
    ? biggestDrop && biggestDrop.delta < 0
      ? `${biggestDrop.label} 较上期下降 ${Math.abs(biggestDrop.delta).toFixed(1)} 个百分点，这是当前最值得先复盘的环节。${biggestGain && biggestGain.delta > 0 ? `相对更稳定的是 ${biggestGain.label}，较上期提升 ${biggestGain.delta.toFixed(1)} 个百分点。` : ""}`
      : biggestGain && biggestGain.delta > 0
        ? `当前各环节通过率整体稳定，其中 ${biggestGain.label} 较上期提升 ${biggestGain.delta.toFixed(1)} 个百分点。`
        : "当前周期与上期通过率基本持平，建议继续结合原因标签与流程耗时判断真正卡点。"
    : "当前和上期样本都较少，建议继续沉淀本期面试和录用结果。";

  return { metrics, summary };
}

function buildRecruitmentAnalytics(candidates: Candidate[]) {
  const resumeTotal = candidates.length;
  const invitedFirstInterview = candidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
  const attendedFirstInterview = candidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.interviewStage === "初试" || candidate.interviewStage === "复试" || candidate.interviewStage === "offer") && (candidate.interviewResult !== "未到面")).length;
  const passedFirstInterview = candidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
  const attendedRetest = candidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
  const passedRetest = candidates.filter((candidate) => candidate.interviewStage === "offer").length;
  const hiredCount = candidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded !== "否").length;

  const rows = [
    {
      label: "推荐简历总数",
      count: resumeTotal,
      share: formatPercent(resumeTotal, resumeTotal),
      conversion: "",
      conversionHint: "",
      note: "",
    },
    {
      label: "通知初试人数",
      count: invitedFirstInterview,
      share: formatPercent(invitedFirstInterview, resumeTotal),
      conversion: formatPercent(invitedFirstInterview, resumeTotal),
      conversionHint: "简历有效率",
      note: "进入面试流程的人选",
    },
    {
      label: "实际参加初试人数",
      count: attendedFirstInterview,
      share: formatPercent(attendedFirstInterview, resumeTotal),
      conversion: formatPercent(attendedFirstInterview, invitedFirstInterview),
      conversionHint: "初试通知出席率",
      note: "剔除未到面人选",
    },
    {
      label: "初试通过人数",
      count: passedFirstInterview,
      share: formatPercent(passedFirstInterview, resumeTotal),
      conversion: formatPercent(passedFirstInterview, attendedFirstInterview),
      conversionHint: "初试通过占比",
      note: "进入复试阶段",
    },
    {
      label: "实际参加复试人数",
      count: attendedRetest,
      share: formatPercent(attendedRetest, resumeTotal),
      conversion: formatPercent(attendedRetest, passedFirstInterview),
      conversionHint: "复试通知出席率",
      note: "已进入复试/offer流程",
    },
    {
      label: "复试通过人数",
      count: passedRetest,
      share: formatPercent(passedRetest, resumeTotal),
      conversion: formatPercent(passedRetest, attendedRetest),
      conversionHint: "复试通过占比",
      note: "进入 offer 阶段",
    },
    {
      label: "最终录用人数",
      count: hiredCount,
      share: formatPercent(hiredCount, resumeTotal),
      conversion: formatPercent(hiredCount, passedRetest),
      conversionHint: "录用人数占比",
      note: "含待入职与已入职",
    },
  ];

  return {
    resumeTotal,
    hiredCount,
    rows,
    chartRows: rows.map((row) => ({
      label: row.label,
      count: row.count,
      shareValue: resumeTotal ? Number(((row.count / resumeTotal) * 100).toFixed(2)) : 0,
    })),
  };
}

function buildJobAnalytics(jobs: Job[], candidates: Candidate[]) {
  return jobs
    .map((job) => {
      const jobCandidates = candidates.filter((candidate) => candidate.jobId === job.id);
      const resumeCount = jobCandidates.length;
      const invitedCount = jobCandidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
      const retestCount = jobCandidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
      const hiredCount = jobCandidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded !== "否").length;
      if (!resumeCount) return null;
      const inviteRate = formatPercent(invitedCount, resumeCount);
      const hireRate = formatPercent(hiredCount, resumeCount);
      return {
        jobId: job.id,
        jobTitle: job.title,
        deptLocation: `${job.dept} · ${job.location}`,
        resumeCount,
        invitedCount,
        retestCount,
        hiredCount,
        inviteRate,
        hireRate,
        summary: hiredCount > 0
          ? `${job.title} 当前已有录用转化，建议复盘高转化来源渠道与面试通过路径。`
          : invitedCount === 0
            ? `${job.title} 当前仍停留在简历阶段，建议先检查 JD、渠道质量和首轮邀约动作。`
            : `${job.title} 已推进到面试流程，但录用转化仍弱，建议复盘复试到 offer 的卡点。`,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.hiredCount - a.hiredCount || b.resumeCount - a.resumeCount);
}

function buildPendingOnboardReasonAnalytics(candidates: Candidate[], jobs: Job[]) {
  const targetCandidates = candidates.filter((candidate) =>
    (candidate.interviewStage === "复试" && candidate.interviewResult !== "淘汰" && candidate.interviewResult !== "未到面")
    || (candidate.interviewStage === "offer" && candidate.onboarded !== "是"),
  );

  const reasonCounter = new Map<string, number>();
  const departmentCounter = new Map<string, Map<string, number>>();

  targetCandidates.forEach((candidate) => {
    const job = jobs.find((item) => item.id === candidate.jobId);
    const department = job?.dept || "未知部门";
    const tags = normalizeStageReasonTags(
      candidate.reasonTags?.length
        ? candidate.reasonTags
        : inferReasonTags(candidate.interviewReason || candidate.reason || "", "offer", candidate.onboarded),
      "offer",
      candidate.onboarded,
    );

    const normalizedTags = tags.length ? tags : ["其他"];
    const deptMap = departmentCounter.get(department) || new Map<string, number>();
    normalizedTags.forEach((tag) => {
      reasonCounter.set(tag, (reasonCounter.get(tag) || 0) + 1);
      deptMap.set(tag, (deptMap.get(tag) || 0) + 1);
    });
    departmentCounter.set(department, deptMap);
  });

  const reasonColumns = offerReasonTagOptions;
  const departmentRows = Array.from(departmentCounter.entries())
    .map(([department, counts]) => ({
      department,
      counts: reasonColumns.map((label) => counts.get(label) || 0),
      total: reasonColumns.reduce((sum, label) => sum + (counts.get(label) || 0), 0),
    }))
    .sort((a, b) => b.total - a.total || a.department.localeCompare(b.department, "zh-Hans-CN"));

  const rows = reasonColumns.map((label) => {
    const count = reasonCounter.get(label) || 0;
    return {
      label,
      count,
      share: "0.0%",
    };
  });

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const normalizedRows = rows.map((row) => ({
    ...row,
    share: total ? `${((row.count / total) * 100).toFixed(1)}%` : "0.0%",
  }));

  const totalRow = {
    department: "合计",
    counts: reasonColumns.map((label) => reasonCounter.get(label) || 0),
  };

  const chartData = normalizedRows
    .filter((row) => row.count > 0)
    .map((row) => ({ name: row.label, value: row.count }));

  return { rows: normalizedRows, total, chartData, reasonColumns, departmentRows, totalRow };
}

function extractReasonTags(candidates: Candidate[]) {
  const source = candidates.flatMap((candidate) => {
    if (candidate.reasonTags?.length) return candidate.reasonTags;
    return inferReasonTags(candidate.interviewReason || candidate.reason || "", candidate.interviewStage || "初试", candidate.onboarded);
  });

  const counter = new Map<string, number>();
  source.forEach((item) => counter.set(item, (counter.get(item) || 0) + 1));
  return Array.from(counter.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function normalizeCandidateSource(source: string) {
  const normalized = source.split(" · ")[0].trim();
  if (/boss/i.test(normalized)) return "BOSS";
  if (/智联/.test(normalized)) return "智联";
  if (/猎聘/.test(normalized)) return "猎聘";
  if (/内推/.test(normalized)) return "内推";
  return "其他";
}

function buildChannelAnalytics(candidates: Candidate[]) {
  const groups = new Map<string, Candidate[]>();
  candidates.forEach((candidate) => {
    const source = normalizeCandidateSource(candidate.source);
    const list = groups.get(source) || [];
    list.push(candidate);
    groups.set(source, list);
  });

  const rows = Array.from(groups.entries()).map(([source, items]) => {
    const resumeCount = items.length;
    const invitedCount = items.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
    const firstPassCount = items.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
    const offerCount = items.filter((candidate) => candidate.interviewStage === "offer").length;
    const onboardedCount = items.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "是").length;
    return {
      source,
      resumeCount,
      invitedCount,
      firstPassCount,
      offerCount,
      onboardedCount,
      inviteRate: formatPercent(invitedCount, resumeCount),
      firstPassRate: formatPercent(firstPassCount, invitedCount),
      onboardRate: formatPercent(onboardedCount, resumeCount),
      summary: resumeCount
        ? `${source} 当前入库 ${resumeCount} 份，推荐初试 ${invitedCount} 人，最终入职 ${onboardedCount} 人。`
        : `${source} 当前暂无有效渠道样本。`,
    };
  }).sort((a, b) => b.onboardedCount - a.onboardedCount || b.resumeCount - a.resumeCount);

  const topChannel = rows[0] || null;
  const lowConversionChannel = [...rows]
    .filter((item) => item.resumeCount >= 2)
    .sort((a, b) => parsePercent(a.onboardRate) - parsePercent(b.onboardRate))[0] || null;

  return {
    rows,
    summary: topChannel
      ? `${topChannel.source} 当前入库 ${topChannel.resumeCount} 份，入职转化 ${topChannel.onboardRate}${lowConversionChannel && lowConversionChannel.source !== topChannel.source ? `；${lowConversionChannel.source} 需要优先复盘渠道质量。` : "。"}`
      : "当前周期暂无足够渠道数据。",
  };
}

function buildStageDurationAnalytics(candidates: Candidate[]) {
  const stages = [
    {
      key: "recommendToFirstPass",
      label: "推荐初试→初试通过",
      values: candidates.map((candidate) => daysBetween(candidate.interviewTimeline?.recommendedAt, candidate.interviewTimeline?.firstInterviewPassedAt)).filter((value): value is number => value !== null),
      threshold: 7,
    },
    {
      key: "firstPassToSecondPass",
      label: "初试通过→复试通过",
      values: candidates.map((candidate) => daysBetween(candidate.interviewTimeline?.firstInterviewPassedAt, candidate.interviewTimeline?.secondInterviewPassedAt)).filter((value): value is number => value !== null),
      threshold: 10,
    },
    {
      key: "secondPassToOffer",
      label: "复试通过→offer确认",
      values: candidates.map((candidate) => daysBetween(candidate.interviewTimeline?.secondInterviewPassedAt, candidate.interviewTimeline?.offerAt)).filter((value): value is number => value !== null),
      threshold: 7,
    },
    {
      key: "offerToOnboard",
      label: "offer确认→入职完结",
      values: candidates.map((candidate) => daysBetween(candidate.interviewTimeline?.offerAt, candidate.interviewTimeline?.onboardedAt)).filter((value): value is number => value !== null),
      threshold: 14,
    },
  ].map((item) => {
    const averageDays = item.values.length ? Number((item.values.reduce((sum, value) => sum + value, 0) / item.values.length).toFixed(1)) : null;
    const level = averageDays === null ? "empty" : averageDays > item.threshold ? "risk" : averageDays > item.threshold * 0.75 ? "watch" : "healthy";
    return {
      key: item.key,
      label: item.label,
      sampleCount: item.values.length,
      averageDays,
      level,
      note: averageDays === null
        ? "当前样本不足，建议继续沉淀流程时间。"
        : level === "risk"
          ? `当前平均耗时偏长，已超过建议阈值 ${item.threshold} 天。`
          : level === "watch"
            ? `当前接近阈值 ${item.threshold} 天，建议提前盯办。`
            : "当前阶段推进较稳定，可继续保持。",
    };
  });

  const bottleneck = stages
    .filter((item) => item.averageDays !== null)
    .sort((a, b) => Number(b.averageDays) - Number(a.averageDays))[0] || null;

  return {
    rows: stages,
    summary: bottleneck && bottleneck.averageDays !== null
      ? `${bottleneck.label} 平均耗时 ${bottleneck.averageDays} 天，是当前最需要盯的流程卡点。`
      : "当前周期内耗时样本还不够，建议继续在面试管理中沉淀流程时间。",
  };
}

function buildIssueReview(candidates: Candidate[]) {
  const noShow = candidates.filter((candidate) => candidate.interviewResult === "未到面");
  const rejected = candidates.filter((candidate) => candidate.interviewResult === "淘汰");
  const pendingOnboard = candidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "待入职");
  const failedOnboard = candidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded === "否");
  const topReasons = extractReasonTags([...noShow, ...rejected, ...pendingOnboard, ...failedOnboard]);

  const suggestions = [
    noShow.length ? `未到面 ${noShow.length} 人，建议重点复盘邀约确认、面试提醒和候选人动机稳定性。` : "本期未到面风险较低，可继续保持面试确认动作。",
    rejected.length ? `淘汰 ${rejected.length} 人，建议回看初试与复试评估标准是否一致，避免前后口径偏差。` : "淘汰数据较少，建议继续保持筛选前置准确度。",
    pendingOnboard.length || failedOnboard.length
      ? `offer 阶段共 ${pendingOnboard.length + failedOnboard.length} 人存在入职风险，建议提前锁定薪资、到岗与流程进展。`
      : "offer 阶段当前较稳定，可继续前置确认入职窗口。",
  ];

  return {
    noShowCount: noShow.length,
    rejectedCount: rejected.length,
    pendingOnboardCount: pendingOnboard.length,
    failedOnboardCount: failedOnboard.length,
    topReasons,
    suggestions,
    summary: topReasons.length
      ? `本期复盘里，最值得优先处理的问题集中在“${topReasons.slice(0, 2).map((item) => item.label).join("、")}”。建议结合岗位与月份再拆解动作。`
      : "当前周期内原因沉淀较少，建议在面试管理中继续完善每位候选人的理由记录。",
  };
}

function buildRecruitmentActionPlan({
  activeJobs,
  channelAnalytics,
  durationAnalytics,
  issueReview,
}: {
  activeJobs: Job[];
  channelAnalytics: ReturnType<typeof buildChannelAnalytics>;
  durationAnalytics: ReturnType<typeof buildStageDurationAnalytics>;
  issueReview: ReturnType<typeof buildIssueReview>;
}) {
  const actions: Array<{ priority: "P1" | "P2" | "P3"; title: string; text: string }> = [];
  const averageResumeCount = activeJobs.length ? activeJobs.reduce((sum, job) => sum + job.resumeCount, 0) / activeJobs.length : 0;
  const lowVolumeJob = activeJobs
    .filter((job) => job.resumeCount <= Math.max(2, Math.floor(averageResumeCount * 0.6)))
    .sort((a, b) => a.resumeCount - b.resumeCount)[0];
  if (lowVolumeJob) {
    actions.push({
      priority: "P1",
      title: `优先补量：${lowVolumeJob.title}`,
      text: `${lowVolumeJob.title} 当前仅有 ${lowVolumeJob.resumeCount} 份简历，建议先复核 JD 关键词、渠道投放和薪资竞争力，优先把有效简历量补上来。`,
    });
  }

  const weakChannel = channelAnalytics.rows
    .filter((item) => item.resumeCount >= 2)
    .sort((a, b) => parsePercent(a.onboardRate) - parsePercent(b.onboardRate))[0];
  if (weakChannel) {
    actions.push({
      priority: "P1",
      title: `优先复盘渠道：${weakChannel.source}`,
      text: `${weakChannel.source} 当前入库 ${weakChannel.resumeCount} 份，但入职转化仅 ${weakChannel.onboardRate}，建议回看该渠道的筛选标准与沟通话术。`,
    });
  }

  const bottleneck = durationAnalytics.rows
    .filter((item) => item.averageDays !== null)
    .sort((a, b) => Number(b.averageDays) - Number(a.averageDays))[0];
  if (bottleneck && bottleneck.averageDays !== null) {
    actions.push({
      priority: "P2",
      title: `优先提速：${bottleneck.label}`,
      text: `${bottleneck.label} 平均耗时 ${bottleneck.averageDays} 天，建议明确面试反馈 SLA，并把等待决策最长的岗位单独盯办。`,
    });
  }

  if (issueReview.topReasons[0]) {
    actions.push({
      priority: "P3",
      title: `优先治理标签：${issueReview.topReasons[0].label}`,
      text: `当前高频问题集中在“${issueReview.topReasons.slice(0, 2).map((item) => item.label).join("、")}”，建议把对应问题写进邀约确认、初筛追问和 offer 跟进 SOP。`,
    });
  }

  return actions.slice(0, 3);
}

function buildFocusJobAnalysis(job: Job, candidates: Candidate[]) {
  const resumeCount = candidates.length;
  const invitedCount = candidates.filter((candidate) => isInterviewCandidate(candidate) && (candidate.stageRecommendation || "是") === "是").length;
  const firstPassCount = candidates.filter((candidate) => candidate.interviewStage === "复试" || candidate.interviewStage === "offer").length;
  const retestPassCount = candidates.filter((candidate) => candidate.interviewStage === "offer").length;
  const hiredCount = candidates.filter((candidate) => candidate.interviewStage === "offer" && candidate.onboarded !== "否").length;
  const salaryData = job.salaryData;
  const validSalaryData = salaryData && salaryData.status !== "insufficient_data" ? salaryData : null;
  const keywordCount = splitKeywords(job.keywords).length;
  const jdComplexity = keywordCount >= 4 || job.description.length > 90 ? "较高" : keywordCount >= 2 ? "中等" : "基础";
  const marketSignal = validSalaryData
    ? `${validSalaryData.benchmarkRegion}${validSalaryData.jobFamily} 市场中位值约 ${validSalaryData.p50}k`
    : "暂无薪酬调研数据";
  const salaryGap = validSalaryData
    ? compareSalaryRange(job.salaryRange, validSalaryData.suggestedLow, validSalaryData.suggestedHigh)
    : "unknown";

  const factors = [
    keywordCount >= 4 ? "岗位关键词较多，说明画像更复合，通常会直接压缩可投递简历池。" : "岗位关键词相对集中，画像本身没有明显过宽问题。",
    salaryGap === "low" ? "当前薪资范围低于系统建议区间，可能影响简历量和 offer 接受率。" : salaryGap === "high" ? "当前薪资范围高于市场建议区间，对吸引简历有帮助，但需关注预算利用率。" : "当前薪资与市场建议区间基本接近，主要影响因素更可能来自 JD 和渠道质量。",
    resumeCount && invitedCount / Math.max(resumeCount, 1) < 0.4 ? "简历入库后推荐面试率偏低，说明简历质量或筛选条件匹配仍需优化。" : "简历到推荐面试的转化尚可，说明前端渠道与画像匹配度基本正常。",
    validSalaryData?.advice.keywordPremiums.length ? `市场侧识别到 ${validSalaryData.advice.keywordPremiums[0]}` : "当前岗位还缺少市场溢价解释，可补充薪酬调研后再复盘。",
  ];

  const suggestions = [
    keywordCount >= 4 ? "建议将重点考核点分成“必须项”和“加分项”，减少 JD 过度复合导致的投递门槛。" : "可继续保持当前关键词结构，重点优化渠道投放与筛选效率。",
    salaryGap === "low" ? "建议优先复核薪资锚点，必要时上调到更接近市场建议区间。" : "薪资暂不是首要问题，可优先优化 JD 表达和筛选标准。",
    invitedCount && firstPassCount / Math.max(invitedCount, 1) < 0.5 ? "初试通过率偏低，建议复盘 JD 与初筛标准是否一致，避免前端吸引错位简历。" : "初试通过率尚可，可继续关注复试与 offer 阶段的转化。",
    hiredCount === 0 ? "若当前无录用，建议拆看渠道来源与未通过原因，优先找出最主要卡点。" : "已有录用转化，建议沉淀该岗位的高效渠道与高通过问题模板。",
  ];

  return {
    resumeCount,
    inviteRate: formatPercent(invitedCount, resumeCount),
    firstPassRate: formatPercent(firstPassCount, invitedCount),
    retestPassRate: formatPercent(retestPassCount, firstPassCount),
    hireRate: formatPercent(hiredCount, resumeCount),
    jdComplexity,
    marketSignal,
    factors,
    suggestions,
    summary: validSalaryData
      ? `${job.title} 当前在 ${job.location} 的市场建议区间更适合参考 ${validSalaryData.suggestedLow}-${validSalaryData.suggestedHigh}k。结合 JD 和简历转化看，当前岗位的核心影响因素主要集中在画像复杂度、薪资竞争力和面试前筛选效率。`
      : `${job.title} 当前已具备岗位 JD 和简历转化数据，但缺少市场薪酬对照。建议先补充薪酬调研，再做更完整的岗位复盘。`,
  };
}

function compareSalaryRange(salaryRange: string, suggestedLow: number, suggestedHigh: number) {
  const matched = salaryRange.match(/(\d+)\s*[-~—]\s*(\d+)/);
  if (!matched) return "unknown";
  const low = Number(matched[1]);
  const high = Number(matched[2]);
  const avg = (low + high) / 2;
  const suggestedAvg = (suggestedLow + suggestedHigh) / 2;
  if (avg < suggestedAvg * 0.92) return "low";
  if (avg > suggestedAvg * 1.08) return "high";
  return "balanced";
}

function VoiceParseView({
  jobs,
  currentJob,
  candidatesByJob,
  voiceAnalysesByJob,
  onStateChange,
  onToast,
}: {
  jobs: Job[];
  currentJob: Job;
  candidatesByJob: AppState["candidates"];
  voiceAnalysesByJob: AppState["voiceAnalyses"];
  onStateChange: (next: AppState) => void;
  onToast: (message: string) => void;
}) {
  const recordingJobs = jobs.filter((job) => job.status === "招聘中");
  const [jobId, setJobId] = useState(currentJob.status === "招聘中" ? currentJob.id : recordingJobs[0]?.id || "");
  const [libraryJobId, setLibraryJobId] = useState(currentJob.id || jobs[0]?.id || "");
  const candidates = candidatesByJob[jobId] || [];
  const [candidateId, setCandidateId] = useState(candidates[0]?.id || "");
  const [status, setStatus] = useState<VoiceSessionStatus>("idle");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [liveHint, setLiveHint] = useState("");
  const [manualNotes, setManualNotes] = useState("");
  const [copiedKey, setCopiedKey] = useState<"all" | "candidate" | "recruiter" | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<string>("");
  const [sessionId, setSessionId] = useState("");
  const [segmentIndex, setSegmentIndex] = useState(0);
  const [isUploadingChunk, setIsUploadingChunk] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [copiedHistory, setCopiedHistory] = useState(false);
  const [deletingHistory, setDeletingHistory] = useState(false);
  const [aiLiveState, setAiLiveState] = useState<VoiceAiLiveState | null>(null);
  const [finalEvaluation, setFinalEvaluation] = useState<VoiceFinalEvaluation | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkQueueRef = useRef<Blob[]>([]);
  const flushTimerRef = useRef<number | null>(null);
  const isFlushingRef = useRef(false);
  const shouldResumeRef = useRef(false);

  useEffect(() => {
    if (!recordingJobs.some((job) => job.id === jobId)) setJobId((currentJob.status === "招聘中" ? currentJob.id : recordingJobs[0]?.id) || "");
  }, [currentJob.id, currentJob.status, jobId, recordingJobs]);

  useEffect(() => {
    if (!jobs.some((job) => job.id === libraryJobId)) setLibraryJobId(currentJob.id || jobs[0]?.id || "");
  }, [currentJob.id, jobs, libraryJobId]);

  useEffect(() => {
    const nextCandidates = candidatesByJob[jobId] || [];
    if (!nextCandidates.some((candidate) => candidate.id === candidateId)) {
      setCandidateId(nextCandidates[0]?.id || "");
    }
  }, [candidateId, candidatesByJob, jobId]);

  useEffect(() => {
    const records = voiceAnalysesByJob[libraryJobId] || [];
    if (selectedHistoryId && records.some((item) => item.id === selectedHistoryId)) return;
    if (selectedHistoryId) setSelectedHistoryId("");
  }, [libraryJobId, selectedHistoryId, voiceAnalysesByJob]);

  useEffect(() => () => {
    shouldResumeRef.current = false;
    if (flushTimerRef.current) window.clearInterval(flushTimerRef.current);
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const selectedJob = recordingJobs.find((job) => job.id === jobId) || currentJob;
  const librarySelectedJob = jobs.find((job) => job.id === libraryJobId) || selectedJob;
  const selectedCandidate = candidates.find((candidate) => candidate.id === candidateId) || null;
  const transcript = finalTranscript.trim();
  const fallbackAnalysis = selectedCandidate ? analyzeRealtimeVoice(selectedJob, selectedCandidate, [transcript, manualNotes].filter(Boolean).join("\n")) : null;
  const analysis = selectedCandidate
    ? buildVoiceRealtimeAnalysisFromAi(selectedJob, selectedCandidate, aiLiveState, finalEvaluation) || fallbackAnalysis
    : null;
  const highlightTerms = useMemo(() => buildVoiceHighlightTerms(selectedJob, transcript, manualNotes), [manualNotes, selectedJob, transcript]);
  const supportsRecording = typeof window !== "undefined" && Boolean(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);
  const voiceHistory = useMemo(() => voiceAnalysesByJob[libraryJobId] || [], [libraryJobId, voiceAnalysesByJob]);
  const selectedHistory = useMemo(() => voiceHistory.find((item) => item.id === selectedHistoryId) || null, [selectedHistoryId, voiceHistory]);
  const historyCandidates = candidatesByJob[libraryJobId] || [];
  const historyCandidate = selectedHistory ? historyCandidates.find((candidate) => candidate.id === selectedHistory.candidateId) || null : null;
  const historyHighlightTerms = useMemo(
    () => selectedHistory ? buildVoiceHighlightTerms(librarySelectedJob, selectedHistory.transcript, "") : [],
    [librarySelectedJob, selectedHistory],
  );
  const shouldShowCurrentOutput = !!selectedCandidate && !!analysis && (!!transcript || !!manualNotes.trim() || status === "listening" || status === "paused" || status === "stopped");

  const markCopied = (key: "all" | "candidate" | "recruiter") => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1600);
  };

  const copyText = async (key: "all" | "candidate" | "recruiter", text: string) => {
    await navigator.clipboard.writeText(text);
    markCopied(key);
  };

  const copyHistoryDetail = async () => {
    if (!selectedHistory || !historyCandidate) return;
    await navigator.clipboard.writeText(formatRealtimeVoiceCopy({
      job: librarySelectedJob,
      candidate: historyCandidate,
      analysis: selectedHistory,
      transcript: selectedHistory.transcript,
      manualNotes: "",
      sessionStartedAt: selectedHistory.createdAt,
    }));
    setCopiedHistory(true);
    window.setTimeout(() => setCopiedHistory(false), 1600);
  };

  const appendTranscript = (text: string) => {
    const next = text.trim();
    if (!next) return;
    setFinalTranscript((value) => `${value}${value ? "\n" : ""}${next}`.trim());
  };

  const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.split(",")[1] || "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  const flushChunks = async () => {
    if (isFlushingRef.current || !chunkQueueRef.current.length) return;
    isFlushingRef.current = true;
    setIsUploadingChunk(true);
    setLiveHint("正在转写最新录音片段...");
    const merged = new Blob(chunkQueueRef.current.splice(0, chunkQueueRef.current.length), {
      type: recorderRef.current?.mimeType || "audio/webm",
    });
    try {
      const audioBase64 = await blobToBase64(merged);
      const result = await api.transcribeVoiceChunk({
        audioBase64,
        mimeType: merged.type || "audio/webm",
        fileName: `voice-${Date.now()}.webm`,
      });
      const normalized = result.normalizedTranscript || result.transcript;
      appendTranscript(normalized);
      setLiveHint(result.normalizedTranscript ? "已完成实时整理" : "已完成实时转写");
      if (selectedCandidate && sessionId && normalized.trim()) {
        const nextSegmentIndex = segmentIndex + 1;
        setSegmentIndex(nextSegmentIndex);
        try {
          const liveResult = await api.analyzeVoiceSegment({
            sessionId,
            segmentId: `seg_${Date.now()}_${nextSegmentIndex}`,
            jobId,
            candidateId: selectedCandidate.id,
            segmentIndex: nextSegmentIndex,
            rawTranscript: result.transcript,
            normalizedTranscript: normalized,
          });
          setAiLiveState(liveResult);
        } catch (error) {
          onToast(error instanceof Error ? error.message : "实时 AI 分析失败");
        }
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : "实时转写失败");
      setLiveHint("转写失败，请继续录音或稍后重试");
    } finally {
      isFlushingRef.current = false;
      setIsUploadingChunk(false);
    }
  };

  const startRecorder = async () => {
    const stream = streamRef.current || await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunkQueueRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    recorder.start(2000);
    if (flushTimerRef.current) window.clearInterval(flushTimerRef.current);
    flushTimerRef.current = window.setInterval(() => {
      void flushChunks();
    }, 3500);
  };

  const startSession = async () => {
    if (!selectedCandidate) {
      onToast("请先选择人选");
      return;
    }
    if (!supportsRecording) {
      onToast("当前浏览器不支持网页端录音，建议使用最新版 Chrome");
      return;
    }
    shouldResumeRef.current = true;
    setSelectedHistoryId("");
    const nextSessionId = `voice_session_${Date.now()}`;
    setSessionId(nextSessionId);
    setSegmentIndex(0);
    setAiLiveState(null);
    setFinalEvaluation(null);
    setSessionStartedAt(new Date().toLocaleString("zh-CN"));
    try {
      setFinalTranscript("");
      setManualNotes("");
      await startRecorder();
      setStatus("listening");
      setCopiedKey(null);
      setLiveHint("正在录音，系统会自动分段转写...");
    } catch {
      onToast("录音启动失败，请检查麦克风权限");
    }
  };

  const pauseSession = () => {
    shouldResumeRef.current = false;
    recorderRef.current?.requestData();
    recorderRef.current?.pause();
    window.setTimeout(() => { void flushChunks(); }, 160);
    setStatus("paused");
    setLiveHint("已暂停，正在整理最后一段录音...");
  };

  const resumeSession = async () => {
    const recorder = recorderRef.current;
    if (!recorder) {
      onToast("当前没有可继续的录音会话");
      return;
    }
    shouldResumeRef.current = true;
    try {
      recorder.resume();
      setStatus("listening");
      setCopiedKey(null);
      setLiveHint("已继续录音");
    } catch {
      onToast("恢复录音失败，请稍后再试");
    }
  };

  const stopSession = () => {
    shouldResumeRef.current = false;
    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    window.setTimeout(() => { void flushChunks(); }, 220);
    setStatus("stopped");
    setLiveHint("本次录音已结束，正在完成最后整理...");
    onToast("本次录音已结束，可保存到录音库或直接复制输出");
    if (selectedCandidate && sessionId) {
      window.setTimeout(() => {
        void api.evaluateVoiceInterview({
          sessionId,
          jobId,
          candidateId: selectedCandidate.id,
        }).then((result) => {
          setFinalEvaluation(result);
          setLiveHint("已生成整场面试评估");
        }).catch((error) => {
          onToast(error instanceof Error ? error.message : "整场面试评估失败");
        });
      }, 600);
    }
  };

  const clearSession = () => {
    shouldResumeRef.current = false;
    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    chunkQueueRef.current = [];
    isFlushingRef.current = false;
    setStatus("idle");
    setFinalTranscript("");
    setLiveHint("");
    setManualNotes("");
    setCopiedKey(null);
    setSessionStartedAt("");
    setSessionId("");
    setSegmentIndex(0);
    setAiLiveState(null);
    setFinalEvaluation(null);
  };

  const saveToLibrary = async () => {
    if (!selectedCandidate || !analysis) {
      onToast("请先选择人选并生成解析结果");
      return;
    }
    const mergedTranscript = [transcript, manualNotes.trim() ? `补充备注：\n${manualNotes.trim()}` : ""].filter(Boolean).join("\n\n").trim();
    if (!mergedTranscript) {
      onToast("当前没有可保存的录音内容");
      return;
    }
    setSaving(true);
    try {
      const { state: nextState, analysis: saved } = await api.saveVoiceAnalysis({
        jobId,
        candidateId: selectedCandidate.id,
        audioName: `${selectedCandidate.name}-${sessionStartedAt || new Date().toLocaleString("zh-CN")}`,
        audioType: "audio/webm",
        audioSize: null,
        transcript: mergedTranscript,
        summary: analysis.summary,
        jobFitAdvice: analysis.jobFitAdvice,
        communicationStrengths: analysis.communicationStrengths,
        communicationRisks: analysis.communicationRisks,
        recruiterSuggestions: analysis.recruiterSuggestions,
        recruiterReview: analysis.recruiterReview,
        recommendation: analysis.recommendation,
      });
      setLibraryJobId(jobId);
      onStateChange(nextState);
      setSelectedHistoryId(saved.id);
      onToast("已保存到录音库");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "保存录音库失败");
    } finally {
      setSaving(false);
    }
  };

  const removeHistory = async () => {
    if (!selectedHistory) return;
    if (!window.confirm("确认删除这条录音记录？删除后无法恢复。")) return;
    setDeletingHistory(true);
    try {
      const { state: nextState } = await api.deleteVoiceAnalysis(selectedHistory.id);
      onStateChange(nextState);
      onToast("录音记录已删除");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "删除录音记录失败");
    } finally {
      setDeletingHistory(false);
    }
  };

  const copyBundle = async (
    key: "all" | "candidate" | "recruiter",
    mode: "all" | "candidate" | "recruiter",
    sourceAnalysis: VoiceRealtimeAnalysis | VoiceAnalysis,
    sourceCandidate: Candidate,
    sourceTranscript: string,
    sourceSessionStartedAt: string,
    sourceManualNotes = "",
  ) => {
    const text = mode === "candidate"
      ? formatCandidateAssessmentCopy({
        job: selectedJob,
        candidate: sourceCandidate,
        analysis: sourceAnalysis,
        transcript: sourceTranscript,
        manualNotes: sourceManualNotes,
        sessionStartedAt: sourceSessionStartedAt,
      })
      : mode === "recruiter"
        ? formatRecruiterAdviceCopy({
          job: selectedJob,
          candidate: sourceCandidate,
          analysis: sourceAnalysis,
          transcript: sourceTranscript,
          manualNotes: sourceManualNotes,
          sessionStartedAt: sourceSessionStartedAt,
        })
        : formatRealtimeVoiceCopy({
          job: selectedJob,
          candidate: sourceCandidate,
          analysis: sourceAnalysis,
          transcript: sourceTranscript,
          manualNotes: sourceManualNotes,
          sessionStartedAt: sourceSessionStartedAt,
        });
    await copyText(key, text);
  };

  const renderAnalysisSections = ({
    sourceAnalysis,
    sourceTranscript,
    sourceSessionStartedAt,
    sourceCandidate,
    sourceHighlightTerms,
    sourceManualNotes = "",
    readOnly = false,
  }: {
    sourceAnalysis: VoiceRealtimeAnalysis | VoiceAnalysis;
    sourceTranscript: string;
    sourceSessionStartedAt: string;
    sourceCandidate: Candidate;
    sourceHighlightTerms: string[];
    sourceManualNotes?: string;
    readOnly?: boolean;
  }) => (
    <div className="voice-analysis-content">
      <div className="row-between voice-analysis-head">
        <div>
          <h3 className="card-title">{readOnly ? "录音库详情" : "单次输出结果"}</h3>
          <p className="helper-text">{sourceSessionStartedAt ? `${readOnly ? "保存时间" : "开始时间"}：${sourceSessionStartedAt}` : "开始录音后，这里会自动根据转写内容输出评估与建议。"}</p>
        </div>
        <div className="voice-head-actions">
          <Badge color={sourceAnalysis.recommendation === "建议推进" ? "green" : sourceAnalysis.recommendation === "建议复核" ? "gold" : "red"}>{sourceAnalysis.recommendation}</Badge>
          {!readOnly && (
            <button className="btn primary compact" type="button" onClick={saveToLibrary} disabled={saving || !sourceTranscript.trim()}>
              {saving ? "保存中..." : "保存到录音库"}
            </button>
          )}
          <button className="btn ghost compact" type="button" onClick={() => void copyBundle("all", "all", sourceAnalysis, sourceCandidate, sourceTranscript, sourceSessionStartedAt, sourceManualNotes)} disabled={!sourceTranscript.trim() && !sourceManualNotes.trim()}>
            {copiedKey === "all" ? "已复制" : "复制全部"}
          </button>
        </div>
      </div>
      <section className="voice-section-panel">
        <div className="row-between voice-section-head">
          <div>
            <h4>候选人评估</h4>
            <p>聚焦候选人回答内容，快速提炼推荐理由、优劣势与岗位风险点。</p>
          </div>
          <button className="btn ghost compact" type="button" onClick={() => void copyBundle("candidate", "candidate", sourceAnalysis, sourceCandidate, sourceTranscript, sourceSessionStartedAt, sourceManualNotes)} disabled={!sourceTranscript.trim() && !sourceManualNotes.trim()}>
            {copiedKey === "candidate" ? "已复制" : "复制候选人评估"}
          </button>
        </div>
        <div className="voice-main-card">
          <section className="voice-item-block voice-summary-block">
            <div className="ai-label">AI 总结</div>
            <p>{sourceAnalysis.summary}</p>
          </section>
          <section className="voice-item-block">
            <strong>匹配建议</strong>
            <p>{sourceAnalysis.jobFitAdvice}</p>
          </section>
          <section className="voice-item-block">
            <strong>优势亮点</strong>
            <ul>{sourceAnalysis.communicationStrengths.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
          <section className="voice-item-block risk">
            <strong>风险点</strong>
            <ul>{sourceAnalysis.communicationRisks.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>
      </section>
      <section className="voice-section-panel recruiter-panel">
        <div className="row-between voice-section-head">
          <div>
            <h4>招聘者建议</h4>
            <p>聚焦你的提问方式、信息采集完整度和追问深度，方便当场调整节奏。</p>
          </div>
          <button className="btn ghost compact" type="button" onClick={() => void copyBundle("recruiter", "recruiter", sourceAnalysis, sourceCandidate, sourceTranscript, sourceSessionStartedAt, sourceManualNotes)} disabled={!sourceTranscript.trim() && !sourceManualNotes.trim()}>
            {copiedKey === "recruiter" ? "已复制" : "复制招聘者建议"}
          </button>
        </div>
        <div className="voice-main-card recruiter-main-card">
          <section className="voice-item-block">
            <strong>沟通质检</strong>
            <div className="review-list">
              {sourceAnalysis.recruiterReview.map((item) => (
                <article className="review-item" key={`${item.title}-${item.text}`}>
                  <div className="row-between">
                    <strong>{item.title}</strong>
                    <Badge color={item.level === "良好" ? "green" : item.level === "注意" ? "gold" : "red"}>{item.level}</Badge>
                  </div>
                  <p>{item.text}</p>
                </article>
              ))}
            </div>
          </section>
          <section className="voice-item-block">
            <strong>优化建议</strong>
            <ul>{sourceAnalysis.recruiterSuggestions.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        </div>
      </section>
      <section className="voice-section-panel">
        <div className="voice-section-head">
          <div>
            <h4>转写与补充</h4>
            <p>{readOnly ? "这里展示该次已保存的录音转写与提炼内容，可随时回看。" : "该区内容支持保存到录音库，便于后续复盘查看。"}</p>
          </div>
        </div>
        {sourceHighlightTerms.length > 0 && (
          <div className="voice-highlight-bar">
            <span className="meta">高亮关键词</span>
            <div className="voice-highlight-chips">
              {sourceHighlightTerms.map((term) => <span className="voice-highlight-chip" key={term}>{term}</span>)}
            </div>
          </div>
        )}
        <div className="resume-box spaced-small">
          {sourceTranscript ? <HighlightedText text={sourceTranscript} terms={sourceHighlightTerms} /> : "录音开始后，这里会出现实时转写内容。"}
        </div>
        {!!sourceManualNotes.trim() && (
          <div className="voice-note-box">
            <strong>补充备注</strong>
            <p><HighlightedText text={sourceManualNotes} terms={sourceHighlightTerms} /></p>
          </div>
        )}
        <div className="voice-history-meta">
          <span>关联人选：{sourceCandidate.name}</span>
          <span>关联岗位：{selectedJob.title}</span>
        </div>
      </section>
    </div>
  );

  const renderLiveCopilot = () => (
    <section className="voice-section-panel">
      <div className="voice-section-head">
        <div>
          <h4>DeepSeek 实时追问辅助</h4>
          <p>每次只取最近 5 段转写做实时分析；结束后再拉取完整记录做整场评估。</p>
        </div>
      </div>
      <div className="voice-main-card">
        <section className="voice-item-block">
          <strong>最新一段关键信息提炼</strong>
          {aiLiveState ? (
            <div className="spaced-small">
              <p>核心观点：{aiLiveState.quickInsight.coreViewpoint}</p>
              <p>信号判断：{aiLiveState.quickInsight.signalType}（{aiLiveState.quickInsight.signalReason}）</p>
              <ul>{aiLiveState.quickInsight.keyEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : <p>录音后，系统会针对最新一段回答自动提炼关键信息。</p>}
        </section>
        <section className="voice-item-block">
          <strong>建议下一问</strong>
          {aiLiveState ? (
            <div className="spaced-small">
              <p>{aiLiveState.followUp.nextQuestion}</p>
              <p>追问目的：{aiLiveState.followUp.objective}</p>
              <div className="voice-history-meta">
                <span>S：{aiLiveState.followUp.starAnchors.situation}</span>
                <span>T：{aiLiveState.followUp.starAnchors.task}</span>
                <span>A：{aiLiveState.followUp.starAnchors.action}</span>
                <span>R：{aiLiveState.followUp.starAnchors.result}</span>
              </div>
            </div>
          ) : <p>系统会基于候选人刚才的回答，自动生成自然衔接的深挖问题。</p>}
        </section>
        <section className="voice-item-block">
          <strong>整场面试评估</strong>
          {finalEvaluation ? (
            <div className="spaced-small">
              <p>{finalEvaluation.summary}</p>
              <p>匹配度综合评分：{finalEvaluation.score}/100</p>
              <ul>{finalEvaluation.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : <p>结束录音后，系统会自动基于完整转写历史生成整场评估报告。</p>}
        </section>
      </div>
    </section>
  );

  return (
    <div className="voice-page">
      <section className="card pad">
        <div className="voice-library-head">
          <div>
            <h3 className="card-title">录音库</h3>
          </div>
          <div className="toolbar-right interview-filters">
            <label className="interview-filter-field voice-library-filter">
              <span>岗位</span>
              <select value={libraryJobId} onChange={(event) => setLibraryJobId(event.target.value)}>
                {jobs.map((job) => <option key={job.id} value={job.id}>{formatJobOption(job)}</option>)}
              </select>
            </label>
            <div className="voice-library-stats">
              <Badge color="green">{voiceHistory.length} 条录音</Badge>
            </div>
          </div>
        </div>
      </section>

      <section className="card interview-table-card voice-library-overview">
        <div className="table-wrap interview-table-wrap voice-library-table-wrap">
          {voiceHistory.length ? (
            <table className="table interview-table voice-library-table">
              <thead>
                <tr>
                  <th>人选</th>
                  <th>岗位</th>
                  <th>时间</th>
                  <th>录音详情</th>
                  <th>删除</th>
                </tr>
              </thead>
              <tbody>
                {voiceHistory.map((item) => {
                  const itemCandidate = historyCandidates.find((candidate) => candidate.id === item.candidateId);
                  return (
                    <tr key={item.id} className={selectedHistoryId === item.id ? "voice-library-table-row active" : "voice-library-table-row"}>
                      <td><strong>{itemCandidate?.name || "未匹配人选"}</strong></td>
                      <td><strong>{librarySelectedJob.title}</strong></td>
                      <td><span className="meta">{item.createdAt}</span></td>
                      <td>
                        <button className="btn compact ghost" type="button" onClick={() => setSelectedHistoryId(item.id)}>录音详情</button>
                      </td>
                      <td>
                        <button
                          className="btn compact danger"
                          type="button"
                          onClick={async () => {
                            setSelectedHistoryId(item.id);
                            if (!window.confirm("确认删除这条录音记录？删除后无法恢复。")) return;
                            setDeletingHistory(true);
                            try {
                              const { state: nextState } = await api.deleteVoiceAnalysis(item.id);
                              onStateChange(nextState);
                              if (selectedHistoryId === item.id) setSelectedHistoryId("");
                              onToast("录音记录已删除");
                            } catch (error) {
                              onToast(error instanceof Error ? error.message : "删除录音记录失败");
                            } finally {
                              setDeletingHistory(false);
                            }
                          }}
                          disabled={deletingHistory}
                        >
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="empty"><div><strong>暂无录音记录</strong></div></div>
          )}
        </div>
      </section>

      <div className="voice-layout">
        <section className="card pad voice-workbench">
        <div className="toolbar">
          <div>
            <h3 className="card-title">访音解析</h3>
            <p className="helper-text">页面内直接开启录音转写；单次解析可保存到录音库，便于后续按岗位与人选回看复盘。</p>
          </div>
          <div className="voice-session-meta">
            <Badge color={status === "listening" ? "green" : status === "paused" ? "gold" : "gray"}>
              {status === "idle" ? "未开始" : status === "listening" ? "录音中" : status === "paused" ? "已暂停" : "已结束"}
            </Badge>
          </div>
        </div>
        <div className="voice-form">
          <label className="form-field">
            <span>关联岗位</span>
            <select value={jobId} onChange={(event) => setJobId(event.target.value)} disabled={status === "listening"}>
              {jobs.map((job) => <option key={job.id} value={job.id}>{formatJobOption(job)}</option>)}
            </select>
          </label>
          <label className="form-field">
            <span>关联人选</span>
            <select value={candidateId} onChange={(event) => setCandidateId(event.target.value)} disabled={!candidates.length || status === "listening"}>
              {candidates.length ? candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>) : <option value="">暂无候选人</option>}
            </select>
          </label>
          <section className="voice-candidate-brief full">
            <span className="meta">当前人选摘要</span>
            {selectedCandidate ? (
              <>
                <div className="voice-candidate-head">
                  <strong>{selectedCandidate.name}</strong>
                  <Badge color={scoreColor(selectedCandidate.score)}>{selectedCandidate.conclusion}</Badge>
                </div>
                <p>{selectedCandidate.reason}</p>
                <div className="candidate-profile-tags">
                  <span>岗位：{selectedJob.title}</span>
                  <span>关键考核点：{selectedJob.keywords || "未填写"}</span>
                </div>
              </>
            ) : (
              <p>当前岗位下暂无候选人，可先去“简历甄选”录入简历。</p>
            )}
          </section>
          <section className="voice-control-panel full">
            <div className="voice-control-actions">
              <button className="btn primary" type="button" onClick={startSession} disabled={!supportsRecording || !selectedCandidate || status === "listening"}>
                {status === "idle" ? "开始录音" : "重新开始"}
              </button>
              <button className="btn" type="button" onClick={pauseSession} disabled={status !== "listening"}>暂停</button>
              <button className="btn" type="button" onClick={resumeSession} disabled={status !== "paused"}>继续</button>
              <button className="btn" type="button" onClick={stopSession} disabled={status !== "listening" && status !== "paused"}>结束</button>
              <button className="btn ghost" type="button" onClick={clearSession}>清空</button>
            </div>
            <small className="helper-text">
              {supportsRecording
                ? "网页端直接录音；后端使用开源语音模型转文字，再由 DeepSeek 做轻量实时整理。确认有效后可一键写入 SQLite 录音库。"
                : "当前浏览器不支持网页录音，建议使用最新版 Chrome 并允许麦克风权限。"}
            </small>
            {liveHint ? <small className="helper-text">{liveHint}{isUploadingChunk ? "…" : ""}</small> : null}
          </section>
          <label className="form-field full">
            <span>实时转写</span>
            <textarea
              value={transcript}
              readOnly
              placeholder="点击“开始录音”后，这里会实时出现转写内容。"
            />
          </label>
          <label className="form-field full">
            <span>补充备注</span>
            <textarea
              value={manualNotes}
              onChange={(event) => setManualNotes(event.target.value)}
              placeholder="可手动补充候选人未被准确识别的关键信息，分析区会同步更新。"
            />
          </label>
        </div>
        </section>
        <section className="card pad voice-analysis-panel">
        {shouldShowCurrentOutput && selectedCandidate && analysis ? (
          <>
            {renderAnalysisSections({
              sourceAnalysis: analysis,
              sourceTranscript: transcript,
              sourceSessionStartedAt: sessionStartedAt,
              sourceCandidate: selectedCandidate,
              sourceHighlightTerms: highlightTerms,
              sourceManualNotes: manualNotes,
            })}
            {renderLiveCopilot()}
          </>
        ) : selectedHistory && historyCandidate ? (
          renderAnalysisSections({
            sourceAnalysis: selectedHistory,
            sourceTranscript: selectedHistory.transcript,
            sourceSessionStartedAt: selectedHistory.createdAt,
            sourceCandidate: historyCandidate,
            sourceHighlightTerms: historyHighlightTerms,
            readOnly: true,
          })
        ) : (
          <div className="voice-empty-state">
            <section className="empty voice-empty-card"><div><strong>候选人评估区</strong><br />先选择岗位和人选，再开启录音。系统会基于实时转写输出推荐理由、优势与风险点。</div></section>
            <section className="empty voice-empty-card"><div><strong>招聘者建议区</strong><br />会根据你的提问内容与沟通节奏，实时给出信息采集、追问深度与改进建议。</div></section>
          </div>
        )}
        </section>
      </div>
      {selectedHistory && historyCandidate && (
        <VoiceHistoryDetailModal
          job={librarySelectedJob}
          history={selectedHistory}
          candidate={historyCandidate}
          highlightTerms={historyHighlightTerms}
          copied={copiedHistory}
          deleting={deletingHistory}
          onClose={() => setSelectedHistoryId("")}
          onCopy={() => void copyHistoryDetail()}
          onDelete={() => void removeHistory()}
        />
      )}
    </div>
  );
}

function VoiceHistoryDetailModal({
  job,
  history,
  candidate,
  highlightTerms,
  copied,
  deleting,
  onClose,
  onCopy,
  onDelete,
}: {
  job: Job;
  history: VoiceAnalysis;
  candidate: Candidate;
  highlightTerms: string[];
  copied: boolean;
  deleting: boolean;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  return (
    <Modal
      title="录音详情"
      className="modal-wide voice-detail-modal"
      onClose={onClose}
      actions={(
        <>
          <button className="btn ghost" type="button" onClick={onCopy}>{copied ? "已复制" : "复制板块"}</button>
          <button className="btn danger" type="button" onClick={onDelete} disabled={deleting}>{deleting ? "删除中..." : "删除录音"}</button>
        </>
      )}
    >
      <div className="modal-body voice-detail-body">
        <section className="voice-detail-hero">
          <div className="voice-detail-hero-meta">
            <span>岗位：{job.title}</span>
            <span>人选：{candidate.name}</span>
            <span>时间：{history.createdAt}</span>
          </div>
          <div className="voice-detail-badges">
            <Badge color={history.recommendation === "建议推进" ? "green" : history.recommendation === "建议复核" ? "gold" : "gray"}>{history.recommendation}</Badge>
          </div>
        </section>
        <section className="voice-detail-grid">
          <article className="voice-detail-card">
            <strong>AI总结</strong>
            <p>{history.summary}</p>
          </article>
          <article className="voice-detail-card">
            <strong>匹配建议</strong>
            <p>{history.jobFitAdvice}</p>
          </article>
        </section>
        <section className="voice-detail-grid">
          <article className="voice-detail-card">
            <strong>候选人优势</strong>
            <ul>{history.communicationStrengths.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
          <article className="voice-detail-card">
            <strong>风险点</strong>
            <ul>{history.communicationRisks.map((item) => <li key={item}>{item}</li>)}</ul>
          </article>
        </section>
        <section className="voice-detail-card">
          <strong>招聘者建议</strong>
          <ul>{history.recruiterSuggestions.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="voice-detail-card">
          <strong>沟通质检</strong>
          <div className="review-list">
            {history.recruiterReview.map((item) => (
              <article className="review-item" key={`${item.title}-${item.text}`}>
                <div className="row-between">
                  <strong>{item.title}</strong>
                  <Badge color={item.level === "良好" ? "green" : item.level === "注意" ? "gold" : "gray"}>{item.level}</Badge>
                </div>
                <p>{item.text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="voice-detail-card">
          <strong>转写内容</strong>
          <div className="resume-box spaced-small voice-library-detail-text">
            <HighlightedText text={history.transcript} terms={highlightTerms} />
          </div>
        </section>
      </div>
    </Modal>
  );
}

function isInterviewCandidate(candidate: Candidate) {
  return candidate.conclusion === "已邀面试";
}


const salaryRegionOptions = ["北京", "上海", "深圳", "广州", "杭州", "成都", "武汉"] as const;
const salaryExperienceOptions = ["无经验", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"] as const;
const salaryIndustryOptions = ["互联网", "企业服务", "消费品/零售", "制造业", "金融", "教育", "医疗健康"] as const;
const salaryEducationOptions = ["大专", "本科", "硕士"] as const;
const salaryRoleOptions = ["HRBP", "招聘专员", "前端工程师", "产品经理", "销售经理", "运营经理"] as const;

function SalaryView({
  data,
  onRefresh,
}: {
  data: SalaryData | null;
  onRefresh: (filters: SalaryFilters) => Promise<void>;
}) {
  const research = data ? {
    dataWindow: data.research?.dataWindow || "历史缓存",
    confidence: data.research?.confidence || "低",
    confidenceReason: data.research?.confidenceReason || "当前数据缺少完整来源追溯，建议刷新薪酬大盘后再查看。", 
    limitations: data.research?.limitations?.length ? data.research.limitations : ["当前缓存数据缺少完整局限性说明。"],
    triangulation: {
      requiredSources: data.research?.triangulation?.requiredSources ?? 3,
      actualSources: data.research?.triangulation?.actualSources ?? data.research?.coreSources?.length ?? 0,
      passed: data.research?.triangulation?.passed ?? false,
      summary: data.research?.triangulation?.summary || "当前数据未完成三角验证，建议重新生成调研结果。",
    },
    metricSources: {
      p25: data.research?.metricSources?.p25 || "当前缓存未提供 P25 来源说明，建议刷新薪酬大盘。",
      p50: data.research?.metricSources?.p50 || "当前缓存未提供 P50 来源说明，建议刷新薪酬大盘。",
      p75: data.research?.metricSources?.p75 || "当前缓存未提供 P75 来源说明，建议刷新薪酬大盘。",
    },
    methodology: data.research?.methodology?.length ? data.research.methodology : ["当前缓存未提供完整调研方法，建议刷新薪酬大盘。"],
    coreSources: data.research?.coreSources?.length ? data.research.coreSources : ["当前缓存未提供核心来源。"],
    validationSources: data.research?.validationSources?.length ? data.research.validationSources : ["当前缓存未提供验证来源。"],
    sampleNotes: data.research?.sampleNotes?.length ? data.research.sampleNotes : ["当前缓存未提供样本说明。"],
    evidence: data.research?.evidence || [],
    disclaimer: data.research?.disclaimer || "当前数据来源信息不完整，建议重新刷新薪酬调研。",
  } : null;
  const [filters, setFilters] = useState<SalaryFilters>(() => buildSalaryFilters(data));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setFilters((current) => ({
      ...buildSalaryFilters(data),
      ...current,
      role: current.role || data?.filters.role || buildSalaryFilters(data).role,
    }));
  }, [data]);

  const applyRefresh = async () => {
    setLoading(true);
    try {
      await onRefresh(filters);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <section className="card pad">
        <div className="toolbar salary-toolbar">
          <div>
            <h3 className="card-title">薪酬调研</h3>
            <p className="helper-text">作为独立调研工具，按岗位、地区、经验、行业、学历组合生成公开数据薪酬研究结果。</p>
          </div>
          <div className="toolbar-right">
            <button className="btn primary" onClick={applyRefresh} disabled={loading}>
              {loading ? "刷新中..." : data ? "刷新薪酬大盘" : "生成薪酬大盘"}
            </button>
          </div>
        </div>
        <div className="salary-filter-row">
          <EditableOptionSwitcher
            label="岗位"
            value={filters.role}
            options={[...salaryRoleOptions]}
            placeholder="输入岗位名称"
            onChange={(role) => setFilters({ ...filters, role })}
          />
          <EditableOptionSwitcher
            label="地区"
            value={filters.region}
            options={[...salaryRegionOptions]}
            placeholder="输入地区搜索或直接填写"
            onChange={(region) => setFilters({ ...filters, region })}
          />
          <label className="interview-filter-field">
            <span>经验</span>
            <select value={filters.experience} onChange={(event) => setFilters({ ...filters, experience: event.target.value })}>
              {salaryExperienceOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <EditableOptionSwitcher
            label="行业"
            value={filters.industry}
            options={[...salaryIndustryOptions]}
            placeholder="输入行业搜索或直接填写"
            onChange={(industry) => setFilters({ ...filters, industry })}
          />
          <label className="interview-filter-field">
            <span>学历</span>
            <select value={filters.education} onChange={(event) => setFilters({ ...filters, education: event.target.value })}>
              {salaryEducationOptions.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
      </section>

      {!data ? (
        <section className="card pad">
          <div className="empty">
            <div><strong>当前暂无薪酬大盘</strong><br />先填写岗位与筛选条件，再点击“生成薪酬大盘”。</div>
          </div>
        </section>
      ) : data.status === "insufficient_data" ? (
        <section className="card pad">
          <div className="empty">
            <div>
              <strong>当前公开数据不足，无法生成高置信度报告</strong><br />
              {data.errorMessage || "未满足至少 3 个独立招聘平台近 3 个月有效样本要求。"}
            </div>
          </div>
          <div className="grid cols-2">
            <section className="card pad">
              <h3 className="card-title">检索说明</h3>
              <div className="ai-point-card spaced-small">
                <strong>调研方法</strong>
                <ul>{research?.methodology.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="ai-point-card spaced-small">
                <strong>局限性说明</strong>
                <ul>{research?.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            </section>
            <section className="card pad">
              <h3 className="card-title">已检索到的公开样本</h3>
              <div className="salary-evidence-list">
                {research?.evidence.length ? research.evidence.map((item, index) => (
                  <article className="salary-evidence-card" key={`${item.source}-${item.role}-${index}`}>
                    <div className="salary-evidence-head">
                      <strong>{item.source}</strong>
                      <span>{item.publishWindow}</span>
                    </div>
                    <div className="salary-evidence-meta">
                      <span>{item.role}</span>
                      <span>{item.region}</span>
                      <span>{item.experience}</span>
                    </div>
                    <p>{item.note}</p>
                  </article>
                )) : <div className="empty"><div>未检索到满足条件的公开招聘平台样本。</div></div>}
              </div>
            </section>
          </div>
        </section>
      ) : (
        <>
          <div className="grid cols-4">
            <StatCard label="P25" value={`${data.p25}k`} extra="保守预算线" />
            <StatCard label="P50" value={`${data.p50}k`} extra="市场中位值" />
            <StatCard label="P75" value={`${data.p75}k`} extra="强竞争候选人" />
            <StatCard label="建议区间" value={`${data.suggestedLow}-${data.suggestedHigh}k`} extra={`锚点 ${data.anchor}k`} />
          </div>

          <div className="grid cols-2">
            <section className="card">
              <CardHeader title="经验薪酬带宽" desc={`${data.benchmarkRegion} · ${data.jobFamily} · ${data.filters.industry}`} />
              <SalaryExperienceChart data={data} />
            </section>
            <section className="card">
              <CardHeader title="地区薪酬对比" desc={`${data.filters.experience} · ${data.filters.education}`} />
              <SalaryRegionChart data={data} />
            </section>
          </div>

          <div className="grid cols-2">
            <section className="card">
              <CardHeader title="行业薪酬分布" desc={`${data.updatedAt} 更新`} />
              <SalaryIndustryChart data={data} />
            </section>
            <section className="card">
              <CardHeader title="学历差异" desc="同岗位不同学历参考中位值" />
              <SalaryEducationChart data={data} />
            </section>
          </div>

          <div className="grid cols-2">
            <section className="card pad salary-advice-card">
              <div className="row-between">
                <div>
                  <h3 className="card-title">薪酬建议</h3>
                  <p className="helper-text">结合岗位内容与筛选条件给出建议报价。</p>
                </div>
                <Badge color="green">{`${data.suggestedLow}-${data.suggestedHigh}k`}</Badge>
              </div>
              <div className="ai-summary-card spaced-small">
                <div className="ai-label">建议摘要</div>
                <p>{data.advice.summary}</p>
              </div>
              <div className="ai-grid spaced-small">
                <section className="ai-point-card">
                  <strong>建议理由</strong>
                  <ul>{data.advice.reasons.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
                <section className="ai-point-card">
                  <strong>岗位溢价点</strong>
                  <ul>{(data.advice.keywordPremiums.length ? data.advice.keywordPremiums : ["当前岗位暂无额外关键词溢价，建议按市场基准与面试质量控制报价。"]).map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              </div>
            </section>

            <section className="card pad">
              <h3 className="card-title">薪酬洞察</h3>
              <div className="timeline spaced">
                {data.insights.map((item) => (
                  <div className="timeline-card" key={item.title}>
                    <strong>{item.title}</strong>
                    <span className="meta">{item.text}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="grid cols-2">
            <section className="card pad">
              <div className="row-between">
                <div>
                  <h3 className="card-title">数据来源与调研方法</h3>
                  <p className="helper-text">{research?.dataWindow} · 置信度 {research?.confidence}</p>
                </div>
                <Badge color="green">{research?.confidence}</Badge>
              </div>
              <div className="salary-disclaimer salary-disclaimer-soft">
                <strong>置信度说明：</strong>{research?.confidenceReason}
              </div>
              <div className="salary-metric-trace-grid">
                <article className="salary-trace-card">
                  <strong>P25 来源</strong>
                  <p>{research?.metricSources.p25}</p>
                </article>
                <article className="salary-trace-card">
                  <strong>P50 来源</strong>
                  <p>{research?.metricSources.p50}</p>
                </article>
                <article className="salary-trace-card">
                  <strong>P75 来源</strong>
                  <p>{research?.metricSources.p75}</p>
                </article>
              </div>
              <div className="salary-triangulation-card">
                <strong>三角验证</strong>
                <p>{research?.triangulation.summary}</p>
                <div className="salary-evidence-meta">
                  <span>要求来源数 {research?.triangulation.requiredSources}</span>
                  <span>实际来源数 {research?.triangulation.actualSources}</span>
                  <span>{research?.triangulation.passed ? "已通过交叉验证" : "未满足交叉验证"}</span>
                </div>
              </div>
              <div className="ai-grid spaced-small">
                <section className="ai-point-card">
                  <strong>核心来源</strong>
                  <ul>{research?.coreSources.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
                <section className="ai-point-card">
                  <strong>验证来源</strong>
                  <ul>{research?.validationSources.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              </div>
              <div className="ai-point-card spaced-small">
                <strong>调研方法</strong>
                <ul>{research?.methodology.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="ai-point-card spaced-small">
                <strong>样本说明</strong>
                <ul>{research?.sampleNotes.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
              <div className="ai-point-card spaced-small">
                <strong>局限性说明</strong>
                <ul>{research?.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
              </div>
            </section>

            <section className="card pad">
              <h3 className="card-title">代表性样本依据</h3>
              <div className="salary-evidence-list">
                {research?.evidence.map((item, index) => (
                  <article className="salary-evidence-card" key={`${item.source}-${item.role}-${index}`}>
                    <div className="salary-evidence-head">
                      <strong>{item.source}</strong>
                      <span>{item.publishWindow}</span>
                    </div>
                    <div className="salary-evidence-meta">
                      <span>{item.role}</span>
                      <span>{item.region}</span>
                      <span>{item.experience}</span>
                      <span>{item.salaryRange}</span>
                    </div>
                    <p>{item.note}</p>
                  </article>
                ))}
              </div>
              <div className="salary-disclaimer">{research?.disclaimer}</div>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function JobModal({ job, onClose, onSaved }: { job?: Job; onClose: () => void; onSaved: (state: AppState) => void }) {
  const [form, setForm] = useState<JobPayload>({
    title: job?.title || "",
    dept: job?.dept || "",
    location: job?.location || "",
    experience: job?.experience || "",
    level: job?.level || "",
    salaryRange: job?.salaryRange || "",
    keywords: job?.keywords || "",
    description: job?.description || "",
    status: job?.status || "招聘中",
  });
  const [jdResult, setJdResult] = useState<{ description: string; html: React.ReactNode } | null>(null);
  const [generatedQuestions, setGeneratedQuestions] = useState<JobCopilotResult["interviewQuestions"]>(buildJobQuestions(form));
  const [copilotLoading, setCopilotLoading] = useState<null | "jd" | "questions">(null);
  const [copilotError, setCopilotError] = useState("");
  const [copied, setCopied] = useState(false);
  const [titlesCopied, setTitlesCopied] = useState(false);
  const interviewQuestions = generatedQuestions.length ? generatedQuestions : buildJobQuestions(form);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = job ? await api.updateJob(job.id, form) : await api.createJob(form);
    onSaved(next);
  }

  async function optimize() {
    setCopilotLoading("jd");
    setCopilotError("");
    try {
      const result = await api.generateJobCopilot({ ...form, useCase: "jd-optimize" });
      const description = normalizeJdDescription(result.optimizedDescription || form.description);
      setGeneratedQuestions(result.interviewQuestions.length ? result.interviewQuestions : buildJobQuestions(form));
      setJdResult({
        description,
        html: (
          <>
            <div className="tool-block">
              <span className="tool-label">推荐标题</span>
              <strong>{result.recommendedTitle || `${form.title || "目标岗位"}｜${form.location || "核心城市"}｜${form.level || "关键岗位"}`}</strong>
            </div>
            <div className="tool-block">
              <div className="row-between tool-heading-row">
                <span className="tool-label">优化描述</span>
                <button className="btn ghost compact" type="button" onClick={() => setForm({ ...form, description })}>一键覆盖职位描述</button>
              </div>
              {renderJdDescription(description)}
            </div>
            {result.actionSuggestions.length ? (
              <div className="tool-block">
                <span className="tool-label">行动建议</span>
                <ul className="tool-bullet-list">
                  {result.actionSuggestions.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            {result.sourcingTitles.length ? (
              <div className="tool-block">
                <div className="row-between tool-heading-row">
                  <span className="tool-label">社交渠道主动搜寻标题</span>
                  <button className="btn ghost compact" type="button" onClick={() => copySourcingTitles(result.sourcingTitles)}>
                    {titlesCopied ? "已复制" : "复制标题"}
                  </button>
                </div>
                <div className="sourcing-title-list">
                  {result.sourcingTitles.map((item, index) => (
                    <article className="sourcing-title-item" key={`${item}-${index}`}>
                      <span>{index + 1}</span>
                      <p>{item}</p>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ),
      });
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : "生成失败，请稍后重试");
    } finally {
      setCopilotLoading(null);
    }
  }

  async function refreshInterviewQuestions() {
    setCopilotLoading("questions");
    setCopilotError("");
    try {
      const result = await api.generateJobCopilot({ ...form, useCase: "interview-questions" });
      setGeneratedQuestions(result.interviewQuestions.length ? result.interviewQuestions : buildJobQuestions(form));
      if (!jdResult && result.optimizedDescription) {
        const description = normalizeJdDescription(result.optimizedDescription);
        setJdResult({
          description,
          html: (
            <>
              <div className="tool-block">
                <span className="tool-label">推荐标题</span>
                <strong>{result.recommendedTitle || form.title || "目标岗位"}</strong>
              </div>
              <div className="tool-block">
                <div className="row-between tool-heading-row">
                  <span className="tool-label">优化描述</span>
                  <button className="btn ghost compact" type="button" onClick={() => setForm({ ...form, description })}>一键覆盖职位描述</button>
                </div>
                {renderJdDescription(description)}
              </div>
              {result.sourcingTitles.length ? (
                <div className="tool-block">
                  <div className="row-between tool-heading-row">
                    <span className="tool-label">社交渠道主动搜寻标题</span>
                    <button className="btn ghost compact" type="button" onClick={() => copySourcingTitles(result.sourcingTitles)}>
                      {titlesCopied ? "已复制" : "复制标题"}
                    </button>
                  </div>
                  <div className="sourcing-title-list">
                    {result.sourcingTitles.map((item, index) => (
                      <article className="sourcing-title-item" key={`${item}-${index}`}>
                        <span>{index + 1}</span>
                        <p>{item}</p>
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ),
        });
      }
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : "生成失败，请稍后重试");
    } finally {
      setCopilotLoading(null);
    }
  };

  const copyQuestions = async () => {
    await navigator.clipboard.writeText(formatInterviewQuestions(form, interviewQuestions));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const copySourcingTitles = async (titles: string[]) => {
    const content = titles.map((item, index) => `${index + 1}. ${item}`).join("\n");
    if (!content) return;
    await navigator.clipboard.writeText(content);
    setTitlesCopied(true);
    window.setTimeout(() => setTitlesCopied(false), 1600);
  };

  return (
    <Modal className="modal-wide modal-job-editor" onClose={onClose} actions={<button className="btn primary" type="submit" form="jobForm">保存职位</button>}>
      <form id="jobForm" onSubmit={submit}>
        <div className="modal-body form-grid">
          <Input label="职位名称" value={form.title} onChange={(title) => setForm({ ...form, title })} />
          <Input label="所属部门" value={form.dept} onChange={(dept) => setForm({ ...form, dept })} />
          <Input label="工作城市" value={form.location} onChange={(location) => setForm({ ...form, location })} />
          <Input label="经验要求" value={form.experience} onChange={(experience) => setForm({ ...form, experience })} />
          <Input label="职位级别" value={form.level} onChange={(level) => setForm({ ...form, level })} />
          <Input label="薪资范围" value={form.salaryRange} onChange={(salaryRange) => setForm({ ...form, salaryRange })} />
          <label className="form-field">
            <span>招聘状态</span>
            <select value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as Job["status"] })}>
              {["招聘中", "暂停", "已关闭"].map((status) => <option key={status}>{status}</option>)}
            </select>
          </label>
          <Input label="岗位关键词" full value={form.keywords} onChange={(keywords) => setForm({ ...form, keywords })} />
          <label className="form-field full">
            <span>职位描述</span>
            <textarea required value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </label>

          <div className="job-tool-grid full">
            <section className="job-tool-card">
              <div className="job-tool-head">
                <div className="job-tool-summary">
                  <h4>JD优化器</h4>
                  <p>基于当前职位信息，调用模型生成更适合发布的岗位卖点、职责表达和行动建议。</p>
                </div>
                <div className="job-tool-actions">
                  <button type="button" className="btn ghost" onClick={optimize} disabled={copilotLoading !== null}>
                    {copilotLoading === "jd" ? "生成中..." : "生成"}
                  </button>
                </div>
              </div>
              <div className={`tool-result ${jdResult ? "" : "empty-mini"}`}>{jdResult?.html || "点击生成后，将展示岗位标题、关键词和职位描述优化建议。"}</div>
            </section>

            <section className="job-tool-card">
              <div className="job-tool-head">
                <div className="job-tool-summary">
                  <h4>推荐面试问题</h4>
                  <p>围绕岗位关键词与核心职责，调用 DeepSeek 生成 STAR 行为面试问题与深度追问。</p>
                </div>
                <div className="job-tool-actions">
                  <button type="button" className="btn ghost" onClick={refreshInterviewQuestions} disabled={copilotLoading !== null}>
                    {copilotLoading === "questions" ? "生成中..." : "生成"}
                  </button>
                  <button type="button" className="btn ghost" onClick={copyQuestions}>{copied ? "已复制" : "复制"}</button>
                </div>
              </div>
              {copilotError ? <div className="tool-error">{copilotError}</div> : null}
              <div className="tool-result">
                <div className="question-list">
                  {interviewQuestions.map((question, index) => (
                    <article className="question-item" key={question.title}>
                      <strong>{index + 1}. {question.title}</strong>
                      {question.competency ? <div className="question-chip-row"><span className="question-chip">{question.competency}</span></div> : null}
                      <p>{question.text}</p>
                      {question.starFocus?.length ? (
                        <div className="question-meta-group">
                          <span className="question-probe-label">STAR关注点</span>
                          <div className="question-chip-row">
                            {question.starFocus.map((item) => <span className="question-chip soft" key={item}>{item}</span>)}
                          </div>
                        </div>
                      ) : null}
                      <span className="question-probe-label">追问</span>
                      <span className="question-probe-text">{normalizeProbeText(question.probe)}</span>
                      {question.evaluationSignals?.length ? (
                        <div className="question-meta-group">
                          <span className="question-probe-label">判断信号</span>
                          <ul className="question-signal-list">
                            {question.evaluationSignals.map((item) => <li key={item}>{item}</li>)}
                          </ul>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>

      </form>
    </Modal>
  );
}

function ResumeModal({ job, onClose, onSaved }: { job: Job; onClose: () => void; onSaved: (state: AppState) => void }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState("BOSS");
  const [resumeText, setResumeText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload: ResumeUploadPayload = { name, source, resumeText, files: await Promise.all(files.map(fileToPayload)) };
      const result = await api.uploadResumes(job.id, payload);
      onSaved(result.state);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "简历分析失败，请稍后重试");
    } finally {
      setLoading(false);
    }
  }
  return <Modal title="上传/录入简历" onClose={onClose}><form onSubmit={submit}><div className="modal-body form-grid"><Input label="候选人姓名（文本录入时必填）" value={name} onChange={setName} /><label className="form-field"><span>来源渠道</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="BOSS">BOSS</option><option value="智联">智联</option><option value="猎聘">猎聘</option><option value="内推">内推</option><option value="其他">其他</option></select></label><label className="form-field full"><span>上传简历文件（支持单个或多个）</span><input className="file-input" type="file" multiple accept=".txt,.md,.pdf,.doc,.docx,.rtf,.jpg,.jpeg,.png,.webp,.gif,.bmp,.heic,.heif,.csv,.json,.xml,.html,.htm,image/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => setFiles(Array.from(event.target.files || []))} /><small className="helper-text">文件原件会写入 SQLite。系统会优先提取 PDF / Word / 图片 / TXT 等文件正文，并结合 DeepSeek 清洗整理后保存到简历原文。</small></label><label className="form-field full"><span>简历文本</span><textarea value={resumeText} onChange={(event) => setResumeText(event.target.value)} placeholder="可直接粘贴简历文本；若同时上传文件，会作为补充文本参与识别、整理与分析" /></label>{error ? <div className="tool-error full">{error}</div> : null}</div><div className="modal-foot"><button className="btn" type="button" onClick={onClose}>取消</button><button className="btn primary" disabled={loading}>{loading ? "分析中..." : "分析并生成候选人"}</button></div></form></Modal>;
}

async function fileToPayload(file: File) {
  const textLike = /^(text\/|application\/(json|xml))/.test(file.type) || /\.(txt|md|csv|json|rtf)$/i.test(file.name);
  return { name: file.name, type: file.type, size: file.size, text: textLike ? await file.text().catch(() => "") : "", dataBase64: await fileToBase64(file) };
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function Chart({ option, className, style }: { option: echarts.EChartsCoreOption; className?: string; style?: React.CSSProperties }) { const ref = useRef<HTMLDivElement>(null); useEffect(() => { if (!ref.current) return; const chart = echarts.init(ref.current); chart.setOption(option); const resize = () => chart.resize(); window.addEventListener("resize", resize); return () => { window.removeEventListener("resize", resize); chart.dispose(); }; }, [option]); return <div className={className ? `chart ${className}` : "chart"} style={style} ref={ref} />; }
function FunnelChart({ candidates }: { candidates: Candidate[] }) { return <Chart option={{ color: ["#0F4C3A", "#1A6B4A", "#65A47D", "#A8CDB8"], tooltip: { trigger: "item" }, series: [{ type: "funnel", left: "10%", width: "80%", data: [{ name: "简历入库", value: candidates.length }, { name: "初筛通过", value: candidates.filter(c => c.score >= 60).length }, { name: "推荐面试", value: candidates.filter(c => c.score >= 70).length }, { name: "强匹配", value: candidates.filter(c => c.score >= 85).length }] }] }} />; }
function JobBarChart({ jobs }: { jobs: Job[] }) {
  const longestTitle = jobs.reduce((max, job) => Math.max(max, job.title.length), 0);
  const chartWidth = Math.max(420, jobs.length * 92);
  const bottomPadding = Math.min(220, Math.max(120, longestTitle * 16));
  const chartHeight = Math.max(340, bottomPadding + 210);
  return (
    <div className="chart-scroll-wrap chart-scroll-jobs">
      <Chart
        className="chart-job-bar"
        style={{ width: `${chartWidth}px`, height: `${chartHeight}px` }}
        option={{
          color: ["#1A6B4A"],
          grid: { left: 24, right: 24, top: 20, bottom: bottomPadding },
          xAxis: {
            type: "category",
            data: jobs.map((job) => job.title),
            axisTick: { alignWithLabel: true },
            axisLine: { lineStyle: { color: "#d8e4de" } },
            axisLabel: {
              color: "#617069",
              fontSize: 13,
              interval: 0,
              rotate: 90,
              margin: 18,
            },
          },
          yAxis: {
            type: "value",
            minInterval: 1,
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: "#e3ebe7" } },
          },
          tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
          series: [{
            type: "bar",
            data: jobs.map((job) => job.resumeCount),
            barWidth: 30,
            label: {
              show: true,
              position: "top",
              color: "#2e4139",
              fontWeight: 700,
            },
            itemStyle: { borderRadius: [8, 8, 0, 0] },
          }],
        }}
      />
    </div>
  );
}

function PendingOnboardDonutChart({ data }: { data: Array<{ name: string; value: number }> }) {
  return (
    <Chart
      style={{ height: 260 }}
      option={{
        color: ["#0F4C3A", "#3D8B68", "#A8CDB8"],
        tooltip: { trigger: "item", formatter: "{b}<br/>{c} 人 ({d}%)" },
        legend: {
          bottom: 0,
          left: "center",
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: "#617069", fontSize: 12 },
        },
        series: [
          {
            type: "pie",
            radius: ["48%", "72%"],
            center: ["50%", "45%"],
            label: {
              color: "#2e4139",
              formatter: "{b}\n{d}%",
              fontSize: 12,
            },
            labelLine: { length: 10, length2: 8 },
            data,
          },
        ],
      }}
    />
  );
}

function RecruitmentAnalyticsChart({ rows }: { rows: Array<{ label: string; count: number; shareValue: number }> }) {
  const axisMax = 110;
  return (
    <Chart
      option={{
        color: ["#5f8f79"],
        legend: {
          top: 8,
          left: "center",
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: "#617069", fontSize: 12 },
          data: ["数量", "占简历总数比例"],
          selectedMode: false,
        },
        grid: { left: 160, right: 88, top: 54, bottom: 14 },
        xAxis: {
          type: "value",
          max: axisMax,
          show: false,
        },
        yAxis: {
          type: "category",
          inverse: true,
          data: rows.map((row) => row.label),
          axisTick: { show: false },
          axisLine: { show: false },
          axisLabel: {
            color: "#617069",
            fontSize: 13,
            margin: 18,
          },
          splitLine: {
            show: true,
            lineStyle: { color: "#e4ece8" },
          },
        },
        tooltip: {
          trigger: "axis",
          axisPointer: { type: "shadow" },
          formatter: (params: Array<{ dataIndex: number }>) => {
            const row = rows[params[0]?.dataIndex || 0];
            return `${row.label}<br/>数量：${row.count}<br/>占简历总数比：${row.shareValue.toFixed(2)}%`;
          },
        },
        series: [
          {
            name: "__offset",
            type: "bar",
            stack: "funnel",
            silent: true,
            barWidth: 22,
            itemStyle: { color: "transparent" },
            emphasis: { disabled: true },
            tooltip: { show: false },
            data: rows.map((row) => Number(((100 - row.shareValue) / 2).toFixed(2))),
          },
          {
            name: "数量",
            type: "bar",
            stack: "funnel",
            barWidth: 22,
            data: rows.map((row) => row.shareValue),
            label: {
              show: true,
              position: "inside",
              formatter: (params: { dataIndex: number }) => {
                const row = rows[params.dataIndex];
                return `${row.count}`;
              },
              color: "#ffffff",
              fontWeight: 700,
            },
            itemStyle: {
              color: "#6c9f86",
              borderRadius: 2,
            },
          },
          {
            name: "占简历总数比例",
            type: "scatter",
            symbolSize: 0,
            tooltip: { show: false },
            data: rows.map((row) => [Number((((100 + row.shareValue) / 2) + 2).toFixed(2)), row.label]),
            label: {
              show: true,
              position: "right",
              formatter: (params: { dataIndex: number }) => `${rows[params.dataIndex].shareValue.toFixed(2)}%`,
              color: "#2e4139",
              fontWeight: 700,
            },
          },
        ],
      }}
    />
  );
}
function SalaryExperienceChart({ data }: { data: NonNullable<Job["salaryData"]> }) { return <Chart option={{ color: ["#A8CDB8", "#1A6B4A", "#0F4C3A"], tooltip: { trigger: "axis" }, legend: { top: 8 }, grid: { left: 42, right: 20, top: 52, bottom: 36 }, xAxis: { type: "category", data: data.experienceBands.map(i => i.label) }, yAxis: { type: "value", axisLabel: { formatter: "{value}k" } }, series: [{ name: "P25", type: "bar", data: data.experienceBands.map(i => i.p25) }, { name: "P50", type: "bar", data: data.experienceBands.map(i => i.p50) }, { name: "P75", type: "bar", data: data.experienceBands.map(i => i.p75) }] }} />; }
function SalaryRegionChart({ data }: { data: NonNullable<Job["salaryData"]> }) { return <Chart option={{ color: ["#0F4C3A", "#58ad71", "#A8CDB8"], tooltip: { trigger: "axis" }, legend: { top: 8 }, grid: { left: 42, right: 20, top: 52, bottom: 36 }, xAxis: { type: "category", data: data.regionComparison.map(i => i.city) }, yAxis: { type: "value", axisLabel: { formatter: "{value}k" } }, series: [{ name: "P25", type: "line", smooth: true, data: data.regionComparison.map(i => i.p25) }, { name: "P50", type: "line", smooth: true, data: data.regionComparison.map(i => i.p50) }, { name: "P75", type: "line", smooth: true, data: data.regionComparison.map(i => i.p75) }] }} />; }
function SalaryIndustryChart({ data }: { data: NonNullable<Job["salaryData"]> }) { return <Chart option={{ color: ["#0F4C3A", "#1A6B4A", "#65A47D", "#A8CDB8", "#c8decf", "#7bb58f", "#2c7f5b"], tooltip: { trigger: "item" }, series: [{ type: "pie", radius: ["42%", "70%"], data: data.industryComparison }] }} />; }
function SalaryEducationChart({ data }: { data: NonNullable<Job["salaryData"]> }) { return <Chart option={{ color: ["#d1e5d8", "#a8cdb8", "#65a47d", "#0f4c3a"], tooltip: { trigger: "axis" }, grid: { left: 42, right: 20, top: 30, bottom: 36 }, xAxis: { type: "category", data: data.educationComparison.map(i => i.label) }, yAxis: { type: "value", axisLabel: { formatter: "{value}k" } }, series: [{ type: "bar", barWidth: 38, data: data.educationComparison.map(i => i.value) }] }} />; }

function Modal({ title, onClose, actions, children, className }: { title?: string; onClose: () => void; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className="modal-root">
      <div className={className ? `modal ${className}` : "modal"}>
        <div className={`modal-head ${!title ? "no-title" : ""}`}>
          <button className="btn" onClick={onClose}>关闭</button>
          {title && <h3>{title}</h3>}
          <div className="modal-actions">{actions}</div>
        </div>
        <div className="modal-scroll">{children}</div>
      </div>
    </div>
  );
}
function Input({ label, value, onChange, full }: { label: string; value: string; onChange: (value: string) => void; full?: boolean }) { return <label className={`form-field ${full ? "full" : ""}`}><span>{label}</span><input required value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
function StatCard({ label, value, extra }: { label: string; value: React.ReactNode; extra: string }) { return <section className="card stat-card"><div className="stat-label">{label}</div><div className="stat-value">{value}</div><div className="stat-extra">{extra}</div></section>; }
function Metric({ label, value }: { label: string; value: React.ReactNode }) { return <div className="salary-metric"><span>{label}</span><strong>{value}</strong></div>; }
function CardHeader({ title, desc, action }: { title: string; desc: string; action?: React.ReactNode }) { return <div className="card-header"><div><h3>{title}</h3><p>{desc}</p></div>{action}</div>; }
function Badge({ color, children }: { color: string; children: React.ReactNode }) { return <span className={`badge ${color}`}>{children}</span>; }
function KeywordList({ keywords }: { keywords: string }) { return <div className="kv spaced-small">{splitKeywords(keywords).map((keyword) => <span key={keyword}>{keyword}</span>)}</div>; }
function splitKeywords(keywords = "") { return keywords.split(/[、,，;；\s]+/).map(k => k.trim()).filter(Boolean); }
function normalizeJdDescription(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderJdDescription(text: string) {
  const normalized = normalizeJdDescription(text);
  if (!normalized) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const blocks: Array<
    | { type: "section"; title: string; items: string[] }
    | { type: "paragraph"; text: string }
  > = [];

  let currentSection: { title: string; items: string[] } | null = null;

  const flushSection = () => {
    if (!currentSection) return;
    blocks.push({ type: "section", title: currentSection.title, items: currentSection.items });
    currentSection = null;
  };

  for (const line of lines) {
    const heading = line.match(/^(岗位概述|岗位职责|任职要求|优先条件)[:：]?$/);
    if (heading) {
      flushSection();
      currentSection = { title: heading[1], items: [] };
      continue;
    }

    if (currentSection) {
      currentSection.items.push(line.replace(/^[•·]\s*/, ""));
    } else {
      blocks.push({ type: "paragraph", text: line });
    }
  }

  flushSection();

  return (
    <div className="jd-preview">
      {blocks.map((block, index) => (
        block.type === "section" ? (
          <section className="jd-preview-section" key={`${block.title}-${index}`}>
            <div className="jd-preview-title">{block.title}</div>
            {block.title === "岗位概述" ? (
              <p className="jd-preview-paragraph">{block.items.join(" ")}</p>
            ) : (
              <ol className="jd-preview-list">
                {block.items.map((item, itemIndex) => (
                  <li key={`${block.title}-${itemIndex}`}>{item.replace(/^\d+[.、]\s*/, "")}</li>
                ))}
              </ol>
            )}
          </section>
        ) : (
          <p className="jd-preview-paragraph" key={`paragraph-${index}`}>{block.text}</p>
        )
      ))}
    </div>
  );
}
function statusColor(status: Job["status"]) { return status === "招聘中" ? "green" : status === "暂停" ? "gold" : "gray"; }
function scoreColor(score: number) { return score >= 85 ? "green" : score >= 70 ? "gold" : score >= 60 ? "gray" : "red"; }
function buildJobQuestions(job: JobPayload) {
  const keywords = splitKeywords(job.keywords).slice(0, 4);
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

function formatInterviewQuestions(job: JobPayload, questions: InterviewQuestionItem[]) {
  const header = [
    `职位：${job.title || "未填写"}`,
    `部门：${job.dept || "未填写"}`,
    `城市：${job.location || "未填写"}`,
    `经验要求：${job.experience || "未填写"}`,
    `薪资范围：${job.salaryRange || "未填写"}`,
    `关键考核点：${job.keywords || "未填写"}`,
  ].join("\n");
  const body = questions
    .map((question, index) => [
      `${index + 1}. ${question.title}`,
      question.competency ? `考察能力：${question.competency}` : "",
      `问题：${question.text}`,
      question.starFocus?.length ? `STAR关注点：${question.starFocus.join("、")}` : "",
      `追问：\n${normalizeProbeText(question.probe)}`,
      question.evaluationSignals?.length ? `判断信号：${question.evaluationSignals.join("；")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");
  return `${header}\n\n推荐面试问题：\n${body}`;
}

function normalizeProbeText(probe: string) {
  return probe
    .replace(/追问(\d+)[：:]/g, "追问$1：")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildVoiceHighlightTerms(job: Job, transcript: string, manualNotes: string) {
  const seedTerms = [
    ...splitKeywords(job.keywords),
    job.title,
    job.location,
    ...["薪资", "到岗", "离职", "动机", "绩效", "团队", "管理", "稳定性", "通勤", "加班", "结果", "项目", "推进", "复盘"],
  ];
  const text = `${transcript}\n${manualNotes}`;
  return Array.from(new Set(seedTerms
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => text.includes(item))))
    .slice(0, 12);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(`(${terms.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|")})`, "g");
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, index) => (
        terms.includes(part)
          ? <mark className="voice-highlight-mark" key={`${part}-${index}`}>{part}</mark>
          : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
      ))}
    </>
  );
}

function analyzeRealtimeVoice(job: Job, candidate: Candidate, rawText: string): VoiceRealtimeAnalysis {
  const transcript = rawText.trim();
  if (!transcript) {
    return {
      summary: "当前还没有足够的转写内容，开始录音后会自动提炼候选人匹配情况与招聘者沟通建议。",
      jobFitAdvice: `建议围绕 ${job.keywords || job.title} 继续追问具体场景、动作与结果，再判断是否推进。`,
      communicationStrengths: ["待录入更多沟通内容后生成。"],
      communicationRisks: ["当前暂无足够信息，无法判断关键风险点。"],
      recruiterSuggestions: ["先确认求职动机、离职原因、薪资预期、到岗时间，再展开岗位深问。"],
      recruiterReview: [
        { title: "开场与破冰", level: "注意", text: "等待录音内容后判断。建议先确认动机与岗位优先级。" },
        { title: "信息采集完整度", level: "注意", text: "等待录音内容后判断。建议覆盖薪资、到岗、离职、流程进度。" },
        { title: "追问深度", level: "注意", text: "等待录音内容后判断。建议优先问时间、角色、动作、结果。" },
        { title: "沟通节奏", level: "注意", text: "等待录音内容后判断。建议每轮只聚焦一个主题。" },
        { title: "改进优先级", level: "注意", text: "先拿到候选人可验证案例，再判断推进。 " },
      ],
      recommendation: "建议复核",
    };
  }

  const lower = transcript.toLowerCase();
  const positiveSignals = ["负责", "推进", "复盘", "协同", "结果", "落地", "增长", "招聘", "绩效", "人才", "搭建", "项目", "优化", "管理"].filter((keyword) => transcript.includes(keyword));
  const riskSignals = ["不太清楚", "可能", "差不多", "忘了", "不确定", "先看看", "再说", "不了解", "没做过"].filter((keyword) => transcript.includes(keyword));
  const recruiterSignals = ["薪资", "到岗", "离职", "动机", "绩效", "团队", "管理", "稳定性", "职业规划", "通勤"].filter((keyword) => transcript.includes(keyword));
  const questionSignals = ["请问", "方便说说", "能否", "为什么", "如何", "有没有", "是否", "具体", "展开讲讲"].filter((keyword) => transcript.includes(keyword));
  const fillerSignals = ["嗯", "然后", "就是", "那个", "吧", "啊"].filter((keyword) => transcript.includes(keyword));
  const jobKeywords = splitKeywords(job.keywords).slice(0, 3);
  const recommendation: VoiceRecommendation = positiveSignals.length >= 4 && riskSignals.length <= 1 ? "建议推进" : positiveSignals.length >= 2 ? "建议复核" : "暂缓推进";

  return {
    summary: `${candidate.name} 当前提到的重点集中在 ${positiveSignals.slice(0, 3).join("、") || "过往经历、动机与基础信息"}，整体${riskSignals.length ? "存在部分模糊表达，建议继续核验细节。" : "表达相对完整，可继续往岗位关键考核点深挖。"} `,
    jobFitAdvice: recommendation === "建议推进"
      ? `从当前沟通看，候选人与 ${job.title} 的贴合度较高，建议推进下一轮，并重点核验 ${jobKeywords.join("、") || "岗位关键能力"} 的真实贡献。`
      : recommendation === "建议复核"
        ? `候选人对 ${job.title} 有一定相关性，但关键证据还不够完整，建议继续用结构化问题追问后再决定。`
        : `当前沟通中尚未充分体现 ${job.title} 的关键能力，建议暂缓推进，优先补充可验证案例。`,
    communicationStrengths: [
      positiveSignals.length ? `主动提及 ${positiveSignals.slice(0, 2).join("、")} 等经历，具备一定内容展开能力。` : "愿意配合沟通，基础信息回应较顺畅。",
      recruiterSignals.length ? `对 ${recruiterSignals.slice(0, 2).join("、")} 等招聘关键信息有明确回应。` : "当前能完成基础岗位与经历对齐。",
      jobKeywords.length ? `已可围绕 ${jobKeywords.join("、")} 做进一步验证。` : "可继续追问更贴近岗位结果的案例。",
    ],
    communicationRisks: [
      riskSignals.length ? `出现 ${riskSignals.slice(0, 2).join("、")} 等模糊表达，建议立即追问具体案例、时间和结果。` : "当前未出现明显答非所问，但仍需继续核实量化结果。",
      lower.includes("加班") || lower.includes("通勤") || lower.includes("距离") ? "对工作节奏或通勤条件有顾虑，建议确认稳定性与接受边界。" : "需进一步确认岗位节奏、组织协同和稳定性预期。",
      !jobKeywords.some((keyword) => transcript.includes(keyword)) ? `当前对 ${jobKeywords.join("、") || job.title} 的直接证据还不够充分。` : "岗位关键考核点已有初步信号，但还需要更细颗粒度案例。",
    ],
    recruiterSuggestions: [
      recruiterSignals.includes("动机") ? "已覆盖求职动机，下一步可把问题继续前置到离职原因和岗位优先级。" : "建议开场先确认求职动机、离职原因与岗位优先级，先建立沟通主线。",
      recruiterSignals.includes("薪资") && recruiterSignals.includes("到岗") ? "基础招聘信息覆盖较完整，可继续补充其他流程进度与稳定性。" : "建议补齐薪资、到岗时间、当前流程进度三项基础信息。",
      questionSignals.length >= 4 ? "当前追问密度较好，可继续用开放式问题拿细节，再用封闭式问题做确认。" : "建议增加“为什么 / 如何 / 具体做了什么 / 结果是多少”这类追问，避免只拿到结论。",
      fillerSignals.length >= 3 ? "对话里可能存在较多停顿词，建议放慢语速、缩短单句，并给候选人更清晰的回答边界。" : "节奏基本平稳，建议继续保持一轮只问一个主题。",
      riskSignals.length ? "遇到模糊表达时，优先追问时间、角色、动作、结果四个维度，减少主观判断。" : "下一步建议重点做量化追问，例如项目规模、结果指标和个人贡献占比。",
    ],
    recruiterReview: [
      {
        title: "开场与破冰",
        level: recruiterSignals.includes("动机") ? "良好" : "待优化",
        text: recruiterSignals.includes("动机")
          ? "已触达求职动机，开场方向基本正确。"
          : "建议先确认求职动机、离职原因和岗位优先级，再进入经历深问。",
      },
      {
        title: "信息采集完整度",
        level: recruiterSignals.includes("薪资") && recruiterSignals.includes("到岗") ? "良好" : recruiterSignals.length >= 2 ? "注意" : "待优化",
        text: recruiterSignals.includes("薪资") && recruiterSignals.includes("到岗")
          ? "薪资、到岗等基础信息已覆盖，可继续补充其他流程节点。"
          : "基础信息还不够完整，建议补齐薪资、到岗、流程进度三项。",
      },
      {
        title: "追问深度",
        level: questionSignals.length >= 4 ? "良好" : questionSignals.length >= 2 ? "注意" : "待优化",
        text: questionSignals.length >= 4
          ? "追问深度较好，开放式与确认式问题搭配相对合理。"
          : "追问偏浅，建议更多使用“为什么 / 如何 / 具体做了什么”拿到可验证信息。",
      },
      {
        title: "沟通节奏",
        level: fillerSignals.length >= 3 ? "待优化" : "良好",
        text: fillerSignals.length >= 3
          ? "疑似存在较多停顿词或重复衔接，建议放慢语速并减少一轮多问。"
          : "整体节奏较平稳，建议继续保持一轮一个主题的提问方式。",
      },
      {
        title: "改进优先级",
        level: riskSignals.length ? "注意" : "良好",
        text: riskSignals.length
          ? "优先补足候选人模糊表达背后的时间、角色、动作和结果。"
          : "下一步重点可转向量化追问，核验项目规模、结果指标与个人贡献。",
      },
    ],
    recommendation,
  };
}

function buildVoiceRealtimeAnalysisFromAi(
  job: Job,
  candidate: Candidate,
  liveState: VoiceAiLiveState | null,
  finalEvaluation: VoiceFinalEvaluation | null,
): VoiceRealtimeAnalysis | null {
  if (!liveState && !finalEvaluation) return null;

  const summary = finalEvaluation?.summary || liveState?.quickInsight.coreViewpoint || `${candidate.name} 正在进行面试沟通分析。`;
  const jobFitAdvice = finalEvaluation
    ? `已验证：${finalEvaluation.passedKeywords.join("、") || "暂无"}；待验证：${finalEvaluation.pendingKeywords.join("、") || "暂无"}。`
    : `当前建议围绕 ${liveState?.followUp.uncoveredKeywords.join("、") || job.keywords || job.title} 继续深挖。`;
  const communicationStrengths = finalEvaluation?.strengths?.length
    ? finalEvaluation.strengths
    : (liveState?.quickInsight.signalType === "加分信号"
      ? liveState.quickInsight.keyEvidence.slice(0, 3)
      : ["当前还需要更多正向证据来支撑推进判断。"]);
  const communicationRisks = finalEvaluation?.risks?.length
    ? finalEvaluation.risks
    : (liveState?.quickInsight.signalType === "风险信号"
      ? [...liveState.quickInsight.followUpDirection.slice(0, 2), liveState.quickInsight.signalReason].filter(Boolean)
      : ["当前暂无明显风险，但仍需继续验证关键案例。"]);
  const recruiterCoach = finalEvaluation?.recruiterCoach || null;
  const recruiterSuggestions = recruiterCoach
    ? buildRecruiterSuggestionList(recruiterCoach)
    : [
      liveState?.followUp.nextQuestion || "继续追问候选人最近提到的案例细节。",
      liveState?.followUp.backupQuestion || "如回答模糊，继续追问个人角色和量化结果。",
      ...(finalEvaluation?.interviewerAdvice.nextRoundFocus || []),
    ].filter(Boolean).slice(0, 5);
  const recruiterReview: VoiceRealtimeAnalysis["recruiterReview"] = recruiterCoach
    ? buildRecruiterReviewList(recruiterCoach)
    : [
      {
        title: "实时追问方向",
        level: liveState?.quickInsight.signalType === "风险信号" ? "注意" : "良好",
        text: liveState?.followUp.objective || "建议继续围绕岗位关键点做深入验证。",
      },
      {
        title: "已覆盖考核点",
        level: liveState?.followUp.coveredKeywords.length ? "良好" : "待优化",
        text: liveState?.followUp.coveredKeywords.join("、") || "当前还未形成足够的已覆盖考核点。",
      },
      {
        title: "待深挖考核点",
        level: liveState?.followUp.uncoveredKeywords.length ? "注意" : "良好",
        text: liveState?.followUp.uncoveredKeywords.join("、") || "当前暂无明显缺口，可继续核验案例真实性。",
      },
    ];
  const recommendation: VoiceRecommendation = finalEvaluation
    ? finalEvaluation.score >= 75 ? "建议推进" : finalEvaluation.score >= 60 ? "建议复核" : "暂缓推进"
    : (liveState?.quickInsight.signalType === "加分信号" ? "建议复核" : "暂缓推进");

  return {
    summary,
    jobFitAdvice,
    communicationStrengths,
    communicationRisks,
    recruiterSuggestions,
    recruiterReview,
    recommendation,
  };
}

function buildRecruiterSuggestionList(report: VoiceRecruiterCoachReport) {
  const core = report.conciseImprovements.filter(Boolean);
  if (core.length) return core.slice(0, 5);

  return [
    report.opening.suggestion,
    ...report.informationCompleteness.suggestionLines,
    ...report.rhythm.advice,
  ].filter(Boolean).slice(0, 5);
}

function buildRecruiterReviewList(report: VoiceRecruiterCoachReport): VoiceRealtimeAnalysis["recruiterReview"] {
  return [
    {
      title: `开场与破冰 · ${report.opening.score}分`,
      level: mapVoiceScoreToLevel(report.opening.score),
      text: [
        report.opening.evidence.length ? `依据：${report.opening.evidence.join("；")}` : "",
        report.opening.issues.length ? `问题：${report.opening.issues.join("；")}` : "",
        report.opening.suggestion ? `建议：${report.opening.suggestion}` : "",
      ].filter(Boolean).join(" "),
    },
    {
      title: `信息采集完整度 · ${report.informationCompleteness.score}分`,
      level: mapVoiceScoreToLevel(report.informationCompleteness.score),
      text: [
        report.informationCompleteness.missingItems.length ? `缺失项：${report.informationCompleteness.missingItems.join("；")}` : "本场基础信息采集较完整。",
        report.informationCompleteness.suggestionLines.length ? `补充话术：${report.informationCompleteness.suggestionLines.join("；")}` : "",
      ].filter(Boolean).join(" "),
    },
    {
      title: `追问深度 · ${report.followUpDepth.score}分`,
      level: mapVoiceScoreToLevel(report.followUpDepth.score),
      text: [
        report.followUpDepth.goodExamples.length ? `亮点：${report.followUpDepth.goodExamples.join("；")}` : "",
        report.followUpDepth.missedOpportunities.length
          ? `待补深挖：${report.followUpDepth.missedOpportunities.map((item) => `${item.moment}；建议问法：${item.suggestion}`).join(" | ")}`
          : "",
      ].filter(Boolean).join(" "),
    },
    {
      title: `沟通节奏 · ${report.rhythm.score}分`,
      level: mapVoiceScoreToLevel(report.rhythm.score),
      text: [
        `主题跳跃度：${report.rhythm.topicJumpLevel}`,
        `讲话占比：${report.rhythm.interviewerTalkRatio}`,
        `时间分配：${report.rhythm.timeAllocation}`,
        report.rhythm.advice.length ? `优化建议：${report.rhythm.advice.join("；")}` : "",
      ].filter(Boolean).join("；"),
    },
  ];
}

function mapVoiceScoreToLevel(score: number): VoiceReviewLevel {
  if (score >= 85) return "良好";
  if (score >= 70) return "注意";
  return "待优化";
}

function formatCandidateAssessmentCopy({
  job,
  candidate,
  analysis,
  transcript,
  manualNotes,
  sessionStartedAt,
}: {
  job: Job;
  candidate: Candidate;
  analysis: VoiceRealtimeAnalysis;
  transcript: string;
  manualNotes: string;
  sessionStartedAt: string;
}) {
  return [
    `岗位：${job.title}`,
    `候选人：${candidate.name}`,
    `开始时间：${sessionStartedAt || "未记录"}`,
    `综合建议：${analysis.recommendation}`,
    "",
    "AI总结：",
    analysis.summary,
    "",
    "匹配建议：",
    analysis.jobFitAdvice,
    "",
    "优势亮点：",
    ...analysis.communicationStrengths.map((item, index) => `${index + 1}. ${item}`),
    "",
    "风险点：",
    ...analysis.communicationRisks.map((item, index) => `${index + 1}. ${item}`),
    ...(manualNotes.trim() ? ["", "补充备注：", manualNotes.trim()] : []),
    "",
    "沟通转写：",
    transcript || "暂无转写内容",
  ].join("\n");
}

function formatRecruiterAdviceCopy({
  job,
  candidate,
  analysis,
  transcript,
  manualNotes,
  sessionStartedAt,
}: {
  job: Job;
  candidate: Candidate;
  analysis: VoiceRealtimeAnalysis;
  transcript: string;
  manualNotes: string;
  sessionStartedAt: string;
}) {
  return [
    `岗位：${job.title}`,
    `候选人：${candidate.name}`,
    `开始时间：${sessionStartedAt || "未记录"}`,
    "",
    "招聘者建议：",
    ...analysis.recruiterSuggestions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "招聘者沟通质检：",
    ...analysis.recruiterReview.map((item, index) => `${index + 1}. ${item.title}（${item.level}）：${item.text}`),
    ...(manualNotes.trim() ? ["", "补充备注：", manualNotes.trim()] : []),
    "",
    "沟通转写：",
    transcript || "暂无转写内容",
  ].join("\n");
}

function formatRealtimeVoiceCopy({
  job,
  candidate,
  analysis,
  transcript,
  manualNotes,
  sessionStartedAt,
}: {
  job: Job;
  candidate: Candidate;
  analysis: VoiceRealtimeAnalysis;
  transcript: string;
  manualNotes: string;
  sessionStartedAt: string;
}) {
  const lines = [
    `岗位：${job.title}`,
    `候选人：${candidate.name}`,
    `开始时间：${sessionStartedAt || "未记录"}`,
    `综合建议：${analysis.recommendation}`,
    "",
    "AI总结：",
    analysis.summary,
    "",
    "匹配建议：",
    analysis.jobFitAdvice,
    "",
    "优势亮点：",
    ...analysis.communicationStrengths.map((item, index) => `${index + 1}. ${item}`),
    "",
    "风险点：",
    ...analysis.communicationRisks.map((item, index) => `${index + 1}. ${item}`),
    "",
    "招聘者建议：",
    ...analysis.recruiterSuggestions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "招聘者沟通质检：",
    ...analysis.recruiterReview.map((item, index) => `${index + 1}. ${item.title}（${item.level}）：${item.text}`),
    ...(manualNotes.trim() ? ["", "补充备注：", manualNotes.trim()] : []),
    "",
    "沟通转写：",
    transcript || "暂无转写内容",
  ];
  return lines.join("\n");
}

function buildSalaryFilters(salaryData: SalaryData | null): SalaryFilters {
  return {
    role: salaryData?.filters.role || "HRBP",
    region: salaryData?.filters.region || "北京",
    experience: salaryData?.filters.experience || "3-5年",
    industry: salaryData?.filters.industry || "企业服务",
    education: salaryEducationOptions.includes((salaryData?.filters.education || "本科") as (typeof salaryEducationOptions)[number])
      ? (salaryData?.filters.education || "本科")
      : "本科",
  };
}

function downloadJson(state: AppState) { const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = `xiaosongshu-${Date.now()}.json`; link.click(); URL.revokeObjectURL(url); }

function SquirrelLogo() { return <svg className="squirrel-logo" viewBox="0 0 96 96" focusable="false" aria-hidden="true"><path className="logo-fill" d="M62.5 72.5c11.7-.8 19.4-8.7 19.4-20.1 0-10.9-7.7-19.3-18.1-20.3 6.9 6.3 6.1 15.3-1.8 21.5 4.2 4.6 4.2 12.3.5 18.9Z" /><path className="logo-inner" d="M67.8 42.1c4.5 3 6.8 7 6.6 11.5-.2 5.9-4.5 10.5-11.3 12.2" /><path className="logo-fill" d="M26.5 57.9c0-12.1 9.5-21.7 22.1-21.7 13 0 22.8 9.7 22.8 22.2 0 12.9-10.1 22.8-22.7 22.8S26.5 71.3 26.5 57.9Z" /><path className="logo-fill" d="M29 33.3c-3.5-6.1.2-13.4 7-13.8 4.8-.3 8.7 3.2 9.1 8.2 2.5-.6 5.2-.6 7.8 0 .8-4.8 4.9-8 9.6-7.2 6.2 1.1 8.7 8.2 5.1 13.7 3.4 3.8 5.2 8.9 5.1 14.4-.2 12.3-9.7 21.2-23.4 21.2-14.3 0-24-8.9-24.2-21.3-.1-6.1 1.4-11.1 3.9-15.2Z" /><path className="logo-line" d="M40.8 59.2c4.5 3.4 12.1 3.4 16.6 0" /><ellipse className="logo-eye" cx="39.7" cy="45.9" rx="3.8" ry="5.1" /><ellipse className="logo-eye" cx="59.4" cy="45.9" rx="3.8" ry="5.1" /><path className="logo-eye" d="M46.8 52.7c1.7-1.4 4.4-1.4 6.1 0 .5.4.4 1.2-.2 1.6l-2 1.3c-.6.4-1.4.4-2 0l-1.9-1.3c-.6-.4-.7-1.2 0-1.6Z" /><path className="logo-line" d="M32.2 62.5c2 9.1 8.4 14.1 16.4 14.1" /></svg>; }

createRoot(document.getElementById("root")!).render(<App />);
