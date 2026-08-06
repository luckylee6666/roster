import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('主窗口允许在放弃未保存修改后关闭窗口', async () => {
  const configUrl = new URL('../src-tauri/capabilities/default.json', import.meta.url);
  const capability = JSON.parse(await readFile(configUrl, 'utf8'));
  assert.ok(capability.permissions.includes('core:window:allow-close'));
  assert.equal(capability.permissions.includes('core:window:allow-destroy'), false);
});
