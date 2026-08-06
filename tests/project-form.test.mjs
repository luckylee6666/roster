import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeProjectMachine, projectMachineTag } from '../src/project-form-utils.js';

test('项目运行环境为可选项且空值不会显示未知标签', async () => {
  const [html, main] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  const select = html.match(/<select class="form-select" id="project-machine"[^>]*>/)?.[0] || '';
  const label = html.match(/<label class="form-label[^>]*>运行环境[^<]*/)?.[0] || '';

  assert.doesNotMatch(select, /\brequired\b/);
  assert.doesNotMatch(label, /\brequired\b/);
  assert.match(html, /<option value="">暂不设置<\/option>/);
  assert.match(main, /machineTagHtml\(p\.machine\)/);
  assert.match(main, /normalizeProjectMachine\(el\.machine\.value, el\.serverSelect\.value\)/);
});

test('运行环境空值可提交，离开服务器环境时会清空服务器关联', () => {
  assert.deepEqual(normalizeProjectMachine('', 'stale-server'), { machine: '', serverId: '' });
  assert.deepEqual(normalizeProjectMachine('local', 'stale-server'), { machine: 'local', serverId: '' });
  assert.deepEqual(normalizeProjectMachine('server', 'server-1'), { machine: 'server', serverId: 'server-1' });
  assert.deepEqual(normalizeProjectMachine('unknown', 'server-1'), { machine: '', serverId: '' });
});

test('未设置运行环境时不生成“未知”标签', () => {
  assert.equal(projectMachineTag(''), null);
  assert.equal(projectMachineTag('unknown'), null);
  assert.deepEqual(projectMachineTag('local'), { className: 'tag-local', label: '本地电脑' });
  assert.deepEqual(projectMachineTag('server'), { className: 'tag-ssh', label: '服务器' });
});
