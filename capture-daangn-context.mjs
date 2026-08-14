import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const OUT = path.resolve('captures');
const targets = [
  {
    academy: '에릭쌤영어학원',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%98%81%EC%96%B4%ED%95%99%EC%9B%90-3p2umcgadi7h/',
    addressFragment: '대전광역시 대덕구 중리북로 10',
    fileName: '03_daangn_ericssam_english_reviews.png'
  },
  {
    academy: '에릭쌤입시영어학원',
    alternateName: '에릭쌤입시영어',
    url: 'https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4-9ea8dgwzru8t/',
    addressFragment: '대전광역시 유성구 용산1로 80',
    fileName: '04_daangn_ericssam_exam_english_reviews.png'
  }
];

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--lang=ko-KR']
});
const context = await browser.newContext({
  viewport: { width: 460, height: 2200 },
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  colorScheme: 'light',
  userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6' }
});
await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

for (const target of targets) {
  const page = await context.newPage();
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(9000);
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  const nameOK = body.includes(target.academy) || (target.alternateName && body.includes(target.alternateName));
  const addressOK = body.includes(target.addressFragment);
  const reviewOK = /후기\s*\d+개|후기\s*\d+/.test(body);
  if (!nameOK || !addressOK || !reviewOK) {
    throw new Error(`${target.academy}: required page evidence missing: name=${nameOK}, address=${addressOK}, review=${reviewOK}`);
  }

  let sectionY = 1700;
  const section = page.getByText(/후기\s*\d+개\s*더보기/).first();
  try {
    if (await section.count()) {
      const box = await section.boundingBox();
      if (box) sectionY = box.y;
    }
  } catch {}
  const targetHeight = Math.max(2200, Math.min(4200, Math.ceil(sectionY + 1450)));
  await page.setViewportSize({ width: 460, height: targetHeight });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, target.fileName), fullPage: false, animations: 'disabled' });
  await page.close();
}
await browser.close();

const manifestPath = path.join(OUT, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
for (const target of targets) {
  const filePath = path.join(OUT, target.fileName);
  const bytes = fsSync.readFileSync(filePath);
  const height = bytes.readUInt32BE(20);
  const width = bytes.readUInt32BE(16);
  const item = manifest.items.find(x => x.academy === target.academy && /Daangn/.test(x.platform));
  if (item) {
    item.finalUrl = target.url;
    item.visualCapture = 'Live Daangn profile page; academy name, registered address, 후기 count, and review content kept in one unedited browser viewport.';
    item.screenshot = {
      fileName: target.fileName,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      width,
      height,
      fullPage: false
    };
  }
}
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
console.log('Daangn context screenshots updated successfully.');
