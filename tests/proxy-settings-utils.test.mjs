import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_NO_PROXY,
  isValidProxyUrl,
  normalizeProxySettings,
  normalizeProxyUrl,
  proxyEnvAssignments,
  redactProxyUrl,
} from '../src/proxy-settings-utils.js';

test('代理地址补全 http，并拒绝危险协议', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:7891'), 'socks5://127.0.0.1:7891');
  assert.equal(isValidProxyUrl('http://127.0.0.1:7890'), true);
  assert.equal(isValidProxyUrl('javascript:alert(1)'), false);
  assert.equal(isValidProxyUrl('file:///tmp'), false);
  assert.equal(isValidProxyUrl(''), false);
});

test('开关关闭时不生成环境变量，打开时写入大小写两套 PROXY', () => {
  assert.deepEqual(proxyEnvAssignments({ enabled: false, url: '127.0.0.1:7890' }), {});
  assert.deepEqual(proxyEnvAssignments({ enabled: true, url: '' }), {});
  const env = proxyEnvAssignments({ enabled: true, url: '127.0.0.1:7890' });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:7890');
  assert.equal(env.http_proxy, 'http://127.0.0.1:7890');
  assert.equal(env.NO_PROXY, DEFAULT_NO_PROXY);
  const socks = proxyEnvAssignments({ enabled: true, url: 'socks5://127.0.0.1:7891' });
  assert.equal(socks.ALL_PROXY, 'socks5://127.0.0.1:7891');
  assert.equal(socks.HTTP_PROXY, undefined);
  assert.equal(redactProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://***@127.0.0.1:7890');
  assert.equal(normalizeProxySettings({ enabled: true, url: 'not a url' }).enabled, false);
  assert.equal(normalizeProxySettings({ enabled: false, url: 'not a url' }).enabled, false);
});
