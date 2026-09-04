import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const usage = readFileSync(new URL('../src-tauri/src/usage.rs', import.meta.url), 'utf8');

test('用量面板支持 Claude、Codex、Grok，且不再依赖 OpenCode/ccusage', () => {
  assert.match(page, /data-agent="claude"/);
  assert.match(page, /data-agent="codex"/);
  assert.match(page, /data-agent="grok"/);
  assert.match(page, /data-agent="claude" hidden/);
  assert.match(page, /data-agent="codex" hidden/);
  assert.match(page, /data-agent="grok" hidden/);
  assert.doesNotMatch(page, /data-agent="opencode"/);
  assert.match(page, /id="terminal-usage-btn" title="用量统计"/);
  assert.match(main, /from '\.\/usage-panel-utils\.js'/);
  assert.match(main, /usageCommandForAgent\(agent\)/);
  assert.match(main, /windowsFromUsagePayload\(agent, o\)/);
  assert.match(main, /usage_supported_agents/);
  assert.match(main, /usageAgentsForInstalledClis\(installedCliIds, usageCapableAgentIds\)/);
  assert.match(main, /tab\.hidden = !visible/);
  assert.match(main, /refreshInstalledClis\(\{ force: true, syncUsageLoad: false \}\)/);
  assert.match(main, /本机没有已安装且支持用量查询的 Claude、Codex 或 Grok/);
  const loadBlock = main.slice(
    main.indexOf('async function loadUsage()'),
    main.indexOf('function renderLimitUsage'),
  );
  const capabilityGateAt = loadBlock.indexOf(
    'usageAgentsForInstalledClis(installedCliIds, usageCapableAgentIds).includes(agent)',
  );
  assert.ok(
    capabilityGateAt >= 0 && capabilityGateAt < loadBlock.indexOf('invoke(command)'),
    '本机未安装的 CLI 必须在调用其用量命令前被拦截',
  );
  assert.match(main, /usagePanelProbeRevision/);
  assert.match(main, /revision !== usagePanelProbeRevision/);
  assert.match(main, /const usageInflight = new Map\(\)/);
  assert.match(main, /currentRevision: usageRequestRevision/);
  assert.match(main, /overlayOpen: \$\('usage-overlay'\)\.classList\.contains\('active'\)/);
  assert.match(main, /renderLimitUsage\(/);
  assert.doesNotMatch(main, /agent_weekly/);
  assert.doesNotMatch(main, /has_npx/);
  assert.doesNotMatch(main, /ccusage/);
  assert.match(rust, /async fn oauth_usage/);
  assert.match(rust, /async fn codex_usage/);
  assert.match(rust, /async fn grok_usage/);
  assert.match(rust, /fn usage_supported_agents/);
  assert.doesNotMatch(rust, /agent_weekly/);
  assert.doesNotMatch(rust, /fn has_npx/);
  assert.match(usage, /account\/rateLimits\/read/);
  assert.match(usage, /codex app-server/);
  assert.match(usage, /billing: fetched credits config/);
  assert.match(usage, /unified\.jsonl/);
  assert.match(usage, /下一次真实请求或交互式 `\/usage`/);
  assert.match(usage, /GROK_LOG_TAIL_BYTES/);
  assert.match(usage, /O_NOFOLLOW/);
  assert.match(usage, /grok_error_or_cached/);
  assert.doesNotMatch(usage, /refresh_grok_billing_snapshot/);
  assert.doesNotMatch(usage, /ccusage/);
});
