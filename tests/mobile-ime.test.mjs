import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('手机外接键盘发送快捷键忽略IME确认，普通回车保持换行', () => {
  const source = readFileSync(new URL('../src-tauri/mobile/main.js', import.meta.url), 'utf8');
  const start = source.indexOf("$('composer').addEventListener('keydown'");
  const end = source.indexOf("$('sendBtn').addEventListener", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let sent = 0;
  const composer = { addEventListener(type, callback) { assert.equal(type, 'keydown'); handler = callback; } };
  new Function('$', 'submit', source.slice(start, end))(
    id => { assert.equal(id, 'composer'); return composer; },
    () => { sent += 1; },
  );
  for (const modifiers of [
    {}, { shiftKey: true },
    { ctrlKey: true, isComposing: true, keyCode: 13 },
    { ctrlKey: true, isComposing: false, keyCode: 229 },
    { metaKey: true, isComposing: false, keyCode: 229 },
  ]) {
    handler({ key: 'Enter', ...modifiers, preventDefault() { assert.fail('选字或普通换行不能被发送快捷键截获'); } });
  }
  assert.equal(sent, 0);
  let prevented = 0;
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    handler({ key: 'Enter', keyCode: 13, isComposing: false, ...modifiers, preventDefault() { prevented += 1; } });
  }
  assert.equal(sent, 2);
  assert.equal(prevented, 2);
});
