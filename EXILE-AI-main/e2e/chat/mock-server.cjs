// Mock EXILE cloud: SSE chat with delays, image endpoint, request log.
const http = require('http');
const log = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC','base64').toString('base64');
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const srv = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.url === '/health') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url === '/__log') { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  let body = ''; for await (const c of req) body += c;
  let j = {}; try { j = JSON.parse(body); } catch {}
  if (req.url.endsWith('/exile-chat')) {
    const msgs = j.messages || [];
    const last = msgs.filter(m => m.role === 'user').pop();
    const text = typeof last?.content === 'string' ? last.content : (last?.content || []).map(c => c.text || '').join('');
    log.push({ fn: 'chat', text, n: msgs.length });
    if (/\bfail\b/i.test(text)) { res.writeHead(500, { ...cors, 'content-type': 'text/plain' }); return res.end('boom'); }
    if (/slowstream/i.test(text)) {
      res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
      let closed = false; res.on('close', () => { closed = true; log.push({ fn: 'slow-closed-by-client' }); });
      for (let i = 0; i < 60 && !closed; i++) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'word' + i + ' ' } }] }) + '\n\n'); await sleep(150); }
      if (!closed) { log.push({ fn: 'slow-completed' }); res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }
    await sleep(700);
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    let out;
    if (/code/i.test(text)) out = ['Here is the script:\n\n```py', 'thon main.py\ndef greet(n):\n', '    return f"hi {n}"\n\nprint(greet("x"))\n', '```\n\nIt prints a greeting. See https://example.com/docs.'];
    else out = ('Reply #' + (log.length) + ' to: ' + text.replace(/\[The user is replying[^\n]*\n/, '[ctx]\n')).match(/.{1,5}/gs);
    for (const c of out) { res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: c } }] }) + '\n\n'); await sleep(90); }
    res.write('data: [DONE]\n\n'); return res.end();
  }
  if (/exile-image|image/.test(req.url)) {
    log.push({ fn: 'image' });
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' });
    res.write('event: image_generation.completed\ndata: ' + JSON.stringify({ type: 'image_generation.completed', b64_json: PNG }) + '\n\n');
    return res.end();
  }
  res.writeHead(404, cors); res.end('no');
});
srv.listen(8799, '127.0.0.1'); srv.listen2 = 1; require('http').createServer(srv.listeners('request')[0]).listen(8787, '127.0.0.1', () => console.log('mock up'));
