import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CONVERSATION_PROMPT_MAX_BYTES,
  confirmConversationDeletion,
  conversationEventRenderMode,
  inspectConversationPrompt,
  utf8ByteLength,
} from '../src/conversation-mode.js';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

test('对话工作台具有项目、历史、消息、输入和进度三区结构', async () => {
  const html = await read('src/index.html');
  for (const id of [
    'conversation-surface',
    'development-surface',
    'development-overlays',
    'conversation-project-list',
    'conversation-history-list',
    'conversation-messages',
    'conversation-composer',
    'conversation-snippet-select',
    'conversation-manage-snippets',
    'conversation-handoff',
    'conversation-write-access',
    'conversation-send',
    'conversation-plan-list',
    'conversation-activity-list',
    'conversation-idea-list',
  ]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, 'g')) || []).length, 1, `${id} 应唯一存在`);
  }
});

test('对话工作台复用项目想法、项目现场和 Prompt 片段能力', async () => {
  const [html, conversation, main] = await Promise.all([
    read('src/index.html'),
    read('src/conversation-mode.js'),
    read('src/main.js'),
  ]);
  assert.match(html, /id="conversation-project-context"/);
  assert.match(html, /id="conversation-idea-capture"/);
  assert.match(html, /id="conversation-snippet-select"/);
  assert.match(conversation, /setSnippets\(nextSnippets\)/);
  assert.match(conversation, /onCreateIdea\(\{/);
  assert.match(conversation, /onUpdateIdea\(\{/);
  assert.match(conversation, /delete_conversation_project_session/);
  assert.match(conversation, /projectId: project\.id/);
  assert.doesNotMatch(conversation, /delete_conversation_project_session', \{[\s\S]{0,100}path: project\.localPath/);
  assert.match(main, /conversationController\.setSnippets\(snippets\)/);
});

test('对话工作台补齐归档想法、片段管理、交接与无项目入口', async () => {
  const [html, conversation, main, css] = await Promise.all([
    read('src/index.html'),
    read('src/conversation-mode.js'),
    read('src/main.js'),
    read('src/styles.css'),
  ]);
  assert.match(html, /id="conversation-ideas-toggle-archived"/);
  assert.match(html, /id="conversation-manage-snippets"/);
  assert.match(html, /id="conversation-handoff"/);
  assert.match(html, /id="snippet-modal-overlay" data-app-global-overlay/);
  assert.match(conversation, /Boolean\(idea\.archived\) === showingArchivedIdeas/);
  assert.match(conversation, /showingArchivedIdeas \? '恢复' : '完善'/);
  assert.match(conversation, /onManageSnippets\?\.\(\)/);
  assert.match(conversation, /providerSelect\?\.showPicker/);
  assert.match(conversation, /conversationHasOpenSession\(state\)[\s\S]{0,100}runnableProviders\(\)\.length < 2/);
  assert.match(conversation, /conversation-create-project/);
  assert.match(conversation, /仅含用户记录/);
  assert.match(main, /onManageSnippets: openSnippetModal/);
  assert.match(main, /onCreateProject: async \(\) => \{[\s\S]{0,120}setView\('developer'\)[\s\S]{0,80}openModal\(\)/);
  assert.match(css, /\.conversation-starter-list button:disabled/);
  assert.match(css, /\.conversation-compact-action/);
});

test('CSS 加载前恢复应用视图，首次安装默认对话模式', async () => {
  const html = await read('src/index.html');
  const cssLink = html.indexOf('href="styles.css"');
  const preload = html.indexOf("localStorage.getItem('roster-app-view-v1')");
  assert.ok(preload > 0 && preload < cssLink);
  assert.match(html, /savedAppShell\.appView === 'developer'[\s\S]*\? 'developer'[\s\S]*: 'conversation'/);
});

test('空状态收在输入区上方，助手选择靠近发送，空闲时隐藏步骤和动态', async () => {
  const [html, css, conversation] = await Promise.all([
    read('src/index.html'),
    read('src/styles.css'),
    read('src/conversation-mode.js'),
  ]);
  const emptyAt = html.indexOf('id="conversation-empty"');
  const composeAt = html.indexOf('conversation-compose-wrap');
  const starterAt = html.indexOf('id="conversation-starter-list"');
  const pickerAt = html.indexOf('id="conversation-provider-select"');
  const headerAt = html.indexOf('class="conversation-header"');
  const headerEnd = html.indexOf('</header>', headerAt);
  assert.ok(emptyAt > 0 && composeAt > emptyAt);
  assert.ok(starterAt > composeAt);
  assert.ok(pickerAt > composeAt);
  assert.ok(html.slice(headerAt, headerEnd).includes('conversation-run-status'));
  assert.doesNotMatch(html.slice(headerAt, headerEnd), /conversation-provider-select/);
  assert.doesNotMatch(html, /conversation-agent-card/);
  assert.doesNotMatch(html, /conversation-empty-mark/);
  assert.match(html, /conversation-plan-section" hidden/);
  assert.match(html, /conversation-activity-section" hidden/);
  assert.match(css, /--chat-accent:\s*#4f46e5/);
  assert.match(css, /\.conversation-project-section \{/);
  assert.match(css, /\.conversation-starter-list\[hidden\]/);
  assert.match(conversation, /dom\.starters\) dom\.starters\.hidden/);
  assert.match(conversation, /dom\.planSection\) dom\.planSection\.hidden/);
  assert.match(conversation, /dom\.activitySection\) dom\.activitySection\.hidden/);
  const sidebar = html.slice(html.indexOf('conversation-sidebar'), html.indexOf('conversation-main'));
  const rail = html.slice(html.indexOf('class="conversation-rail"'));
  const historyTitleAt = html.indexOf('最近对话');
  const newChatAt = html.indexOf('id="conversation-new-chat"');
  assert.doesNotMatch(sidebar, /conversation-history-list/);
  assert.doesNotMatch(sidebar, /conversation-new-chat/);
  assert.match(rail, /id="conversation-history-list"/);
  assert.match(rail, /id="conversation-new-chat"/);
  assert.ok(historyTitleAt > 0 && newChatAt > historyTitleAt);
  assert.match(html, /id="conversation-composer"[\s\S]*?data-app-view-focus/);
  assert.match(css, /\.conversation-rail-section\.conversation-history-section/);
  assert.match(css, /\.conversation-new-chat\[hidden\]/);
  assert.match(conversation, /conversationHasOpenSession\(state\)/);
  assert.match(conversation, /dom\.newChat\.hidden = !showNewChat/);
});

test('对话输入框为当前 CLI 提供斜杠命令补全', async () => {
  const [html, conversation] = await Promise.all([
    read('src/index.html'),
    read('src/conversation-mode.js'),
  ]);
  assert.match(html, /id="conversation-slash-menu"/);
  assert.match(conversation, /conversation_slash_list/);
  assert.match(conversation, /conversation_model_list/);
  assert.match(conversation, /conversation_effort_list/);
  assert.match(conversation, /provider\.supportsModel/);
  assert.match(conversation, /provider\.supportsEffort/);
  assert.match(
    conversation,
    /async function openHistory[\s\S]*?loadConversationTranscript[\s\S]*?refreshSlashCommands\(\)/,
  );
  assert.match(conversation, /mergeConversationSlashCommands/);
  assert.match(conversation, /model: currentModel\(\)/);
  assert.match(conversation, /effort: currentEffort\(\)/);
  assert.match(conversation, /正在读取 \$\{currentProvider\(\)\.label\} 的\$\{kind\}/);
  assert.match(conversation, /dataset\.kind = parsed\.mode/);
});

test('对话模式去掉项目首字和消息字母块，发言人只留文字名', async () => {
  const [css, conversation] = await Promise.all([
    read('src/styles.css'),
    read('src/conversation-mode.js'),
  ]);
  assert.doesNotMatch(conversation, /conversation-project-mark/);
  assert.doesNotMatch(conversation, /conversation-message-avatar/);
  assert.doesNotMatch(css, /conversation-project-mark/);
  assert.doesNotMatch(css, /conversation-message-avatar/);
  assert.match(conversation, /conversation-message-label/);
  assert.match(conversation, /provider\.label/);
});

test('助手 Markdown 不保留 HTML 换行空白，用户纯文本仍保留换行', async () => {
  const css = await read('src/styles.css');
  const sharedStart = css.indexOf('.conversation-message-content {');
  const userStart = css.indexOf('.conversation-message.is-user .conversation-message-content {');
  const shared = css.slice(sharedStart, userStart);
  assert.ok(sharedStart >= 0 && userStart > sharedStart);
  assert.doesNotMatch(shared, /white-space:\s*pre-wrap/);
  assert.match(css.slice(userStart, css.indexOf('.conversation-thinking {')), /white-space:\s*pre-wrap/);
  assert.match(css, /li > p \{ margin: 0; \}/);
});

test('长对话只在消息区滚动，不能把底部输入框推出视口', async () => {
  const css = await read('src/styles.css');
  const shell = css.slice(css.indexOf('.conversation-shell {'), css.indexOf('.conversation-sidebar,', css.indexOf('.conversation-shell {')));
  const main = css.slice(css.indexOf('.conversation-main {'), css.indexOf('.conversation-header {', css.indexOf('.conversation-main {')));
  const scroll = css.slice(css.indexOf('.conversation-scroll {'), css.indexOf('.conversation-empty {', css.indexOf('.conversation-scroll {')));

  assert.match(shell, /grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  assert.match(main, /min-height:\s*0/);
  assert.match(main, /overflow:\s*hidden/);
  assert.match(scroll, /min-height:\s*0/);
  assert.match(scroll, /overflow:\s*auto/);
});

test('对话使用结构化多 CLI IPC 和 DOMPurify，不解析终端 ANSI', async () => {
  const [conversation, controller, main, rust, codexAdapter, router] = await Promise.all([
    read('src/conversation-mode.js'),
    read('src/conversation-run-controller.js'),
    read('src/main.js'),
    read('src-tauri/src/lib.rs'),
    read('src-tauri/src/codex_chat.rs'),
    read('src-tauri/src/conversation_chat.rs'),
  ]);
  assert.match(controller, /invoke\('conversation_chat_start', \{ request \}\)/);
  assert.match(controller, /invoke\('conversation_chat_cancel', \{ runId \}\)/);
  assert.match(conversation, /listen\('conversation-chat-event'/);
  assert.match(conversation, /DOMPurify\.sanitize/);
  assert.match(conversation, /preview_conversation_transcript/);
  assert.match(conversation, /read_conversation_project_media/);
  assert.match(conversation, /conversation-message-attachments/);
  assert.doesNotMatch(conversation, /terminal-output|xterm|ANSI/i);
  assert.match(rust, /conversation_chat_start/);
  assert.match(rust, /conversation_chat_cancel/);
  assert.match(rust, /preview_conversation_transcript/);
  assert.match(rust, /read_conversation_project_media/);
  assert.match(conversation, /allowWrite/);
  assert.match(codexAdapter, /json!\(\{ "type": "readOnly" \}\)/);
  assert.match(codexAdapter, /get_webview_window\("main"\)/);
  assert.doesNotMatch(codexAdapter, /app\.emit\(/);
  assert.match(router, /HEADLESS_PROVIDERS/);
  assert.match(router, /resolve_registered_cli_bin/);
  assert.doesNotMatch(router, /Command::new\(&input\./);
  assert.match(main, /installConversationMode/);
});

test('对话 Markdown 禁止内联样式和未校验 data 图片', async () => {
  const conversation = await read('src/conversation-mode.js');
  assert.match(conversation, /FORBID_ATTR:\s*\['style', 'id', 'name'\]/);
  assert.doesNotMatch(conversation, /if \(\/\^data:image\\\//);
});

test('对话启动与取消命令移出 Tauri UI 线程', async () => {
  const rust = await read('src-tauri/src/lib.rs');
  assert.match(rust, /async fn conversation_chat_start\(/);
  assert.match(rust, /async fn conversation_chat_cancel\(/);
  assert.match(
    rust,
    /async fn conversation_chat_start[\s\S]*?spawn_blocking\(move \|\|[\s\S]*?conversation_chat::start/,
  );
  assert.match(
    rust,
    /async fn conversation_chat_cancel[\s\S]*?spawn_blocking\(move \|\|[\s\S]*?conversation_chat::cancel/,
  );
});

test('事件监听就绪前禁止发送，连接中取消会等后端注册后再执行', async () => {
  const conversation = await read('src/conversation-mode.js');
  assert.match(conversation, /!listenerReady/);
  assert.match(conversation, /dom\.stop\.hidden = !busy/);
  assert.match(conversation, /!\['starting', 'running'\]\.includes\(state\.status\)/);
  assert.match(conversation, /runController\.cancel\(runId, \{ backendReady: false \}\)/);
});

test('运行中可预输入，停止看门狗和删除门禁不会让界面永久卡死', async () => {
  const [conversation, css] = await Promise.all([
    read('src/conversation-mode.js'),
    read('src/styles.css'),
  ]);
  assert.match(conversation, /const STOPPING_WATCHDOG_MS = 10_000/);
  assert.match(conversation, /function armStoppingWatchdog\(runId\)/);
  assert.match(conversation, /status: 'running', notice: '停止请求尚未确认/);
  assert.match(conversation, /dom\.composer\.disabled = unavailable;/);
  assert.match(conversation, /isDeletingHistory\(\)/);
  assert.match(conversation, /const selectedProjectExists = \(\) => Boolean\(selectedProject/);
  assert.match(conversation, /project => project\.id === finishedProject\.id/);
  assert.match(conversation, /当前项目已被删除；本轮对话保留在屏幕上/);
  assert.match(css, /\.conversation-rail \{[\s\S]*?overflow: auto;/);
  assert.match(css, /data-state="loading"\] i/);
  assert.match(css, /data-state="history"\] i/);
});

test('强制 CLI 探测会取消旧重试，避免旧请求覆盖已安装列表', async () => {
  const main = await read('src/main.js');
  assert.match(
    main,
    /async function refreshInstalledClis\(\{ force = false \} = \{\}\) \{[\s\S]{0,700}if \(force && installedCliRetryTimer !== null\) \{[\s\S]{0,120}clearTimeout\(installedCliRetryTimer\);[\s\S]{0,120}installedCliRetryTimer = null;[\s\S]{0,180}const revision = \+\+installedCliProbeRevision;/,
  );
});

test('对话删除复用双模式共用的应用内确认，不依赖 WKWebView 原生 confirm', async () => {
  const [html, conversation, main] = await Promise.all([
    read('src/index.html'),
    read('src/conversation-mode.js'),
    read('src/main.js'),
  ]);
  const developmentOverlaysAt = html.indexOf('<div id="development-overlays">');
  const globalConfirmAt = html.indexOf('<!-- 全局确认');
  assert.ok(developmentOverlaysAt >= 0 && globalConfirmAt > developmentOverlaysAt);
  assert.doesNotMatch(html.slice(developmentOverlaysAt, globalConfirmAt), /id="confirm-overlay"/);
  assert.match(html.slice(globalConfirmAt), /id="confirm-overlay" data-app-global-overlay/);
  assert.doesNotMatch(conversation, /defaultView\?\.confirm|window\.confirm/);
  assert.match(conversation, /confirm,\n\}\) \{/);
  assert.match(conversation, /confirmConversationDeletion\(/);
  assert.match(conversation, /确认功能不可用，未删除想法/);
  assert.match(conversation, /确认功能不可用，未删除历史对话/);
  assert.match(main, /confirm: requestConfirm/);
  assert.match(main, /function requestConfirm\(options\)/);
  assert.match(main, /const supersededCancel = pendingConfirmCancel/);
  assert.match(main, /supersededCancel\?\.\(\)/);
  assert.match(main, /onCancel: \(\) => resolve\(false\)/);
});

test('删除确认的取消和不可用路径都不会获准删除', async () => {
  const prompts = [];
  const notices = [];
  assert.equal(await confirmConversationDeletion(options => {
    prompts.push(options);
    return false;
  }, () => {}, '确定删除测试吗？', '确认不可用'), false);
  assert.deepEqual(prompts[0], {
    title: '确认删除', message: '确定删除测试吗？', confirmText: '删除', danger: true,
  });
  assert.equal(await confirmConversationDeletion(null, (...args) => notices.push(args), 'ignored', '确认不可用'), false);
  assert.deepEqual(notices, [['确认不可用', 'error']]);
});

test('高频对话元数据合并渲染，错误和完成事件立即渲染', () => {
  const state = { status: 'running' };
  const changed = { status: 'running', threadId: 'thread-1' };
  assert.equal(conversationEventRenderMode(state, changed, { kind: 'thread' }), 'deferred');
  assert.equal(conversationEventRenderMode(state, changed, { kind: 'notice' }), 'deferred');
  assert.equal(conversationEventRenderMode(state, changed, { kind: 'completed' }), 'immediate');
  assert.equal(conversationEventRenderMode(state, changed, { kind: 'error' }), 'immediate');
  assert.equal(conversationEventRenderMode(state, state, { kind: 'notice' }), 'none');
});

test('对话输入按 UTF-8 字节执行与后端一致的 64 KiB 边界', async () => {
  const rust = await read('src-tauri/src/codex_chat.rs');
  assert.equal(CONVERSATION_PROMPT_MAX_BYTES, 65_536);
  assert.match(rust, /const MAX_PROMPT_BYTES: usize = 64 \* 1024;/);
  assert.equal(utf8ByteLength('a你🙂'), 8);

  const asciiBoundary = inspectConversationPrompt(`  ${'a'.repeat(65_536)}  `);
  assert.equal(asciiBoundary.byteLength, 65_536);
  assert.equal(asciiBoundary.tooLong, false);

  const chineseBoundary = inspectConversationPrompt('你'.repeat(21_845));
  assert.equal(chineseBoundary.byteLength, 65_535);
  assert.equal(chineseBoundary.tooLong, false);

  const oversizedChinese = inspectConversationPrompt('你'.repeat(21_846));
  assert.equal(oversizedChinese.byteLength, 65_538);
  assert.equal(oversizedChinese.tooLong, true);
});

test('超限消息在发送前禁用并保留输入内容', async () => {
  const [html, conversation] = await Promise.all([
    read('src/index.html'),
    read('src/conversation-mode.js'),
  ]);
  assert.match(html, /id="conversation-composer"[^>]*data-max-utf8-bytes="65536"/);
  assert.match(conversation, /dom\.send\.disabled = unavailable \|\| deleting \|\| !hasPrompt \|\| promptState\.tooLong/);

  const sendStart = conversation.indexOf('async function send()');
  const validation = conversation.indexOf('if (promptState.tooLong)', sendStart);
  const clear = conversation.indexOf("dom.composer.value = '';", sendStart);
  assert.ok(validation > sendStart && clear > validation, '必须在清空输入框前拦截超限消息');
  assert.match(conversation.slice(validation, clear), /notify\?\.\(promptTooLongMessage\(promptState\.byteLength\), 'error'\)[\s\S]*return/);
});

test('开发终端交互入口都受应用视图门禁保护', async () => {
  const main = await read('src/main.js');
  assert.match(main, /function developerTerminalVisible\(\)/);
  assert.match(main, /native-esc[\s\S]*if \(!developerTerminalVisible\(\)\) return/);
  assert.match(main, /function shouldNotify[\s\S]*developerTerminalVisible\(\)/);
  assert.match(main, /targetAtNativePosition[\s\S]*developerTerminalVisible\(\)/);
  assert.match(main, /function terminalSessionAtViewportPoint[\s\S]*developerTerminalVisible\(\)/);
});
