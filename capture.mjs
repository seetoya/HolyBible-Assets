import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = path.resolve('screenshots');
await fs.mkdir(OUT, { recursive: true });

const targets = {
  naverMain: {
    item: 1,
    academy: '에릭쌤영어학원',
    platform: '네이버 플레이스',
    reviewType: '방문자/영수증 리뷰',
    expectedAddress: '대전광역시 대덕구 중리북로 10 유지빌딩 501호',
    requestedUrl: 'https://m.place.naver.com/place/1177401952/review/visitor',
    successFile: '01_naver_ericssam_english_visitor_reviews.png',
    failureStem: '01_naver_ericssam_english_visitor_reviews'
  },
  naverExam: {
    item: 2,
    academy: '에릭쌤입시영어학원',
    platform: '네이버 플레이스',
    reviewType: '방문자/영수증 리뷰',
    expectedAddress: '대전광역시 유성구 용산1로 80 호반그랜드프라자 504호',
    requestedUrl: 'https://m.place.naver.com/place/2076083264/review/visitor',
    successFile: '02_naver_ericssam_exam_english_visitor_reviews.png',
    failureStem: '02_naver_ericssam_exam_english_visitor_reviews'
  },
  daangnMain: {
    item: 3,
    academy: '에릭쌤영어학원',
    platform: '당근 동네업체',
    reviewType: '후기',
    expectedAddress: '대전광역시 대덕구 중리북로 10 유지빌딩 501호',
    requestedUrl: 'https://www.daangn.com/kr/business-post/%EB%AA%85%EC%84%9D%EA%B3%A0-2%ED%95%99%EB%85%84-24%EB%85%84-9%EC%9B%94-2%EB%93%B1%EA%B8%89-1%EB%93%B1%EA%B8%89-66f448dcb49987074fb9fe47/',
    successFile: '03_daangn_ericssam_english_reviews.png',
    failureStem: '03_daangn_ericssam_english_reviews'
  },
  daangnExam: {
    item: 4,
    academy: '에릭쌤입시영어학원',
    searchName: '에릭쌤입시영어',
    platform: '당근 동네업체',
    reviewType: '후기',
    expectedAddress: '대전광역시 유성구 용산1로 80 호반그랜드프라자 504호',
    requestedUrl: 'https://www.daangn.com/kr/local-profile/?in=%EC%8B%A0%EC%9D%BC%EB%8F%99-5742&themeIds=123%2C118%2C209%2C189%2C166%2C192%2C156%2C442',
    successFile: '04_daangn_ericssam_exam_english_reviews.png',
    failureStem: '04_daangn_ericssam_exam_english_reviews'
  }
};

const manifest = {
  generatedAt: new Date().toISOString(),
  method: 'GitHub Actions Ubuntu runner + Playwright Chromium; live public webpages rendered directly',
  viewport: { width: 1280, height: 1600 },
  items: []
};

const browser = await chromium.launch({
  headless: true,
  args: ['--lang=ko-KR', '--disable-blink-features=AutomationControlled']
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 1600 },
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  colorScheme: 'light',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  extraHTTPHeaders: {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4'
  }
});

async function newObservedPage() {
  const page = await context.newPage();
  const consoleErrors = [];
  const requestFailures = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 500));
  });
  page.on('requestfailed', req => {
    requestFailures.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText || 'unknown'}`.slice(0, 800));
  });
  return { page, consoleErrors, requestFailures };
}

async function gotoLive(page, url) {
  let responseStatus = null;
  let navigationError = null;
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
    responseStatus = response?.status() ?? null;
  } catch (error) {
    navigationError = String(error?.message || error);
  }
  await page.waitForTimeout(10000);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(2500);
  return { responseStatus, navigationError };
}

async function dismissCommonOverlays(page) {
  const labels = ['닫기', '나중에', '취소', '확인', '동의하고 계속', '앱에서 보기 닫기'];
  for (const label of labels) {
    const loc = page.getByRole('button', { name: label, exact: true });
    try {
      const count = Math.min(await loc.count(), 3);
      for (let i = 0; i < count; i++) {
        if (await loc.nth(i).isVisible()) await loc.nth(i).click({ timeout: 1200 }).catch(() => {});
      }
    } catch {}
  }
  await page.keyboard.press('Escape').catch(() => {});
}

async function bodyText(page) {
  try {
    return (await page.locator('body').innerText({ timeout: 15000 })).replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

async function findBestReviewAnchor(page, platform) {
  const patterns = platform === 'naver'
    ? [/방문자\s*리뷰/i, /영수증\s*리뷰/i, /리뷰/i]
    : [/^후기(?:\s*\d+)?$/i, /후기\s*\d+/i, /후기/i];

  for (const pattern of patterns) {
    const loc = page.getByText(pattern);
    const count = Math.min(await loc.count().catch(() => 0), 80);
    let best = null;
    for (let i = 0; i < count; i++) {
      const item = loc.nth(i);
      try {
        if (!(await item.isVisible())) continue;
        const box = await item.boundingBox();
        if (!box || box.width < 10 || box.height < 8) continue;
        const text = ((await item.innerText().catch(() => '')) || '').trim();
        const score = (text.length < 40 ? 10 : 0) + (box.y > 200 ? 3 : 0) + (box.width < 800 ? 2 : 0);
        if (!best || score > best.score) best = { item, box, text, score };
      } catch {}
    }
    if (best) return best;
  }
  return null;
}

async function focusReviewArea(page, platform) {
  const found = await findBestReviewAnchor(page, platform);
  if (found) {
    await found.item.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(1800);
    const y = await found.item.evaluate(el => el.getBoundingClientRect().top + window.scrollY).catch(() => 0);
    await page.evaluate(targetY => window.scrollTo({ top: Math.max(0, targetY - 300), behavior: 'instant' }), y);
    await page.waitForTimeout(1500);
    return { found: true, text: found.text, documentY: y };
  }
  await page.evaluate(() => window.scrollTo({ top: Math.floor(document.documentElement.scrollHeight * 0.58), behavior: 'instant' }));
  await page.waitForTimeout(1800);
  return { found: false, text: null, documentY: null };
}

async function captureViewport(page, fileName) {
  const filePath = path.join(OUT, fileName);
  await page.screenshot({ path: filePath, fullPage: false, animations: 'disabled' });
  return filePath;
}

async function discoverBusinessProfileHref(page, names) {
  const values = await page.locator('a').evaluateAll(anchors => anchors.map(a => ({
    text: (a.textContent || '').replace(/\s+/g, ' ').trim(),
    href: a.href || ''
  })).filter(x => x.href)).catch(() => []);

  const normalizedNames = names.map(x => x.replace(/\s+/g, ''));
  const scored = values.map(v => {
    const compact = v.text.replace(/\s+/g, '');
    let score = 0;
    if (normalizedNames.some(n => compact.includes(n))) score += 100;
    if (/business-profiles|business-profile|local-profile/.test(v.href)) score += 40;
    if (/business-post/.test(v.href)) score -= 30;
    return { ...v, score };
  }).filter(v => v.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length) return { href: scored[0].href, candidates: scored.slice(0, 10) };

  const html = await page.content().catch(() => '');
  const prefixes = [
    'https://www.daangn.com/kr/business-profiles/',
    '/kr/business-profiles/',
    'https://www.daangn.com/kr/business-profile/',
    '/kr/business-profile/'
  ];
  for (const prefix of prefixes) {
    const idx = html.indexOf(prefix);
    if (idx >= 0) {
      let end = idx;
      while (end < html.length && !['"', "'", '<', '>', ' ', '\\'].includes(html[end])) end++;
      const raw = html.slice(idx, end).replaceAll('&amp;', '&');
      const href = raw.startsWith('http') ? raw : new URL(raw, page.url()).href;
      return { href, candidates: [{ text: 'HTML-discovered profile URL', href, score: 1 }] };
    }
  }
  return { href: null, candidates: values.filter(v => normalizedNames.some(n => v.text.replace(/\s+/g, '').includes(n))).slice(0, 20) };
}

function classifyBody(text, academy, platform) {
  const lower = text.toLowerCase();
  const blockedTerms = ['접근이 제한', 'captcha', 'robot', '비정상적인 접근', '서비스를 이용할 수 없습니다', '페이지를 찾을 수 없습니다', '오류가 발생'];
  const blocked = blockedTerms.find(term => lower.includes(term.toLowerCase()));
  const academyPresent = text.replace(/\s+/g, '').includes(academy.replace(/\s+/g, '')) ||
    (academy === '에릭쌤입시영어학원' && text.replace(/\s+/g, '').includes('에릭쌤입시영어'));
  const reviewPresent = platform === 'naver' ? /방문자\s*리뷰|영수증\s*리뷰|리뷰/.test(text) : /후기/.test(text);
  return { blocked: blocked || null, academyPresent, reviewPresent };
}

async function captureNaver(target) {
  const observed = await newObservedPage();
  const { page, consoleErrors, requestFailures } = observed;
  const nav = await gotoLive(page, target.requestedUrl);
  await dismissCommonOverlays(page);
  const focus = await focusReviewArea(page, 'naver');
  const text = await bodyText(page);
  const cls = classifyBody(text, target.academy, 'naver');
  const success = !cls.blocked && cls.academyPresent && cls.reviewPresent;
  const fileName = success ? target.successFile : `${target.failureStem}_${cls.blocked ? 'blocked' : 'not_found'}.png`;
  await captureViewport(page, fileName);
  const record = {
    ...target,
    status: success ? 'CAPTURED' : (cls.blocked ? 'BLOCKED_SCREEN_CAPTURED' : 'REVIEW_SCREEN_NOT_CONFIRMED'),
    reason: success ? '학원명과 리뷰 관련 문구가 실제 렌더링 화면에서 확인됨' : (cls.blocked || '학원명 또는 리뷰 영역을 화면에서 동시에 확인하지 못함'),
    finalUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
    responseStatus: nav.responseStatus,
    navigationError: nav.navigationError,
    focus,
    academyPresent: cls.academyPresent,
    reviewPresent: cls.reviewPresent,
    screenshot: fileName,
    evidenceText: text.slice(0, 2500),
    consoleErrors: consoleErrors.slice(0, 20),
    requestFailures: requestFailures.slice(0, 20)
  };
  await page.close();
  manifest.items.push(record);
}

async function captureDaangn(target) {
  const observed = await newObservedPage();
  const { page, consoleErrors, requestFailures } = observed;
  const startNav = await gotoLive(page, target.requestedUrl);
  await dismissCommonOverlays(page);

  const names = [target.academy, target.searchName || target.academy];
  let discovery = await discoverBusinessProfileHref(page, names);
  let profileNavigation = null;

  if (discovery.href && discovery.href !== page.url()) {
    profileNavigation = await gotoLive(page, discovery.href);
    await dismissCommonOverlays(page);
  } else if (!discovery.href) {
    const card = page.getByText(new RegExp((target.searchName || target.academy).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).first();
    try {
      if (await card.isVisible()) {
        await card.click({ timeout: 5000 });
        await page.waitForTimeout(8000);
        discovery = { ...discovery, clickedTextFallback: true };
      }
    } catch {}
  }

  await dismissCommonOverlays(page);
  const focus = await focusReviewArea(page, 'daangn');
  const text = await bodyText(page);
  const cls = classifyBody(text, target.academy, 'daangn');
  const success = !cls.blocked && cls.academyPresent && cls.reviewPresent;
  const fileName = success ? target.successFile : `${target.failureStem}_${cls.blocked ? 'blocked' : 'not_found'}.png`;
  await captureViewport(page, fileName);

  const record = {
    ...target,
    status: success ? 'CAPTURED' : (cls.blocked ? 'BLOCKED_SCREEN_CAPTURED' : 'REVIEW_SCREEN_NOT_CONFIRMED'),
    reason: success ? '학원명과 후기 관련 문구가 실제 렌더링 화면에서 확인됨' : (cls.blocked || '정확한 상세 업체 후기 영역을 화면에서 확인하지 못함'),
    startUrl: target.requestedUrl,
    discoveredProfileUrl: discovery.href,
    discoveryCandidates: discovery.candidates,
    finalUrl: page.url(),
    pageTitle: await page.title().catch(() => ''),
    responseStatus: profileNavigation?.responseStatus ?? startNav.responseStatus,
    navigationError: profileNavigation?.navigationError ?? startNav.navigationError,
    focus,
    academyPresent: cls.academyPresent,
    reviewPresent: cls.reviewPresent,
    screenshot: fileName,
    evidenceText: text.slice(0, 3000),
    consoleErrors: consoleErrors.slice(0, 20),
    requestFailures: requestFailures.slice(0, 20)
  };
  await page.close();
  manifest.items.push(record);
}

async function fileInfo(fileName) {
  const filePath = path.join(OUT, fileName);
  const bytes = await fs.readFile(filePath);
  const stat = await fs.stat(filePath);
  const width = bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG' ? bytes.readUInt32BE(16) : null;
  const height = bytes.length >= 24 && bytes.toString('ascii', 1, 4) === 'PNG' ? bytes.readUInt32BE(20) : null;
  return {
    bytes: stat.size,
    width,
    height,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

try {
  await captureNaver(targets.naverMain);
  await captureNaver(targets.naverExam);
  await captureDaangn(targets.daangnMain);
  await captureDaangn(targets.daangnExam);
} finally {
  await browser.close();
}

for (const item of manifest.items) {
  item.file = await fileInfo(item.screenshot);
}

await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const lines = [
  '# 실제 리뷰 화면 캡처 결과',
  '',
  `생성 시각: ${manifest.generatedAt}`,
  ''
];
for (const item of manifest.items.sort((a, b) => a.item - b.item)) {
  lines.push(`## ${item.item}. ${item.academy} / ${item.platform} / ${item.reviewType}`);
  lines.push(`- 상태: ${item.status}`);
  lines.push(`- 파일: ${item.screenshot}`);
  lines.push(`- 최종 URL: ${item.finalUrl}`);
  lines.push(`- 기준 주소: ${item.expectedAddress}`);
  lines.push(`- 사유: ${item.reason}`);
  lines.push(`- 크기: ${item.file.width}×${item.file.height}, ${item.file.bytes} bytes`);
  lines.push(`- SHA-256: ${item.file.sha256}`);
  lines.push('');
}
await fs.writeFile(path.join(OUT, 'capture_list.md'), lines.join('\n'), 'utf8');

console.log(JSON.stringify(manifest, null, 2));
