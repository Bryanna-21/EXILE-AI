const { chromium } = require('playwright');
const URL = 'http://127.0.0.1:4177/';
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const unlock = async () => { await page.goto(URL); await page.waitForLoadState('networkidle'); await page.getByLabel('Unlock with Face ID').click(); await sleep(2600); };
  await unlock();
  const box = page.getByLabel('Message', { exact: true });
  await page.locator('input[type=file]').first().setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('persist me please') },
    { name: 'pic.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await box.fill('here are files'); await box.press('Enter');
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Sending"]'), null, { timeout: 20000 });
  await sleep(800);
  check(await page.getByTestId('file-card').count() + await page.locator('[data-testid=image-card]').count() >= 2 || await page.locator('[data-role=user] img, [data-role=user] [data-testid^=file]').count() >= 1, 'attachments render before reload');
  const dbInfo = await page.evaluate(async () => { const dbs = await indexedDB.databases(); return dbs.map(d => d.name); });
  check(dbInfo.includes('exile-chat-media'), 'IndexedDB database created: ' + dbInfo.join(','));
  await page.reload(); await page.waitForLoadState('networkidle'); await page.getByLabel('Unlock with Face ID').click(); await sleep(2600);
  await sleep(1000);
  const missing = await page.getByTestId('file-missing').count();
  check(missing === 0, 'no "no longer stored" notices after reload (missing=' + missing + ')');
  const txt = await page.locator('[data-role=user]').first().innerText();
  check(/notes\.txt/.test(txt), 'file card for notes.txt present after reload');
  const imgs = await page.locator('[data-role=user] img').count();
  check(imgs >= 1, 'image preview restored after reload (imgs=' + imgs + ')');
  // deleting the message removes stored media
  const row = page.locator('[data-role=user]').first();
  await row.hover(); await row.getByRole('button', { name: 'Message actions' }).click(); await page.getByRole('menuitem', { name: /delete/i }).click();
  await sleep(9000);
  const left = await page.evaluate(() => new Promise((res) => { const r = indexedDB.open('exile-chat-media'); r.onsuccess = () => { const q = r.result.transaction('media').objectStore('media').count(); q.onsuccess = () => res(q.result); }; }));
  check(left === 0, 'stored media removed after the message delete is final (records left: ' + left + ')');
  check(errors.length === 0, 'no page errors ' + errors.join('|'));
  await browser.close(); process.exit(failures ? 1 : 0);
})();
