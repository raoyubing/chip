import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });
await page.goto('http://127.0.0.1:5175/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.analytics-duration-tier', { timeout: 15000 });
const data = await page.evaluate(() => {
  return Array.from(document.querySelectorAll('.analytics-duration-tier')).map((tier, index) => {
    const step = tier.querySelector('.analytics-duration-step');
    const top = tier.querySelector('.analytics-duration-step-top');
    const face = tier.querySelector('.analytics-duration-step-face');
    const copy = tier.querySelector('.analytics-duration-copy');
    const rect = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      index,
      tier: { className: tier.className, rect: rect(tier), style: getComputedStyle(tier).cssText },
      step: step ? {
        className: step.className,
        rect: rect(step),
        border: getComputedStyle(step).border,
        outline: getComputedStyle(step).outline,
        background: getComputedStyle(step).background,
        borderRadius: getComputedStyle(step).borderRadius,
        boxShadow: getComputedStyle(step).boxShadow,
        display: getComputedStyle(step).display,
      } : null,
      top: top ? { rect: rect(top), background: getComputedStyle(top).background, border: getComputedStyle(top).border } : null,
      face: face ? { rect: rect(face), background: getComputedStyle(face).background, border: getComputedStyle(face).border } : null,
      copy: copy ? { rect: rect(copy), afterBg: getComputedStyle(copy, '::after').backgroundColor, beforeBg: getComputedStyle(copy, '::before').backgroundColor } : null,
    };
  });
});
console.log(JSON.stringify(data, null, 2));
await browser.close();
