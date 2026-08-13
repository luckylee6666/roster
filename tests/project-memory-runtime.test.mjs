import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const memoryRs = readFileSync(new URL('../src-tauri/src/project_memory.rs', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const native = readFileSync(new URL('../src/native-esc-utils.js', import.meta.url), 'utf8');

test('终端工具栏提供项目记忆面板', () => {
  assert.match(html, /id="terminal-memory-btn"/);
  assert.match(html, /id="terminal-memory-menu"/);
  assert.match(styles, /\.memory-menu\.active\s*\{\s*display:\s*block/);
  assert.match(native, /#terminal-memory-menu\.active/);
});

test('只有开启统一记忆的项目才会在创建终端时挂载 .memory', () => {
  assert.match(main, /统一记忆到 Claude/);
  assert.match(main, /shouldAutoMountProjectMemory\(cwd, '', readMemoryUnifyPaths\(\)\)/);
  assert.match(main, /ensure_project_memory/);
  assert.match(main, /detach_project_memory/);
  assert.match(main, /writeMemoryBanner\(term, memory\)/);
  assert.match(main, /function collapseDock\(\)[\s\S]*?closeMemoryMenu\(\)/);
  assert.match(main, /if \(e\.key !== 'Escape'\) return;[\s\S]*?closeMemoryMenu\(\)/);
  assert.match(main, /memoryUnifyOp/);
  assert.match(rust, /ensure_project_memory/);
  assert.match(rust, /detach_project_memory/);
  assert.match(memoryRs, /WORKSPACE_MEMORY_LINK: &str = "\.memory"/);
  assert.match(memoryRs, /create_dir_symlink/);
});
