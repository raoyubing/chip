import { expect, test, type Locator, type Page } from "@playwright/test";

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
  await selectArcoOption(page, page.locator(".interview-filter-field .arco-select").nth(1), "2026年07月");
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

test("薪酬调研和职位管理支持省市区列式级联选择与任意层级搜索，职位薪资经验和关键词使用标准选项", async ({ page }) => {
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
  await page.getByRole("button", { name: /薪酬调研/ }).click();
  await expect(page.getByRole("heading", { name: "薪酬调研", exact: true, level: 2 })).toBeVisible();

  const salaryRegion = page.locator(".salary-region-switcher .region-cascader");
  await expectArcoCascaderSearchCanFind(page, salaryRegion, "广东", /广东省/);
  await expectArcoCascaderSearchCanFind(page, salaryRegion, "深圳", /广东省.*深圳市/);
  await expectArcoCascaderSearchCanFind(page, salaryRegion, "南山", /广东省.*深圳市.*南山区/);
  await selectArcoCascaderByPath(page, salaryRegion, ["广东省", "深圳市", "南山区"]);
  await expect(salaryRegion).toContainText("南山区");
  const salaryResearchResponse = page.waitForResponse((response) =>
    response.url().includes("/api/salary/research") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /生成薪酬大盘|刷新薪酬大盘/ }).click();
  await expect(page.getByRole("button", { name: "刷新中..." })).toBeVisible();
  await expect(salaryRegion).toContainText("南山区");
  finishSalaryResearch();
  await expect((await salaryResearchResponse).ok()).toBeTruthy();
  await expect(salaryRegion).toContainText("南山区");

  await page.getByRole("button", { name: /职位管理/ }).click();
  await expect(page.getByRole("heading", { name: "职位管理", exact: true, level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "新增职位" }).click();

  const modal = page.getByRole("dialog", { name: "新增职位" });
  await expect(modal).toBeVisible();
  await modal.getByRole("textbox", { name: "职位名称" }).fill("前端薪资测试岗位");
  const jobRegion = modal.locator(".region-cascader-field .region-cascader");
  await selectArcoCascaderByPath(page, jobRegion, ["广东省", "深圳市", "南山区"]);
  await expect(jobRegion).toContainText("南山区");

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
  await expect(page.getByRole("button", { name: "保存职位" })).toBeEnabled();
  await page.getByRole("button", { name: "保存职位" }).click();
  const createdJobCard = page.locator(".job-card").filter({ hasText: "前端薪资测试岗位" });
  await expect(createdJobCard).toBeVisible();
  await expect(createdJobCard).toContainText("18k - 26k");

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
