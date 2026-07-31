import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

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
  await expect(page.getByText("按当前年度筛选统计在招岗位简历量")).toBeVisible();
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
  test.setTimeout(120_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidate = Object.values(initialState.candidates).flat()[0] as { id: string; name: string };
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
    expect(firstBatchCandidate.recruitmentBatchId).toBe(job.currentBatchId);
    await page.request.post(`/api/candidates/${firstBatchCandidate.id}/mark-interview`, { data: {} });

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
    expect(updateResponse.ok(), await updateResponse.text()).toBeTruthy();

    await page.goto("/");
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

test("同一招聘批次支持多HC并限制超额入职，工作台按批次月份汇总", async ({ page }) => {
  test.setTimeout(60_000);
  const initialState = await (await page.request.get("/api/state")).json();
  const sourceCandidates = Object.values(initialState.candidates).flat().slice(0, 3) as Array<{ id: string }>;
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

    const onboard = (candidateId: string) => page.request.patch(`/api/candidates/${candidateId}/interview-stage`, {
      data: {
        interviewStage: "offer",
        stageRecommendation: "是",
        interviewResult: "通过",
        onboarded: "是",
        reportMonth: job.recruitmentBatches[0].targetMonth,
        interviewReason: "HC自动化验证",
        reasonTags: [],
        interviewTimeline: { onboardedAt: "2026-07-31" },
      },
    });

    expect((await onboard(targetCandidates[0].id)).ok()).toBeTruthy();
    expect((await onboard(targetCandidates[1].id)).ok()).toBeTruthy();
    const overCapacityResponse = await onboard(targetCandidates[2].id);
    expect(overCapacityResponse.status()).toBe(400);
    expect(await overCapacityResponse.text()).toContain("已全部完成");

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
    expect(await reduceResponse.text()).toContain("不能低于已完成人数");

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
    expect((await onboard(targetCandidates[2].id)).ok()).toBeTruthy();

    const finalState = await (await page.request.get("/api/state")).json();
    const targetMonth = job.recruitmentBatches[0].targetMonth;
    const matchingBatches = finalState.jobs.flatMap((item: { id: string; recruitmentBatches: Array<{ id: string; targetMonth: string; plannedHeadcount: number }> }) =>
      item.recruitmentBatches.filter((batch) => batch.targetMonth === targetMonth).map((batch) => ({ ...batch, jobId: item.id })),
    );
    const expectedPlanned = matchingBatches.reduce((sum: number, batch: { plannedHeadcount: number }) => sum + batch.plannedHeadcount, 0);
    const expectedCompleted = matchingBatches.reduce((sum: number, batch: { id: string; jobId: string }) => sum + (finalState.candidates[batch.jobId] || []).filter((candidate: { recruitmentBatchId: string; onboarded: string }) => candidate.recruitmentBatchId === batch.id && candidate.onboarded === "是").length, 0);

    await page.goto("/");
    await selectArcoOption(page, page.locator(".dashboard-global-filters .arco-select"), targetMonth);
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "计划 HC" }).locator(".dashboard-summary-value")).toHaveText(String(expectedPlanned));
    await expect(page.locator(".dashboard-summary-card").filter({ hasText: "已完成 HC" }).locator(".dashboard-summary-value")).toHaveText(String(expectedCompleted));

    await page.locator(".section-radio-tabs").getByText("流程复盘").click();
    const departmentRow = page.locator('.department-hc-table tbody tr[data-department="HC测试部"]');
    await expect(departmentRow).toBeVisible();
    await expect(departmentRow.locator('td[data-column="计划 HC"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="计划内新增"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="复试通过"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="已入职"]')).toHaveText("3");
    await expect(departmentRow.locator('td[data-column="剩余 HC"]')).toHaveText("0");
    await expect(departmentRow.locator('td[data-column="完成率"]')).toContainText("100%");
  } finally {
    await page.request.post("/api/current-job", { data: { jobId: "job_001" } });
    if (jobId) await page.request.delete(`/api/jobs/${jobId}`);
  }
});

test("小松鼠主流程无控制台错误，并可标记面试进入初试", async ({ page }) => {
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
  await expect(page.getByRole("columnheader", { name: "统计月份" })).toBeVisible();
  await page.locator(".month-input").first().fill("2026年07月");
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "是");
  await page.getByRole("button", { name: "保存" }).first().click();

  await page.locator(".stage-filter", { hasText: "初试" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "初试" })).toBeVisible();

  await selectArcoOption(page, page.locator(".recommendation-select").first(), "通过");
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "复试" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "复试" })).toBeVisible();
  await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(0), "全部");
  await expect(page.getByRole("columnheader", { name: "岗位" })).toBeVisible();
  await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(2), "2026年07月");
  await expect(page.locator(".month-input").first()).toHaveValue("2026年07月");

  await selectArcoOption(page, page.locator(".recommendation-select").first(), "通过");
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "offer" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "offer" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "入职" })).toBeVisible();
  await selectArcoOption(page, page.locator(".recommendation-select").first(), "是");

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
  await expect(page.locator(".talent-table tbody tr").filter({ hasText: candidateName })).toBeVisible();
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
  await expect(modal.locator(".resume-ai-status")).toContainText("AI 正在分析第 1 / 2 份");
  await expect(modal.locator(".resume-ai-status")).toContainText("已完成 0 份");
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

test("薪酬调研和职位管理统一使用省市两级地区，职位薪资经验和关键词使用标准选项", async ({ page }) => {
  test.setTimeout(75_000);
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
  await expect(page.getByRole("button", { name: "保存职位" })).toBeEnabled();
  await page.getByRole("button", { name: "保存职位" }).click();
  const createdJobCard = page.locator(".job-card").filter({ hasText: "前端薪资测试岗位" });
  await expect(createdJobCard).toBeVisible();
  await expect(createdJobCard).toContainText("18k - 26k");
  await expect(createdJobCard).toContainText("计划内新增");

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
