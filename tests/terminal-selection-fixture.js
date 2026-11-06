// Browser integration fixture: use the shipped xterm and the real createSession options.
// Run via a local static server; results are shown on the page, outside pnpm test counts.
const results = document.getElementById('results');
const runButton = document.getElementById('run');
const sample = '新增配置，支持中文选择与复制。';
const enableMouse = '\x1b[?1002h\x1b[?1006h';
const disableMouse = '\x1b[?1002l\x1b[?1003l\x1b[?1006l';
const renderer = new URLSearchParams(location.search).get('renderer') || 'dom';
const write = (term, data) => new Promise(resolve => term.write(data, resolve));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function applicationOptions() {
  const response = await fetch('../src/main.js');
  assert(response.ok, '无法读取应用终端配置');
  const source = await response.text();
  const start = source.indexOf('  const term = new window.Terminal({', source.indexOf('async function createSession('));
  const end = source.indexOf('\n  });', start);
  assert(start >= 0 && end > start, 'createSession 结构变化，请更新夹具提取边界');
  // Evaluate only the repository-owned constructor, with Terminal replaced by an options capture.
  const capture = new Function('window', 'currentFontSize', 'currentThemeDef', 'TERM_THEMES',
    `${source.slice(start, end + 6)}; return term;`);
  return capture({ Terminal: class { constructor(options) { return options; } } }, 16, null,
    { classic: { theme: { background: '#000000', foreground: '#00ff00', selectionBackground: '#46608c' } } });
}

async function createCase(id, options) {
  const host = document.getElementById(id);
  const status = document.getElementById(`${id}-status`);
  const term = new Terminal({ ...options, cols: 64, rows: 5, cursorBlink: false });
  term.open(host);
  if (renderer === 'webgl') term.loadAddon(new WebglAddon.WebglAddon());
  const data = [];
  const updateStatus = () => {
    status.textContent = `渲染：${renderer}；选区：${JSON.stringify(term.getSelection())}；鼠标报告数：${data.length}`;
  };
  term.onSelectionChange(updateStatus);
  term.onData(value => { data.push(value); updateStatus(); });
  await write(term, `${sample}\r\n第二行：保留滚轮与 CLI 点击。\r\n${enableMouse}`);
  await frame();
  updateStatus();
  return { term, host, data, updateStatus };
}

function eventAt(target, type, x, y, options = {}) {
  const buttons = type === 'mouseup' ? 0 : 1;
  target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, button: 0, buttons, detail: 1,
    clientX: x, clientY: y, ...options,
  }));
}

function cellPoint(state, column = 0, row = 0) {
  const screen = state.host.querySelector('.xterm-screen');
  const rect = screen.getBoundingClientRect();
  return { screen, x: rect.left + (column + 0.15) * rect.width / state.term.cols,
    y: rect.top + (row + 0.5) * rect.height / state.term.rows };
}

async function drag(state, { altKey = false, shiftKey = false } = {}) {
  state.term.clearSelection();
  state.data.length = 0;
  const start = cellPoint(state);
  const end = cellPoint(state, 40);
  const modifiers = { altKey, shiftKey };
  eventAt(start.screen, 'mousedown', start.x, start.y, modifiers);
  eventAt(document, 'mousemove', end.x, end.y, modifiers);
  eventAt(document, 'mouseup', end.x, end.y, modifiers);
  await frame();
}

async function checkCases(baseline, current) {
  const passed = [];
  const check = async (label, callback) => {
    await callback();
    passed.push(label);
    results.textContent = passed.map(text => `PASS ${text}`).join('\n');
  };
  for (const state of [baseline, current]) {
    await write(state.term, disableMouse + enableMouse);
    state.term.clearSelection();
  }
  await check('旧配置复现：鼠标上报时无法普通拖选', async () => {
    await drag(baseline);
    assert(baseline.term.getSelection() === '', '旧配置没有复现');
    assert(baseline.data.some(value => value.startsWith('\x1b[<')), '旧配置未发送鼠标报告');
  });
  await check('当前配置：鼠标上报时普通拖动选中完整中文，不发送 PTY 数据', async () => {
    await drag(current);
    assert(current.term.getSelection() === sample, `选区错误：${JSON.stringify(current.term.getSelection())}`);
    assert(current.data.length === 0, '选择文字时不应向 CLI 发送数据');
  });
  await check('复制事件读取真实选区（使用测试剪贴板，不写系统剪贴板）', async () => {
    let copied = '';
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: {
      setData: (type, text) => { if (type === 'text/plain') copied = text; },
    } });
    current.term.element.dispatchEvent(event);
    assert(copied === sample && event.defaultPrevented, '复制事件未读取选区');
  });
  await check('Option/Alt 拖动保留 CLI 鼠标报告，且不把 Alt 修饰符传给 CLI', async () => {
    await drag(current, { altKey: true });
    assert(current.term.getSelection() === '', '交互拖动不应建立文本选区');
    assert(current.data.length >= 2, 'CLI 缺少按下/抬起报告');
    assert(current.data.every(value => /^\x1b\[<(0|32);\d+;\d+[Mm]$/.test(value)), '鼠标报告错误或包含 Alt');
  });
  await check('普通滚轮仍向启用鼠标模式的 CLI 上报', async () => {
    current.data.length = 0;
    const point = cellPoint(current, 2, 1);
    point.screen.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: point.x, clientY: point.y, deltaY: 120, deltaMode: 0 }));
    assert(current.data.some(value => /^\x1b\[<65;/.test(value)), '滚轮报告丢失');
  });
  await check('全移动上报模式下也能选中文字且不会泄漏普通鼠标移动', async () => {
    await write(current.term, '\x1b[?1003h');
    await drag(current);
    assert(current.term.getSelection() === sample && current.data.length === 0, '全移动模式抢走选区');
    const point = cellPoint(current, 3, 1);
    eventAt(point.screen, 'mousemove', point.x, point.y, { buttons: 0 });
    assert(current.data.length === 0, '普通移动被发送到 CLI');
  });
  await check('退出鼠标模式后普通 shell 拖选保持正常', async () => {
    await write(current.term, disableMouse);
    await drag(current);
    assert(current.term.getSelection() === sample && current.data.length === 0, '普通 shell 拖选回归');
  });
  await check('切回鼠标模式后选择策略仍然有效', async () => {
    await write(current.term, enableMouse);
    await drag(current);
    assert(current.term.getSelection() === sample && current.data.length === 0, '重新启用鼠标后选择失效');
  });
  results.textContent += `\n${passed.length}/${passed.length} 通过（${renderer}）`;
  for (const state of [baseline, current]) state.updateStatus();
}

try {
  const options = await applicationOptions();
  const baseline = await createCase('baseline', { ...options, mouseEventsRequireAlt: false });
  const current = await createCase('current', options);
  results.textContent = '就绪。可以手动拖动两段文字对照，再运行行为回归。';
  runButton.disabled = false;
  runButton.onclick = async () => {
    runButton.disabled = true;
    try { await checkCases(baseline, current); }
    catch (error) { results.textContent += `\nFAIL ${error.stack || error}`; }
    finally { runButton.disabled = false; }
  };
  window.addEventListener('pagehide', () => { baseline.term.dispose(); current.term.dispose(); }, { once: true });
} catch (error) {
  results.textContent = `FAIL ${error.stack || error}`;
}
