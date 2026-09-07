const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGlobal } = require('./helpers/runtime');
test('worker rejects pending requests, cleans timers and reconnects with session reset', async () => {
  const messages = [], sockets = [], timers = new Map(); let sequence = 0;
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; sockets.push(this); }
    send(data) { this.payload = JSON.parse(data); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const self = { postMessage: data => messages.push(data) };
  loadGlobal('src/js/worker/highlight.worker.js', 'pendingRequests', {
    self, WebSocket: Socket,
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const configuring = self.onmessage({ data: { taskId: 'configure', taskName: 'configure', data: { endpoint: { host: '127.0.0.1', port: 1234 } } } });
  sockets[0].open(); await configuring;
  const pending = self.onmessage({ data: { taskId: 'pending', taskName: 'openDocument', data: { documentId: 'old', language: 'javascript', code: 'const a = 1;' } } });
  await new Promise(r => setImmediate(r)); assert.equal(timers.size, 1);
  sockets[0].close(); await pending;
  assert.ok(messages.some(m => m.type === 'sessionLost'));
  assert.match(messages.find(m => m.taskId === 'pending').error, /closed/);
  assert.equal(timers.size, 1); const retry = [...timers.values()][0]; assert.equal(retry.delay, 500);
  timers.clear(); retry.fn(); sockets[1].open();
  assert.ok(messages.some(m => m.type === 'sessionReset'));
  assert.equal(timers.size, 0);
});

test('real NSH server over local WebSocket: JS/TS/C++ tokens and reopened text', { timeout: 15000 }, async () => {
  const { NSHServer } = require('nsh/server');
  const WebSocket = require('ws');
  const server = new NSHServer({ host: '127.0.0.1', port: 0 });
  const port = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const pending = new Map(); let id = 0;
  socket.on('message', data => { const response = JSON.parse(data); pending.get(response.id)?.(response); pending.delete(response.id); });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  async function request(requestType, args = {}) {
    const requestId = String(++id);
    const result = new Promise(resolve => pending.set(requestId, resolve));
    socket.send(JSON.stringify({ id: requestId, requestType, ...args }));
    const response = await result; assert.equal(response.success, true, response.error); return response;
  }
  try {
    for (const [language, code, token] of [['javascript', 'const a = 1;', 'const'], ['typescript', 'interface User { name: string; }', 'interface'], ['cpp', 'int main() { return 0; }', 'int']]) {
      await request('openDocument', { documentId: 'doc', language, code });
      const response = await request('getDocumentLines', { documentId: 'doc', startLine: 0, endLine: 1 });
      assert.equal(response.lines[0].text, code);
      assert.ok(response.lines[0].tokens.some(t => t.value === token && t.type));
      await request('closeDocument', { documentId: 'doc' });
    }
    await request('openDocument', { documentId: 'reload', language: 'javascript', code: 'const b = "hello";' });
    const response = await request('getDocumentLines', { documentId: 'reload', startLine: 0, endLine: 1 });
    assert.ok(response.lines[0].tokens.some(t => t.value.includes('hello')));
  } finally { socket.terminate(); await server.stop(); }
});
