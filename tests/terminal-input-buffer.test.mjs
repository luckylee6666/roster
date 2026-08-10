import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalInputBuffer } from '../src/terminal-input-buffer.js';

test('PTY 就绪前的输入会在启动命令后按顺序发送', async () => {
  const sent = [];
  const buffer = createTerminalInputBuffer({
    send: async data => sent.push(data),
  });
  buffer.write('first');
  buffer.write(' second');
  await buffer.markReady('codex\r');
  buffer.write(' third');
  await buffer.markReady();
  assert.deepEqual(sent, ['codex\r', 'first second', ' third']);
});

test('PTY 创建失败会丢弃缓存且不再发送', async () => {
  const sent = [];
  const buffer = createTerminalInputBuffer({ send: async data => sent.push(data) });
  buffer.write('queued');
  buffer.markFailed();
  await buffer.markReady();
  buffer.write('late');
  assert.deepEqual(sent, []);
});

test('启动阶段缓存有上限并只报告一次溢出', async () => {
  const sent = [];
  let overflows = 0;
  const buffer = createTerminalInputBuffer({
    send: async data => sent.push(data),
    maxBufferedLength: 5,
    onOverflow: () => { overflows += 1; },
  });
  buffer.write('1234');
  buffer.write('567');
  buffer.write('89');
  await buffer.markReady();
  assert.deepEqual(sent, ['12345']);
  assert.equal(overflows, 1);
});
