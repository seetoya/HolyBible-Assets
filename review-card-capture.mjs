import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('review-card-output');
await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });

const targets = [
  {
    fileName: '01_naver_ericssam_english_review_card.png',
    url: 'https://m.place.naver.com/place/1177401952/review/visitor',
    reviewerNames: ['이정용28'],
    requiredTerms: ['방문일'],
    excludedTerms: ['win****'],
  },
  {
    fileName: '02_naver_ericssam_exam_english_review_card.png',
    url: 'https://m.place.naver.com/place/2076083264/review/visitor',
    reviewerNames: ['온헤이', '은헤이', '은혜이'],
    requiredTerms: ['방문일'],
    excludedTerms: [],
  },
  {
    fileName: '03_daangn_ericssam_english_review_card.png',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%98%81%EC%96%B4%ED%95%99%EC%9B%90-3p2umcgadi7h/',
    reviewerNames: ['세상돈다내꺼9'],
    requiredTerms: ['도움돼요'],
    excludedTerms: ['오여사', '사장님의 답글'],
  },
  {
    fileName: '04_daangn_ericssam_exam_english_review_card.png',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4-9ea8dgwzru8t/',
    reviewerNames: ['후추후추'],
    requiredTerms: ['도움돼요'],
    excludedTerms: ['미자쏭'],
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

async function newContext() {
  const context = await browser.newContext({
    viewport: { width: 460, height: 1400 },
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

async function navigate(page, url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForTimeout(10000);
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
      await page.waitForTimeout(1200);
      return response?.status() ?? null;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(2500);
    }
  }
  throw lastError;
}

async function findReviewer(page, names) {
  for (const name of names) {
    const matches = page.getByText(name, { exact: true });
    const count = await matches.count();
    for (let i = 0; i < count; i++) {
      const item = matches.nth(i);
      try {
        if (await item.isVisible()) return item;
      } catch {}
    }
  }
  return null;
}

async function chooseCard(reviewer, target) {
  const candidates = [];
  let node = reviewer;
  for (let level = 0; level <= 14; level++) {
    try {
      const text = (await node.innerText()).replace(/\s+/g, ' ').trim();
      const box = await node.boundingBox();
      if (!box) break;
      const hasReviewer = target.reviewerNames.some(name => text.includes(name));
      const hasRequired = target.requiredTerms.every(term => text.includes(term));
      const hasExcluded = target.excludedTerms.some(term => text.includes(term));
      if (
        hasReviewer &&
        hasRequired &&
        !hasExcluded &&
        box.width >= 300 &&
        box.height >= 120 &&
        box.height <= 1700
      ) {
        candidates.push({ level, height: box.height, width: box.width, textLength: text.length });
      }
      node = node.locator('xpath=..');
    } catch {
      break;
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.height - b.height || a.textLength - b.textLength);
  const chosen = candidates[0];
  let card = reviewer;
  for (let i = 0; i < chosen.level; i++) card = card.locator('xpath=..');
  return card;
}

async function expandReview(page, card) {
  for (const label of ['더보기', '펼쳐보기']) {
    const matches = card.getByText(label, { exact: true });
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      try {
        const item = matches.nth(i);
        if (await item.isVisible()) {
          await item.click({ timeout: 3000 });
          await page.waitForTimeout(1000);
        }
      } catch {}
    }
  }
}

for (const target of targets) {
  const context = await newContext();
  const page = await context.newPage();
  try {
    const status = await navigate(page, target.url);
    console.log(`${target.fileName}: HTTP ${status} ${page.url()}`);

    const reviewer = await findReviewer(page, target.reviewerNames);
    if (!reviewer) throw new Error(`Reviewer not found: ${target.reviewerNames.join(', ')}`);
    await reviewer.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    let card = await chooseCard(reviewer, target);
    if (!card) throw new Error('Review-card ancestor not found');
    await expandReview(page, card);
    card = (await chooseCard(reviewer, target)) ?? card;
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1000);

    await card.screenshot({
      path: path.join(OUT, target.fileName),
      animations: 'disabled',
      type: 'png',
    });
    console.log(`${target.fileName}: SUCCESS`);
  } catch (error) {
    console.error(`${target.fileName}: FAILED`, error);
    await page.screenshot({
      path: path.join(OUT, target.fileName.replace('.png', '_FAILED_FULLPAGE.png')),
      fullPage: true,
      animations: 'disabled',
    }).catch(() => {});
  } finally {
    await context.close();
  }
}

await browser.close();
