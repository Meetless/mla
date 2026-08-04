#!/usr/bin/env node
// Click ONE /cli/authorize page in a CDP-attached Chrome that already holds a console
// session. Used by capture-identity-cdp.sh; not useful on its own.
//
// WHAT THIS IS NOT: it is not a way around the login. `/cli/authorize` is a top-level form
// POST behind `requireAccountAuth`, deliberately, so the browser follows the 303 to the
// CLI's loopback listener as a full navigation (a fetch would swallow the redirect). There
// is no headless path and there should not be one. This drives a REAL click on the REAL
// page in a REAL browser holding a REAL session. What it removes is the operator's
// SYNCHRONY, not the operator's authorization: a human signed that browser in, once.
//
// usage: authorize-click.mjs <authorize-url>
// exit: 0 clicked | 2 browser is signed out | 3 no authorize control | 4 CDP unreachable
//
// Node 18+ ships a global WebSocket, so this has no dependencies. Note a closed CDP socket
// still holds node's event loop open, hence the explicit process.exit at the end.
const [, , url] = process.argv;
if (!url) { console.error('usage: authorize-click.mjs <authorize-url>'); process.exit(64); }
const PORT = process.env.MLA_CDP_PORT || '58970';

let targets;
try {
  targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
} catch (e) {
  console.error(`CDP unreachable on 127.0.0.1:${PORT}: ${e.message}`);
  process.exit(4);
}
const target = targets.find((t) => t.type === 'page');
if (!target) { console.error('no page target in the CDP browser'); process.exit(4); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((resolve) => ws.addEventListener('open', resolve));

const probe = `(() => {
  const href = location.href;
  if (/\\/signin|accounts\\.google\\.com/.test(href)) return JSON.stringify({ status: 'signed-out', href });
  const forms = [...document.querySelectorAll('form')];
  const form = forms.find((f) => (f.getAttribute('action') || '').includes('/api/cli/grants')) || forms[0];
  if (!form) return JSON.stringify({ status: 'waiting', href, title: document.title });
  const btn = form.querySelector('button[type=submit], input[type=submit], button');
  if (!btn) return JSON.stringify({ status: 'no-button', href, action: form.getAttribute('action') });
  const r = btn.getBoundingClientRect();
  if (!r.width || !r.height) return JSON.stringify({ status: 'waiting', href });
  return JSON.stringify({
    status: 'ready', href, action: form.getAttribute('action'),
    label: (btn.innerText || btn.value || '').trim().slice(0, 60),
    x: r.left + r.width / 2, y: r.top + r.height / 2,
  });
})()`;

await send('Page.enable');
await send('Page.navigate', { url });

// Poll for the control rather than sleeping a fixed amount. The session check can bounce us
// to /signin, and that bounce is the one outcome we want to name precisely instead of
// reporting as a timeout: "signed out" is a setup problem, a timeout is a mystery.
let state = { status: 'unknown' };
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const res = await send('Runtime.evaluate', { expression: probe, returnByValue: true, awaitPromise: true });
  const raw = res.result?.result?.value;
  if (!raw) continue;
  state = JSON.parse(raw);
  if (state.status === 'ready' || state.status === 'signed-out') break;
}

console.log(`authorize page: ${JSON.stringify(state)}`);
if (state.status === 'signed-out') {
  console.error('that Chrome is NOT signed into the console; sign it in once, then re-run');
  process.exit(2);
}
if (state.status !== 'ready') { console.error('no authorize control found on the page'); process.exit(3); }

// A real trusted mouse event at the control, not element.click(). If the page ever grows an
// isTrusted check, or a handler that ignores synthetic clicks, this keeps working.
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x, y: state.y, button: 'left', clickCount: 1 });
console.log(`clicked: ${state.label}`);
process.exit(0);
