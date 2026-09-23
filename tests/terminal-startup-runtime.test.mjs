import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createTerminalInputBuffer } from '../src/terminal-input-buffer.js';
import { normalizeCliToolName, sessionLayoutEntries } from '../src/session-restore-utils.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const creationStart = main.indexOf('async function createSession(');
const startupStart = main.indexOf('    // tool 只传工具名', creationStart);
const startupCode = main.slice(startupStart, main.indexOf('  } catch (e) {', startupStart));

async function runStartup(initialPrompt, exitImmediately = false) {
  const calls = [], writes = [];
  const session = { status: 'running', restorable: false, tool: 'cmd', cwd: '/project', name: '项目' };
  const inputBuffer = createTerminalInputBuffer({ send: async data => writes.push(data) });
  const sessions = new Map([['id', session]]);
  const deps = {
    id: 'id', cwd: '/project', label: '项目', autoCmd: 'cmd', initialPrompt, normalizeCliToolName,
    term: { cols: 80, rows: 24 }, session, sessions, inputBuffer, projects: [],
    characterTheme: { setState: () => {} }, fitSession: () => {}, persistSessionLayout: () => {},
    setTimeout: callback => callback(),
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === 'terminal_create' && exitImmediately) {
        session.status = 'exited'; inputBuffer.markFailed();
      }
      if (method === 'get_proxy_shell_hook') return { command: '' };
    },
  };
  const run = new Function(...Object.keys(deps), `return async () => { ${startupCode} };`)(...Object.values(deps));
  const error = await run().then(() => null, error => error);
  return { calls, writes, session, error, sessions };
}

test('轮换初始消息由IPC交给原生启动，不向PTY写命令、提示或代理shell钩子', async () => {
  const result = await runStartup('这是交接，请读取 .vibe/handoff/test.md');
  assert.equal(result.error, null);
  assert.deepEqual(result.calls, [{ method: 'terminal_create', args: {
    id: 'id', cwd: '/project', cols: 80, rows: 24, name: '项目', tool: 'cmd', initialPrompt: '这是交接，请读取 .vibe/handoff/test.md',
  } }]);
  assert.deepEqual(result.writes, []);
  assert.deepEqual(sessionLayoutEntries(result.sessions), [{ cwd: '/project', name: '项目', autoCmd: 'cmd' }]);
});

test('原生CLI立即退出则启动失败，不保存恢复标签、不发送初始消息', async () => {
  const result = await runStartup('这是任务', true);
  assert.match(result.error.message, /启动期间已关闭/);
  assert.equal(result.session.restorable, false);
  assert.deepEqual(result.writes, []);
});

test('普通终端继续原有shell启动路径，不传原生初始消息', async () => {
  const result = await runStartup('');
  assert.equal(result.error, null);
  assert.equal(Object.hasOwn(result.calls[0].args, 'initialPrompt'), false);
  assert.equal(result.calls[1].method, 'get_proxy_shell_hook');
  assert.deepEqual(result.writes, ['cmd\r']);
});

test('所有桌面输入入口共用启动队列，退出或关闭使队列不可再用', async () => {
  assert.equal([...main.matchAll(/invoke\('terminal_write'/g)].length, 1, '不能有绕过队列的桌面写入入口');
  assert.match(main, /send: data => invoke\('terminal_write'/);
  const exitHandler = main.slice(main.indexOf("await listen('terminal-exit'"), main.indexOf("await listen('terminal-attention'"));
  const finalize = main.slice(main.indexOf('function finalizeSessionClose('), main.indexOf('async function closeSession('));
  assert.match(exitHandler, /s\.inputBuffer\?\.markFailed\(\)/);
  assert.match(finalize, /session\.inputBuffer\?\.markFailed\(\)/);
  const source = main.slice(main.indexOf('function queueTerminalInput('), main.indexOf('function orchestraSessionId('));
  const sent = [];
  let reject;
  const buffer = createTerminalInputBuffer({ send: data => {
    sent.push(data);
    if (data === 'launch\r') return new Promise((_, fail) => { reject = fail; });
  } });
  const session = { status: 'running', inputBuffer: buffer };
  const queue = new Function('sessions', `${source}; return queueTerminalInput;`)(new Map([['id', session]]));
  const ready = buffer.markReady('launch\r');
  await new Promise(resolve => setImmediate(resolve));
  for (const input of ['snippet', '\x1b', '/dragged/path ', 'bash script.sh ']) assert.equal(queue('id', input), true);
  reject(new Error('启动失败'));
  assert.equal(await ready, false);
  assert.deepEqual(sent, ['launch\r']);
  assert.equal(queue('id', 'later'), false);
});
