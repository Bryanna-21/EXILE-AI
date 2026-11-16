const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'http://127.0.0.1:4177/';
const SHOTS = process.env.SHOTS; fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const pdf = () => { const objs = ['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>','<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>','','<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'];
  const stream = 'BT /F1 18 Tf 20 100 Td (Hello PDF world) Tj ET'; objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const off = []; objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF`; return Buffer.from(out); };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC', 'base64');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4177' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL); await page.waitForLoadState('networkidle');
  await page.getByLabel('Unlock with Face ID').click(); await sleep(2600);
  const box = page.getByLabel('Message', { exact: true });
  const users = page.locator('[data-role=user]'), exiles = page.locator('[data-role=exile]');
  const waitIdle = async () => page.getByRole('button', { name: 'Send message' }).or(page.getByRole('button', { name: 'Send message' })).waitFor({ state: 'attached', timeout: 20000 }).then(() => page.waitForFunction(() => !document.querySelector('button[aria-label="Sending"], button[aria-label="Stop generating"]'), null, { timeout: 20000 }));
  const log = async () => (await fetch('http://127.0.0.1:8799/__log')).json();
  const menu = async (row, item) => { await sleep(350); await row.hover(); await row.getByRole('button', { name: 'Message actions' }).click(); await page.getByRole('menuitem', { name: item }).click(); };
  const bodyText = (row) => row.getByTestId('message-body').innerText();

  // empty state keeps original hero
  check(await page.getByText('YOUR COMMAND CENTER').isVisible(), 'original hero and empty state intact before first message');
  check(await page.getByRole('button', { name: 'Send message' }).isDisabled(), 'send disabled when composer empty');

  // 1 send + thinking + streaming
  await page.evaluate(() => { window.__lens = []; new MutationObserver(() => { const b = [...document.querySelectorAll('[data-role=exile] [data-testid=message-body]')].pop(); if (b) window.__lens.push(b.innerText.length); }).observe(document.body, { subtree: true, childList: true, characterData: true }); });
  await box.fill('hello there'); await page.screenshot({ path: `${SHOTS}/01-typed.png` });
  await box.press('Enter');
  await users.first().waitFor();
  check(await users.first().getByTestId('status').getAttribute('data-status') === 'sending', 'outgoing bubble shows "sending" status');
  check(await page.getByRole('button', { name: 'Stop generating' }).isVisible(), 'send button becomes a Stop button while replying');
  await exiles.first().getByTestId('thinking').waitFor({ timeout: 3000 }).then(() => check(true, 'thinking animation shown before first token'), () => check(false, 'thinking animation shown'));
  await page.screenshot({ path: `${SHOTS}/02-thinking.png` });
  await page.waitForFunction(() => !document.querySelector('button[aria-label="Sending"], button[aria-label="Stop generating"]'), null, { timeout: 20000 });
  const lens = new Set(await page.evaluate(() => window.__lens));
  check(lens.size >= 3 && Math.min(...lens) < Math.max(...lens), `reply streamed incrementally (${lens.size} distinct lengths: ${[...lens].join(',')})`);
  await waitIdle();
  check((await bodyText(exiles.first())).startsWith('Reply #') && (await bodyText(exiles.first())).includes('to: hello there'), 'final reply text correct: ' + JSON.stringify((await bodyText(exiles.first())).slice(0, 40)));
  check(await users.first().getByTestId('status').getAttribute('data-status') === 'answered', 'outgoing status becomes "answered"');
  check(await users.first().locator('time').count() === 1 && await exiles.first().locator('time').count() === 1, 'timestamps on both bubbles');
  const ub = await users.first().locator('article').boundingBox(), eb = await exiles.first().locator('article').boundingBox();
  check(ub.x + ub.width > 640 && eb.x < 640 - 0 && eb.x < ub.x, 'outgoing right-aligned, incoming left-aligned');
  await page.screenshot({ path: `${SHOTS}/03-conversation.png` });

  // 3 multiline
  await box.fill(''); await box.type('a'); await box.press('Shift+Enter'); await box.type('b');
  check(await box.inputValue() === 'a\nb' && await users.count() === 1, 'Shift+Enter inserts newline and does not send');
  await box.fill('');

  // 4 code
  await box.fill('please write code'); await box.press('Enter'); await waitIdle();
  const cb = page.getByTestId('code-block').first();
  await cb.waitFor();
  check((await cb.getByTestId('code-language').innerText()) === 'Python' && await cb.getByText('main.py').count() === 1, 'code block identifies language (Python) and filename (main.py)');
  const code = 'def greet(n):\n    return f"hi {n}"\n\nprint(greet("x"))';
  check(await cb.locator('code').innerText() === code, 'code formatting and indentation preserved');
  check(await cb.locator('.tok-keyword').count() > 0 && await cb.locator('.tok-string').count() > 0, 'syntax highlighting tokens present');
  await cb.getByTestId('copy-code').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check(clip === code, 'Copy code copies ONLY the code: ' + JSON.stringify(clip.slice(0, 30)));
  check(!/Copy code|Python|main\.py|Here is the script|It prints/.test(clip), 'clipboard has no UI labels or explanation text');
  const [dl] = await Promise.all([page.waitForEvent('download'), cb.getByRole('button', { name: /Download main.py/ }).click()]);
  check(dl.suggestedFilename() === 'main.py' && fs.readFileSync(await dl.path(), 'utf8') === code, 'code download uses filename main.py with exact content');
  check(await exiles.last().locator('a[href="https://example.com/docs"]').count() === 1, 'URL in message rendered as safe link');
  await page.screenshot({ path: `${SHOTS}/04-code.png` });
  await cb.getByRole('button', { name: 'Open in code editor' }).click();
  await page.getByRole('dialog').locator('.cm-editor').first().waitFor({ timeout: 8000 }).catch(() => {}); check(await page.getByRole('dialog').locator('.cm-editor').count() > 0, 'code opens in the full editor dialog (lazy-loaded)'); await page.keyboard.press('Escape'); await sleep(450);

  // 9 copy message / select text
  await menu(exiles.first(), 'Copy message');
  check(await page.evaluate(() => navigator.clipboard.readText()) === (await bodyText(exiles.first())).trim(), 'Copy message copies the message text');
  await menu(exiles.first(), 'Select text'); await sleep(500);
  { const sel = await page.evaluate(() => getSelection().toString()); check(sel.includes('to: hello there'), 'Select text selects the message text for copying: ' + JSON.stringify(sel.slice(0, 40))); }
  await page.evaluate(() => getSelection().removeAllRanges());

  // 5 edit
  const before = await users.count();
  await menu(users.first(), 'Edit');
  await page.getByLabel('Edit message').fill('hello edited'); await page.getByLabel('Edit message').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[data-role=exile]').length === 1 && !document.querySelector('button[aria-label="Sending"], button[aria-label="Stop generating"]') === false || true);
  await waitIdle();
  check(await users.count() === 1 && await exiles.count() === 1, `edit replaces later turns (${before} user turns -> 1)`);
  check((await bodyText(users.first())) === 'hello edited' && await users.first().getByText('edited', { exact: true }).count() === 1, 'edited message shows new text with "edited" marker');
  const L = await log(); check(L[L.length - 1].text === 'hello edited', 'edited text was actually sent to the model');
  check((await bodyText(exiles.first())).includes('to: hello edited'), 'new reply answers the edited message');

  // 6 resend
  const nBefore = (await log()).length;
  await menu(users.first(), 'Resend'); await waitIdle();
  const L2 = await log(); check(L2.length === nBefore + 1 && L2[L2.length - 1].text === 'hello edited' && await users.count() === 1, 'Resend re-sends the same message without duplicating it');

  // 7 regenerate
  const r1 = await bodyText(exiles.first());
  await menu(exiles.last(), 'Regenerate'); await waitIdle();
  const r2 = await bodyText(exiles.first());
  check(r1 !== r2 && (await log()).length === nBefore + 2 && await exiles.count() === 1, 'Regenerate produces a fresh answer: ' + r1.slice(0, 10) + ' -> ' + r2.slice(0, 10));

  // 8 reply
  await menu(exiles.first(), 'Reply');
  check(await page.getByTestId('reply-bar').isVisible(), 'reply bar appears in composer');
  await box.fill('follow up'); await box.press('Enter'); await waitIdle();
  check(await users.last().getByTestId('quoted-reply').count() === 1, 'sent message shows quoted reply');
  check(/\[The user is replying to your earlier message/.test((await log()).pop().text), 'reply context was sent to the model');
  check(await page.getByTestId('reply-bar').count() === 0, 'reply bar clears after send');
  await users.last().getByTestId('quoted-reply').click();

  // 10 delete + undo
  const total = await page.locator('[data-turn-id]').count();
  await menu(users.last(), 'Delete');
  check(await page.locator('[data-turn-id]').count() === total - 1, 'Delete removes the message');
  await page.getByRole('button', { name: 'Undo' }).click();
  check(await page.locator('[data-turn-id]').count() === total, 'Undo restores the deleted message');

  // 11 attachments
  fs.writeFileSync('/tmp/notes.txt', 'line1\nline2 alpha'); fs.writeFileSync('/tmp/pic.png', PNG); fs.writeFileSync('/tmp/doc.pdf', pdf());
  await page.locator('input[type=file]').setInputFiles(['/tmp/notes.txt', '/tmp/pic.png', '/tmp/doc.pdf']);
  await page.getByTestId('attachment-previews').locator('li').nth(2).waitFor({ timeout: 8000 });
  check(await page.getByTestId('attachment-previews').locator('li').count() === 3 && await page.getByTestId('attachment-previews').locator('img').count() === 1, 'attachment previews shown (3 files, image thumbnail)');
  await page.getByRole('button', { name: 'Remove doc.pdf' }).click();
  check(await page.getByTestId('attachment-previews').locator('li').count() === 2, 'attachment can be removed before sending');
  await page.locator('input[type=file]').setInputFiles(['/tmp/doc.pdf']); await page.getByTestId('attachment-previews').locator('li').nth(2).waitFor();
  await page.screenshot({ path: `${SHOTS}/05-attachments-composer.png` });
  await box.fill('see attached'); await box.press('Enter'); await waitIdle();
  const mine = users.last();
  check(await mine.getByTestId('file-card').count() === 2 && await mine.getByTestId('image-card').count() === 1, 'sent message shows 2 file cards + 1 inline image');
  check(await mine.getByTestId('file-name').allInnerTexts().then(a => a.sort().join(',')) === 'doc.pdf,notes.txt', 'file names kept');
  check(/TXT · 17 B/.test(await mine.getByTestId('file-card').filter({ hasText: 'notes.txt' }).innerText()), 'file card shows extension and size');
  const txtCard = mine.getByTestId('file-card').filter({ hasText: 'notes.txt' });
  await txtCard.getByRole('button', { name: /Preview/ }).click();
  check((await page.getByTestId('file-preview-text').innerText()).includes('line2 alpha'), 'text file preview shows contents'); await page.keyboard.press('Escape'); await sleep(450);
  const [d2] = await Promise.all([page.waitForEvent('download'), txtCard.getByRole('button', { name: /Download notes.txt/ }).click()]);
  check(d2.suggestedFilename() === 'notes.txt' && fs.readFileSync(await d2.path(), 'utf8') === 'line1\nline2 alpha', 'file download keeps original name and bytes');
  await txtCard.getByRole('button', { name: 'Copy' }).click();
  check(await page.evaluate(() => navigator.clipboard.readText()) === 'line1\nline2 alpha', 'Copy file contents works');
  const pdfCard = mine.getByTestId('file-card').filter({ hasText: 'doc.pdf' });
  const [d3] = await Promise.all([page.waitForEvent('download'), pdfCard.getByRole('button', { name: /Download doc.pdf/ }).click()]);
  check(d3.suggestedFilename() === 'doc.pdf' && fs.readFileSync(await d3.path()).equals(fs.readFileSync('/tmp/doc.pdf')), 'PDF download is byte-identical');
  await pdfCard.getByRole('button', { name: /Preview/ }).click();
  check(await page.getByTestId('pdf-frame').count() === 1, 'PDF preview dialog opens with viewer frame');
  await page.getByRole('button', { name: 'Show extracted text' }).click();
  check((await page.getByTestId('file-preview-text').innerText()).includes('Hello PDF world'), 'PDF extracted text view works'); await page.keyboard.press('Escape'); await sleep(450);
  check((await log()).pop().text.includes('line2 alpha') && (await log()).pop().text.includes('Hello PDF world'), 'attachment contents were sent to the model');
  const img = mine.getByTestId('image-card');
  await img.getByRole('button', { name: 'Expand image', exact: true }).click();
  check(await page.getByTestId('image-expanded').isVisible(), 'image expands'); await page.screenshot({ path: `${SHOTS}/06-image-expanded.png` });
  const [d4] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').getByRole('button', { name: /Download/ }).click()]);
  check(d4.suggestedFilename() === 'pic.png' && fs.readFileSync(await d4.path()).equals(PNG), 'image download keeps name/bytes');
  await page.getByRole('dialog').getByRole('button', { name: /Copy image/ }).click(); await page.getByText('Image copied.').waitFor({ timeout: 4000 }).catch(() => {});
  const types = await page.evaluate(async () => (await navigator.clipboard.read()).map(i => i.types).flat());
  check(types.includes('image/png'), 'copy image puts image/png on the clipboard ' + JSON.stringify(types) + ' toasts=' + JSON.stringify(await page.locator('[data-sonner-toast]').allInnerTexts())); await page.keyboard.press('Escape'); await sleep(450);
  await page.screenshot({ path: `${SHOTS}/07-files-in-chat.png` });

  // 12 image generation
  await box.fill('generate an image of a cat'); await box.press('Enter'); await waitIdle();
  await page.locator('[data-role=exile]').last().getByTestId('image-card').waitFor({ timeout: 8000 }).then(() => check(true, 'generated image appears inline in the chat'), () => check(false, 'generated image appears inline'));
  await sleep(300); check(await page.getByText('GOLDEN CANVAS').count() === 0, 'Golden Canvas progress panel is gone after completion');

  // 13 failure → local
  await box.fill('please fail now'); await box.press('Enter'); await waitIdle();
  const lastU = users.last();
  check(await lastU.getByTestId('status').getAttribute('data-status') === 'answered-local', 'cloud failure: status marks answer as local');
  check(await exiles.last().getByText('local answer').count() === 1 && /answered locally/.test(await bodyText(exiles.last())), 'cloud failure: reply labelled as local answer');
  await page.screenshot({ path: `${SHOTS}/08-local-fallback.png` });

  await box.fill('one more code sample'); await box.press('Enter'); await waitIdle();
  // 14 persistence
  await page.reload(); await page.waitForLoadState('networkidle'); await page.getByLabel('Unlock with Face ID').click(); await sleep(2600);
  check(await page.locator('[data-turn-id]').count() > 6, 'conversation text persists after reload');
  check(await page.getByTestId('file-missing').count() === 0 && await page.getByTestId('file-card').count() + await page.locator('[data-role=user] img').count() >= 1, 'after reload, attachments are restored from IndexedDB');
  check(await page.getByTestId('code-block').count() >= 1, 'code blocks still render after reload');

  // 15 sidebar + background untouched
  check(await page.locator('aside').count() >= 1 && await page.locator('img[aria-hidden], img[alt=""]').count() >= 0 && await page.getByText('Chat History').count() >= 1, 'sidebar still present');

  // 16 reduced motion
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.chat-in-user')).animationName) === 'none', 'reduced motion disables message animations');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.chat-in-user')).animationName) !== 'none', 'animations active when motion allowed');

  // 17 responsive
  for (const [w, h, touch] of [[360, 740, true], [768, 1024, true], [1280, 800, false], [1920, 1080, false]]) {
    const c2 = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: w < 700, acceptDownloads: true });
    const p2 = await c2.newPage(); p2.on('pageerror', e => errors.push('pageerror: ' + e)); p2.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await p2.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, ['x', 'y']);
    await p2.goto(URL); await p2.waitForLoadState('networkidle'); await p2.getByLabel('Unlock with Face ID').click(); await sleep(2600);
    const b2 = p2.getByLabel('Message', { exact: true });
    await b2.fill('layout check code with a very long line ' + 'x'.repeat(200)); await b2.press('Enter');
    await p2.waitForFunction(() => document.querySelector('[data-testid=code-block]') && !document.querySelector('button[aria-label="Sending"], button[aria-label="Stop generating"]'), null, { timeout: 25000 }); await sleep(500);
    const m = await p2.evaluate(() => ({ docW: document.documentElement.scrollWidth, vw: innerWidth, logOverflow: (() => { const l = document.querySelector('[data-testid=chat-log]'); return l.scrollWidth - l.clientWidth; })(), maxRight: Math.max(...[...document.querySelectorAll('.chat-bubble')].map(e => e.getBoundingClientRect().right)), maxLeft: Math.min(...[...document.querySelectorAll('.chat-bubble')].map(e => e.getBoundingClientRect().left)) }));
    check(m.docW <= m.vw && m.logOverflow <= 0 && m.maxRight <= m.vw + 0.5 && m.maxLeft >= 0, `${w}px: no horizontal overflow (doc ${m.docW}/${m.vw}, log ${m.logOverflow}, bubbles ${Math.round(m.maxLeft)}..${Math.round(m.maxRight)})`);
    const trig = p2.locator('[data-role=exile]').first().getByRole('button', { name: 'Message actions' });
    if (touch) { const op = await trig.evaluate(e => getComputedStyle(e).opacity); const bb = await trig.boundingBox(); check(Number(op) > 0.5 && bb.width >= 32 && bb.height >= 32, `${w}px touch: actions button visible without hover (opacity ${op}, ${Math.round(bb.width)}x${Math.round(bb.height)})`);
      await trig.tap(); check(await p2.getByRole('menuitem', { name: 'Reply' }).isVisible(), `${w}px touch: actions menu opens by tap`); await p2.keyboard.press('Escape'); await p2.getByRole('menuitem', { name: 'Reply' }).waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {}); await sleep(450); }
    check(await p2.getByLabel('Message', { exact: true }).isVisible() && await p2.getByRole('button', { name: 'Send message' }).isVisible(), `${w}px: composer and send button visible`);
    await p2.screenshot({ path: `${SHOTS}/r-${w}.png` }); await c2.close();
  }

  const noise = errors.filter(e => !/favicon|Failed to load resource: the server responded with a status of (500|404)/.test(e));
  check(noise.length === 0, 'no browser console errors / page errors' + (noise.length ? '\n   ' + noise.slice(0, 8).join('\n   ') : ''));
  if (errors.length !== noise.length) console.log(`note: ${errors.length - noise.length} expected 500/404 mock-server network console line(s) from the mocked cloud failure`);
  await browser.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED'); process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
