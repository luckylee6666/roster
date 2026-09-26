// 终端镜像：手机按 PTY 列宽镜像电脑上已打开的终端会话（原「手机远程」的全部行为）。
// xterm 只在第一次打开终端时按需加载，对话页不背这份体积。

const ESC = String.fromCharCode(27);
const SEQ = {
  enter: '\r', tab: '\t', ctrlc: String.fromCharCode(3), esc: ESC,
  up: `${ESC}[A`, down: `${ESC}[B`, right: `${ESC}[C`, left: `${ESC}[D`,
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`加载 ${src} 失败`));
    document.head.appendChild(script);
  });
}

let xtermReady = null;
function ensureXterm() {
  if (window.Terminal) return Promise.resolve();
  if (!xtermReady) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/xterm.css';
    document.head.appendChild(css);
    xtermReady = loadScript('/vendor/xterm.js').then(() => loadScript('/vendor/addon-fit.js'));
  }
  return xtermReady;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * @param {object} deps
 * @param {() => string} deps.getPin
 * @param {(state: string) => void} deps.setConn
 * @param {() => void} deps.onAuthError
 */
export function createTerminalPanel({ getPin, setConn, onAuthError }) {
  const host = document.getElementById('termHost');
  let term = null;
  let ws = null;
  let curId = '';
  let ptyCols = 80;
  let ptyRows = 24;

  async function list() {
    const response = await fetch(`/api/sessions?token=${encodeURIComponent(getPin())}`, { cache: 'no-store' });
    if (response.status === 401) {
      onAuthError();
      throw new Error('PIN 已失效');
    }
    if (!response.ok) throw new Error(`读取终端失败（${response.status}）`);
    return response.json();
  }

  // 镜像 PTY：列宽必须 = PTY 列宽（否则换行错乱），按宽度自动缩字号铺满；
  // 行数取「填满手机高度」与 PTY 行数的较大值。绝不反向 resize PTY。
  function applySize(cols, rows) {
    if (!term || !cols) return;
    ptyCols = cols;
    ptyRows = rows || ptyRows;
    const availW = host.clientWidth - 14;
    const availH = host.clientHeight - 6;
    let fontSize = Math.floor((availW / cols) / 0.62);
    fontSize = Math.max(7, Math.min(15, fontSize));
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    const fitRows = Math.floor(availH / (fontSize * 1.2));
    try { term.resize(cols, Math.max(ptyRows, fitRows, 1)); } catch (_) {}
  }

  // xterm 内置触屏滚动不可靠，touchmove → term.scrollLines 最稳。
  function setupTouchScroll() {
    let lastY = null;
    host.addEventListener('touchstart', event => { lastY = event.touches[0].clientY; }, { passive: true });
    host.addEventListener('touchmove', event => {
      if (lastY === null || !term) return;
      const y = event.touches[0].clientY;
      const lines = (lastY - y) / ((term.options.fontSize || 12) * 1.2);
      const n = lines > 0 ? Math.floor(lines) : Math.ceil(lines);
      if (n !== 0) { term.scrollLines(n); lastY = y; }
    }, { passive: true });
    const clear = () => { lastY = null; };
    host.addEventListener('touchend', clear, { passive: true });
    host.addEventListener('touchcancel', clear, { passive: true });
  }

  function ensureTerm() {
    if (term) return;
    term = new window.Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
      cursorBlink: true,
      scrollback: 8000,
      theme: { background: '#0b1120', foreground: '#e2e8f0', cursor: '#8f89ff' },
    });
    term.open(host);
    term.onData(data => sendInput(data));
    window.addEventListener('resize', () => applySize(ptyCols, ptyRows));
    window.addEventListener('orientationchange', () => setTimeout(() => applySize(ptyCols, ptyRows), 300));
    setupTouchScroll();
  }

  function connect() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getPin())}&id=${encodeURIComponent(curId)}`);
    ws = socket;
    setConn('connecting');
    socket.onopen = () => setConn('on');
    socket.onmessage = event => {
      let frame;
      try { frame = JSON.parse(event.data); } catch (_) { return; }
      if (frame.t === 'o') term.write(b64ToBytes(frame.d));
      else if (frame.t === 'size') applySize(frame.cols, frame.rows);
      else if (frame.t === 'exit') {
        term.write('\r\n\x1b[90m[会话已结束]\x1b[0m\r\n');
        setConn('off');
        // 会话已死：清掉 curId，阻止 onclose 对死会话反复重连。
        curId = '';
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      setConn('off');
      if (curId) setTimeout(() => { if (curId && ws === socket) connect(); }, 1500);
    };
    socket.onerror = () => setConn('off');
  }

  function sendInput(data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'i', d: data }));
  }

  async function open(id) {
    await ensureXterm();
    curId = id;
    ensureTerm();
    term.reset();
    connect();
    requestAnimationFrame(() => applySize(ptyCols, ptyRows));
  }

  function close() {
    curId = '';
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  document.querySelectorAll('#keysRow button').forEach(button => {
    button.addEventListener('click', () => {
      sendInput(SEQ[button.dataset.k] || '');
      term?.focus();
    });
  });
  const input = document.getElementById('cmdInput');
  const submit = () => {
    sendInput(`${input.value}\r`);
    input.value = '';
  };
  document.getElementById('cmdSend').addEventListener('click', submit);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });

  return { list, open, close, isOpen: () => Boolean(curId) };
}
