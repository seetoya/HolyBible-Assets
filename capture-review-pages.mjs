import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = path.resolve('captures');
await fs.mkdir(OUT, { recursive: true });

const now = new Date().toISOString();
const manifest = {
  generatedAt: now,
  purpose: 'Actual webpage screenshots of Naver Place visitor reviews and Daangn neighborhood-business reviews',
  viewport: { width: 460, height: 1350, deviceScaleFactor: 1 },
  items: [],
  diagnostics: []
};

function clean(s = '') {
  return String(s).replace(/\s+/g, ' ').trim();
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fsSync.readFileSync(filePath)).digest('hex');
}

async function saveScreenshot(page, fileName, { fullPage = false } = {}) {
  const filePath = path.join(OUT, fileName);
  await page.screenshot({ path: filePath, fullPage, animations: 'disabled' });
  const stat = await fs.stat(filePath);
  return {
    fileName,
    bytes: stat.size,
    sha256: sha256(filePath),
    width: page.viewportSize()?.width ?? null,
    height: page.viewportSize()?.height ?? null,
    fullPage
  };
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function dismissCommon(page) {
  const labels = [
    /닫기/i,
    /나중에/i,
    /확인/i,
    /동의하고 계속/i,
    /쿠키.*동의/i,
    /앱에서 열기 취소/i
  ];
  for (const re of labels) {
    try {
      const loc = page.getByRole('button', { name: re }).first();
      if (await loc.isVisible({ timeout: 500 })) await loc.click({ timeout: 1000 });
    } catch {}
  }
}

async function gotoStable(page, url, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 70000 });
      await page.waitForTimeout(7000);
      await dismissCommon(page);
      await page.waitForTimeout(1200);
      return { responseStatus: response?.status() ?? null, attempts: attempt };
    } catch (error) {
      lastError = error;
      manifest.diagnostics.push({ label, attempt, error: String(error) });
      await page.waitForTimeout(2500);
    }
  }
  throw lastError ?? new Error(`Navigation failed: ${url}`);
}

async function bodyText(page) {
  try {
    return clean(await page.locator('body').innerText({ timeout: 15000 }));
  } catch {
    return '';
  }
}

async function scrollToReviewArea(page, patterns) {
  for (const pattern of patterns) {
    try {
      const loc = page.getByText(pattern).first();
      if (await loc.count()) {
        await loc.scrollIntoViewIfNeeded({ timeout: 5000 });
        const box = await loc.boundingBox();
        if (box) {
          await page.evaluate(y => window.scrollTo({ top: Math.max(0, y - 230), behavior: 'instant' }), box.y + await page.evaluate(() => window.scrollY));
          await page.waitForTimeout(1200);
        }
        return { found: true, matchedText: clean(await loc.innerText().catch(() => '')) };
      }
    } catch {}
  }
  return { found: false, matchedText: '' };
}

async function verifyNaverAddress(context, placeId, expectedAddressFragment) {
  const p = await context.newPage();
  try {
    await gotoStable(p, `https://m.place.naver.com/place/${placeId}/home`, `naver-address-${placeId}`);
    const text = await bodyText(p);
    return {
      verified: text.includes(expectedAddressFragment),
      finalUrl: p.url(),
      evidenceSnippet: text.includes(expectedAddressFragment)
        ? text.slice(Math.max(0, text.indexOf(expectedAddressFragment) - 100), text.indexOf(expectedAddressFragment) + expectedAddressFragment.length + 160)
        : text.slice(0, 700)
    };
  } catch (error) {
    return { verified: false, error: String(error), finalUrl: p.url() };
  } finally {
    await p.close();
  }
}

async function captureNaver(context, spec) {
  const page = await context.newPage();
  const baseRecord = {
    academy: spec.academy,
    platform: 'Naver Place',
    reviewType: '방문자/영수증 리뷰',
    expectedAddress: spec.address,
    placeId: spec.placeId,
    requestedUrl: `https://m.place.naver.com/place/${spec.placeId}/review/visitor`
  };
  try {
    const nav = await gotoStable(page, baseRecord.requestedUrl, `naver-${spec.placeId}`);
    let text = await bodyText(page);

    if (!/방문자\s*리뷰|리뷰/.test(text)) {
      const tabs = [
        page.getByRole('link', { name: /리뷰/ }).first(),
        page.getByRole('button', { name: /리뷰/ }).first(),
        page.getByText(/리뷰/).first()
      ];
      for (const tab of tabs) {
        try {
          if (await tab.isVisible({ timeout: 800 })) {
            await tab.click({ timeout: 3000 });
            await page.waitForTimeout(5000);
            break;
          }
        } catch {}
      }
      text = await bodyText(page);
    }

    const blocked = /접근이 제한|서비스 이용이 제한|비정상적인 접근|captcha|robot|ERR_|페이지를 찾을 수 없|일시적으로 사용할 수 없/i.test(text);
    const nameMatched = text.includes(spec.academy) || text.includes(spec.shortName);
    const review = await scrollToReviewArea(page, [/방문자\s*리뷰/, /리뷰\s*\d+/, /이런 점이 좋았어요/, /사진\/영상/]);
    const addressCheck = await verifyNaverAddress(context, spec.placeId, spec.addressFragment);

    const success = !blocked && nameMatched && review.found;
    const fileName = success ? spec.fileName : spec.fileName.replace(/\.png$/, blocked ? '_blocked.png' : '_not_found.png');
    const shot = await saveScreenshot(page, fileName, { fullPage: false });

    manifest.items.push({
      ...baseRecord,
      status: success ? 'SUCCESS' : 'FAILED',
      reason: success ? null : blocked ? 'Access restriction or anti-bot/error page visible' : 'Expected academy name or visitor-review area was not visible',
      finalUrl: page.url(),
      httpStatus: nav.responseStatus,
      nameMatched,
      reviewAreaFound: review.found,
      reviewAreaText: review.matchedText,
      addressVerification: addressCheck,
      bodySnippet: text.slice(0, 1500),
      screenshot: shot
    });
  } catch (error) {
    const fileName = spec.fileName.replace(/\.png$/, '_blocked.png');
    let shot = null;
    try { shot = await saveScreenshot(page, fileName, { fullPage: false }); } catch {}
    manifest.items.push({
      ...baseRecord,
      status: 'FAILED',
      reason: String(error),
      finalUrl: page.url(),
      screenshot: shot
    });
  } finally {
    await page.close();
  }
}

async function extractProfileLink(page, namePattern) {
  const links = await page.locator('a').evaluateAll((anchors) => anchors.map(a => ({
    text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim(),
    href: a.href || ''
  })));
  const byName = links.find(l => namePattern.test(l.text) && /daangn\.com/.test(l.href) && !/business-post/.test(l.href));
  if (byName) return byName.href;
  const profile = links.find(l => /\/kr\/(business-profiles|local-profile)\//.test(l.href) && namePattern.test(l.text));
  if (profile) return profile.href;
  return '';
}

async function discoverDaangnFirst(context) {
  const page = await context.newPage();
  const seed = 'https://www.daangn.com/kr/business-post/%EB%AA%85%EC%84%9D%EA%B3%A0-2%ED%95%99%EB%85%84-24%EB%85%84-9%EC%9B%94-2%EB%93%B1%EA%B8%89-1%EB%93%B1%EA%B8%89-66f448dcb49987074fb9fe47/';
  try {
    await gotoStable(page, seed, 'daangn-first-seed');
    let href = await extractProfileLink(page, /에릭쌤영어학원/);
    if (!href) {
      const a = page.locator('a').filter({ hasText: /에릭쌤영어학원/ }).first();
      if (await a.count()) href = await a.getAttribute('href') ?? '';
    }
    if (href && href.startsWith('/')) href = new URL(href, page.url()).href;
    return { profileUrl: href, seedUrl: seed, seedText: (await bodyText(page)).slice(0, 1200) };
  } finally {
    await page.close();
  }
}

async function discoverDaangnSecond(context) {
  const page = await context.newPage();
  const seeds = [
    'https://www.daangn.com/kr/local-profile/?in=%EC%8B%A0%EC%9D%BC%EB%8F%99-5742&themeIds=123%2C118%2C209%2C189%2C166%2C192%2C156%2C442',
    'https://www.google.com/search?q=site%3Adaangn.com%2Fkr+%22%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4%22',
    'https://www.bing.com/search?q=site%3Adaangn.com%2Fkr+%22%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4%22'
  ];
  try {
    for (const seed of seeds) {
      try {
        await gotoStable(page, seed, 'daangn-second-seed');
        let href = await extractProfileLink(page, /에릭쌤입시영어(?:학원)?/);
        if (!href) {
          const a = page.locator('a').filter({ hasText: /에릭쌤입시영어/ }).first();
          if (await a.count()) href = await a.getAttribute('href') ?? '';
        }
        if (href && href.startsWith('/')) href = new URL(href, page.url()).href;
        if (href) return { profileUrl: href, seedUrl: seed, seedText: (await bodyText(page)).slice(0, 1200) };
      } catch (error) {
        manifest.diagnostics.push({ label: 'daangn-second-discovery', seed, error: String(error) });
      }
    }
    return { profileUrl: '', seedUrl: seeds[0], seedText: (await bodyText(page)).slice(0, 1200) };
  } finally {
    await page.close();
  }
}

async function captureDaangn(context, spec, discovery) {
  const page = await context.newPage();
  const baseRecord = {
    academy: spec.academy,
    platform: 'Daangn neighborhood business',
    reviewType: '후기',
    expectedAddress: spec.address,
    discovery
  };
  try {
    if (!discovery.profileUrl) {
      await gotoStable(page, discovery.seedUrl, `daangn-not-found-${spec.key}`);
      const fileName = spec.fileName.replace(/\.png$/, '_not_found.png');
      const shot = await saveScreenshot(page, fileName, { fullPage: false });
      manifest.items.push({
        ...baseRecord,
        status: 'FAILED',
        reason: 'Could not resolve an academy detail/profile URL from the public Daangn pages',
        finalUrl: page.url(),
        bodySnippet: (await bodyText(page)).slice(0, 1500),
        screenshot: shot
      });
      return;
    }

    const nav = await gotoStable(page, discovery.profileUrl, `daangn-${spec.key}`);
    let text = await bodyText(page);
    const nameMatched = text.includes(spec.academy) || text.includes(spec.shortName);
    const neighborhoodMatched = spec.neighborhoods.some(n => text.includes(n));
    const blocked = /접근이 제한|서비스 이용이 제한|비정상적인 접근|captcha|robot|페이지를 찾을 수 없|앱에서만 확인/i.test(text);

    let review = await scrollToReviewArea(page, [/후기\s*\d+/, /후기/, /아직.*후기/, /리뷰/]);
    if (review.found) {
      const clickable = page.getByText(/후기\s*\d+|후기/).first();
      try {
        const tag = await clickable.evaluate(el => el.tagName.toLowerCase());
        if (['a', 'button'].includes(tag)) {
          await clickable.click({ timeout: 2500 });
          await page.waitForTimeout(3500);
          text = await bodyText(page);
          review = await scrollToReviewArea(page, [/후기\s*\d+/, /후기/, /아직.*후기/, /리뷰/]);
        }
      } catch {}
    }

    const success = !blocked && nameMatched && review.found;
    const fileName = success ? spec.fileName : spec.fileName.replace(/\.png$/, blocked ? '_blocked.png' : '_not_found.png');
    const shot = await saveScreenshot(page, fileName, { fullPage: false });
    manifest.items.push({
      ...baseRecord,
      status: success ? 'SUCCESS' : 'FAILED',
      reason: success ? null : blocked ? 'Daangn displayed an access/app-only/anti-bot restriction' : 'Expected profile name or review/후기 area was not visible',
      finalUrl: page.url(),
      httpStatus: nav.responseStatus,
      nameMatched,
      neighborhoodMatched,
      reviewAreaFound: review.found,
      reviewAreaText: review.matchedText,
      bodySnippet: text.slice(0, 1800),
      screenshot: shot
    });
  } catch (error) {
    const fileName = spec.fileName.replace(/\.png$/, '_blocked.png');
    let shot = null;
    try { shot = await saveScreenshot(page, fileName, { fullPage: false }); } catch {}
    manifest.items.push({
      ...baseRecord,
      status: 'FAILED',
      reason: String(error),
      finalUrl: page.url(),
      screenshot: shot
    });
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--lang=ko-KR',
    '--window-size=460,1350'
  ]
});

const context = await browser.newContext({
  viewport: { width: 460, height: 1350 },
  deviceScaleFactor: 1,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  colorScheme: 'light',
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6' }
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
});

const naverSpecs = [
  {
    academy: '에릭쌤영어학원',
    shortName: '에릭쌤영어학원',
    address: '대전광역시 대덕구 중리북로 10 유지빌딩 501호',
    addressFragment: '중리북로 10',
    placeId: '1177401952',
    fileName: '01_naver_ericssam_english_visitor_reviews.png'
  },
  {
    academy: '에릭쌤입시영어학원',
    shortName: '에릭쌤입시영어',
    address: '대전광역시 유성구 용산1로 80 호반그랜드프라자 504호',
    addressFragment: '용산1로 80',
    placeId: '2076083264',
    fileName: '02_naver_ericssam_exam_english_visitor_reviews.png'
  }
];

for (const spec of naverSpecs) await captureNaver(context, spec);

const firstDiscovery = await discoverDaangnFirst(context);
await captureDaangn(context, {
  key: 'ericssam-english',
  academy: '에릭쌤영어학원',
  shortName: '에릭쌤영어학원',
  address: '대전광역시 대덕구 중리북로 10 유지빌딩 501호',
  neighborhoods: ['법2동', '법동', '대덕구'],
  fileName: '03_daangn_ericssam_english_reviews.png'
}, firstDiscovery);

const secondDiscovery = await discoverDaangnSecond(context);
await captureDaangn(context, {
  key: 'ericssam-exam-english',
  academy: '에릭쌤입시영어학원',
  shortName: '에릭쌤입시영어',
  address: '대전광역시 유성구 용산1로 80 호반그랜드프라자 504호',
  neighborhoods: ['용산동', '유성구'],
  fileName: '04_daangn_ericssam_exam_english_reviews.png'
}, secondDiscovery);

await browser.close();

manifest.successCount = manifest.items.filter(x => x.status === 'SUCCESS').length;
manifest.failureCount = manifest.items.filter(x => x.status !== 'SUCCESS').length;
await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
await fs.writeFile(path.join(OUT, 'capture_summary.txt'), manifest.items.map((x, i) => `${i + 1}. ${x.academy} | ${x.platform} | ${x.reviewType} | ${x.status} | ${x.screenshot?.fileName ?? 'no screenshot'} | ${x.reason ?? 'OK'} | ${x.finalUrl ?? ''}`).join('\n') + '\n', 'utf8');

console.log(JSON.stringify(manifest, null, 2));
