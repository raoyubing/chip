import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createCandidate } from "../apps/server/src/analyzer";
import type { Job } from "../apps/server/src/types";

async function selectArcoOption(page: Page, select: Locator, option: string | RegExp) {
  await select.locator(".arco-select-view").click();
  const popup = page.locator(".arco-select-popup:visible").last();
  await expect(popup).toBeVisible();
  const targetOption = popup.locator(".arco-select-option").filter({ hasText: option }).first();
  await expect(targetOption).toBeVisible();
  try {
    await targetOption.click({ timeout: 2_000 });
  } catch {
    await targetOption.click({ force: true });
  }
}

async function selectArcoCascaderByPath(page: Page, cascader: Locator, path: string[]) {
  await expect(cascader).not.toHaveClass(/arco-cascader-disabled/);
  await cascader.locator(".arco-cascader-view").click();
  const popup = page.locator(".arco-cascader-popup:visible").last();
  await expect(popup).toBeVisible();
  for (const [index, label] of path.entries()) {
    const column = popup.locator(".arco-cascader-list-column").nth(index);
    await expect(column).toBeVisible();
    await column.locator(".arco-cascader-list-item").filter({ hasText: label }).first().click();
  }
}

async function expectArcoCascaderSearchCanFind(page: Page, cascader: Locator, search: string, expected: string | RegExp) {
  await expect(cascader).not.toHaveClass(/arco-cascader-disabled/);
  await cascader.locator(".arco-cascader-view").click();
  await cascader.locator("input:visible").first().fill(search);
  const popup = page.locator(".arco-cascader-popup:visible").last();
  await expect(popup).toBeVisible();
  await expect(popup.locator(".arco-cascader-list-search-item").filter({ hasText: expected }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
}

function isKnownThirdPartyConsoleNoise(message: string) {
  return message.includes("Accessing element.ref was removed in React 19");
}

test.beforeEach(async ({ page }) => {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "admin", password: "e2e-admin-password" },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
});

test("登录页支持内置账号，普通用户无法访问薪酬和高风险功能", async ({ page }) => {
  await page.request.post("/api/auth/logout");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录小松鼠" })).toBeVisible();
  await expect(page.getByRole("button", { name: /guest/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /admin/ })).toBeVisible();

  await page.getByRole("button", { name: /guest/ }).click();
  await page.getByLabel("登录密码").fill("e2e-guest-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "工作台概览", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /薪酬调研/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "清空本地数据" })).toHaveCount(0);

  const stateResponse = await page.request.get("/api/state");
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json();
  expect(state.currentUser).toBe("guest");
  expect(state.jobs.every((job: { salaryData: unknown }) => job.salaryData === null)).toBeTruthy();

  const salaryResponse = await page.request.post("/api/salary/research", {
    data: { role: "HRBP", region: "石家庄市", experience: "3-5年", industry: "互联网", education: "本科" },
  });
  expect(salaryResponse.status()).toBe(403);

  const deleteJobResponse = await page.request.delete(`/api/jobs/${state.jobs[0].id}`);
  expect(deleteJobResponse.status()).toBe(403);
  const candidate = Object.values(state.candidates).flat()[0] as { id: string } | undefined;
  expect(candidate).toBeTruthy();
  const hardDeleteResponse = await page.request.delete(`/api/candidates/${candidate!.id}/hard`);
  expect(hardDeleteResponse.status()).toBe(403);

  const accountResponse = await page.request.get("/api/auth/users");
  expect(accountResponse.status()).toBe(403);
});

test("管理员可打开账号管理并校验密码，账号接口不返回密码哈希", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "账号管理" }).click();

  const modal = page.getByRole("dialog", { name: "账号管理" });
  await expect(modal).toBeVisible();
  await expect(modal.locator(".account-role-card")).toHaveCount(2);
  await expect(modal.locator(".account-role-card.active")).toContainText("guest");

  const accountsResponse = await page.request.get("/api/auth/users");
  expect(accountsResponse.ok(), await accountsResponse.text()).toBeTruthy();
  const accountsPayload = await accountsResponse.json() as { users: Array<Record<string, unknown>> };
  expect(accountsPayload.users).toHaveLength(2);
  expect(accountsPayload.users.map((account) => account.username)).toEqual(["admin", "guest"]);
  for (const account of accountsPayload.users) {
    expect(account).not.toHaveProperty("passwordHash");
  }

  await modal.getByLabel("新密码", { exact: true }).fill("guest-next-password");
  await modal.getByLabel("确认新密码").fill("guest-other-password");
  await modal.getByRole("button", { name: "更新密码" }).click();
  await expect(modal).toContainText("两次输入的密码不一致");
});

test("工作台时间筛选固定在右上角并作用于四个分区", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台概览", exact: true })).toBeVisible();

  const globalFilters = page.locator(".topbar .dashboard-global-filters");
  await expect(globalFilters).toBeVisible();
  await expect.poll(async () => (await globalFilters.boundingBox())?.height || 0).toBeLessThanOrEqual(70);
  await expect(globalFilters).toContainText("月数据");
  await expect(globalFilters).toContainText("统计月份");
  await expect(page.locator(".content-dashboard > .analytics-toolbar-card").filter({ hasText: "招聘周期复盘" })).toHaveCount(0);

  await page.locator(".section-radio-tabs").getByText("流程复盘").click();
  const channelFilter = page.locator(".analytics-channel-filter .arco-select");
  await expect(channelFilter).toContainText("全部渠道");
  const allChannelCards = page.locator(".analytics-channel-grid .analytics-channel-card");
  const allChannelCount = await allChannelCards.count();
  expect(allChannelCount).toBeGreaterThan(1);
  const firstChannel = (await allChannelCards.first().locator(".analytics-channel-head > strong").textContent())?.trim() || "";
  await selectArcoOption(page, channelFilter, firstChannel);
  await expect(allChannelCards).toHaveCount(1);
  await expect(allChannelCards.first().locator(".analytics-channel-head > strong")).toHaveText(firstChannel);
  await expect(allChannelCards.first()).toContainText("offer");
  await selectArcoOption(page, channelFilter, "全部渠道");
  await expect(allChannelCards).toHaveCount(allChannelCount);

  for (const tabName of ["招聘概览", "职位分析", "流程复盘", "问题与行动"]) {
    await page.locator(".section-radio-tabs").getByText(tabName).click();
    await expect(globalFilters).toBeVisible();
  }

  await globalFilters.getByRole("button", { name: "年数据" }).click();
  await expect(globalFilters).toContainText("统计年份");
  await page.locator(".section-radio-tabs").getByText("职位分析").click();
  await expect(page.getByText("按招聘月份展示当期岗位，并延续展示尚未完成的跨期岗位")).toBeVisible();
});

test("AI招聘运营复盘按固定字段输出备注证据并缓存相同快照", async ({ page }) => {
  test.setTimeout(90_000);
  const payload = {
    granularity: "month",
    selectedPeriod: "2025年12月",
    scopeLabel: "2025年12月 · 测试岗位",
    jobScope: { id: "review-test-job", label: "测试岗位" },
    snapshot: {
      headcount: { planned: 3, remaining: 2, overdueRemaining: 1 },
      periodComparison: [{ label: "初试通过率", current: 40, previous: 65, delta: -25 }],
      stageDurations: [{ label: "初试通过→复试通过", averageDays: 12, sampleCount: 4, level: "risk" }],
      channels: [{ source: "BOSS", resumeCount: 5, onboardedCount: 0 }],
      reasonTags: [{ label: "部门对比", count: 2 }],
    },
    jobs: [{
      id: "review-test-job",
      title: "测试岗位",
      department: "测试部门",
      location: "北京市",
      experience: "5-10年",
      level: "经理",
      salaryRange: "20k - 30k",
      keywords: "业务协同、团队管理",
      description: "负责业务协同与团队管理。",
      status: "招聘中",
    }],
    remarks: [{
      candidateRef: "候选人1",
      jobTitle: "测试岗位",
      stage: "复试",
      occurredAt: "2025-12-18",
      remark: "初试反馈等待较久，用人部门仍在进行多位候选人对比。",
    }],
    externalEvidence: [],
  };

  const firstResponse = await page.request.post("/api/analytics/recruitment-review", { data: payload });
  expect(firstResponse.ok(), await firstResponse.text()).toBeTruthy();
  const firstResult = await firstResponse.json();
  expect(firstResult.cached).toBe(false);
  expect(firstResult.analysisMode).toBe("rules");
  expect(firstResult.notice).toContain("系统基于真实指标");
  expect(firstResult.issues.length).toBeGreaterThan(0);
  for (const issue of firstResult.issues) {
    expect(issue).toEqual(expect.objectContaining({
      problem: expect.any(String),
      dataEvidence: expect.any(Array),
      remarkEvidence: expect.any(Array),
      internalCauses: expect.any(Array),
      externalCauses: expect.any(Array),
      solutions: expect.any(Array),
      ownerSuggestions: expect.any(Array),
    }));
    expect(issue.externalCauses.join(" ")).toContain("外部证据不足");
  }
  expect(firstResult.issues[0].remarkEvidence.join(" ")).toContain("初试反馈等待较久");

  const secondResponse = await page.request.post("/api/analytics/recruitment-review", { data: payload });
  expect(secondResponse.ok(), await secondResponse.text()).toBeTruthy();
  const secondResult = await secondResponse.json();
  expect(secondResult.cached).toBe(true);
  expect(secondResult.generatedAt).toBe(firstResult.generatedAt);

  const currentDate = new Date();
  const currentPeriod = `${currentDate.getFullYear()}年${String(currentDate.getMonth() + 1).padStart(2, "0")}月`;
  const currentPeriodResponse = await page.request.post("/api/analytics/recruitment-review", {
    data: {
      ...payload,
      selectedPeriod: currentPeriod,
      scopeLabel: `${currentPeriod} · 当前周期测试岗位`,
      snapshot: {
        headcount: { planned: 5, remaining: 5, overdueRemaining: 0 },
        periodComparison: [{ label: "初试通过率", current: 60, previous: 61, delta: -1 }],
        stageDurations: [{ label: "初试通过→复试通过", averageDays: 3, sampleCount: 5, level: "healthy" }],
        channels: [],
        reasonTags: [],
      },
      remarks: [],
    },
  });
  expect(currentPeriodResponse.ok(), await currentPeriodResponse.text()).toBeTruthy();
  const currentPeriodResult = await currentPeriodResponse.json();
  expect(currentPeriodResult.issues.map((issue: { problem: string }) => issue.problem).join(" ")).not.toContain("未完成HC");
  expect(currentPeriodResult.issues.map((issue: { problem: string }) => issue.problem).join(" ")).not.toContain("耗时偏长");

  const futurePeriodResponse = await page.request.post("/api/analytics/recruitment-review", {
    data: {
      ...payload,
      selectedPeriod: "2099年12月",
      scopeLabel: "2099年12月 · 未来周期测试岗位",
      snapshot: {
        headcount: { planned: 8, remaining: 8, overdueRemaining: 4 },
        periodComparison: [{ label: "初试通过率", current: 0, previous: 70, delta: -70 }],
        stageDurations: [],
        channels: [],
        reasonTags: [],
      },
      remarks: [],
    },
  });
  expect(futurePeriodResponse.ok(), await futurePeriodResponse.text()).toBeTruthy();
  const futurePeriodResult = await futurePeriodResponse.json();
  expect(futurePeriodResult.issues[0].problem).toContain("尚未开始");
  expect(futurePeriodResult.issues.map((issue: { problem: string }) => issue.problem).join(" ")).not.toContain("未完成HC");

  const competingOfferResponse = await page.request.post("/api/analytics/recruitment-review", {
    data: {
      ...payload,
      selectedPeriod: "2025年11月",
      scopeLabel: "2025年11月 · 竞争Offer测试岗位",
      externalSignals: [{ type: "competing_offer", evidence: "候选人1备注明确提到已接到其他 Offer", count: 1 }],
    },
  });
  expect(competingOfferResponse.ok(), await competingOfferResponse.text()).toBeTruthy();
  const competingOfferResult = await competingOfferResponse.json();
  expect(competingOfferResult.issues[0].externalCauses.join(" ")).toContain("其他 Offer");

  await page.goto("/");
  await page.locator(".section-radio-tabs").getByText("问题与行动").click();
  const reviewSection = page.locator(".recruitment-ai-review");
  await expect(reviewSection.getByRole("heading", { name: "AI招聘运营复盘" })).toBeVisible();
  await expect(reviewSection.locator(".recruitment-ai-review-scope")).toContainText("复盘范围");
  await reviewSection.getByRole("button", { name: "生成分析" }).click();
  const firstIssue = reviewSection.locator(".recruitment-ai-review-issue").first();
  await expect(firstIssue).toBeVisible();
  for (const label of ["问题点：", "数据证据：", "备注证据：", "内部原因：", "外部原因：", "解决方案：", "负责人建议："]) {
    await expect(firstIssue.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(reviewSection.locator(".recruitment-ai-review-mode")).toHaveText("系统规则分析");
  await expect(reviewSection.locator(".recruitment-ai-review-notice")).toContainText("DeepSeek 未配置");
});

test("职位池导出数据为 Excel 文件", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /职位管理/ }).click();
  await expect(page.getByRole("heading", { name: "职位管理", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "职位池", exact: true })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出Excel" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^职位池-招聘中-\d{8}\.xls$/);

  const filePath = await download.path();
  expect(filePath).toBeTruthy();
  const content = readFileSync(filePath!, "utf8");
  expect(content).toContain("Excel.Sheet");
  expect(content).toContain("职位池-招聘中");
  expect(content).toContain("职位名称");
  expect(content).toContain("薪资范围");
  expect(content).toContain("需求类型");

  await page.getByRole("button", { name: "新增职位" }).click();
  const createJobDialog = page.getByRole("dialog", { name: "新增职位" });
  await expect(createJobDialog).toBeVisible();
  const demandTypeSelect = createJobDialog.locator(".form-field").filter({ hasText: "需求类型" }).locator(".arco-select");
  await demandTypeSelect.locator(".arco-select-view").click();
  const demandTypePopup = page.locator(".arco-select-popup:visible").last();
  for (const demandType of ["离职替补", "计划内提前", "计划内新增", "计划外新增"]) {
    await expect(demandTypePopup.locator(".arco-select-option").filter({ hasText: demandType })).toBeVisible();
  }
});

test("关闭职位后重新招聘会创建新批次并隔离历史人选", async ({ page }) => {
  test.setTimeout(240_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidate = initialState.candidates.job_001[0] as { id: string; name: string };
  const title = `批次隔离测试岗位-${Date.now()}`;
  const originalDescription = "用于验证同一职位重新招聘时，新旧候选人按招聘批次隔离。";
  const nextBatchDescription = "第2批调整后的岗位画像，不应覆盖第1批的历史快照。";
  const nextBatchKeywords = "战略升级、组织协同、经营分析";
  const nextBatchScoreWeights = { experience: 20, professional: 25, stability: 10, education: 5, business: 40 };
  let jobId: string | undefined;

  try {
    const createResponse = await page.request.post("/api/jobs", {
      data: {
        title,
        dept: "批次测试部",
        location: "北京市 / 北京市 / 朝阳区",
        experience: "3-5年",
        level: "经理",
        salaryRange: "18k - 24k",
        demandType: "离职替补",
        plannedHeadcount: 3,
        keywords: "批次管理、流程复盘",
        scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
        description: originalDescription,
        status: "招聘中",
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const createdState = await createResponse.json();
    const job = createdState.jobs.find((item: { title: string }) => item.title === title);
    expect(job).toBeTruthy();
    jobId = job.id;
    expect(job.recruitmentBatches).toHaveLength(1);

    const firstRecommendation = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, {
      data: { jobId: job.id },
    });
    expect(firstRecommendation.ok(), await firstRecommendation.text()).toBeTruthy();
    const firstState = await firstRecommendation.json();
    const firstBatchCandidate = firstState.candidates[job.id][0];
    const firstBatchScoreWeights = Object.fromEntries(firstBatchCandidate.evaluation.scoreDimensions.map((item: { key: string; weight: number }) => [item.key, item.weight]));
    expect(firstBatchCandidate.recruitmentBatchId).toBe(job.currentBatchId);
    const markInterviewResponse = await page.request.post(`/api/candidates/${firstBatchCandidate.id}/mark-interview`, { data: {} });
    const markInterviewResponseText = await markInterviewResponse.text();
    expect(markInterviewResponse.ok(), markInterviewResponseText).toBeTruthy();
    const markedState = JSON.parse(markInterviewResponseText);
    const firstBatchScore = markedState.candidates[job.id].find((candidate: { id: string }) => candidate.id === firstBatchCandidate.id).score;
    const stageMonthResponse = await page.request.patch(`/api/candidates/${firstBatchCandidate.id}/interview-stage`, {
      data: {
        interviewStage: "推荐",
        stageRecommendation: "待定",
        interviewResult: "待定",
        onboarded: "待入职",
        reportMonth: "2025年07月",
        interviewReason: "验证阶段日期不改变招聘月份",
        reasonTags: [],
        interviewTimeline: { recommendedAt: "2025-07-15" },
      },
    });
    expect(stageMonthResponse.ok(), await stageMonthResponse.text()).toBeTruthy();
    const stageMonthState = await stageMonthResponse.json();
    expect(stageMonthState.candidates[job.id].find((candidate: { id: string }) => candidate.id === firstBatchCandidate.id).reportMonth).toBe(job.recruitmentBatches[0].targetMonth);

    const closeResponse = await page.request.post(`/api/jobs/${job.id}/close`, { data: {} });
    expect(closeResponse.ok(), await closeResponse.text()).toBeTruthy();
    const closedState = await closeResponse.json();
    const closedJob = closedState.jobs.find((item: { id: string }) => item.id === job.id);
    const updateResponse = await page.request.put(`/api/jobs/${job.id}`, {
      data: {
        title: closedJob.title,
        dept: closedJob.dept,
        location: closedJob.location,
        experience: closedJob.experience,
        level: closedJob.level,
        salaryRange: closedJob.salaryRange,
        demandType: closedJob.demandType,
        plannedHeadcount: closedJob.plannedHeadcount,
        keywords: nextBatchKeywords,
        scoreWeights: nextBatchScoreWeights,
        description: nextBatchDescription,
        status: "已关闭",
      },
    });
    const updateResponseText = await updateResponse.text();
    expect(updateResponse.ok(), updateResponseText).toBeTruthy();
    const updatedClosedState = JSON.parse(updateResponseText);
    const preservedHistoricalCandidate = updatedClosedState.candidates[job.id].find((candidate: { id: string }) => candidate.id === firstBatchCandidate.id);
    expect(preservedHistoricalCandidate.score).toBe(firstBatchScore);
    expect(Object.fromEntries(preservedHistoricalCandidate.evaluation.scoreDimensions.map((item: { key: string; weight: number }) => [item.key, item.weight]))).toEqual(firstBatchScoreWeights);

    await page.goto("/");
    await page.getByRole("button", { name: "面试管理", exact: true }).click();
    await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(0), title);
    await expect(page.locator(".interview-table tbody tr").filter({ hasText: sourceCandidate.name })).toBeVisible();
    await page.getByRole("button", { name: /工作台概览/ }).click();
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2025年07月");
    await selectArcoOption(page, page.locator(".analytics-toolbar-card .analytics-scope-field .arco-select"), title);
    await page.locator(".section-radio-tabs").getByText("流程复盘").click();
    const durationCard = page.locator("section.card").filter({ hasText: "阶段耗时分析" });
    await expect(durationCard.locator(".analytics-scope-field .arco-select-view-value")).toContainText(title);
    await page.getByRole("button", { name: /职位管理/ }).click();
    await page.locator(".filter-tab").filter({ hasText: "已关闭" }).click();
    await page.locator(".job-card").filter({ hasText: title }).click();
    await page.getByRole("button", { name: "重新招聘" }).click();

    const reopenModal = page.getByRole("dialog", { name: "重新招聘" });
    await expect(reopenModal).toBeVisible();
    await reopenModal.getByPlaceholder("2026年07月").fill("2026年08月");
    await selectArcoOption(page, reopenModal.locator(".form-field").filter({ hasText: "需求类型" }).locator(".arco-select"), "计划外新增");
    await reopenModal.getByLabel("计划HC人数").fill("2");
    await reopenModal.getByRole("button", { name: "开启新批次" }).click();
    await expect(reopenModal).toBeHidden();
    await page.locator(".filter-tab").filter({ hasText: "招聘中" }).click();
    const reopenedJobCard = page.locator(".job-card").filter({ hasText: title });
    await expect(reopenedJobCard).toContainText("第2批");
    await expect(reopenedJobCard).toContainText("2026年08月");

    const secondRecommendation = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, {
      data: { jobId: job.id },
    });
    expect(secondRecommendation.ok(), await secondRecommendation.text()).toBeTruthy();
    const secondState = await secondRecommendation.json();
    const reopenedJob = secondState.jobs.find((item: { id: string }) => item.id === job.id);
    const jobCandidates = secondState.candidates[job.id];
    expect(reopenedJob.recruitmentBatches).toHaveLength(2);
    expect(reopenedJob.recruitmentBatches[0].demandType).toBe("离职替补");
    expect(reopenedJob.recruitmentBatches[1].demandType).toBe("计划外新增");
    expect(reopenedJob.recruitmentBatches[0].plannedHeadcount).toBe(3);
    expect(reopenedJob.recruitmentBatches[1].plannedHeadcount).toBe(2);
    expect(reopenedJob.plannedHeadcount).toBe(2);
    expect(reopenedJob.demandType).toBe("计划外新增");
    expect(reopenedJob.recruitmentBatches[0].profileSnapshot.description).toBe(originalDescription);
    expect(reopenedJob.recruitmentBatches[1].profileSnapshot.description).toBe(nextBatchDescription);
    expect(reopenedJob.recruitmentBatches[1].profileSnapshot.keywords).toBe(nextBatchKeywords);
    expect(jobCandidates).toHaveLength(2);
    const historicalCandidate = jobCandidates.find((candidate: { recruitmentBatchId: string }) => candidate.recruitmentBatchId === reopenedJob.recruitmentBatches[0].id);
    const currentBatchCandidates = jobCandidates.filter((candidate: { recruitmentBatchId: string }) => candidate.recruitmentBatchId === reopenedJob.currentBatchId);
    const currentBatchCandidate = currentBatchCandidates[0];
    expect(currentBatchCandidates).toHaveLength(1);
    expect(currentBatchCandidate.id).not.toBe(historicalCandidate.id);
    expect(currentBatchCandidate.reportMonth).toBe("2026年08月");
    expect(currentBatchCandidate.conclusion).toBe("待筛选");
    expect(currentBatchCandidate.keyPointAnalysis.some((item: { keyword: string }) => item.keyword === "战略升级")).toBeTruthy();
    expect(Object.fromEntries(currentBatchCandidate.evaluation.scoreDimensions.map((item: { key: string; weight: number }) => [item.key, item.weight]))).toEqual(nextBatchScoreWeights);

    const duplicateRecommendation = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, {
      data: { jobId: job.id },
    });
    expect(duplicateRecommendation.ok(), await duplicateRecommendation.text()).toBeTruthy();
    const duplicateState = await duplicateRecommendation.json();
    expect(duplicateState.candidates[job.id]).toHaveLength(2);

    await page.request.post("/api/current-job", { data: { jobId: job.id } });
    await page.reload();
    await page.getByRole("button", { name: /简历甄选/ }).click();
    await expect(page.locator(".candidate-list .candidate-card")).toHaveCount(1);
    await expect(page.locator(".candidate-list .candidate-card")).toContainText(sourceCandidate.name);

    await page.getByRole("button", { name: /面试管理/ }).click();
    await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(0), title);
    await expect(page.locator(".interview-table tbody tr")).toHaveCount(0);
    await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(1), "第1批");
    await expect(page.locator(".interview-table tbody tr").filter({ hasText: sourceCandidate.name })).toBeVisible();
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    if (jobId) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("编辑招聘月份立即同步当前批次已有候选人", async ({ page }) => {
  const initialState = await (await page.request.get("/api/state")).json();
  const job = initialState.jobs.find((item: { id: string }) => item.id === "job_001");
  const currentBatch = job.recruitmentBatches.find((batch: { id: string }) => batch.id === job.currentBatchId);
  const payload = {
    title: job.title,
    dept: job.dept,
    location: job.location,
    experience: job.experience,
    level: job.level,
    salaryRange: job.salaryRange,
    demandType: job.demandType,
    plannedHeadcount: job.plannedHeadcount,
    keywords: job.keywords,
    scoreWeights: job.scoreWeights,
    description: job.description,
    status: job.status,
  };

  try {
    const updateResponse = await page.request.put("/api/jobs/job_001", { data: { ...payload, targetMonth: "2032年01月" } });
    expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
    const updatedState = await updateResponse.json();
    const currentBatchCandidates = updatedState.candidates.job_001.filter((candidate: { recruitmentBatchId: string }) => candidate.recruitmentBatchId === job.currentBatchId);
    expect(currentBatchCandidates.length).toBeGreaterThan(0);
    expect(currentBatchCandidates.every((candidate: { reportMonth: string }) => candidate.reportMonth === "2032年01月")).toBeTruthy();
  } finally {
    const restoreResponse = await page.request.put("/api/jobs/job_001", { data: { ...payload, targetMonth: currentBatch.targetMonth } });
    expect(restoreResponse.ok(), await restoreResponse.text()).toBeTruthy();
  }
});

test("修改AI评分权重后自动刷新当前批次已有简历评分", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `权重重算测试岗位-${Date.now()}`;
  let jobId = "";

  try {
    const createResponse = await page.request.post("/api/jobs", {
      data: {
        title,
        dept: "评分测试部",
        location: "北京市",
        experience: "3-5年",
        level: "经理",
        salaryRange: "18k - 24k",
        demandType: "计划内新增",
        plannedHeadcount: 1,
        keywords: "招聘管理、业务协同、数据分析",
        scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
        description: "负责招聘管理、跨部门业务协同和招聘数据分析。",
        status: "招聘中",
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const createdState = await createResponse.json();
    const createdJob = createdState.jobs.find((job: { title: string }) => job.title === title);
    jobId = createdJob.id;

    const uploadResponse = await page.request.post(`/api/jobs/${jobId}/resumes`, {
      data: {
        duplicateAction: "skip",
        files: [{
          name: "权重重算候选人.pdf",
          candidateName: "权重重算候选人",
          source: "BOSS",
          resumeText: "本科，5年招聘经验，负责招聘流程与跨部门协同；能够完成招聘数据复盘，但业务经营结果经验较少。",
          type: "application/pdf",
          content_type: "application/pdf",
          size: 128,
        }],
      },
    });
    expect(uploadResponse.ok(), await uploadResponse.text()).toBeTruthy();
    const uploadedState = (await uploadResponse.json()).state;
    const originalCandidate = uploadedState.candidates[jobId][0];
    const originalDimensions = originalCandidate.evaluation.scoreDimensions as Array<{ key: string; weight: number; score: number }>;
    const targetDimension = [...originalDimensions]
      .sort((left, right) => Math.abs(right.score - originalCandidate.score) - Math.abs(left.score - originalCandidate.score))[0];
    expect(Math.abs(targetDimension.score - originalCandidate.score)).toBeGreaterThan(0);

    const nextWeights = {
      experience: 0,
      professional: 0,
      stability: 0,
      education: 0,
      business: 0,
      [targetDimension.key]: 100,
    };
    const updateResponse = await page.request.put(`/api/jobs/${jobId}`, {
      data: {
        title: createdJob.title,
        dept: createdJob.dept,
        location: createdJob.location,
        experience: createdJob.experience,
        level: createdJob.level,
        salaryRange: createdJob.salaryRange,
        demandType: createdJob.demandType,
        plannedHeadcount: createdJob.plannedHeadcount,
        keywords: createdJob.keywords,
        scoreWeights: nextWeights,
        description: createdJob.description,
        status: createdJob.status,
      },
    });
    expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
    const updatedState = await updateResponse.json();
    const updatedJob = updatedState.jobs.find((job: { id: string }) => job.id === jobId);
    const updatedCandidate = updatedState.candidates[jobId][0];
    const updatedDimensionWeights = Object.fromEntries(updatedCandidate.evaluation.scoreDimensions.map((dimension: { key: string; weight: number }) => [dimension.key, dimension.weight]));

    expect(updatedCandidate.score).toBe(targetDimension.score);
    expect(updatedCandidate.score).not.toBe(originalCandidate.score);
    expect(updatedDimensionWeights).toEqual(nextWeights);
    expect(updatedCandidate.evaluation.summary).toContain(`按最新岗位评分权重重新计算为 ${targetDimension.score} 分`);
    expect(updatedJob.recruitmentBatches.find((batch: { id: string }) => batch.id === updatedJob.currentBatchId).profileSnapshot.scoreWeights).toEqual(nextWeights);
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    if (jobId) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("同一招聘批次支持多HC并限制超额入职，工作台按批次月份汇总", async ({ page }) => {
  test.setTimeout(240_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidates = initialState.candidates.job_001.slice(0, 3) as Array<{ id: string }>;
  const title = `多HC测试岗位-${Date.now()}`;
  let jobId = "";

  try {
    const createResponse = await page.request.post("/api/jobs", {
      data: {
        title,
        dept: "HC测试部",
        location: "北京市 / 北京市 / 朝阳区",
        experience: "3-5年",
        level: "经理",
        salaryRange: "20k - 30k",
        demandType: "计划内新增",
        plannedHeadcount: 2,
        keywords: "HC管理、招聘交付",
        scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
        description: "用于验证同一招聘批次的多HC完成、增减与月度汇总。",
        status: "招聘中",
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const createdState = await createResponse.json();
    const job = createdState.jobs.find((item: { title: string }) => item.title === title);
    jobId = job.id;
    expect(job.location).toBe("北京市");
    expect(job.plannedHeadcount).toBe(2);
    expect(job.recruitmentBatches[0].plannedHeadcount).toBe(2);

    for (const sourceCandidate of sourceCandidates) {
      const response = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, { data: { jobId } });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    const targetCandidates = (await (await page.request.get("/api/state")).json()).candidates[jobId] as Array<{ id: string }>;
    expect(targetCandidates).toHaveLength(3);

    const targetMonth = job.recruitmentBatches[0].targetMonth;
    const monthMatch = targetMonth.match(/^(\d{4})年(\d{2})月$/)!;
    const offerSentAt = `${monthMatch[1]}-${monthMatch[2]}-08`;
    const plannedOnboardDate = `${monthMatch[1]}-${monthMatch[2]}-28`;
    const completeHeadcount = (candidateId: string, onboarded: "待入职" | "否" = "待入职") => page.request.patch(`/api/candidates/${candidateId}/interview-stage`, {
      data: {
        interviewStage: "offer",
        stageRecommendation: "是",
        interviewResult: "通过",
        onboarded,
        offerStatus: "已发出",
        plannedOnboardDate,
        reportMonth: targetMonth,
        interviewReason: "HC自动化验证",
        reasonTags: onboarded === "否" ? ["岗位调整"] : [],
        interviewTimeline: { offerSentAt, plannedOnboardDate },
      },
    });

    expect((await completeHeadcount(targetCandidates[0].id)).ok()).toBeTruthy();
    expect((await completeHeadcount(targetCandidates[1].id)).ok()).toBeTruthy();
    const overCapacityResponse = await completeHeadcount(targetCandidates[2].id);
    expect(overCapacityResponse.status()).toBe(400);
    expect(await overCapacityResponse.text()).toContain("已全部完成");

    expect((await completeHeadcount(targetCandidates[0].id, "否")).ok()).toBeTruthy();
    expect((await completeHeadcount(targetCandidates[2].id)).ok()).toBeTruthy();

    const currentState = await (await page.request.get("/api/state")).json();
    const currentJob = currentState.jobs.find((item: { id: string }) => item.id === jobId);
    const reduceResponse = await page.request.put(`/api/jobs/${jobId}`, {
      data: {
        title: currentJob.title,
        dept: currentJob.dept,
        location: currentJob.location,
        experience: currentJob.experience,
        level: currentJob.level,
        salaryRange: currentJob.salaryRange,
        demandType: currentJob.demandType,
        plannedHeadcount: 1,
        keywords: currentJob.keywords,
        scoreWeights: currentJob.scoreWeights,
        description: currentJob.description,
        status: currentJob.status,
      },
    });
    expect(reduceResponse.status()).toBe(400);
    expect(await reduceResponse.text()).toContain("不能低于已完成 HC 数");

    const increaseResponse = await page.request.put(`/api/jobs/${jobId}`, {
      data: {
        title: currentJob.title,
        dept: currentJob.dept,
        location: currentJob.location,
        experience: currentJob.experience,
        level: currentJob.level,
        salaryRange: currentJob.salaryRange,
        demandType: currentJob.demandType,
        plannedHeadcount: 3,
        keywords: currentJob.keywords,
        scoreWeights: currentJob.scoreWeights,
        description: currentJob.description,
        status: currentJob.status,
      },
    });
    expect(increaseResponse.ok(), await increaseResponse.text()).toBeTruthy();
    expect((await completeHeadcount(targetCandidates[0].id)).ok()).toBeTruthy();

    const repeatedMarkResponse = await page.request.post(`/api/candidates/${targetCandidates[0].id}/mark-interview`, { data: {} });
    expect(repeatedMarkResponse.ok(), await repeatedMarkResponse.text()).toBeTruthy();
    const repeatedMarkState = await repeatedMarkResponse.json();
    const repeatedMarkCandidate = repeatedMarkState.candidates[jobId].find((candidate: { id: string }) => candidate.id === targetCandidates[0].id);
    expect(repeatedMarkCandidate.interviewStage).toBe("offer");
    expect(repeatedMarkCandidate.onboarded).toBe("待入职");
    expect(repeatedMarkCandidate.interviewTimeline.offerSentAt).toBe(offerSentAt);

    const finalState = await (await page.request.get("/api/state")).json();
    const matchingBatches = finalState.jobs.flatMap((item: { id: string; recruitmentBatches: Array<{ id: string; targetMonth: string; plannedHeadcount: number }> }) =>
      item.recruitmentBatches.filter((batch) => batch.targetMonth === targetMonth).map((batch) => ({ ...batch, jobId: item.id })),
    );
    const expectedPlanned = matchingBatches.reduce((sum: number, batch: { plannedHeadcount: number }) => sum + batch.plannedHeadcount, 0);
    const expectedCompleted = matchingBatches.reduce((sum: number, batch: { id: string; jobId: string }) => sum + (finalState.candidates[batch.jobId] || []).filter((candidate: { recruitmentBatchId: string; onboarded: string; interviewTimeline?: { offerSentAt?: string } }) => candidate.recruitmentBatchId === batch.id && Boolean(candidate.interviewTimeline?.offerSentAt) && candidate.onboarded !== "否").length, 0);

    await page.goto("/");
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), targetMonth);
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "计划 HC" }).locator(".dashboard-summary-value")).toHaveText(String(expectedPlanned));
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "当期发出 Offer" }).locator(".dashboard-summary-value")).toHaveText(String(expectedCompleted));

    await page.locator(".section-radio-tabs").getByText("流程复盘").click();
    const departmentRow = page.locator('.department-hc-table tbody tr[data-department="HC测试部"]');
    await expect(departmentRow).toBeVisible();
    await expect(departmentRow.locator('td[data-column="计划 HC"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="计划内新增"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="复试通过"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="待入职"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="HC完成"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="剩余 HC"]')).toHaveText("0");
    await expect(departmentRow.locator('td[data-column="完成率"]')).toContainText("100%");
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    if (jobId) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("复试通过后可记录不发Offer且不占用HC", async ({ page }) => {
  test.setTimeout(180_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidate = initialState.candidates.job_001[0] as { id: string };
  const title = `Offer决策测试岗位-${Date.now()}`;
  const department = `Offer决策测试部-${Date.now()}`;
  const targetMonth = "2032年04月";
  let jobId = "";

  try {
    const payload = {
      title,
      dept: department,
      location: "北京市",
      experience: "3-5年",
      level: "经理",
      salaryRange: "20k - 30k",
      demandType: "计划内新增" as const,
      plannedHeadcount: 1,
      keywords: "Offer决策、部门对比",
      scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
      description: "用于验证复试通过但部门对比后不发Offer的流程与统计。",
      status: "招聘中" as const,
    };
    const createResponse = await page.request.post("/api/jobs", { data: payload });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const createdState = await createResponse.json();
    const createdJob = createdState.jobs.find((job: { title: string }) => job.title === title);
    jobId = createdJob.id;

    const updateResponse = await page.request.put(`/api/jobs/${jobId}`, { data: { ...payload, targetMonth } });
    expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
    const recommendResponse = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, { data: { jobId } });
    expect(recommendResponse.ok(), await recommendResponse.text()).toBeTruthy();
    const recommendedState = await recommendResponse.json();
    const candidate = recommendedState.candidates[jobId][0] as { id: string };

    const noOfferPayload = {
      interviewStage: "offer",
      stageRecommendation: "是",
      interviewResult: "通过",
      onboarded: "是",
      offerStatus: "不发出",
      plannedOnboardDate: "2032-05-01",
      reportMonth: targetMonth,
      interviewReason: "复试通过，但部门对比后本次不发出Offer",
      reasonTags: [] as string[],
      interviewTimeline: {
        recommendedAt: "2032-04-01",
        firstInterviewAt: "2032-04-05",
        firstInterviewPassedAt: "2032-04-05",
        secondInterviewAt: "2032-04-12",
        secondInterviewPassedAt: "2032-04-12",
        offerDecisionAt: "2032-04-18",
        offerSentAt: "2032-04-15",
        plannedOnboardDate: "2032-05-01",
        onboardedAt: "2032-05-01",
      },
    };
    const missingReasonResponse = await page.request.patch(`/api/candidates/${candidate.id}/interview-stage`, { data: noOfferPayload });
    expect(missingReasonResponse.status()).toBe(400);
    expect(await missingReasonResponse.text()).toContain("请选择原因标签");

    const saveResponse = await page.request.patch(`/api/candidates/${candidate.id}/interview-stage`, {
      data: { ...noOfferPayload, reasonTags: ["部门对比"] },
    });
    expect(saveResponse.ok(), await saveResponse.text()).toBeTruthy();
    const savedState = await saveResponse.json();
    const savedCandidate = savedState.candidates[jobId].find((item: { id: string }) => item.id === candidate.id);
    expect(savedCandidate.onboarded).toBe("待入职");
    expect(savedCandidate.reasonTags).toEqual(["部门对比"]);
    expect(savedCandidate.interviewTimeline).toMatchObject({
      secondInterviewPassedAt: "2032-04-12",
      offerDecision: "不发出",
      offerDecisionAt: "2032-04-18",
      offerSentAt: "",
    });
    expect(savedCandidate.interviewTimeline).not.toHaveProperty("offerAt");
    expect(savedCandidate.interviewTimeline).not.toHaveProperty("plannedOnboardDate");
    expect(savedCandidate.interviewTimeline).not.toHaveProperty("onboardedAt");

    await page.goto("/");
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), targetMonth);
    await page.locator(".section-radio-tabs").getByText("流程复盘").click();
    const headcountRow = page.locator(`.department-hc-table tbody tr[data-department="${department}"]`);
    await expect(headcountRow.locator('td[data-column="复试通过"]')).toHaveText("1");
    await expect(headcountRow.locator('td[data-column="待入职"]')).toHaveText("0");
    await expect(headcountRow.locator('td[data-column="HC完成"]')).toHaveText("0");
    const channelCard = page.locator(".analytics-channel-card").filter({ has: page.locator(".analytics-channel-head > strong", { hasText: "其他" }) });
    await expect(channelCard.locator(".analytics-channel-metrics > div").filter({ hasText: "offer" }).locator("strong")).toHaveText("0");

    await page.locator(".section-radio-tabs").getByText("职位分析").click();
    const reasonHeaders = await page.locator(".pending-onboard-table thead th").allTextContents();
    const departmentReasonColumn = reasonHeaders.findIndex((label) => label.trim() === "部门对比");
    expect(departmentReasonColumn).toBeGreaterThan(0);
    const reasonRow = page.locator(".pending-onboard-table tbody tr").filter({ hasText: department });
    await expect(reasonRow.locator("td").nth(departmentReasonColumn)).toHaveText("1");
    await expect(reasonRow.locator("td").nth(reasonHeaders.findIndex((label) => label.trim() === "待入职"))).toHaveText("0");

    await page.locator(".section-radio-tabs").getByText("问题与行动").click();
    await expect(page.locator(".analytics-issue-stats > div").filter({ hasText: "待入职" }).locator("strong")).toHaveText("0");
    await expect(page.locator(".analytics-review-board .analytics-tag-list")).toContainText("部门对比 · 1");

    const addToTalentPoolResponse = await page.request.post(`/api/candidates/${candidate.id}/talent-pool`, { data: {} });
    expect(addToTalentPoolResponse.ok(), await addToTalentPoolResponse.text()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: /人才库/ }).click();
    const talentRow = page.locator(".talent-table tbody tr").filter({ hasText: department });
    await expect(talentRow.locator(".talent-outcome-trigger")).toContainText("可重新推荐");
    await expect(talentRow.locator(".talent-stage-tag")).toHaveText("复试通过 · 未发Offer");
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    if (jobId) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("招聘概览区分本期HC、跨期Offer和历史缺口", async ({ page }) => {
  test.setTimeout(240_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidates = initialState.candidates.job_001.slice(0, 3) as Array<{ id: string }>;
  const createdJobIds: string[] = [];

  const createJob = async (title: string, targetMonth: string, plannedHeadcount: number) => {
    const payload = {
      title,
      dept: "跨期HC测试部",
      location: "北京市",
      experience: "3-5年",
      level: "经理",
      salaryRange: "20k - 30k",
      demandType: "计划内新增" as const,
      plannedHeadcount,
      keywords: "跨期HC、招聘交付",
      scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
      description: "用于验证跨月招聘需求、Offer发生量与HC完成率分开统计。",
      status: "招聘中" as const,
    };
    const createResponse = await page.request.post("/api/jobs", { data: payload });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const createdState = await createResponse.json();
    const createdJob = createdState.jobs.find((job: { title: string }) => job.title === title);
    createdJobIds.push(createdJob.id);
    const updateResponse = await page.request.put(`/api/jobs/${createdJob.id}`, { data: { ...payload, targetMonth } });
    expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();
    const updatedState = await updateResponse.json();
    return updatedState.jobs.find((job: { id: string }) => job.id === createdJob.id);
  };

  try {
    expect(sourceCandidates).toHaveLength(3);
    const currentJob = await createJob(`2031年9月HC-${Date.now()}`, "2031年09月", 2);
    const carryoverJob = await createJob(`2031年7月HC-${Date.now()}`, "2031年07月", 2);

    for (const sourceCandidate of sourceCandidates.slice(0, 2)) {
      const response = await page.request.post(`/api/candidates/${sourceCandidate.id}/recommend-to-job`, { data: { jobId: currentJob.id } });
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    const carryoverResponse = await page.request.post(`/api/candidates/${sourceCandidates[2].id}/recommend-to-job`, { data: { jobId: carryoverJob.id } });
    expect(carryoverResponse.ok(), await carryoverResponse.text()).toBeTruthy();

    const stateWithCandidates = await (await page.request.get("/api/state")).json();
    const currentCandidates = stateWithCandidates.candidates[currentJob.id] as Array<{ id: string }>;
    const carryoverCandidate = stateWithCandidates.candidates[carryoverJob.id][0] as { id: string };
    const sendOffer = (candidateId: string) => page.request.patch(`/api/candidates/${candidateId}/interview-stage`, {
      data: {
        interviewStage: "offer",
        stageRecommendation: "是",
        interviewResult: "通过",
        onboarded: "待入职",
        offerStatus: "已发出",
        plannedOnboardDate: "2031-10-01",
        reportMonth: "2031年09月",
        interviewReason: "跨期HC统计验证",
        reasonTags: [],
        interviewTimeline: { offerSentAt: "2031-09-10", plannedOnboardDate: "2031-10-01" },
      },
    });

    for (const candidate of currentCandidates) {
      const response = await sendOffer(candidate.id);
      expect(response.ok(), await response.text()).toBeTruthy();
    }
    const carryoverOfferResponse = await sendOffer(carryoverCandidate.id);
    expect(carryoverOfferResponse.ok(), await carryoverOfferResponse.text()).toBeTruthy();
    const carryoverOfferState = await carryoverOfferResponse.json();
    expect(carryoverOfferState.candidates[carryoverJob.id][0].reportMonth).toBe("2031年07月");
    const expectedOverdue = carryoverOfferState.jobs.flatMap((job: { id: string; recruitmentBatches: Array<{ id: string; targetMonth: string; plannedHeadcount: number }> }) =>
      job.recruitmentBatches.filter((batch) => batch.targetMonth < "2031年09月").map((batch) => {
        const completed = (carryoverOfferState.candidates[job.id] || []).filter((candidate: { recruitmentBatchId: string; onboarded: string; interviewTimeline?: { offerAt?: string; offerSentAt?: string } }) =>
          candidate.recruitmentBatchId === batch.id
          && Boolean(candidate.interviewTimeline?.offerSentAt || candidate.interviewTimeline?.offerAt)
          && candidate.onboarded !== "否").length;
        return Math.max(batch.plannedHeadcount - completed, 0);
      })).reduce((sum: number, value: number) => sum + value, 0);
    expect(expectedOverdue).toBeGreaterThanOrEqual(1);

    await page.goto("/");
    await page.locator(".dashboard-global-filters .arco-select .arco-select-view").click();
    await expect(page.locator(".arco-select-popup:visible .arco-select-option").filter({ hasText: "2031年10月" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2031年09月");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "本期计划 HC" }).locator(".dashboard-summary-value")).toHaveText("2");
    const offerCard = page.locator(".dashboard-summary-card").filter({ hasText: "当期发出 Offer" });
    await expect(offerCard.locator(".dashboard-summary-value")).toHaveText("3");
    await expect(offerCard).toContainText("本期需求 2 · 跨期需求 1");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "跨期未完成 HC" }).locator(".dashboard-summary-value")).toHaveText(String(expectedOverdue));
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "本期未完成 HC" }).locator(".dashboard-summary-value")).toHaveText("0");
    await expect(page.getByLabel("HC完成率100.00%")).toBeVisible();

    await page.getByRole("button", { name: "季度数据" }).click();
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2031年Q3");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "本期计划 HC" }).locator(".dashboard-summary-value")).toHaveText("4");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "当期发出 Offer" }).locator(".dashboard-summary-value")).toHaveText("3");
    await expect(page.getByLabel("HC完成率75.00%")).toBeVisible();

    await page.getByRole("button", { name: "年数据" }).click();
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2031年");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "本期计划 HC" }).locator(".dashboard-summary-value")).toHaveText("4");
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "当期发出 Offer" }).locator(".dashboard-summary-value")).toHaveText("3");
    await expect(page.getByLabel("HC完成率75.00%")).toBeVisible();

    const finalizeOffer = (candidateId: string, onboarded: "是" | "否", onboardedAt = "") => page.request.patch(`/api/candidates/${candidateId}/interview-stage`, {
      data: {
        interviewStage: "offer",
        stageRecommendation: "是",
        interviewResult: "通过",
        onboarded,
        offerStatus: "已发出",
        plannedOnboardDate: "2031-10-01",
        reportMonth: "2031年09月",
        interviewReason: onboarded === "否" ? "发展不符合预期" : "已确认入职",
        reasonTags: onboarded === "否" ? ["发展不符合预期"] : [],
        interviewTimeline: {
          offerSentAt: "2031-09-10",
          plannedOnboardDate: "2031-10-01",
          ...(onboardedAt ? { onboardedAt } : {}),
        },
      },
    });
    expect((await finalizeOffer(currentCandidates[0].id, "是", "2031-10-05")).ok()).toBeTruthy();
    expect((await finalizeOffer(currentCandidates[1].id, "否")).ok()).toBeTruthy();

    await page.reload();
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2031年09月");
    await expect(page.locator(".analytics-comparison-card").filter({ hasText: "Offer后入职率" }).locator("strong")).toHaveText("33.3%");
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    for (const jobId of createdJobIds) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("小松鼠主流程无控制台错误，并可标记面试进入初试", async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));

  await page.goto("/");
  await expect(page.getByRole("button", { name: /简历甄选/ })).toBeVisible();

  await page.getByRole("button", { name: /简历甄选/ }).click();
  await expect(page.getByRole("heading", { name: "简历甄选", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "标记面试" }).click();
  await expect(page.getByRole("heading", { name: "面试管理", exact: true })).toBeVisible();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "推荐" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "阶段日期" })).toBeVisible();
  await page.getByLabel("推荐日期").fill("2026-07-02");
  await page.locator(".interview-remark").first().fill("推荐部门继续评估，重点确认业务落地经验。");
  await page.getByRole("button", { name: "保存" }).first().click();

  const interviewMonthFilter = page.locator(".interview-filter-field .arco-select").nth(2);
  await selectArcoOption(page, interviewMonthFilter, "2026年08月");
  await expect(page.locator(".interview-table tbody tr").first()).toContainText("跨月进行中 · 始于2026年07月");
  await selectArcoOption(page, interviewMonthFilter, "全部");
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "是");
  await page.getByRole("button", { name: "保存" }).first().click();

  await page.locator(".stage-filter", { hasText: "初试" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "初试" })).toBeVisible();
  const recommendedRemark = await page.locator(".interview-remark").first().inputValue();
  expect(recommendedRemark).toContain("【2026-07-02｜推荐】\n推荐部门继续评估，重点确认业务落地经验。");

  await page.getByLabel("初试日期").fill("2026-07-14");
  await page.locator(".interview-remark").first().fill(`${recommendedRemark}\n初试沟通表达清晰，专业基础符合要求。`);
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "推荐" }).click();
  await page.locator(".stage-filter", { hasText: "初试" }).click();
  await expect(page.getByLabel("初试日期")).toHaveValue("2026-07-14");

  await selectArcoOption(page, page.locator(".recommendation-select").first(), "未到面");
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.getByRole("button", { name: /工作台概览/ }).click();
  await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2026年07月");
  await page.locator(".section-radio-tabs").getByText("流程复盘").click();
  const noShowFirstInterviewRow = page.locator(".analytics-funnel-table tbody tr").filter({ hasText: "实际参加初试人数" });
  await expect(noShowFirstInterviewRow.locator("td").nth(1)).toHaveText("0");
  await page.getByRole("button", { name: "面试管理", exact: true }).click();

  await page.getByLabel("初试日期").fill("2026-07-15");
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "通过");
  const firstInterviewRemark = await page.locator(".interview-remark").first().inputValue();
  await page.locator(".interview-remark").first().fill(`${firstInterviewRemark}\n补充核验后通过初试，复试关注团队管理跨度。`);
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "复试" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "复试" })).toBeVisible();
  await page.getByLabel("复试日期").fill("2026-08-02");
  await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(0), "全部");
  await expect(page.getByRole("columnheader", { name: "岗位" })).toBeVisible();

  await selectArcoOption(page, page.locator(".recommendation-select").first(), "通过");
  const secondInterviewRemark = await page.locator(".interview-remark").first().inputValue();
  await page.locator(".interview-remark").first().fill(`${secondInterviewRemark}\n复试认可专业能力，建议进入Offer决策。`);
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "offer" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "offer" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Offer状态" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "计划到岗" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "入职状态" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "入职日期 / 未入职原因" })).toBeVisible();
  await expect(page.getByLabel("计划到岗日期")).toBeDisabled();
  const offerRow = page.locator(".interview-table tbody tr").first();
  await selectArcoOption(page, offerRow.locator(".offer-status-select"), "不发出");
  await expect(offerRow.getByLabel("计划到岗日期")).toHaveCount(0);
  await expect(offerRow).toContainText("本次不发出 Offer");
  await expect(offerRow.locator(".interview-actions .btn").first()).toBeDisabled();
  await selectArcoOption(page, offerRow.locator(".reason-tags-select"), "部门对比");
  await page.keyboard.press("Escape");
  await expect(offerRow.locator(".interview-actions .btn").first()).toBeEnabled();
  await selectArcoOption(page, page.locator(".offer-status-select").first(), "已发出");
  await page.getByLabel("offer日期").fill("2026-08-05");
  await page.getByLabel("计划到岗日期").fill("2026-08-20");
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "是");
  await expect(page.getByLabel("实际入职日期")).toBeVisible();
  await page.getByLabel("实际入职日期").fill("2026-08-25");
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "否");
  await expect(page.locator(".interview-table tbody tr").first().locator(".reason-tags-select")).toBeVisible();
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "待入职");
  await expect(page.getByLabel("实际入职日期")).toHaveCount(0);
  await expect(page.locator(".interview-table tbody tr").first()).toContainText("确认入职后填写实际日期");
  await expect(page.locator(".interview-table tbody tr").first().locator(".reason-tags-select")).toHaveCount(0);
  const offerRemark = await offerRow.locator(".interview-remark").inputValue();
  await offerRow.locator(".interview-remark").fill(`${offerRemark}\nOffer方案已确认，等待候选人按计划到岗。`);
  await page.getByRole("button", { name: "保存" }).first().click();

  const savedState = await (await page.request.get("/api/state")).json();
  const savedCandidate = Object.values(savedState.candidates).flat().find((candidate: any) => candidate.interviewTimeline?.offerSentAt === "2026-08-05") as any;
  expect(savedCandidate).toBeTruthy();
  expect(savedCandidate.interviewTimeline).toMatchObject({
    recommendedAt: "2026-07-02",
    firstInterviewAt: "2026-07-15",
    firstInterviewPassedAt: "2026-07-15",
    secondInterviewAt: "2026-08-02",
    secondInterviewPassedAt: "2026-08-02",
    offerSentAt: "2026-08-05",
    plannedOnboardDate: "2026-08-20",
  });
  expect(savedCandidate.onboarded).toBe("待入职");
  expect(savedCandidate.interviewReason).toContain("【2026-07-02｜推荐】\n推荐部门继续评估，重点确认业务落地经验。");
  expect(savedCandidate.interviewReason).toContain("【2026-07-14｜初试】\n初试沟通表达清晰，专业基础符合要求。");
  expect(savedCandidate.interviewReason).toContain("【2026-07-15｜初试】\n补充核验后通过初试，复试关注团队管理跨度。");
  expect(savedCandidate.interviewReason).toContain("【2026-08-02｜复试】\n复试认可专业能力，建议进入Offer决策。");
  expect(savedCandidate.interviewReason).toContain("【2026-08-05｜Offer】\nOffer方案已确认，等待候选人按计划到岗。");
  expect(savedCandidate.interviewReason.match(/【2026-07-14｜初试】/g)).toHaveLength(1);

  await page.getByRole("button", { name: /工作台概览/ }).click();
  await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2026年07月");
  await page.locator(".section-radio-tabs").getByText("流程复盘").click();
  const julyFirstInterviewRow = page.locator(".analytics-funnel-table tbody tr").filter({ hasText: "实际参加初试人数" });
  await expect(julyFirstInterviewRow.locator("td").nth(1)).not.toHaveText("0");

  await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), "2026年08月");
  await page.locator(".section-radio-tabs").getByText("招聘概览").click();
  await expect(page.locator(".dashboard-summary-card").filter({ hasText: "当期发出 Offer" }).locator(".dashboard-summary-value")).not.toHaveText("0");
  await page.locator(".section-radio-tabs").getByText("职位分析").click();
  await expect(page.locator(".pending-onboard-table").getByRole("columnheader", { name: "待入职" })).toBeVisible();
  const pendingReasonHeaders = await page.locator(".pending-onboard-table thead th").allTextContents();
  const pendingOnboardColumn = pendingReasonHeaders.findIndex((label) => label.trim() === "待入职");
  expect(pendingOnboardColumn).toBeGreaterThan(0);
  await expect(page.locator(".pending-onboard-table tfoot td").nth(pendingOnboardColumn)).not.toHaveText("0");

  await page.getByRole("button", { name: "面试管理", exact: true }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "offer" })).toBeVisible();
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "是");
  await page.getByLabel("实际入职日期").fill("2026-08-25");
  await page.getByRole("button", { name: "保存" }).first().click();
  const onboardedState = await (await page.request.get("/api/state")).json();
  const onboardedCandidate = Object.values(onboardedState.candidates).flat().find((candidate: any) => candidate.id === savedCandidate.id) as any;
  expect(onboardedCandidate.onboarded).toBe("是");
  expect(onboardedCandidate.interviewTimeline.onboardedAt).toBe("2026-08-25");
  expect(onboardedCandidate.reasonTags).toEqual([]);

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("访音解析可根据补充备注生成实时建议", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));

  await page.goto("/");
  await page.getByRole("button", { name: /访音解析/ }).click();
  await expect(page.getByRole("heading", { name: "访音解析", exact: true, level: 2 })).toBeVisible();

  await selectArcoOption(page, page.locator(".voice-form .arco-select").nth(0), /^HRBP/);
  await selectArcoOption(page, page.locator(".voice-form .arco-select").nth(1), /^赖雯/);
  const notes = page.getByPlaceholder(/可手动补充候选人未被准确识别的关键信息/);
  await notes.fill("候选人提到自己负责招聘与绩效推进，也做过跨团队协同和复盘，对到岗时间、薪资和动机都能明确回应。");

  await expect(page.locator(".voice-analysis-panel")).toContainText("建议推进");
  await expect(page.locator(".voice-analysis-panel")).toContainText("匹配建议");
  await expect(page.locator(".voice-analysis-panel")).toContainText("招聘者建议");

  await notes.fill("候选人多次表示不太清楚、可能再说，对离职动机和稳定性回答不确定。");
  await expect(page.locator(".voice-analysis-panel")).toContainText(/建议复核|暂缓推进/);

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("访音解析左右区域可独立滚动", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto("/");
  await page.getByRole("button", { name: /访音解析/ }).click();
  await expect(page.getByRole("heading", { name: "访音解析", exact: true, level: 2 })).toBeVisible();

  await selectArcoOption(page, page.locator(".voice-form .arco-select").nth(0), /^HRBP/);
  await selectArcoOption(page, page.locator(".voice-form .arco-select").nth(1), /^赖雯/);
  const associationFields = page.locator(".voice-form > .job-switcher");
  const jobFieldBox = await associationFields.nth(0).boundingBox();
  const candidateFieldBox = await associationFields.nth(1).boundingBox();
  expect(jobFieldBox).not.toBeNull();
  expect(candidateFieldBox).not.toBeNull();
  expect(Math.abs(jobFieldBox!.width - candidateFieldBox!.width)).toBeLessThanOrEqual(2);
  expect(candidateFieldBox!.y).toBeGreaterThan(jobFieldBox!.y + jobFieldBox!.height - 1);
  await page.getByPlaceholder(/可手动补充候选人未被准确识别的关键信息/).fill(
    "候选人负责招聘、绩效和组织发展推进，能讲清业务背景、关键动作和结果。".repeat(8),
  );
  await expect(page.locator(".voice-analysis-panel")).toContainText("候选人评估");

  const scrollState = await page.evaluate(() => {
    const workbench = document.querySelector(".voice-workbench") as HTMLElement | null;
    const analysis = document.querySelector(".voice-analysis-panel") as HTMLElement | null;
    if (!workbench || !analysis) return null;
    const initialWindowScrollY = window.scrollY;
    workbench.scrollTop = 160;
    analysis.scrollTop = 180;
    return {
      initialWindowScrollY,
      windowScrollY: window.scrollY,
      workbench: {
        overflowY: getComputedStyle(workbench).overflowY,
        scrollTop: workbench.scrollTop,
        scrollHeight: workbench.scrollHeight,
        clientHeight: workbench.clientHeight,
      },
      analysis: {
        overflowY: getComputedStyle(analysis).overflowY,
        scrollTop: analysis.scrollTop,
        scrollHeight: analysis.scrollHeight,
        clientHeight: analysis.clientHeight,
      },
    };
  });

  expect(scrollState).not.toBeNull();
  expect(scrollState!.windowScrollY).toBe(scrollState!.initialWindowScrollY);
  expect(scrollState!.workbench.overflowY).toBe("auto");
  expect(scrollState!.analysis.overflowY).toBe("auto");
  expect(scrollState!.workbench.scrollHeight).toBeGreaterThan(scrollState!.workbench.clientHeight);
  expect(scrollState!.analysis.scrollHeight).toBeGreaterThan(scrollState!.analysis.clientHeight);
  expect(scrollState!.workbench.scrollTop).toBeGreaterThan(0);
  expect(scrollState!.analysis.scrollTop).toBeGreaterThan(0);
});

test("简历甄选左右区域可独立滚动", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await expect(page.getByRole("heading", { name: "简历甄选", exact: true })).toBeVisible();

  const listPane = page.locator(".candidate-layout > .card").first();
  const detailPane = page.locator(".candidate-detail-card");
  await expect(listPane).toBeVisible();
  await expect(detailPane).toBeVisible();

  const scrollState = await page.evaluate(() => {
    const list = document.querySelector(".candidate-layout > .card") as HTMLElement | null;
    const detail = document.querySelector(".candidate-detail-card") as HTMLElement | null;
    if (!list || !detail) return null;
    const initialWindowScrollY = window.scrollY;
    list.scrollTop = 120;
    detail.scrollTop = 160;
    return {
      initialWindowScrollY,
      windowScrollY: window.scrollY,
      list: {
        overflowY: getComputedStyle(list).overflowY,
        scrollTop: list.scrollTop,
        scrollHeight: list.scrollHeight,
        clientHeight: list.clientHeight,
      },
      detail: {
        overflowY: getComputedStyle(detail).overflowY,
        scrollTop: detail.scrollTop,
        scrollHeight: detail.scrollHeight,
        clientHeight: detail.clientHeight,
      },
    };
  });

  expect(scrollState).not.toBeNull();
  expect(scrollState!.windowScrollY).toBe(scrollState!.initialWindowScrollY);
  expect(scrollState!.list.overflowY).toBe("auto");
  expect(scrollState!.detail.overflowY).toBe("auto");
  expect(scrollState!.list.scrollHeight).toBeGreaterThan(scrollState!.list.clientHeight);
  expect(scrollState!.detail.scrollHeight).toBeGreaterThan(scrollState!.detail.clientHeight);
  expect(scrollState!.list.scrollTop).toBeGreaterThan(0);
  expect(scrollState!.detail.scrollTop).toBeGreaterThan(0);
});

test("简历甄选移除已入库人选后仍保留人才档案", async ({ page }) => {
  const candidateId = "c5";
  const candidateName = "宋天宇";

  const archiveResponse = await page.request.post(`/api/candidates/${candidateId}/talent-pool`, { data: {} });
  expect(archiveResponse.ok()).toBeTruthy();

  const removeResponse = await page.request.delete(`/api/candidates/${candidateId}`);
  expect(removeResponse.ok()).toBeTruthy();

  const state = await (await page.request.get("/api/state")).json();
  const archivedCandidate = state.candidates.job_001.find((candidate: { id: string }) => candidate.id === candidateId);
  expect(archivedCandidate).toMatchObject({
    id: candidateId,
    isInTalentPool: true,
    removedFromScreening: true,
  });
  expect(archivedCandidate.resumeText).toContain("招聘经验");

  await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await expect(page.locator(".candidate-card").filter({ hasText: candidateName })).toHaveCount(0);

  await page.getByRole("button", { name: "人才库", exact: true }).click();
  const talentRow = page.locator(".talent-table tbody tr").filter({ hasText: candidateName });
  await expect(talentRow).toBeVisible();
  await expect(talentRow).toContainText("可重新推荐");
  await expect(talentRow).toContainText("未进入流程");
});

test("简历服务返回 HTML 错误页时显示友好提示", async ({ page }) => {
  await page.route("**/api/files/upload", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "file_e2e_overload",
        name: "批量上传测试.pdf",
        size: 24,
        content_type: "application/pdf",
        bucket: "e2e",
        object_key: "resume/e2e/批量上传测试.pdf",
        url: null,
        view_url: null,
      }),
    });
  });
  await page.route("**/api/resumes/parse", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body><h1>Bad Gateway</h1></body></html>",
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await page.getByRole("button", { name: "批量上传简历" }).click();
  const modal = page.getByRole("dialog", { name: "批量上传简历" });
  await modal.locator('input[type="file"]').setInputFiles({
    name: "批量上传测试.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n"),
  });

  const failedCard = modal.locator(".resume-parse-card.error");
  await expect(failedCard).toContainText("哎呀，服务器挤爆啦，请稍后重试。");
  await expect(modal).not.toContainText("Bad Gateway");
  await expect(modal).not.toContainText("Unexpected token");
});

test("单次选择超过五份简历时仍可排队上传解析", async ({ page }) => {
  let uploadRequests = 0;
  let parseRequests = 0;
  await page.route("**/api/files/upload", async (route) => {
    uploadRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: `file_e2e_queue_${uploadRequests}`,
        name: `候选人${uploadRequests}.pdf`,
        size: 24,
        content_type: "application/pdf",
        bucket: "e2e",
        object_key: `resume/e2e/候选人${uploadRequests}.pdf`,
        url: null,
        view_url: null,
      }),
    });
  });
  await page.route("**/api/resumes/parse", async (route) => {
    parseRequests += 1;
    const payload = route.request().postDataJSON() as { files: Array<Record<string, unknown>> };
    const file = payload.files[0];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        resumes: [{
          file,
          candidateName: `候选人${parseRequests}`,
          source: "BOSS",
          resumeText: `候选人${parseRequests}，招聘管理经验。`,
          extractionMethod: "pdf",
          warnings: [],
        }],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await page.getByRole("button", { name: "批量上传简历" }).click();
  const modal = page.getByRole("dialog", { name: "批量上传简历" });
  await modal.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 6 }, (_, index) => ({
      name: `候选人${index + 1}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    })),
  );

  await expect(modal.locator(".resume-parse-card")).toHaveCount(6);
  await expect.poll(() => uploadRequests).toBe(6);
  await expect.poll(() => parseRequests).toBe(6);
  await expect(modal.locator(".resume-parse-card.ready")).toHaveCount(6);
  await expect(modal.locator(".tool-error")).toHaveCount(0);
});

test("AI 入库返回 HTML 后自动回查已生成结果", async ({ page }) => {
  const initialState = await (await page.request.get("/api/state")).json();
  const jobId = initialState.currentJobId as string;
  const objectKey = "resume/e2e/ai-result-reconcile.pdf";
  let returnCommittedState = false;
  let stateChecksAfterError = 0;

  await page.route("**/api/state", async (route) => {
    if (!returnCommittedState) {
      await route.continue();
      return;
    }
    stateChecksAfterError += 1;
    const templateCandidate = initialState.candidates[jobId][0];
    const committedCandidate = {
      ...templateCandidate,
      id: "candidate_e2e_reconciled",
      name: "AI回查候选人",
      source: "BOSS · AI回查候选人.pdf",
      fileName: "AI回查候选人.pdf",
      fileType: "application/pdf",
      fileSize: 24,
      fileObjectKey: objectKey,
      resumeText: "AI回查候选人，8年招聘管理经验。",
      removedFromScreening: false,
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...initialState,
        candidates: {
          ...initialState.candidates,
          [jobId]: [...initialState.candidates[jobId], committedCandidate],
        },
      }),
    });
  });
  await page.route("**/api/files/upload", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "file_e2e_reconciled",
        name: "AI回查候选人.pdf",
        size: 24,
        content_type: "application/pdf",
        bucket: "e2e",
        object_key: objectKey,
        url: null,
        view_url: null,
      }),
    });
  });
  await page.route("**/api/resumes/parse", async (route) => {
    const payload = route.request().postDataJSON() as { files: Array<Record<string, unknown>> };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        resumes: [{
          file: payload.files[0],
          candidateName: "AI回查候选人",
          source: "BOSS",
          resumeText: "AI回查候选人，8年招聘管理经验。",
          extractionMethod: "pdf",
          warnings: [],
        }],
      }),
    });
  });
  await page.route("**/api/jobs/*/resumes", async (route) => {
    returnCommittedState = true;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>upstream timeout</body></html>",
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await page.getByRole("button", { name: "批量上传简历" }).click();
  const modal = page.getByRole("dialog", { name: "批量上传简历" });
  await modal.locator('input[type="file"]').setInputFiles({
    name: "AI回查候选人.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n"),
  });
  await expect(modal.locator(".resume-parse-card.ready")).toBeVisible();
  await modal.getByRole("button", { name: "分析并生成候选人" }).click();

  await expect(modal).toBeHidden();
  await expect(page.locator(".toast")).toContainText("简历分析完成");
  expect(stateChecksAfterError).toBeGreaterThan(0);
});

test("批量简历上传仅允许 PDF、DOC、DOCX，并用解析结果生成多名候选人", async ({ page }) => {
  const rejectedResponse = await page.request.post("/api/files/upload", {
    multipart: {
      scene: "resume",
      file: {
        name: "候选人.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("这是一份文本简历"),
      },
    },
  });
  expect(rejectedResponse.status()).toBe(400);
  expect(await rejectedResponse.text()).toContain("简历文件仅支持 PDF、DOC、DOCX");

  let uploadRequests = 0;
  let parseRequests = 0;
  const uploadedFiles = [
    {
      id: "file_e2e_resume_songle",
      name: "宋乐-前端高级工程师-BOSS.pdf",
      size: 24,
      content_type: "application/pdf",
      bucket: "e2e",
      object_key: "resume/e2e/宋乐-前端高级工程师-BOSS.pdf",
      url: null,
      view_url: null,
    },
    {
      id: "file_e2e_resume_xuehai",
      name: "薛海-HRBP-猎聘.pdf",
      size: 32,
      content_type: "application/pdf",
      bucket: "e2e",
      object_key: "resume/e2e/薛海-HRBP-猎聘.pdf",
      url: null,
      view_url: null,
    },
  ];
  await page.route("**/api/files/upload", async (route) => {
    uploadRequests += 1;
    const uploaded = uploadedFiles[Math.min(uploadRequests - 1, uploadedFiles.length - 1)];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(uploaded),
    });
  });
  await page.route("**/api/resumes/parse", async (route) => {
    parseRequests += 1;
    const payload = route.request().postDataJSON() as { files: Array<Record<string, unknown>> };
    const file = payload.files[0];
    const fileName = String(file.name || "");
    const isSongle = fileName.includes("宋乐");
    const candidateName = isSongle ? "宋乐" : "薛海";
    const source = isSongle ? "BOSS" : "猎聘";
    const resumeText = isSongle
      ? "姓名：宋乐\n7年前端工程师，负责 React 与组件化平台。"
      : "姓名：薛海\n5年HRBP经验，负责招聘、绩效和组织发展。";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        resumes: [
          {
            file: {
              ...file,
              candidateName,
              source,
              resumeText,
            },
            candidateName,
            source,
            resumeText,
            extractionMethod: "pdf",
            warnings: [],
          },
        ],
      }),
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /简历甄选/ }).click();
  await expect(page.getByRole("heading", { name: "简历甄选", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "批量上传简历" }).click();
  const modal = page.getByRole("dialog", { name: "批量上传简历" });
  await expect(modal).toBeVisible();
  await expect.poll(async () => {
    const modalBox = await modal.boundingBox();
    const viewport = page.viewportSize();
    if (!modalBox || !viewport) return Number.POSITIVE_INFINITY;
    const expectedModalTop = Math.max(0, (viewport.height - modalBox.height) / 2);
    return Math.abs(modalBox.y - expectedModalTop);
  }).toBeLessThanOrEqual(16);
  await expect.poll(async () => (await modal.boundingBox())?.width || 0).toBeGreaterThanOrEqual(1000);
  await expect(modal).toContainText("支持批量选择 PDF、DOC、DOCX 文件");

  const fileInput = modal.locator('input[type="file"]');
  const accept = await fileInput.getAttribute("accept");
  expect(accept).toContain(".pdf");
  expect(accept).toContain(".doc");
  expect(accept).toContain(".docx");
  expect(accept).toContain("application/pdf");
  expect(accept).not.toContain(".txt");
  expect(accept).not.toContain("image/");

  await fileInput.setInputFiles({
    name: "候选人.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("这是一份文本简历"),
  });
  await expect(modal.locator(".resume-parse-card")).toHaveCount(0);
  expect(uploadRequests).toBe(0);

  let chooserEvents = 0;
  page.on("filechooser", () => {
    chooserEvents += 1;
  });
  const fileChooserPromise = page.waitForEvent("filechooser");
  await modal.locator(".resume-upload-trigger").click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles([
    {
      name: "宋乐-前端高级工程师-BOSS.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    },
    {
      name: "薛海-HRBP-猎聘.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n"),
    },
  ]);
  await expect(modal.locator(".resume-parse-card")).toHaveCount(2);
  await expect.poll(() => uploadRequests).toBe(2);
  await expect.poll(() => parseRequests).toBe(2);
  await expect(modal.locator(".resume-parse-card").filter({ hasText: "宋乐-前端高级工程师-BOSS.pdf" })).toContainText("已解析");
  await expect(modal.locator(".resume-parse-card").filter({ hasText: "薛海-HRBP-猎聘.pdf" })).toContainText("已解析");
  await expect.poll(async () => {
    const listBox = await modal.locator(".resume-parse-list").boundingBox();
    const cardBox = await modal.locator(".resume-parse-card").first().boundingBox();
    if (!listBox || !cardBox) return Number.POSITIVE_INFINITY;
    return Math.abs(listBox.width - cardBox.width);
  }).toBeLessThanOrEqual(4);
  await expect.poll(async () => {
    const modalBox = await modal.boundingBox();
    const listBox = await modal.locator(".resume-parse-list").boundingBox();
    if (!modalBox || !listBox) return 0;
    return listBox.width / modalBox.width;
  }).toBeGreaterThan(0.88);
  expect(chooserEvents).toBe(1);

  const songleCard = modal.locator(".resume-parse-card").filter({ hasText: "宋乐-前端高级工程师-BOSS.pdf" });
  await expect(songleCard.locator(".form-field").filter({ hasText: "候选人姓名" }).locator("input")).toHaveValue("宋乐");
  const sourceField = songleCard.locator(".form-field").filter({ hasText: "来源渠道" });
  await expect(sourceField).toContainText("BOSS");
  await expect(songleCard.locator(".form-field").filter({ hasText: "简历原文" }).locator("textarea")).toContainText("7年前端工程师");
  await songleCard.locator(".form-field").filter({ hasText: "候选人姓名" }).locator("input").fill("宋乐改");
  await sourceField.locator(".arco-select-view").click();
  const sourcePopup = page.locator(".arco-select-popup:visible").last();
  await expect.poll(async () => {
    const popupBox = await sourcePopup.boundingBox();
    return popupBox?.height || Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(300);
  await expect(sourcePopup.getByRole("option", { name: "智联", exact: true })).toBeVisible();
  await expect(sourcePopup.getByRole("option", { name: "BOSS", exact: true })).toBeVisible();
  await expect(sourcePopup.getByRole("option", { name: "BOSS直聘", exact: true })).toHaveCount(0);
  await expect(sourcePopup.getByRole("option", { name: "智联招聘", exact: true })).toHaveCount(0);
  await sourceField.locator("input:visible").fill("小红书私域");
  const songleResumeText = songleCard.locator(".form-field").filter({ hasText: "简历原文" }).locator("textarea");
  await songleResumeText.click();
  await expect(sourceField).toContainText("小红书私域");
  await songleResumeText.fill("姓名：宋乐改\n前端负责人，负责 React、工程化与团队协作。");

  const currentState = await (await page.request.get("/api/state")).json();
  let resumeAnalysisRequests = 0;
  let activeResumeAnalysisRequests = 0;
  let maxActiveResumeAnalysisRequests = 0;
  const resumeAnalysisPayloads: Array<Record<string, unknown>> = [];
  const analyzedCandidates: Array<Record<string, unknown>> = [];
  await page.route("**/api/jobs/*/resumes", async (route) => {
    resumeAnalysisRequests += 1;
    activeResumeAnalysisRequests += 1;
    maxActiveResumeAnalysisRequests = Math.max(maxActiveResumeAnalysisRequests, activeResumeAnalysisRequests);
    const requestPayload = route.request().postDataJSON() as Record<string, unknown>;
    resumeAnalysisPayloads.push(requestPayload);
    const submittedFile = (requestPayload.files as Array<Record<string, unknown>>)[0];
    const templateCandidate = currentState.candidates[currentState.currentJobId][0];
    analyzedCandidates.push({
      ...templateCandidate,
      id: `candidate_e2e_upload_${resumeAnalysisRequests}`,
      name: String(submittedFile.candidateName || "候选人"),
      source: `${String(submittedFile.source || "本地上传")} · ${String(submittedFile.name || "简历")}`,
      fileName: submittedFile.name,
      fileType: submittedFile.content_type,
      fileSize: submittedFile.size,
      fileObjectKey: submittedFile.object_key,
      resumeText: submittedFile.resumeText,
      reason: `AI已完成 ${String(submittedFile.candidateName || "候选人")} 的简历分析`,
      removedFromScreening: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        state: {
          ...currentState,
          candidates: {
            ...currentState.candidates,
            [currentState.currentJobId]: [...currentState.candidates[currentState.currentJobId], ...analyzedCandidates],
          },
        },
      }),
    });
    activeResumeAnalysisRequests -= 1;
  });
  await modal.getByRole("button", { name: "分析并生成候选人" }).click();
  await expect(modal.locator(".resume-ai-status")).toContainText(/AI 正在分析第 [12] \/ 2 份/);
  await expect(modal.locator(".resume-ai-status")).toContainText(/已完成 [01] 份/);
  await expect.poll(() => resumeAnalysisRequests).toBe(2);
  expect(maxActiveResumeAnalysisRequests).toBe(1);
  expect(resumeAnalysisPayloads).toHaveLength(2);
  resumeAnalysisPayloads.forEach((payload) => {
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("source");
    expect(payload).not.toHaveProperty("resumeText");
    expect(payload.files).toHaveLength(1);
  });
  const submittedFiles = resumeAnalysisPayloads.flatMap((payload) => payload.files as Array<Record<string, unknown>>);
  expect(submittedFiles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: "宋乐-前端高级工程师-BOSS.pdf",
      content_type: "application/pdf",
      object_key: "resume/e2e/宋乐-前端高级工程师-BOSS.pdf",
      candidateName: "宋乐改",
      source: "小红书私域",
      resumeText: expect.stringContaining("前端负责人"),
    }),
    expect.objectContaining({
      name: "薛海-HRBP-猎聘.pdf",
      content_type: "application/pdf",
      object_key: "resume/e2e/薛海-HRBP-猎聘.pdf",
      candidateName: "薛海",
      source: "猎聘",
      resumeText: expect.stringContaining("5年HRBP经验"),
    }),
  ]));
  await expect(modal).toBeHidden();

  const candidateSearch = page.getByPlaceholder("搜索姓名、来源、文件名或简历内容");
  await expect(candidateSearch).toBeVisible();
  await candidateSearch.fill("宋乐改");
  await expect(page.locator(".candidate-list .candidate-card")).toHaveCount(1);
  await expect(page.locator(".candidate-list .candidate-card .candidate-search-mark").first()).toContainText("宋乐改");
  await candidateSearch.fill("");

  const recentUploadFilter = page.locator(".candidate-recent-toggle");
  await expect(recentUploadFilter).toBeEnabled();
  await recentUploadFilter.click();
  await expect(page.locator(".candidate-list .candidate-card")).toHaveCount(2);
});

test("薪酬调研和职位管理统一使用省市两级地区，职位支持多城市招聘任务", async ({ page }) => {
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const experienceOptions = ["无经验", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"];

  page.on("console", (message) => {
    if (message.type() === "error" && !isKnownThirdPartyConsoleNoise(message.text())) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));

  let finishSalaryResearch: () => void = () => undefined;
  const salaryResearchCanFinish = new Promise<void>((resolve) => {
    finishSalaryResearch = resolve;
  });
  await page.route("**/api/salary/research", async (route) => {
    const filters = route.request().postDataJSON() as Record<string, string>;
    await salaryResearchCanFinish;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        salaryData: {
          status: "ready",
          filters,
          benchmarkRegion: filters.region,
          jobFamily: filters.role,
          p25: 18,
          p50: 24,
          p75: 32,
          suggestedLow: 22,
          suggestedHigh: 30,
          anchor: 26,
          experienceBands: [
            { label: filters.experience, p25: 18, p50: 24, p75: 32 },
          ],
          regionComparison: [
            { city: filters.region, p25: 18, p50: 24, p75: 32 },
            { city: "北京市", p25: 19, p50: 25, p75: 34 },
          ],
          educationComparison: [{ label: filters.education, value: 24 }],
          industryComparison: [{ name: filters.industry, value: 24 }],
          updatedAt: "2026-07-12T00:00:00.000Z",
          insights: [{ title: "测试洞察", text: "用于验证执行薪酬调研后地区展示不丢失。" }],
          advice: {
            summary: "测试薪酬调研结果。",
            reasons: ["地区筛选已保留。"],
            keywordPremiums: [],
          },
          research: {
            dataWindow: "2026-07",
            confidence: "中",
            confidenceReason: "E2E stub",
            limitations: ["E2E stub"],
            triangulation: {
              requiredSources: 2,
              actualSources: 2,
              passed: true,
              summary: "E2E stub",
            },
            metricSources: {
              p25: "E2E stub",
              p50: "E2E stub",
              p75: "E2E stub",
            },
            methodology: ["E2E stub"],
            coreSources: ["E2E stub"],
            validationSources: ["E2E stub"],
            sampleNotes: ["E2E stub"],
            evidence: [],
            disclaimer: "E2E stub",
          },
        },
      }),
    });
  });

  await page.goto("/");
  const regionDirectoryResponse = await page.request.get("/api/regions");
  expect(regionDirectoryResponse.ok(), await regionDirectoryResponse.text()).toBeTruthy();
  const regionDirectory = await regionDirectoryResponse.json() as { regions: Array<{ level: string; children: Array<{ level: string; children: unknown[] }> }> };
  expect(regionDirectory.regions.every((province) => province.level === "province" && province.children.every((city) => city.level === "city" && city.children.length === 0))).toBeTruthy();

  await page.getByRole("button", { name: /薪酬调研/ }).click();
  await expect(page.getByRole("heading", { name: "薪酬调研", exact: true, level: 2 })).toBeVisible();

  const salaryRegion = page.locator(".salary-region-switcher .region-cascader");
  await expectArcoCascaderSearchCanFind(page, salaryRegion, "广东", /广东省/);
  await expectArcoCascaderSearchCanFind(page, salaryRegion, "深圳", /广东省.*深圳市/);
  await selectArcoCascaderByPath(page, salaryRegion, ["广东省", "深圳市"]);
  await expect(salaryRegion).toContainText("广东省 / 深圳市");
  await expect(salaryRegion).not.toContainText("南山区");
  const salaryResearchResponse = page.waitForResponse((response) =>
    response.url().includes("/api/salary/research") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /生成薪酬大盘|刷新薪酬大盘/ }).click();
  await expect(page.getByRole("button", { name: "刷新中..." })).toBeVisible();
  await expect(salaryRegion).toContainText("深圳市");
  finishSalaryResearch();
  const completedSalaryResearchResponse = await salaryResearchResponse;
  await expect(completedSalaryResearchResponse.ok()).toBeTruthy();
  expect((completedSalaryResearchResponse.request().postDataJSON() as { region: string }).region).toBe("广东省 / 深圳市");
  await expect(salaryRegion).toContainText("深圳市");

  await page.getByRole("button", { name: /职位管理/ }).click();
  await expect(page.getByRole("heading", { name: "职位管理", exact: true, level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "新增职位" }).click();

  const modal = page.getByRole("dialog", { name: "新增职位" });
  await expect(modal).toBeVisible();
  await modal.getByRole("textbox", { name: "职位名称" }).fill("前端薪资测试岗位");
  const jobRegion = modal.locator(".region-cascader-field .region-cascader");
  await selectArcoCascaderByPath(page, jobRegion, ["广东省", "深圳市"]);
  await expect(jobRegion).toContainText("广东省 / 深圳市");

  const salaryField = modal.locator(".form-field").filter({ hasText: "薪资范围" });
  await salaryField.locator(".arco-select-view").click();
  const salaryPopup = page.locator(".arco-select-popup:visible").last();
  await expect(salaryPopup.locator(".arco-select-option").filter({ hasText: /^请选择薪资范围$/ })).toHaveCount(0);
  await salaryPopup.locator(".arco-select-option").filter({ hasText: "20k - 30k" }).first().click();
  await expect(salaryField).toContainText("20k - 30k");
  await selectArcoOption(page, salaryField, "自定义区间");
  await expect(salaryField.getByLabel("最低薪资")).toHaveAttribute("type", "number");
  await expect(salaryField.getByLabel("最高薪资")).toHaveAttribute("type", "number");
  await salaryField.getByLabel("最低薪资").fill("18");
  await salaryField.getByLabel("最高薪资").fill("26");

  const experienceField = modal.locator(".form-field").filter({ hasText: "经验要求" });
  await experienceField.locator(".arco-select-view").click();
  const popup = page.locator(".arco-select-popup:visible");
  for (const option of experienceOptions) {
    await expect(popup.locator(".arco-select-option").filter({ hasText: option })).toBeVisible();
  }
  await popup.locator(".arco-select-option").filter({ hasText: "3-5年" }).click();
  await expect(experienceField).toContainText("3-5年");

  const keywordField = modal.locator(".job-keyword-field");
  await keywordField.locator(".arco-select-view").click();
  const keywordPopup = page.locator(".arco-select-popup:visible .job-keyword-popup").last();
  await expect(keywordPopup).toBeVisible();
  const firstKeywordOption = keywordPopup.locator(".arco-select-option").nth(0);
  const secondKeywordOption = keywordPopup.locator(".arco-select-option").nth(1);
  await expect(secondKeywordOption).toBeVisible();
  const firstKeywordOptionBox = await firstKeywordOption.boundingBox();
  const secondKeywordOptionBox = await secondKeywordOption.boundingBox();
  expect(firstKeywordOptionBox).not.toBeNull();
  expect(secondKeywordOptionBox).not.toBeNull();
  expect(secondKeywordOptionBox!.y - (firstKeywordOptionBox!.y + firstKeywordOptionBox!.height)).toBeGreaterThanOrEqual(6);
  await keywordField.locator("input:visible").last().fill("React");
  await expect(page.locator(".arco-select-popup:visible").last().locator(".arco-select-option").filter({ hasText: "React" })).toBeVisible();
  await keywordField.locator("input:visible").last().press("Enter");
  await expect(keywordField).toContainText("React");
  await keywordField.locator(".arco-select-view").click();
  await keywordField.locator("input:visible").last().fill("薪资测试");
  await keywordField.locator("input:visible").last().press("Enter");
  await expect(keywordField).toContainText("薪资测试");

  await modal.getByRole("textbox", { name: "所属部门" }).fill("测试部门");
  await modal.getByRole("textbox", { name: "职位级别" }).fill("P6");
  await modal.getByRole("textbox", { name: "职位描述" }).fill("负责薪资范围控件测试，验证常规选项与自定义数字区间。");
  await selectArcoOption(page, modal.locator(".form-field").filter({ hasText: "需求类型" }).locator(".arco-select"), "计划内新增");
  await modal.getByRole("button", { name: "增加城市" }).click();
  const secondCityRow = modal.locator(".job-city-task-row").nth(1);
  await selectArcoCascaderByPath(page, secondCityRow.locator(".region-cascader"), ["上海市"]);
  await secondCityRow.getByLabel(/计划HC$/).fill("2");
  await expect(page.getByRole("button", { name: "创建 2 个城市任务" })).toBeEnabled();
  await page.getByRole("button", { name: "创建 2 个城市任务" }).click();
  const createdJobCard = page.locator(".job-card").filter({ hasText: "前端薪资测试岗位" });
  await expect(createdJobCard).toBeVisible();
  await expect(createdJobCard).toContainText("2 个城市任务");
  await expect(createdJobCard).toContainText("广东省 / 深圳市");
  await expect(createdJobCard).toContainText("上海市");
  await expect(createdJobCard).toContainText("总 HC");
  await expect(createdJobCard).toContainText("0/3");
  await expect(createdJobCard).toContainText("18k - 26k");
  await expect(createdJobCard).toContainText("计划内新增");

  await createdJobCard.click();
  await page.getByRole("button", { name: "增加城市", exact: true }).click();
  const addCityModal = page.getByRole("dialog", { name: "增加城市招聘任务" });
  await expect(addCityModal).toBeVisible();
  await selectArcoCascaderByPath(page, addCityModal.locator(".region-cascader"), ["北京市"]);
  await expect(addCityModal.getByRole("button", { name: "创建城市任务" })).toBeEnabled();
  await addCityModal.getByRole("button", { name: "创建城市任务" }).click();
  await expect(addCityModal).toBeHidden();
  await expect(createdJobCard).toContainText("3 个城市任务");
  await expect(createdJobCard).toContainText("北京市");

  const savedState = await (await page.request.get("/api/state")).json();
  const createdCityJobs = savedState.jobs.filter((job: { title: string }) => job.title === "前端薪资测试岗位");
  expect(createdCityJobs).toHaveLength(3);
  expect(new Set(createdCityJobs.map((job: { profileGroupId: string }) => job.profileGroupId)).size).toBe(1);
  expect(createdCityJobs.map((job: { location: string }) => job.location).sort()).toEqual(["北京市", "上海市", "广东省 / 深圳市"].sort());
  expect(createdCityJobs.map((job: { recruitmentBatches: Array<{ targetMonth: string }> }) => job.recruitmentBatches[0].targetMonth)).toEqual(["2026年08月", "2026年08月", "2026年08月"]);

  await page.locator(".job-detail-city-switcher").getByRole("button", { name: "广东省 / 深圳市", exact: true }).click();
  await page.getByRole("button", { name: "编辑职位" }).click();
  const editModal = page.getByRole("dialog", { name: "编辑职位" });
  await expect(editModal.getByRole("textbox", { name: "招聘月份" })).toHaveValue("2026年08月");
  await editModal.getByRole("textbox", { name: "招聘月份" }).fill("2026年07月");
  await editModal.getByRole("button", { name: "保存职位" }).click();
  await expect(editModal).toBeHidden();

  const updatedState = await (await page.request.get("/api/state")).json();
  const updatedCityJobs = updatedState.jobs.filter((job: { title: string }) => job.title === "前端薪资测试岗位");
  const targetMonthByLocation = Object.fromEntries(updatedCityJobs.map((job: { location: string; recruitmentBatches: Array<{ targetMonth: string }> }) => [job.location, job.recruitmentBatches[0].targetMonth]));
  expect(targetMonthByLocation).toEqual({
    "广东省 / 深圳市": "2026年07月",
    "上海市": "2026年08月",
    "北京市": "2026年08月",
  });

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("新上传简历继承职位当前招聘批次月份", () => {
  const job: Job = {
    id: "job_report_month",
    profileGroupId: "job_report_month",
    title: "招聘经理",
    dept: "人力资源部",
    location: "石家庄市",
    experience: "3-5年",
    level: "P6",
    salaryRange: "15k - 20k",
    demandType: "计划内新增",
    plannedHeadcount: 1,
    keywords: "招聘管理、人才盘点",
    scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
    description: "负责招聘管理与人才盘点。",
    status: "招聘中",
    currentBatchId: "job_report_month_batch_1",
    recruitmentBatches: [{
      id: "job_report_month_batch_1",
      sequence: 1,
      label: "第1批",
      targetMonth: "2026年07月",
      demandType: "计划内新增",
      plannedHeadcount: 1,
      status: "招聘中",
      startedAt: "2026-08-03T00:00:00.000Z",
      profileSnapshot: {
        title: "招聘经理",
        dept: "人力资源部",
        location: "石家庄市",
        experience: "3-5年",
        level: "P6",
        salaryRange: "15k - 20k",
        keywords: "招聘管理、人才盘点",
        scoreWeights: { experience: 30, professional: 30, stability: 15, education: 10, business: 15 },
        description: "负责招聘管理与人才盘点。",
      },
    }],
    resumeCount: 0,
    salaryData: null,
    sortOrder: 0,
  };

  const candidate = createCandidate({
    id: "candidate_report_month",
    job,
    name: "测试候选人",
    source: "BOSS",
    resumeText: "负责招聘管理与人才盘点。",
  });

  expect(candidate.reportMonth).toBe("2026年07月");
  expect(candidate.recruitmentBatchId).toBe("job_report_month_batch_1");
});
