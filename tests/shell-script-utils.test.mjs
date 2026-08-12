import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createShellScriptCommand,
  isShellScriptEntry,
  shellQuotePath,
  shouldCloseShellScriptPreview,
} from '../src/shell-script-utils.js';

test('运行命令入口仅接受普通 sh 文件', () => {
  assert.equal(isShellScriptEntry({ name: 'deploy.sh', isDir: false }), true);
  assert.equal(isShellScriptEntry({ name: 'BUILD.SH', isDir: false }), true);
  assert.equal(isShellScriptEntry({ name: 'deploy.sh.txt', isDir: false }), false);
  assert.equal(isShellScriptEntry({ name: 'deploy.sh', isDir: true }), false);
});

test('运行命令安全转义路径且不自动附加回车', () => {
  assert.equal(shellQuotePath('/tmp/a b/run.sh'), "'/tmp/a b/run.sh'");
  assert.equal(shellQuotePath("/tmp/a'b/run.sh"), "'/tmp/a'\\''b/run.sh'");
  assert.equal(createShellScriptCommand('/tmp/a b/run.sh'), "bash -- '/tmp/a b/run.sh' ");
  assert.equal(createShellScriptCommand('-x.sh'), 'bash -- -x.sh ');
  assert.equal(createShellScriptCommand('C:\\My App\\run.sh', true), "bash -- 'C:\\My App\\run.sh' ");
  assert.equal(
    createShellScriptCommand("C:\\$(calc)\\it's`here.sh", true),
    "bash -- 'C:\\$(calc)\\it''s`here.sh' ",
  );
  assert.doesNotMatch(createShellScriptCommand('/tmp/run.sh'), /[\r\n]/);
});

test('文件树菜单仅为 sh 文件显示填入命令动作并先确认 Bash 可用', async () => {
  const [html, main, rust] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="ctx-run-script"[^>]*data-action="run-script"[^>]*style="display:none;"/);
  assert.match(main, /ctx-run-script'\)\.style\.display\s*=\s*isShellScriptEntry\(entry\)/);
  assert.match(main, /data:\s*createShellScriptCommand\(entry\.path, IS_WINDOWS\)/);
  assert.match(main, /invoke\('has_bash'\)/);
  assert.match(rust, /async fn has_bash\(\) -> bool/);
  assert.match(rust, /generate_handler!\[[\s\S]*?has_bash,/);
  assert.match(main, /运行命令已填入，请检查并按回车执行/);
});

test('异步填入命令只关闭发起操作时的同一个文件预览', () => {
  const original = {
    sessionId: 'a',
    activeSessionId: 'a',
    previewSeqAtStart: 7,
    currentPreviewSeq: 7,
    previewOpen: true,
    hasUnsavedChanges: false,
  };
  assert.equal(shouldCloseShellScriptPreview(original), true);
  assert.equal(shouldCloseShellScriptPreview({ ...original, activeSessionId: 'b' }), false);
  assert.equal(shouldCloseShellScriptPreview({ ...original, currentPreviewSeq: 8 }), false);
  assert.equal(shouldCloseShellScriptPreview({ ...original, hasUnsavedChanges: true }), false);
});
