import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MEMORY_POINTER_START,
  canonicalProjectMemoryDir,
  encodeClaudeProjectDir,
  ensureMemoryGitignore,
  memoryBannerText,
  parseMemoryTopics,
  isProjectMemoryUnifyEnabled,
  loadProjectMemoryUnifyPaths,
  removeMemoryPointer,
  setProjectMemoryUnifyEnabled,
  shouldAutoMountProjectMemory,
  shouldMountProjectMemory,
  upsertMemoryPointer,
  workspaceMemoryLinkPath,
} from '../src/project-memory-utils.js';

test('Claude 项目目录编码与现有记忆路径一致', () => {
  assert.equal(
    encodeClaudeProjectDir('/Users/lucky/git/smalltree/self/vibe-coding-manage'),
    '-Users-lucky-git-smalltree-self-vibe-coding-manage',
  );
  assert.equal(
    encodeClaudeProjectDir('/Users/lucky/foo.bar/'),
    '-Users-lucky-foo-bar',
  );
  assert.equal(
    canonicalProjectMemoryDir('/Users/lucky', '/Users/lucky/git/app'),
    '/Users/lucky/.claude/projects/-Users-lucky-git-app/memory',
  );
  assert.equal(
    workspaceMemoryLinkPath('/Users/lucky/git/app/'),
    '/Users/lucky/git/app/.memory',
  );
});

test('主目录和根目录不挂载项目记忆', () => {
  assert.equal(shouldMountProjectMemory(''), false);
  assert.equal(shouldMountProjectMemory('/'), false);
  assert.equal(shouldMountProjectMemory('/Users/lucky', '/Users/lucky'), false);
  assert.equal(shouldMountProjectMemory('/Users/lucky/git/app', '/Users/lucky'), true);
});

test('统一记忆到 Claude 默认关闭，只对勾选的项目自动挂载', () => {
  assert.deepEqual(loadProjectMemoryUnifyPaths('{"paths":["/Users/lucky/git/app/"]}'), ['/Users/lucky/git/app']);
  assert.equal(isProjectMemoryUnifyEnabled('/Users/lucky/git/app', []), false);
  const enabled = setProjectMemoryUnifyEnabled('/Users/lucky/git/app/', true, []);
  assert.equal(isProjectMemoryUnifyEnabled('/Users/lucky/git/app', enabled), true);
  assert.equal(shouldAutoMountProjectMemory('/Users/lucky/git/app', '/Users/lucky', []), false);
  assert.equal(shouldAutoMountProjectMemory('/Users/lucky/git/app', '/Users/lucky', enabled), true);
  assert.deepEqual(setProjectMemoryUnifyEnabled('/Users/lucky/git/app', false, enabled), []);
});

test('指令指针和 gitignore 重复写入保持稳定', () => {
  const first = upsertMemoryPointer('# 约束\n');
  const second = upsertMemoryPointer(first);
  assert.equal(first, second);
  assert.match(first, new RegExp(MEMORY_POINTER_START));
  assert.match(first, /长期记忆只在 `\.memory\//);
  const ignore = ensureMemoryGitignore('node_modules\n');
  assert.equal(ignore, ensureMemoryGitignore(ignore));
  assert.match(ignore, /^\.memory$/m);
  const stripped = removeMemoryPointer(first);
  assert.equal(stripped.includes(MEMORY_POINTER_START), false);
  assert.match(stripped, /# 约束/);
  assert.equal(removeMemoryPointer(stripped), stripped);
});

test('从 MEMORY.md 解析专题链接并生成挂载提示', () => {
  const topics = parseMemoryTopics('# 索引\n\n- [内置终端](builtin-terminal.md)\n- [发版](release-process.md)\n');
  assert.deepEqual(topics, [
    { title: '内置终端', file: 'builtin-terminal.md' },
    { title: '发版', file: 'release-process.md' },
  ]);
  assert.equal(
    memoryBannerText({ mounted: true, topicCount: 2, inboxCount: 1 }),
    '[项目记忆] 已挂载 .memory（2 个专题，inbox 1）',
  );
  assert.equal(memoryBannerText({ mounted: false, warning: '主目录不挂载' }), '[项目记忆] 主目录不挂载');
});
