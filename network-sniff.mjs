import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
const OUT=path.resolve('network-sniff-output'); await fs.rm(OUT,{recursive:true,force:true}); await fs.mkdir(OUT,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--lang=ko-KR']});
const targets=[
 ['naver','https://m.place.naver.com/place/1177401952/review/visitor'],
 ['daangn_main','https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%98%81%EC%96%B4%ED%95%99%EC%9B%90-3p2umcgadi7h/'],
 ['daangn_exam','https://www.daangn.com/kr/local-profile/%EC%97%90%EB%A6%AD%EC%8C%A4%EC%9E%85%EC%8B%9C%EC%98%81%EC%96%B4-9ea8dgwzru8t/']
];
const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
for(const [name,url] of targets){
 const c=await browser.newContext({viewport:{width:460,height:1400},locale:'ko-KR',timezoneId:'Asia/Seoul',userAgent:'Mozilla/5.0 (Linux; Android 15; SM-S938N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',extraHTTPHeaders:{'Accept-Language':'ko-KR,ko;q=0.9'}}); await c.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
 const p=await c.newPage(); const log={name,url,requests:[],responses:[]};
 p.on('request',r=>{if(['xhr','fetch'].includes(r.resourceType())) log.requests.push({method:r.method(),url:r.url(),postData:(r.postData()||'').slice(0,10000)})});
 p.on('response',async r=>{const req=r.request(),ct=r.headers()['content-type']||'';if(['xhr','fetch'].includes(req.resourceType())){const x={status:r.status(),url:r.url(),ct};if(/json/.test(ct)&&r.status()<400){try{x.body=(await r.text()).slice(0,50000)}catch(e){x.err=String(e)}}log.responses.push(x)}});
 const resp=await p.goto(url,{waitUntil:'domcontentloaded',timeout:90000}); log.http=resp?.status(); await p.waitForTimeout(10000);
 if(name==='naver'){
   log.body=norm(await p.locator('body').innerText()).slice(0,20000);
   await p.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight)); await p.waitForTimeout(2000);
   log.more=await p.evaluate(()=>{const n=v=>String(v||'').replace(/\s+/g,' ').trim();const vis=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};return [...document.querySelectorAll('button,a,[role="button"]')].filter(e=>vis(e)&&n(e.innerText)==='더보기').map((e,i)=>{const r=e.getBoundingClientRect();return{i,tag:e.tagName,cls:e.className,href:e.getAttribute('href'),aria:e.getAttribute('aria-label'),y:r.y+scrollY,html:e.outerHTML.slice(0,1000),parent:n(e.parentElement?.innerText).slice(0,1000)}})});
   const semantic=p.locator('button,a,[role="button"]').filter({hasText:/^더보기$/}); const count=await semantic.count(); if(count){let best=-1,bestY=-1;for(let i=0;i<count;i++){try{const el=semantic.nth(i);if(await el.isVisible()){const b=await el.boundingBox();if(b&&b.y>bestY){bestY=b.y;best=i}}}catch{}} if(best>=0){log.clicked={index:best,beforeUrl:p.url()};try{await semantic.nth(best).click({timeout:5000});await p.waitForTimeout(7000);log.clicked.afterUrl=p.url();log.clicked.body=norm(await p.locator('body').innerText()).slice(0,5000)}catch(e){log.clicked.error=String(e)}}}
 } else {
   log.body=norm(await p.locator('body').innerText()).slice(0,20000);
   const more=p.getByText('더보기',{exact:true});const cnt=await more.count();for(let i=0;i<cnt;i++){try{const el=more.nth(i);if(await el.isVisible()){let n=el;for(let k=0;k<6;k++){const t=norm(await n.innerText());if(/후기\s*\d+개/.test(t)){await el.click({timeout:4000});log.reviewMoreIndex=i;k=99;break}n=n.locator('xpath=..')}}}catch{}} await p.waitForTimeout(5000);
   await p.evaluate(()=>{window.scrollTo(0,document.documentElement.scrollHeight);for(const e of document.querySelectorAll('body *'))if(e.scrollHeight>e.clientHeight+40)e.scrollTop=e.scrollHeight}); await p.waitForTimeout(5000);
   log.bodyAfter=norm(await p.locator('body').innerText()).slice(0,30000);
 }
 await fs.writeFile(path.join(OUT,`${name}.json`),JSON.stringify(log,null,2),'utf8'); await c.close();
}
await browser.close();
