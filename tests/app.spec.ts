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

test("工作台时间筛选固定在右上角并作用于四个分区", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "工作台概览", exact: true })).toBeVisible();

  const globalFilters = page.locator(".topbar .dashboard-global-filters");
  await expect(globalFilters).toBeVisible();
  await expect.poll(async () => (await globalFilters.boundingBox())?.height || 0).toBeLessThanOrEqual(70);
  await expect(globalFilters).toContainText("月数据");
  await expect(globalFilters).toContainText("统计月份");
  await expect(page.locator(".content-dashboard > .analytics-toolbar-card").filter({ hasText: "招聘周期复盘" })).toHaveCount(0);

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
  await expect(sourcePopup.getByRole("option", { name: "智联", exact: true })).toBeVisible();
  await expect(sourcePopup.getByRole("option", { name: "BOSS直聘", exact: true })).toHaveCount(0);
  await expect(sourcePopup.getByRole("option", { name: "智联招聘", exact: true })).toHaveCount(0);
  await sourceField.locator("input:visible").fill("小红书私域");
  const songleResumeText = songleCard.locator(".form-field").filter({ hasText: "简历原文" }).locator("textarea");
  await songleResumeText.click();
  await expect(sourceField).toContainText("小红书私域");
  await songleResumeText.fill("姓名：宋乐改\n前端负责人，负责 React、工程化与团队协作。");

  const currentState = await (await page.request.get("/api/state")).json();
  let resumeAnalysisRequests = 0;
  let resumeAnalysisPayload: Record<string, unknown> | null = null;
  await page.route("**/api/jobs/*/resumes", async (route) => {
    resumeAnalysisRequests += 1;
    resumeAnalysisPayload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ state: currentState }),
    });
  });
  await modal.getByRole("button", { name: "分析并生成候选人" }).click();
  await expect.poll(() => resumeAnalysisRequests).toBe(1);
  const submittedPayload = resumeAnalysisPayload as { files?: Array<Record<string, unknown>>; duplicateAction?: string } | null;
  expect(submittedPayload).not.toHaveProperty("name");
  expect(submittedPayload).not.toHaveProperty("source");
  expect(submittedPayload).not.toHaveProperty("resumeText");
  expect(submittedPayload?.files).toHaveLength(2);
  expect(submittedPayload?.files).toEqual(expect.arrayContaining([
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
  await expect(page.getByRole("button", { name: "保存职位" })).toBeEnabled();
  await page.getByRole("button", { name: "保存职位" }).click();
  const createdJobCard = page.locator(".job-card").filter({ hasText: "前端薪资测试岗位" });
  await expect(createdJobCard).toBeVisible();
  await expect(createdJobCard).toContainText("18k - 26k");

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
