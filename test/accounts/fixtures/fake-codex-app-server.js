'use strict';

// A synthetic `codex app-server` for the identity check tests: it reads one JSON message per line, answers `initialize` with the
// CODEX_HOME it was given and `account/read` as FAKE_MODE says, then keeps running (like the real server) until it is stopped.
const mode = process.env.FAKE_MODE || 'chatgpt';
const home = process.env.CODEX_HOME || null;
const accounts = {
  chatgpt: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' },
  'odd-plan': { type: 'chatgpt', email: 'person@example.test', planType: 'self_serve_business_usage_based' },
  'api-key': { type: 'apiKey' },
  'signed-out': null
};
const say = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let end;
  while ((end = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, end);
    buffered = buffered.slice(end + 1);
    const message = JSON.parse(line);
    if (message.method === 'initialize') say({ id: message.id, result: { userAgent: 'fake', codexHome: mode === 'other-home' ? '/elsewhere' : home } });
    if (message.method === 'account/read') {
      if (mode === 'silent') continue;
      if (mode === 'error') { say({ id: message.id, error: { code: -32600, message: 'not available' } }); continue; }
      say({ method: 'remoteControl/status/changed', params: { status: 'disabled' } });
      say({ id: message.id, result: { account: mode === 'other-home' ? accounts.chatgpt : accounts[mode], requiresOpenaiAuth: true } });
    }
  }
});
setInterval(() => {}, 1 << 30);
