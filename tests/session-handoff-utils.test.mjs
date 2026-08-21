import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SESSION_HANDOFF_FILE_MAX_BYTES,
  SESSION_HANDOFF_MAX_BYTES,
  buildSessionHandoffMarkdown,
  handoffLaunchPrompt,
  handoffTargetTools,
  latestHandoffSession,
  validateSessionHandoffContent,
} from '../src/session-handoff-utils.js';

test('交接目标只包含已安装且不是来源的 CLI', () => {
  assert.deepEqual(
    handoffTargetTools(['grok', 'claude', 'mimo', 'unknown'], 'claude').map(tool => tool.id),
    ['grok', 'mimo'],
  );
  assert.deepEqual(
    handoffTargetTools(['grok', 'claude', 'codex'], 'grok').map(tool => tool.id),
    ['claude', 'codex'],
  );
});

test('按时间选中来源工具的最新会话', () => {
  const groups = [
    { tool: 'grok', sessions: [{ id: 'g1', atMs: 999 }] },
    { tool: 'claude', sessions: [{ id: 'c1', atMs: 10 }, { id: 'c2', atMs: 20 }] },
  ];
  assert.equal(latestHandoffSession(groups, 'claude')?.id, 'c2');
  assert.equal(latestHandoffSession(groups, 'codex'), null);
});

test('交接稿包含最近对话、目标和当前 Git 现场', () => {
  const markdown = buildSessionHandoffMarkdown({
    project: { name: 'Roster', localPath: '/repo/roster' },
    sourceTool: 'claude',
    targetTool: 'grok',
    generatedAt: '2026-08-21T10:00:00.000Z',
    preview: {
      sourceId: 'session-1',
      sourceTitle: '完成登录功能',
      truncated: true,
      messages: [
        { role: 'user', text: '这个实现不太好，换个方案。' },
        { role: 'assistant', text: '还需要处理失败回滚。' },
      ],
    },
    context: {
      exists: true,
      isRepo: true,
      branch: 'main',
      dirty: true,
      changed: 2,
      untracked: 1,
      ahead: 1,
      behind: 0,
      files: [{ status: 'M', path: 'src/main.js' }],
      filesMore: 0,
      commits: [{ hash: 'abc123', subject: '功能：登录', rel: '2 小时前' }],
    },
  });

  assert.match(markdown, /来源：Claude/);
  assert.match(markdown, /接手：Grok/);
  assert.match(markdown, /### 用户\n\n这个实现不太好/);
  assert.match(markdown, /### Claude\n\n还需要处理失败回滚/);
  assert.match(markdown, /分支：main/);
  assert.match(markdown, /M src\/main\.js/);
  assert.match(markdown, /只保留最近一段/);
});

test('任意来源和目标都使用登记表名称生成交接稿', () => {
  const markdown = buildSessionHandoffMarkdown({
    project: { name: 'Roster', localPath: '/repo/roster' },
    sourceTool: 'grok',
    targetTool: 'claude',
    preview: {
      sourceId: 'grok-1',
      sourceTitle: '继续登录功能',
      messages: [{ role: 'assistant', text: '需要换一种实现。' }],
    },
    context: { exists: true, isRepo: false },
  });
  assert.match(markdown, /来源：Grok/);
  assert.match(markdown, /接手：Claude/);
  assert.match(markdown, /### Grok\n\n需要换一种实现/);
});

test('交接稿按 UTF-8 字节上限截断', () => {
  const markdown = buildSessionHandoffMarkdown({
    project: { name: '大项目', localPath: '/repo/app' },
    sourceTool: 'claude',
    targetTool: 'grok',
    preview: {
      sourceId: 'long',
      sourceTitle: '长对话',
      messages: [{ role: 'assistant', text: '测'.repeat(40_000) }],
    },
    context: { exists: true, isRepo: false },
  });
  assert.ok(new TextEncoder().encode(markdown).length <= SESSION_HANDOFF_MAX_BYTES);
  assert.match(markdown, /交接稿已按安全上限截断/);
});

test('用户编辑的交接稿按 UTF-8 字节而不是字符数校验', () => {
  assert.equal(validateSessionHandoffContent('x'.repeat(SESSION_HANDOFF_FILE_MAX_BYTES)).valid, true);
  assert.equal(validateSessionHandoffContent('中'.repeat(21_845)).valid, true);
  const oversized = validateSessionHandoffContent('中'.repeat(21_846));
  assert.equal(oversized.valid, false);
  assert.equal(oversized.bytes, 65_538);
  assert.match(oversized.error, /64 KiB/);
  assert.equal(validateSessionHandoffContent('\0').valid, false);
});

test('启动提示只有一行且要求核对真实工作区', () => {
  const prompt = handoffLaunchPrompt('.vibe/handoff/abc.md\n', 'claude', 'grok');
  assert.doesNotMatch(prompt, /[\r\n]/);
  assert.match(prompt, /从 Claude 交给 Grok/);
  assert.match(prompt, /\.vibe\/handoff\/abc\.md/);
  assert.match(prompt, /检查当前 Git 工作区/);
});
