import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { terminalSessionIdAtPoint, visibleTerminalSessionIds } from '../src/terminal-pane-layout.js';
import { createTerminalInputBuffer } from '../src/terminal-input-buffer.js';
import { nativeFileDropPoint } from '../src/native-file-drop.js';

const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function sourceFunction(name, nextName) {
  const start = main.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const end = nextName
    ? main.indexOf(`\nfunction ${nextName}(`, start)
    : main.indexOf('\n}', start) + 2;
  return end > start ? main.slice(start, end) : '';
}

function makeInputBuffer({ ready = true, fail = false } = {}) {
  const writes = [];
  let startup = ready;
  let failed = fail;
  return {
    writes,
    write(data) {
      if (failed) return false;
      writes.push(data);
      return true;
    },
    flush: async () => !failed,
    get ready() { return startup; },
    markReady() { startup = true; },
    markFailed() { failed = true; },
  };
}

function pasteApi({ sessions, msg = () => {} } = {}) {
  const code = sourceFunction('queueTerminalPaste', 'orchestraSessionId');
  assert.ok(code, 'main.js 应提供 queueTerminalPaste');
  const api = new Function('sessions', 'msg', `${code}; return queueTerminalPaste;`)(sessions, msg);
  return api;
}

function bindRealOnData(term, inputBuffer, session) {
  const match = main.match(/^\s*term\.onData\(data => \{[^\n]*\}\);$/m);
  assert.ok(match, 'main.js 应把 xterm onData 接入输入队列');
  new Function('term', 'inputBuffer', 'session', match[0])(term, inputBuffer, session);
}

function pathInsertApi({ sessions, paste, quotePath, msg = () => {}, activeSession = 'a' } = {}) {
  const code = sourceFunction('insertPathsToTerminal', 'insertPathToTerminal');
  assert.ok(code, 'main.js 应提供 insertPathsToTerminal');
  return new Function(
    'sessions', 'queueTerminalPaste', 'shellQuotePath', 'msg', 'activeSession',
    `${code}; return insertPathsToTerminal;`,
  )(sessions, paste, quotePath, msg, activeSession);
}

function nativeDropFixture({ dpr = 1, isWindows = false, appVisible = true, activeSession = 'a' } = {}) {
  const listeners = new Map();
  const highlights = [];
  const activated = [];
  const pasted = [];
  const focused = [];
  const rects = new Map([
    ['a', { left: 0, right: 200, top: 0, bottom: 180 }],
    ['b', { left: 200, right: 400, top: 0, bottom: 180 }],
  ]);
  const sessions = new Map([...rects].map(([id, rect]) => [id, {
    bodyEl: { getBoundingClientRect: () => rect },
    term: { paste: data => pasted.push({ id, data }), focus: () => focused.push(id) },
    lastInputAccepted: true,
  }]));
  const listen = async (name, callback) => {
    listeners.set(name, callback);
    return () => listeners.delete(name);
  };
  const setTerminalPaneDragTarget = id => highlights.push(id);
  const terminalSessionAtViewportPoint = (x, y) => {
    const panes = visibleTerminalSessionIds(['a', 'b']).map(id => {
      const rect = sessions.get(id)?.bodyEl.getBoundingClientRect();
      return rect ? { id, ...rect } : null;
    }).filter(Boolean);
    return terminalSessionIdAtPoint(panes, x, y);
  };
  const activateSession = (id, _force, callback) => { activated.push(id); callback(); };
  const queueTerminalPaste = (id, data) => {
    const session = sessions.get(id);
    session?.term.paste(data);
    return session?.lastInputAccepted === true;
  };
  const insertPaths = sourceFunction('insertPathsToTerminal', 'insertPathToTerminal');
  const insertPathsToTerminal = insertPaths
    ? new Function('sessions', 'queueTerminalPaste', 'shellQuotePath', 'msg', 'activeSession',
      `${insertPaths}; return insertPathsToTerminal;`)(
      sessions, queueTerminalPaste, path => `'${path.replaceAll("'", "'\\''")}'`, () => {}, activeSession,
    )
    : undefined;
  const queueTerminalInput = (id, data) => queueTerminalPaste(id, data);
  const body = main.slice(main.indexOf('  // 拖拽文件/文件夹到终端窗格'), main.indexOf('\n}', main.indexOf('  // 拖拽文件/文件夹到终端窗格')));
  assert.ok(body, 'main.js 应保留原生拖放监听接线');
  const deps = {
    listen, window: { devicePixelRatio: dpr }, IS_WINDOWS: isWindows, nativeFileDropPoint,
    developerTerminalVisible: () => appVisible,
    terminalSessionAtViewportPoint, setTerminalPaneDragTarget, activateSession,
    sessions, queueTerminalPaste, queueTerminalInput, insertPathsToTerminal,
    shellQuotePath: path => `'${path.replaceAll("'", "'\\''")}'`,
  };
  const bind = new Function(...Object.keys(deps), `return async () => { ${body}\n};`)(...Object.values(deps));
  return {
    listeners, highlights, activated, pasted, focused, sessions, bind,
    drop(payload) { listeners.get('tauri://drag-drop')?.({ payload }); },
    over(payload) { listeners.get('tauri://drag-over')?.({ payload }); },
    leave() { listeners.get('tauri://drag-leave')?.({ payload: {} }); },
    positionForViewportPoint(x, y) { return isWindows ? { x: x * dpr, y: y * dpr } : { x, y }; },
  };
}

test('多文件按 shell 引用后通过 xterm paste 一次插入，不发送回车', () => {
  const received = [];
  const sessions = new Map(['claude', 'codex', 'cmd'].map(id => [id, {
    term: { paste: data => received.push({ id, data }), focus() {} }, lastInputAccepted: true,
  }]));
  const insert = pathInsertApi({
    sessions,
    paste: (id, data) => { sessions.get(id).term.paste(data); return true; },
    quotePath: path => `'${path.replaceAll("'", "'\\''")}'`,
    activeSession: 'cmd',
  });
  assert.equal(insert(['/tmp/两 个.txt', "/tmp/it's.png"], 'cmd'), true);
  assert.deepEqual(received, [{ id: 'cmd', data: "'/tmp/两 个.txt' '/tmp/it'\\''s.png' " }]);
  assert.doesNotMatch(received[0].data, /[\r\n]$/);
});

test('所有 CLI 的 xterm paste 都由 onData 进入同一启动输入缓存，并尊重 bracketed-paste 状态', async () => {
  for (const cli of ['claude', 'grok', 'codex', 'opencode', 'agy', 'qwen', 'mimo', 'cmd', 'pi']) {
    const sent = [];
    const inputBuffer = createTerminalInputBuffer({ send: data => { sent.push(data); } });
    const session = { status: 'running', inputBuffer, lastInputAccepted: false };
    let onData;
    const term = {
      onData(callback) { onData = callback; },
      paste(data, bracketed) {
        onData(bracketed ? `\x1b[200~${data}\x1b[201~` : data);
      },
    };
    session.term = term;
    bindRealOnData(term, inputBuffer, session);
    const sessions = new Map([[cli, session]]);
    const paste = pasteApi({ sessions });
    assert.equal(paste(cli, 'path '), true, `${cli} 应缓存 paste`);
    assert.deepEqual(sent, [], `${cli} 在启动就绪前不应越过缓存`);
    term.paste('path ', false);
    assert.equal(session.lastInputAccepted, true, `${cli} 普通 paste 由 onData 接收`);
    term.paste('path ', true);
    assert.equal(session.lastInputAccepted, true, `${cli} bracketed paste 由 onData 接收`);
    assert.equal(await inputBuffer.markReady('launch\r'), true);
    assert.deepEqual(sent, ['launch\r', 'path path \x1b[200~path \x1b[201~']);
  }
});

test('onData 写入失败会记录未接收，paste 返回失败供调用方提示', () => {
  const session = { status: 'running', lastInputAccepted: false };
  const inputBuffer = { write: () => false };
  const term = { onData(callback) { this.handleData = callback; }, paste(data) { this.handleData(data); } };
  session.term = term;
  bindRealOnData(term, inputBuffer, session);
  const paste = pasteApi({ sessions: new Map([['a', session]]) });
  assert.equal(paste('a', 'path '), false);
  assert.equal(session.lastInputAccepted, false);
});

test('路径校验拒绝控制字符、空值、超项数及单项/总长度超限', () => {
  const calls = [], notices = [];
  const sessions = new Map([['a', { lastInputAccepted: false }]]);
  const insert = pathInsertApi({
    sessions, paste: (id, data) => { calls.push({ id, data }); return sessions.get(id).lastInputAccepted === true; },
    quotePath: path => JSON.stringify(path), msg: (...args) => notices.push(args),
  });
  for (const paths of [
    ['', '  '], ['bad\npath'], [1], Array.from({ length: 17 }, (_, i) => `/p/${i}`),
    [`/${'a'.repeat(4096)}`], Array.from({ length: 16 }, () => `/${'b'.repeat(4095)}`),
  ]) assert.equal(insert(paths, 'a'), false);
  assert.equal(insert(['/tmp/valid.png'], 'a'), false, 'paste 接收失败时向调用者返回失败');
  assert.deepEqual(calls, [{ id: 'a', data: '"/tmp/valid.png" ' }]);
  assert.ok(notices.length >= 2, '路径校验和 paste 失败都应给用户反馈');
});

for (const dpr of [1, 1.5, 2]) {
  test(`Windows 原生拖放按 DPR ${dpr} 转换物理坐标并粘贴到鼠标命中的分屏`, async () => {
    const f = nativeDropFixture({ dpr, isWindows: true, activeSession: 'a' });
    await f.bind();
    const position = f.positionForViewportPoint(250, 90);
    f.over({ position });
    assert.equal(f.highlights.at(-1), 'b');
    f.drop({ position, paths: ['/tmp/a b.txt', '/tmp/中文.png'] });
    assert.deepEqual(f.activated, ['b']);
    assert.deepEqual(f.pasted, [{ id: 'b', data: "'/tmp/a b.txt' '/tmp/中文.png' " }]);
    assert.deepEqual(f.focused, ['b']);
    assert.equal(f.highlights.at(-1), null);
  });
}

test('macOS Retina 原生拖放使用逻辑坐标：x=240 命中右窗格，不被误除以 2', async () => {
  const f = nativeDropFixture({ dpr: 2, isWindows: false, activeSession: 'a' });
  await f.bind();
  const position = f.positionForViewportPoint(240, 90);
  f.over({ position });
  assert.equal(f.highlights.at(-1), 'b');
  f.drop({ position, paths: ['/tmp/mac.txt'] });
  assert.deepEqual(f.activated, ['b']);
  assert.deepEqual(f.pasted, [{ id: 'b', data: "'/tmp/mac.txt' " }]);
});

test('原生拖放受开发视图门禁，缺失/非法坐标或无命中时不输入', async () => {
  const hidden = nativeDropFixture({ appVisible: false });
  await hidden.bind();
  hidden.drop({ position: hidden.positionForViewportPoint(250, 90), paths: ['/tmp/x'] });
  assert.deepEqual(hidden.pasted, []);

  const f = nativeDropFixture();
  await f.bind();
  for (const position of [undefined, null, {}, { x: NaN, y: 20 }, { x: Infinity, y: 20 }, { x: '200', y: 20 }]) {
    f.drop({ position, paths: ['/tmp/x'] });
  }
  f.drop({ position: f.positionForViewportPoint(500, 90), paths: ['/tmp/x'] });
  assert.deepEqual(f.activated, []);
  assert.deepEqual(f.pasted, []);
});

test('paste 通道尊重 onData 接收结果并识别缓存与失败', async () => {
  const acceptedBuffer = makeInputBuffer({ ready: false });
  const accepted = { id: 'claude', status: 'running', inputBuffer: acceptedBuffer, lastInputAccepted: false };
  accepted.term = { onData(callback) { this.handleData = callback; }, paste(data) { this.handleData(data); } };
  const rejectedBuffer = makeInputBuffer({ ready: false, fail: true });
  const rejected = { id: 'cmd', status: 'running', inputBuffer: rejectedBuffer, lastInputAccepted: false };
  rejected.term = { onData(callback) { this.handleData = callback; }, paste(data) { this.handleData(data); } };
  bindRealOnData(accepted.term, acceptedBuffer, accepted);
  bindRealOnData(rejected.term, rejectedBuffer, rejected);
  const sessions = new Map([[accepted.id, accepted], [rejected.id, rejected]]);
  const paste = pasteApi({ sessions });
  assert.equal(paste('claude', 'cached path '), true);
  assert.deepEqual(acceptedBuffer.writes, ['cached path ']);
  assert.equal(paste('cmd', 'rejected path '), false);
  assert.equal(rejected.lastInputAccepted, false);
});
