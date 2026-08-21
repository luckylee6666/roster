import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('终端工具栏为任意已登记 CLI 提供跨 CLI 交接预览和目标选择', async () => {
  const [html, main, css] = await Promise.all([
    readFile(new URL('src/index.html', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/styles.css', root), 'utf8'),
  ]);

  assert.match(html, /id="terminal-handoff-btn"[^>]*disabled/);
  assert.match(html, /id="session-handoff-overlay"/);
  assert.match(html, /id="session-handoff-targets"[^>]*role="radiogroup"/);
  assert.match(html, /id="session-handoff-content"[^>]*maxlength="65536"/);
  assert.match(html, /内容可能发送给目标 CLI 对应的服务/);
  assert.match(css, /\.modal-handoff/);
  assert.match(css, /\.handoff-content/);

  assert.match(main, /CLI_TOOL_IDS\.includes\(current\.sourceTool\)/);
  assert.match(main, /handoffTargetTools\(installedCliIds, sourceTool\)/);
  assert.match(main, /const targetTool = targets\[0\]\.id/);
  assert.match(main, /sourceTool: current\.sourceTool/);
  assert.match(main, /validateSessionHandoffContent\(content\)/);
  assert.match(main, /if \(!validation\.valid\)[\s\S]*?return;/);
  assert.doesNotMatch(main, /SESSION_HANDOFF_SOURCE_TOOL/);
  assert.match(main, /syncProjectIdeasContext\(\)[\s\S]*?syncSessionHandoffButton\(\)/);
});

test('交接读取最新磁盘会话和 Git 现场，再安全新开目标终端', async () => {
  const main = await readFile(new URL('src/main.js', root), 'utf8');
  const openBlock = main.slice(
    main.indexOf('async function openSessionHandoff()'),
    main.indexOf('async function startSessionHandoff()'),
  );
  const startBlock = main.slice(
    main.indexOf('async function startSessionHandoff()'),
    main.indexOf('let orchestraProject = null'),
  );

  assert.match(openBlock, /invalidateProjectSessionHistory\(current\.project\.localPath\)/);
  assert.match(openBlock, /loadProjectSessionHistory\(current\.project\.localPath\)/);
  assert.match(openBlock, /invoke\('project_context'/);
  assert.match(openBlock, /latestHandoffSession\(history\.groups, current\.sourceTool\)/);
  assert.match(openBlock, /invoke\('preview_session_handoff'/);
  assert.match(openBlock, /sourceTool: current\.sourceTool/);

  const writeAt = startBlock.indexOf("invoke('write_session_handoff'");
  const createAt = startBlock.indexOf('createProjectToolSession(context.project, targetTool)');
  const injectAt = startBlock.indexOf('injectToSession(createdId, prompt)');
  assert.ok(writeAt >= 0 && writeAt < createAt && createAt < injectAt);
  assert.match(startBlock, /handoffLaunchPrompt\(/);
  assert.match(startBlock, /rollbackCreatedSessions\(\[createdId\], terminalState\)/);
  assert.match(startBlock, /sourceTool !== context\.sourceTool/);
  assert.match(startBlock, /handoffLaunchPrompt\([\s\S]*?context\.sourceTool/);
  assert.match(startBlock, /sourceLabel} 原会话仍保留/);
  assert.match(startBlock, /const operation = Object\.freeze/);
  assert.match(startBlock, /sessionHandoffOperation !== operation/);
  assert.match(startBlock, /sessionHandoffOperation === operation/);
  assert.doesNotMatch(startBlock, /resumeCliCommand|launchCommandForProjectTool/);

  const closeBlock = main.slice(
    main.indexOf('function closeSessionHandoff'),
    main.indexOf('async function openSessionHandoff'),
  );
  assert.match(closeBlock, /sessionHandoffBusy && !force/);
  assert.match(closeBlock, /return false/);
  assert.match(main, /sessionHandoffClose\.disabled = sessionHandoffBusy/);
  assert.match(main, /sessionHandoffCancel\.disabled = sessionHandoffBusy/);
});

test('Rust 交接文件和会话抽取命令已注册', async () => {
  const [lib, sessions, orchestra] = await Promise.all([
    readFile(new URL('src-tauri/src/lib.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/project_sessions.rs', root), 'utf8'),
    readFile(new URL('src-tauri/src/orchestra.rs', root), 'utf8'),
  ]);
  assert.match(lib, /preview_session_handoff,/);
  assert.match(lib, /write_session_handoff,/);
  const sourceBlock = sessions.slice(
    sessions.indexOf('fn source_handoff_messages('),
    sessions.indexOf('pub fn preview_session_handoff_with_home('),
  );
  for (const tool of ['claude', 'grok', 'codex', 'opencode', 'gemini', 'agy', 'qwen', 'mimo']) {
    assert.match(sourceBlock, new RegExp(`"${tool}" =>`));
  }
  assert.match(sessions, /limit_handoff_messages/);
  assert.match(sessions, /read_utf8_file_bounded/);
  assert.match(sessions, /sqlite_handoff_candidates/);
  assert.match(orchestra, /pub const HANDOFF_DIR: &str = "\.vibe\/handoff"/);
  assert.match(orchestra, /O_EXCL/);
  assert.match(orchestra, /require_single_link\(&file, "交接文件"\)/);
});
