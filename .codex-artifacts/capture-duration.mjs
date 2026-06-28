import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:5175/', { waitUntil: 'networkidle' });
const title = page.getByRole('heading', { name: '阶段耗时分析' });
await title.scrollIntoViewIfNeeded();
const card = title.locator('xpath=ancestor::section[1]');
await card.screenshot({ path: '.codex-artifacts/duration-card-current.png' });
await browser.close();
