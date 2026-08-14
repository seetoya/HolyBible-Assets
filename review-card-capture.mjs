import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('review-card-output');
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const targets = [
  {
    key: '01_naver_ericssam_english_review_card',
    platform: 'naver',
    url: 'https://m.place.naver.com/place/1177401952/review/visitor',
    reviewer: '이정용28',
    required: ['방문일'],
    exclude: ['win****'],
  },
  {
    key: '02_naver_ericssam_exam_english_review_card',
    platform: 'naver',
    url: 'https://m.place.naver.com/place/2076083264/review/visitor',
    reviewer: '온헤이',
    altReviewers: ['은헤이', '은혜이'],
    required: ['방문일'],
    exclude: [],
  },
  {
    key: '03_daangn_ericssam_english_review_card',
    platform: 'daangn',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%98%81%EC%96%B4%ED%95%99%EC%9B%90-3p2umcgadi7h/',
    reviewer: '세상돈다내꺼9',
    required: ['도움돼요'],
    exclude: ['오여사'],
  },
  {
    key: '04_daangn_ericssam_exam_english_review_card',
    platform: 'daangn',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4-9ea8dgwzru8t/',
    reviewer: '후추후추',
    required: ['도움돼요'],
    exclude: ['미자쏭'],
  },
];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR',
  ],
});

async function createContext() {
  const context = await browser.newContext({
    viewport: { width: 460, height: 1200 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'light',
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.5',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

async function stableGoto(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(9000);
      try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
      await page.waitForTimeout(1500);
      return response?.status() ?? null;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(3000);
    }
  }
  throw lastError;
}

async function findVisibleReviewer(page, target) {
  const names = [target.reviewer, ...(target.altReviewers ?? [])];
  for (const name of names) {
    const loc = page.getByText(name, { exact: true });
    const count = await loc.count();
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      try {
        if (await item.isVisible()) return { locator: item, matchedName: name };
      } catch {}
    }
  }
  return null;
}

async function chooseAncestor(reviewerLocator, target) {
  const candidates = [];
  let current = reviewerLocator;
  for (let level = 0; level <= 12; level++) {
    try {
      const text = (await current.innerText()).replace(/\s+/g, ' ').trim();
      const box = await current.boundingBox();
      const tag = await current.evaluate(el => el.tagName.toLowerCase());
      const requiredOk = target.required.every(term => text.includes(term));
      const excludesOk = target.exclude.every(term => !text.includes(term));
      const nameOk = text.includes(target.reviewer) || (target.altReviewers ?? []).some(name => text.includes(name));
      if (box && box.width >= 300 && box.height >= 120 && box.height <= 1500 && requiredOk && excludesOk && nameOk) {
        candidates.push({ level, height: box.height, width: box.width, textLength: text.length, tag, text: text.slice(0, 600) });
      }
      current = current.locator('xpath=..');
    } catch {
      break;
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.height - b.height || a.textLength - b.textLength);
  const chosen = candidates[0];
  let loc = reviewerLocator;
  for (let i = 0; i < chosen.level; i++) loc = loc.locator('xpath=..');
  return { locator: loc, candidates, chosen };
}

async function clickMoreWithin(container) {
  for (const label of ['더보기', '펼쳐보기']) {
    const loc = container.getByText(label, { exact: true });
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      try {
        const item = loc.nth(i);
        if (await item.isVisible()) {
          await item.click({ timeout: 3000 });
          await item.page().waitForTimeout(1200);
        }
      } catch {}
    }
  }
}

async function captureTarget(target) {
  const context = await createContext();
  const page = await context.newPage();
  const record = { ...target };
  try {
    record.httpStatus = await stableGoto(page, target.url);
    record.finalUrl = page.url();

    const reviewer = await findVisibleReviewer(page, target);
    if (!reviewer) throw new Error(`Reviewer not found: ${target.reviewer}`);
    record.matchedReviewer = reviewer.matchedName;
    await reviewer.locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);

    let picked = await chooseAncestor(reviewer.locator, target);
    if (!picked) throw new Error('Could not identify an isolated review-card ancestor');
    await clickMoreWithin(picked.locator);
    picked = await chooseAncestor(reviewer.locator, target) ?? picked;
    await picked.locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    const box = await picked.locator.boundingBox();
    if (!box) throw new Error('Chosen review card has no bounding box');

    const topPadding = 8;
    const bottomPadding = 8;
    const x = 0;
    const y = Math.max(0, box.y - topPadding);
    const width = 460;
    const documentHeight = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    const height = Math.min(box.height + topPadding + bottomPadding, documentHeight - y);

    const fileName = `${target.key}.png`;
    await page.screenshot({
      path: path.join(OUT, fileName),
      clip: { x, y, width, height },
      captureBeyondViewport: true,
      animations: 'disabled',
    });
    record.status = 'SUCCESS';
    record.fileName = fileName;
    record.cardBox = box;
    record.clip = { x, y, width, height };
    record.chosen = picked.chosen;
    record.candidates = picked.candidates;
  } catch (error) {
    record.status = 'FAILED';
    record.error = String(error?.stack || error);
    const fallbackName = `${target.key}_fallback_fullpage.png`;
    try {
      await page.screenshot({ path: path.join(OUT, fallbackName), fullPage: true, animations: 'disabled' });
      record.fallbackFile = fallbackName;
    } catch {}
  } finally {
    await fs.writeFile(path.join(OUT, `${target.key}.debug.json`), JSON.stringify(record, null, 2), 'utf8');
    await context.close();
  }
}

for (const target of targets) {
  await captureTarget(target);
}

await browser.close();
