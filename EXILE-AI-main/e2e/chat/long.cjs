const { chromium } = require('playwright');
const N = Number(process.env.N || 600);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const turns = []; const now = Date.now();
  for (let i = 0; i < N; i++) turns.push({ id: 't' + i, role: i % 2 ? 'exile' : 'user', at: now - (N - i) * 60000, text: i % 2 ? 'Reply ' + i + ': ' + 'lorem ipsum dolor sit amet '.repeat(12) + '\n\n```js\nconst x = ' + i + ';\nconsole.log(x);\n```' : 'Question ' + i + ' ' + 'what about this '.repeat(6) });
  await page.addInitScript(([turns]) => { localStorage.setItem('exile.sessions', JSON.stringify([{ id: 's1', title: 'long', turns, startedAt: turns[0].at, updatedAt: Date.now() }])); localStorage.setItem('exile.session.active', 's1'); }, [turns]);
  await page.goto('http://127.0.0.1:4177/'); await page.waitForLoadState('networkidle');
  await page.getByLabel('Unlock with Face ID').click(); await sleep(2600);
  const t0 = Date.now();
  await page.locator('[data-role=exile]').last().waitFor();
  const rendered = await page.locator('[data-role]').count();
  const dom = await page.evaluate(() => document.getElementsByTagName('*').length);
  // typing latency in composer with long history
  const box = page.getByLabel('Message', { exact: true });
  const lat = await page.evaluate(async () => { const ta = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; const times = []; for (let i = 0; i < 20; i++) { const s = performance.now(); set.call(ta, 'x'.repeat(i + 1)); ta.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => requestAnimationFrame(() => r())); times.push(performance.now() - s); } return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]; });
  const scroll = await page.evaluate(async () => { const el = [...document.querySelectorAll('div')].find(d => d.scrollHeight > d.clientHeight + 500 && getComputedStyle(d).overflowY !== 'visible'); if (!el) return null; const s = performance.now(); for (let i = 0; i < 20; i++) { el.scrollTop = (i % 2 ? 0 : el.scrollHeight); await new Promise(r => requestAnimationFrame(() => r())); } return (performance.now() - s) / 20; });
  console.log(JSON.stringify({ N, bubblesInDom: rendered, domNodes: dom, medianTypingFrameMs: Math.round(lat), avgScrollFrameMs: scroll && Math.round(scroll) }));
  await browser.close();
})();
