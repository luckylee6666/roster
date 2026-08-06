import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompanionWebview,
  isAllowedCompanionUrl,
  normalizeCompanionBounds,
  normalizeCompanionUrl,
} from '../src/companion-webview.js';

test('轻松模式仅接受 HTTPS 与本地 HTTP 地址', () => {
  assert.equal(isAllowedCompanionUrl('https://www.douyin.com/'), true);
  assert.equal(normalizeCompanionUrl('http://localhost:3000/game'), 'http://localhost:3000/game');
  assert.equal(isAllowedCompanionUrl('http://example.com'), false);
  assert.equal(isAllowedCompanionUrl('https://user:secret@example.com'), false);
  assert.equal(isAllowedCompanionUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedCompanionUrl('data:text/html,hello'), false);
});

test('网页容器规范化位置和尺寸', () => {
  assert.deepEqual(normalizeCompanionBounds({ x: -8, y: 4.2, width: 0, height: '22.5' }), {
    x: 0,
    y: 4,
    width: 1,
    height: 23,
  });
});

test('浏览器测试环境可以安全降级', async () => {
  const companion = new CompanionWebview({ globalObject: {} });
  assert.equal(companion.available, false);
  assert.equal(await companion.create('https://www.douyin.com', {}), null);
  assert.equal(await companion.show(), false);
});

test('使用 Tauri Webview 的创建、更新和销毁 API', async () => {
  const calls = [];
  class FakeWebview {
    constructor(parent, label, options) {
      this.parent = parent;
      this.label = label;
      this.options = options;
      calls.push(['create', parent, label, options]);
    }
    async show() { calls.push(['show']); }
    async hide() { calls.push(['hide']); }
    async setFocus() { calls.push(['focus']); }
    async setPosition(position) { calls.push(['position', position]); }
    async setSize(size) { calls.push(['size', size]); }
    async close() { calls.push(['close']); }
  }

  const globalObject = {
    __TAURI__: {
      webview: { Webview: FakeWebview },
      window: { getCurrentWindow: () => ({ label: 'main' }) },
      dpi: {
        LogicalPosition: class LogicalPosition { constructor(x, y) { this.x = x; this.y = y; } },
        LogicalSize: class LogicalSize { constructor(width, height) { this.width = width; this.height = height; } },
      },
    },
  };
  const companion = new CompanionWebview({ globalObject });
  await companion.create('https://www.douyin.com', { x: 12, y: 8, width: 420, height: 600 });
  await companion.setPosition({ x: 16 });
  await companion.setSize({ width: 500 });
  await companion.show();
  await companion.hide();
  await companion.focus();
  await companion.navigate('https://example.com', { width: 300, height: 200 });
  await companion.close();

  assert.equal(calls.filter(([name]) => name === 'create').length, 2);
  assert.equal(calls[0][1].label, 'main');
  const position = calls.find(([name]) => name === 'position')[1];
  const size = calls.find(([name]) => name === 'size')[1];
  assert.equal(position.x, 16);
  assert.equal(position.y, 8);
  assert.equal(size.width, 500);
  assert.equal(size.height, 600);
  assert.equal(calls.filter(([name]) => name === 'close').length, 2);
});

test('原生关闭失败时保留 Webview 状态，并允许再次关闭', async () => {
  let closeAttempts = 0;
  class RetryableWebview {
    async close() {
      closeAttempts += 1;
      if (closeAttempts === 1) throw new Error('native close failed');
    }
  }

  const globalObject = {
    __TAURI__: {
      webview: { Webview: RetryableWebview },
      window: { getCurrentWindow: () => ({ label: 'main' }) },
    },
  };
  const companion = new CompanionWebview({ globalObject });
  await companion.create('https://example.com/path', { x: 12, y: 8, width: 420, height: 600 });
  const originalView = companion.webview;
  const originalBounds = { ...companion.bounds };

  await assert.rejects(companion.close(), /native close failed/);
  assert.equal(companion.created, true);
  assert.equal(companion.webview, originalView);
  assert.equal(companion.url, 'https://example.com/path');
  assert.deepEqual(companion.bounds, originalBounds);

  assert.equal(await companion.close(), true);
  assert.equal(closeAttempts, 2);
  assert.equal(companion.created, false);
  assert.equal(companion.webview, null);
  assert.equal(companion.url, null);
  assert.equal(companion.bounds, null);
});
