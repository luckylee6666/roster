import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const orchestraRust = readFileSync(new URL('../src-tauri/src/orchestra.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const orchestraModal = page.slice(
  page.indexOf('<!-- 协作会话 -->'),
  page.indexOf('<!-- 历史会话预览 -->'),
);
const orchestraRuntime = main.slice(
  main.indexOf('let orchestraProject = null;'),
  main.indexOf('// ===== 项目卡片 Git 状态徽标 ====='),
);

test('协作弹窗从 CLI 登记表动态生成单选大脑和多选干活终端', () => {
  assert.match(main, /function openOrchestraModal/);
  assert.match(main, /const availableTools = installedCliTools\(config\.kit\)/);
  assert.match(main, /availableTools\.map\(tool => orchestraPickHtml\(tool, 'brain', config\)\)/);
  assert.match(main, /availableTools\.map\(tool => orchestraPickHtml\(tool, 'worker', config\)\)/);
  assert.doesNotMatch(orchestraRuntime, /<small>未安装<\/small>/);
  assert.match(main, /type = role === 'brain' \? 'radio' : 'checkbox'/);
  assert.match(main, /class="action-btn orchestra-btn-card"/);
  assert.match(main, /开协作/);
  assert.match(orchestraModal, /id="orchestra-overlay"/);
  assert.match(orchestraModal, /id="orchestra-brain-picks"/);
  assert.match(orchestraModal, /id="orchestra-worker-picks"/);
  assert.match(orchestraModal, /只显示本机已安装的 CLI/);
  assert.doesNotMatch(orchestraModal, /name="orchestra-brain"/);
  assert.doesNotMatch(orchestraModal, /干活：Codex|另外两个|三家/);
  assert.match(page, /id="orchestra-bar"/);
  assert.match(page, /发给大脑/);
  assert.match(page, /派活/);
  assert.match(styles, /\.orchestra-tool-picks\s*\{[\s\S]*?flex-wrap: wrap/);
  assert.match(styles, /\.orchestra-bar\.active/);
  assert.match(styles, /\.term-pane-role\[data-role="brain"\]/);
});

test('协作弹窗接入 latest-wins 门闩，旧探测结果和关闭后的结果不会重新打开弹窗', () => {
  assert.match(main, /createLatestRequestGate/);
  assert.match(orchestraRuntime, /const orchestraModalGate = createLatestRequestGate\(\)/);
  assert.match(orchestraRuntime, /const request = orchestraModalGate\.begin\(\)[\s\S]*?await refreshInstalledClis\(\{ force: true \}\)[\s\S]*?if \(!orchestraModalGate\.isCurrent\(request\)\) return/);
  assert.match(orchestraRuntime, /function closeOrchestraModal\(\)[\s\S]*?orchestraModalGate\.invalidate\(\)/);
});

test('协作按单大脑和多 workers 新开并精确绑定本次终端', () => {
  assert.match(orchestraRuntime, /function selectedOrchestraBrain\(\)[\s\S]*?input\[name="orchestra-brain"\]:checked/);
  assert.match(orchestraRuntime, /function selectedOrchestraWorkers\(\)[\s\S]*?input\[name="orchestra-worker"\]:checked/);
  assert.match(orchestraRuntime, /workers: selectedOrchestraWorkers\(\)/);
  assert.match(orchestraRuntime, /const participants = \[config\.brain, \.\.\.config\.workers\]/);
  assert.match(orchestraRuntime, /runOrchestraLaunchTransaction\(\{[\s\S]*?participants,[\s\S]*?create: tool => createProjectToolSession\(project, tool\)/);
  assert.match(main, /async function launchProjectTools\(project, selectedTools,[\s\S]*?for \(const tool of selectedTools\)[\s\S]*?autoCmd/);
  assert.match(orchestraRuntime, /activeOrchestra\.sessionIds\?\.\[tool\] === id/);
  const sessionLookup = orchestraRuntime.slice(
    orchestraRuntime.indexOf('function orchestraSessionId'),
    orchestraRuntime.indexOf('async function sendOrchestra'),
  );
  assert.match(sessionLookup, /activeOrchestra\?\.sessionIds\?\.\[tool\]/);
  assert.doesNotMatch(sessionLookup, /findRunningProjectTool/);
  assert.doesNotMatch(orchestraRuntime, /三个窗口|DEFAULT_PROJECT_KIT/);
});

test('无 worker 或启动锁忙时先拦截，终端验收成功后才提交计划并切换协作', () => {
  const start = orchestraRuntime.slice(
    orchestraRuntime.indexOf('async function startOrchestraFromModal'),
  );
  const guard = start.indexOf('if (!config.workers.length)');
  const opening = start.indexOf('const openingToken = beginProjectToolOpening()');
  const busyGuard = start.indexOf('if (!openingToken)');
  const close = start.indexOf('closeOrchestraModal()');
  const launch = start.indexOf('await runOrchestraLaunchTransaction({');
  const commit = start.indexOf('await commitOrchestraFiles(project.localPath, goal)');
  const activate = start.indexOf('activeOrchestra = {');
  assert.ok(guard >= 0);
  assert.ok(opening >= 0);
  assert.ok(busyGuard >= 0);
  assert.ok(guard < close);
  assert.ok(opening < busyGuard);
  assert.ok(busyGuard < close);
  assert.ok(guard < launch);
  assert.ok(close < launch);
  assert.ok(launch < commit);
  assert.ok(commit < activate);
  assert.doesNotMatch(start.slice(0, launch), /commitOrchestraFiles|write_orchestra_file/);
  assert.match(start, /至少选择一个干活的终端/);
  assert.match(start, /正在打开另一组终端，请稍后再试/);
  assert.match(start, /rollback: createdIds => rollbackCreatedSessions\(createdIds, terminalState\)/);
  assert.match(start, /saveOrchestraConfig\(activeOrchestra\)/);
});

test('协作文件只写在项目 \.vibe/orchestra 且不进 Git', () => {
  assert.match(rust, /ensure_orchestra/);
  assert.match(rust, /write_orchestra_file/);
  assert.match(rust, /read_orchestra_file/);
  assert.match(orchestraRust, /fn valid_inbox_id/);
  assert.match(orchestraRust, /fn allowed_relative[\s\S]*?strip_prefix\("inbox\/"\)[\s\S]*?strip_suffix\("\.md"\)/);
  assert.doesNotMatch(orchestraRust, /"inbox\/(?:claude|grok|codex|opencode|gemini|agy|qwen|mimo)\.md"/);
  assert.match(ignore, /^\.vibe\/$/m);
});
