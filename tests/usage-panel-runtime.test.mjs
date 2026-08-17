import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const usage = readFileSync(new URL('../src-tauri/src/usage.rs', import.meta.url), 'utf8');

test('用量面板去掉 OpenCode，Codex 走 app-server 限流', () => {
  assert.match(page, /data-agent="claude"/);
  assert.match(page, /data-agent="codex"/);
  assert.doesNotMatch(page, /data-agent="opencode"/);
  assert.match(page, /id="terminal-usage-btn" title="用量统计"/);
  assert.match(main, /from '\.\/usage-panel-utils\.js'/);
  assert.match(main, /usageCommandForAgent\(agent\)/);
  assert.match(main, /windowsFromUsagePayload\(agent, o\)/);
  assert.match(main, /renderLimitUsage\(/);
  assert.doesNotMatch(main, /agent_weekly/);
  assert.doesNotMatch(main, /has_npx/);
  assert.doesNotMatch(main, /ccusage/);
  assert.match(rust, /async fn oauth_usage/);
  assert.match(rust, /async fn codex_usage/);
  assert.doesNotMatch(rust, /agent_weekly/);
  assert.doesNotMatch(rust, /fn has_npx/);
  assert.match(usage, /account\/rateLimits\/read/);
  assert.match(usage, /codex app-server/);
  assert.doesNotMatch(usage, /ccusage/);
});
