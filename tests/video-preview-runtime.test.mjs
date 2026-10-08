import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createProjectVideoPreview,
  VIDEO_PREVIEW_ERROR_MESSAGE,
} from '../src/video-preview.js';

function mockVideo(state = { current: null }) {
  const listeners = new Map();
  const video = {
    src: '',
    paused: true,
    pauseCount: 0,
    loadCount: 0,
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    pause() { this.pauseCount++; this.paused = true; },
    load() { this.loadCount++; },
    cloneNode() { return mockVideo(state); },
    replaceWith(next) { state.current = next; },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatchError() { listeners.get('error')?.(); },
  };
  state.current ||= video;
  return video;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('打开项目视频使用路径 IPC 和后端 URL，不自动播放；暂停与关闭会释放资源', async () => {
  const state = { current: null };
  const video = mockVideo(state);
  const calls = [];
  const player = createProjectVideoPreview({
    video,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'open_project_video') {
        return { token: 'tok-1', url: 'http://127.0.0.1:4321/tok-1', mimeType: 'video/mp4', size: 20 };
      }
    },
  });

  assert.equal(await player.open('project-1', '/project/clip.mp4'), true);
  assert.deepEqual(calls[0], {
    command: 'open_project_video',
    args: { projectId: 'project-1', path: '/project/clip.mp4' },
  });
  assert.equal(state.current.src, 'http://127.0.0.1:4321/tok-1');
  assert.equal(state.current.pauseCount, 0); // 没有调用 play()

  player.pause();
  assert.equal(state.current.pauseCount, 1);
  player.close();
  await Promise.resolve();
  assert.equal(state.current.src, '');
  assert.deepEqual(calls.at(-1), { command: 'close_project_video', args: { token: 'tok-1' } });
});

test('关闭或切文件后到达的异步 token 会立即释放且不覆盖新媒体', async () => {
  const state = { current: null };
  const video = mockVideo(state);
  const oldOpen = deferred();
  const calls = [];
  const player = createProjectVideoPreview({
    video,
    invoke: (command, args) => {
      calls.push({ command, args });
      if (command === 'open_project_video' && args.path.endsWith('late.mp4')) return oldOpen.promise;
      if (command === 'open_project_video') {
        return Promise.resolve({ token: 'new-token', url: 'http://127.0.0.1/new-token', mimeType: 'video/webm' });
      }
      return Promise.resolve();
    },
  });

  const late = player.open('p', '/p/late.mp4');
  const current = player.open('p', '/p/current.webm');
  assert.equal(await current, true);
  oldOpen.resolve({ token: 'late-token', url: 'http://127.0.0.1/late-token', mimeType: 'video/mp4' });
  assert.equal(await late, false);
  await Promise.resolve();
  assert.equal(state.current.src, 'http://127.0.0.1/new-token');
  assert.ok(calls.some(call => call.command === 'close_project_video' && call.args.token === 'late-token'));

  const delayed = deferred();
  const closedState = { current: null };
  const player2 = createProjectVideoPreview({
    video: mockVideo(closedState),
    invoke: command => command === 'open_project_video' ? delayed.promise : Promise.resolve(),
  });
  const pending = player2.open('p', '/p/close-race.mov');
  player2.close();
  delayed.resolve({ token: 'closed-token', url: 'http://127.0.0.1/closed-token' });
  assert.equal(await pending, false);
  assert.equal(closedState.current.src, '');
});

test('旧视频节点的迟到 error 不污染新来源；当前节点解码错误释放 token', async () => {
  const state = { current: null };
  const messages = [];
  const calls = [];
  const player = createProjectVideoPreview({
    video: mockVideo(state),
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'open_project_video') {
        const token = args.path.endsWith('a.mp4') ? 'token-a' : 'token-b';
        return { token, url: `http://127.0.0.1/${token}`, mimeType: 'video/mp4' };
      }
    },
    onError: message => messages.push(message),
  });

  await player.open('p', '/p/a.mp4');
  const oldVideo = state.current;
  await player.open('p', '/p/b.mp4');
  const currentVideo = state.current;
  assert.notEqual(currentVideo, oldVideo);
  oldVideo.dispatchError();
  assert.deepEqual(messages, []);
  assert.equal(currentVideo.src, 'http://127.0.0.1/token-b');

  currentVideo.dispatchError();
  await Promise.resolve();
  assert.deepEqual(messages, [VIDEO_PREVIEW_ERROR_MESSAGE]);
  assert.equal(currentVideo.src, '');
  assert.ok(calls.some(call => call.command === 'close_project_video' && call.args.token === 'token-b'));
});

test('缺项目和媒体解码错误给出可操作的 MP4 编码提示', async () => {
  const errors = [];
  const player = createProjectVideoPreview({ video: mockVideo(), invoke: async () => ({}), onError: text => errors.push(text) });
  assert.equal(await player.open('', '/unknown/video.mp4'), false);
  assert.match(errors[0], /没有关联的本地项目/);
  assert.equal(VIDEO_PREVIEW_ERROR_MESSAGE, '视频无法播放或编码不受支持。请尝试 MP4（H.264/AAC）格式。');
});

test('DOM 初始化或设置来源抛错时也释放已取得的 token', async () => {
  for (const failurePoint of ['cloneNode', 'replaceVideo', 'src']) {
    const closedTokens = [];
    const errors = [];
    const clone = {
      pause() {},
      removeAttribute() {},
      load() {},
      addEventListener() {},
      removeEventListener() {},
    };
    Object.defineProperty(clone, 'src', {
      set() { if (failurePoint === 'src') throw new Error('src failed'); },
    });
    const initialVideo = {
      pause() {},
      removeAttribute() {},
      load() {},
      cloneNode() {
        if (failurePoint === 'cloneNode') throw new Error('clone failed');
        return clone;
      },
    };
    const player = createProjectVideoPreview({
      video: initialVideo,
      replaceVideo: () => {
        if (failurePoint === 'replaceVideo') throw new Error('replace failed');
      },
      invoke: async (command, args) => {
        if (command === 'open_project_video') return { token: `token-${failurePoint}`, url: 'http://127.0.0.1/video' };
        if (command === 'close_project_video') closedTokens.push(args.token);
      },
      onError: message => errors.push(message),
    });

    assert.equal(await player.open('p', '/p/video.mp4'), false, failurePoint);
    await Promise.resolve();
    assert.deepEqual(closedTokens, [`token-${failurePoint}`], failurePoint);
    assert.match(errors[0], /MP4（H\.264\/AAC）/);
    const detail = { cloneNode: 'clone', replaceVideo: 'replace', src: 'src' }[failurePoint];
    assert.match(errors[0], new RegExp(`${detail} failed`));
  }
});

test('文件预览接入指定格式、原生 controls 和各隐藏生命周期暂停点', async () => {
  const [html, main] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /<video id="file-preview-video" controls playsinline preload="metadata"/);
  assert.match(main, /mp4\|m4v\|mov\|webm\|ogv/);
  assert.match(main, /findProjectByCwd\(cwd\)/);
  assert.match(main, /function closePreview\(force = false\)[\s\S]*?if \(!force && isFileEditorDirty\(\)\)/);
  assert.match(main, /function collapseDock\(\)[\s\S]*?projectVideoPreview\.pause\(\)/);
  assert.match(main, /if \(document\.hidden\)[\s\S]*?projectVideoPreview\?\.pause\(\)/);
  assert.match(main, /onViewChange: view => \{[\s\S]*?projectVideoPreview\.pause\(\)/);
});
