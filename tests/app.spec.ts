import { expect, test, type Locator, type Page } from "@playwright/test";

async function selectArcoOption(page: Page, select: Locator, option: string | RegExp) {
  await select.locator(".arco-select-view").click();
  const popup = page.locator(".arco-select-popup:visible");
  await popup.locator(".arco-select-option").filter({ hasText: option }).first().click();
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
