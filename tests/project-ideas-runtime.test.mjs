import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('项目想法入口位于终端工具栏，抽屉支持速记、多条编辑和放入对话', async () => {
  const [page, main, styles] = await Promise.all([
    source('src/index.html'),
    source('src/main.js'),
    source('src/styles.css'),
  ]);
  const dock = page.slice(page.indexOf('id="terminal-dock"'), page.indexOf('id="terminal-fab"'));

  assert.match(dock, /id="terminal-ideas-btn"/);
  assert.match(dock, /id="terminal-ideas-btn"[^>]*disabled/);
  assert.match(dock, /id="project-ideas-drawer"/);
  assert.match(dock, /id="project-ideas-drawer"[^>]*role="complementary"/);
  assert.doesNotMatch(dock, /id="project-ideas-drawer"[^>]*aria-modal="true"/);
  assert.match(dock, /id="project-ideas-title"/);
  assert.match(dock, /id="project-idea-input"/);
  assert.match(dock, /id="project-idea-add"/);
  assert.match(dock, /id="project-ideas-list"/);
  assert.match(dock, /id="project-ideas-close"/);
  assert.match(main, /放入当前对话|放入对话/);
  assert.match(main, /from '\.\/project-ideas-utils\.js'/);
  assert.match(main, /createProjectIdea\(/);
  assert.match(main, /projectIdeasFor\(/);
  assert.match(main, /updateProjectIdea\(/);
  assert.match(main, /removeProjectIdea\(/);
  assert.match(main, /ideasBtn:\s*\$\('terminal-ideas-btn'\)/);
  assert.match(main, /ideaInput:\s*\$\('project-idea-input'\)/);
  assert.match(main, /ideasOrphanList:\s*\$\('project-ideas-orphans-list'\)/);
  assert.match(styles, /\.project-ideas-drawer\b/);
  assert.match(styles, /\.project-ideas-drawer\.active\s*\{[^}]*display:\s*flex/);
  assert.match(styles, /\.project-idea-card\b/);
});

test('想法写入采用单事务飞行，保存完成前禁用其他变更并精确回滚', async () => {
  const main = await source('src/main.js');
  const ideasRuntime = main.slice(
    main.indexOf('// ===== 项目想法'),
    main.indexOf('// ===== 项目"\u6062复现场"'),
  );

  assert.match(ideasRuntime, /createProjectIdeaMutationGate\(\)/);
  assert.match(ideasRuntime, /function beginProjectIdeaMutation\([\s\S]*?!projectIdeaMutationGate\.begin\(\)/);
  assert.match(ideasRuntime, /function commitProjectIdeasMutation\(previous, next\)[\s\S]*?commitProjectIdeaSnapshot\([\s\S]*?persist:\s*persistProjectIdeas[\s\S]*?finally/);
  assert.match(ideasRuntime, /ideaInput\.disabled = projectIdeaMutationGate\.pending/);
  assert.match(ideasRuntime, /querySelectorAll\('button, input, textarea'\)/);
  assert.doesNotMatch(ideasRuntime, /projectIdeaSaveChain/);
});

test('想法始终由活动终端 cwd 定位项目，切换会话会同步或关闭旧项目抽屉', async () => {
  const main = await source('src/main.js');
  const ideasRuntime = main.slice(
    main.indexOf('// ===== 项目想法'),
    main.indexOf('// ===== 项目"\u6062复现场"'),
  );

  assert.match(ideasRuntime, /activeSession/);
  assert.match(ideasRuntime, /sessions\.get\(activeSession\)/);
  assert.match(ideasRuntime, /session\?\.status\s*===\s*['"]running['"]/);
  assert.match(ideasRuntime, /sessionCloseCoordinator\.isClosing\(activeSession\)/);
  assert.match(ideasRuntime, /findProjectByCwd\([^)]*cwd/);
  assert.match(ideasRuntime, /projectIdeasFor\([^,]+,\s*project\.id/);
  assert.match(ideasRuntime, /createProjectIdea\([^,]+,\s*project\.id/);
  assert.match(ideasRuntime, /ideasBtn\.disabled\s*=\s*!project|ideasBtn\.disabled\s*=\s*!Boolean\(project\)/);
  assert.doesNotMatch(ideasRuntime, /req-project|fillReqProjectSelect|<select[^>]+project/i);

  const activate = main.slice(
    main.indexOf('function activateSession'),
    main.indexOf('function removeSessionFromPane'),
  );
  assert.match(activate, /syncProjectIdeas|closeProjectIdeas|renderProjectIdeas/);
});

test('放入当前对话会重新校验项目和会话，只调用 xterm paste 而不代替用户回车', async () => {
  const main = await source('src/main.js');
  const call = main.indexOf('planProjectIdeaPaste({');
  assert.ok(call >= 0, '放入对话前应先通过纯函数生成受校验的粘贴计划');
  const runtime = main.slice(Math.max(0, call - 1200), call + 2400);

  assert.match(runtime, /planProjectIdeaPaste\(/);
  assert.match(runtime, /activeSession/);
  assert.match(runtime, /sessions\.get\(/);
  assert.match(runtime, /session\.term\.paste\(plan\.text\)/);
  assert.match(runtime, /session\.term\.focus\(\)/);
  assert.match(runtime, /lastPlacedAt/);
  assert.match(runtime, /lastPlacedTool/);
  assert.match(runtime, /lastPlacedSessionId/);
  assert.match(runtime, /commitProjectIdeasMutation\(/);
  assert.doesNotMatch(runtime, /createSession\s*\(\s*\{\s*\}\s*\)/);
  assert.doesNotMatch(runtime, /plan\.text\s*\+\s*['"]\\r['"]/);
  assert.doesNotMatch(runtime, /injectSnippet\([^,]+,\s*true\)/);
});

test('旧侧栏需求入口、全局弹窗和 requirements 持久化已完整移除', async () => {
  const [page, main, styles, rust] = await Promise.all([
    source('src/index.html'),
    source('src/main.js'),
    source('src/styles.css'),
    source('src-tauri/src/lib.rs'),
  ]);

  assert.doesNotMatch(page, /id="req-entry"|id="req-modal-overlay"|id="req-modal-close"/);
  assert.doesNotMatch(page, />\s*需求清单\s*</);
  assert.doesNotMatch(main, /openReqModal|closeReqModal|updateReqBadge|fillReqProjectSelect|reqFilter|renderReqList/);
  assert.doesNotMatch(styles, /\.req-(?:capture|tabs?|row|status|main|title|note|meta|pri|tag|time|actions?|edit)\b/);

  assert.doesNotMatch(main, /get_requirements|save_requirements|\brequirements\b/);
  assert.doesNotMatch(rust, /\bRequirement\b|get_requirements|save_requirements|requirements\.json/);
  assert.match(main, /invoke\('get_project_ideas'\)/);
  assert.match(main, /invoke\('save_project_ideas'/);
  assert.match(rust, /struct ProjectIdea/);
  assert.match(rust, /ideas\.json/);
  assert.match(rust, /fn get_project_ideas/);
  assert.match(rust, /fn save_project_ideas/);
  assert.match(rust, /archived:\s*bool/);
  assert.match(rust, /last_placed_at|lastPlacedAt/);
  assert.match(rust, /last_placed_tool|lastPlacedTool/);
  assert.match(rust, /last_placed_session_id|lastPlacedSessionId/);
});

test('想法抽屉接入 ESC、原生 WebView 浮层状态和终端收起清理', async () => {
  const [main, nativeEsc] = await Promise.all([
    source('src/main.js'),
    source('src/native-esc-utils.js'),
  ]);
  const open = main.slice(
    main.indexOf('function openProjectIdeas'),
    main.indexOf('function closeProjectIdeas'),
  );
  const close = main.slice(
    main.indexOf('function closeProjectIdeas'),
    main.indexOf('\nfunction ', main.indexOf('function closeProjectIdeas') + 10),
  );
  const escapeHandler = main.slice(
    main.indexOf('document.onkeydown'),
    main.indexOf('// 运行环境切换'),
  );
  const collapse = main.slice(
    main.indexOf('function collapseDock'),
    main.indexOf('// 最大化/还原终端抽屉'),
  );

  assert.match(open, /setFloatingUiOpen\('project-ideas', true\)/);
  assert.match(close, /setFloatingUiOpen\('project-ideas', false\)/);
  const gateLatestWins = /const revision\s*=\s*ideaPanelGate\.begin\(\)[\s\S]*?await[\s\S]*?!ideaPanelGate\.isCurrent\(revision\)/.test(open)
    && /ideaPanelGate\.invalidate\(\)/.test(close);
  const revisionLatestWins = /const revision\s*=\s*\+\+ideaPanelRevision[\s\S]*?await[\s\S]*?revision\s*!==\s*ideaPanelRevision/.test(open)
    && /ideaPanelRevision\s*\+=\s*1|\+\+ideaPanelRevision/.test(close);
  assert.ok(gateLatestWins || revisionLatestWins, '关闭后迟到的 WebView 隐藏结果不得重新打开想法抽屉');
  assert.match(escapeHandler, /closeProjectIdeas\(\)/);
  assert.match(collapse, /closeProjectIdeas\(false\)/);
  assert.match(nativeEsc, /#project-ideas-drawer\.active/);
});
