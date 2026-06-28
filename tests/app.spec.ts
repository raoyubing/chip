import { expect, test } from "@playwright/test";

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
  await expect(page.locator(".stage-filter.active").filter({ hasText: "初试" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "初试" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "统计月份" })).toBeVisible();
  await page.locator(".month-input").first().fill("2026年07月");

  await page.getByRole("combobox").filter({ hasText: "待定" }).first().selectOption("通过");
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "复试" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "复试" })).toBeVisible();
  await page.locator(".interview-filter-field select").nth(0).selectOption("all");
  await expect(page.getByRole("columnheader", { name: "岗位" })).toBeVisible();
  await page.locator(".interview-filter-field select").nth(1).selectOption("2026年07月");
  await expect(page.locator(".month-input").first()).toHaveValue("2026年07月");

  await page.getByRole("combobox").filter({ hasText: "待定" }).first().selectOption("通过");
  await page.getByRole("button", { name: "保存" }).first().click();
  await page.locator(".stage-filter", { hasText: "offer" }).click();
  await expect(page.locator(".stage-filter.active").filter({ hasText: "offer" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "入职" })).toBeVisible();
  await expect(page.getByRole("combobox").filter({ hasText: "待入职" }).first()).toBeVisible();
  await page.getByRole("combobox").filter({ hasText: "待入职" }).first().selectOption("是");

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("访音解析可生成结果并切换历史记录", async ({ page }) => {
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

  await page.locator(".voice-form select").first().selectOption("job_001");
  await page.locator(".voice-form select").nth(1).selectOption("c1");
  await page.getByPlaceholder(/粘贴与候选人的电话\/微信沟通转写内容/).fill("候选人提到自己负责招聘与绩效推进，也做过跨团队协同和复盘，对到岗时间、薪资和动机都能明确回应。");
  await page.getByRole("button", { name: "生成解析" }).click();

  await expect(page.locator(".voice-analysis-panel")).toContainText("建议推进");
  await expect(page.locator(".voice-analysis-panel")).toContainText("岗位匹配建议");
  await expect(page.locator(".voice-analysis-panel")).toContainText("招聘人员建议");

  await page.getByPlaceholder(/粘贴与候选人的电话\/微信沟通转写内容/).fill("候选人多次表示不太清楚、可能再说，对离职动机和稳定性回答不确定。");
  await page.getByRole("button", { name: "生成解析" }).click();

  await expect(page.locator(".voice-analysis-panel")).toContainText("历史解析");
  await page.locator(".voice-history-field select").selectOption({ index: 1 });
  await expect(page.locator(".resume-box").last()).toContainText("负责招聘与绩效推进");

  expect(failedRequests, failedRequests.join("\n")).toEqual([]);
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
