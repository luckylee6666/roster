import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../src-tauri/mobile/${path}`, import.meta.url), 'utf8');

function functionSource(source, start, next) {
  const from = source.indexOf(start);
  const to = source.indexOf(next, from + start.length);
  assert.notEqual(from, -1, `缺少函数 ${start}`);
  assert.notEqual(to, -1, `缺少函数边界 ${next}`);
  return source.slice(from, to).trim();
}

test('手机对话从历史、实时事件和快照加载附件元数据并走受鉴权媒体端点', async () => {
  const main = await read('main.js');
  assert.match(main, /SAFE_IMAGE_MIME = new Set\(\['image\/png', 'image\/jpeg', 'image\/webp', 'image\/gif'\]\)/);
  assert.match(main, /SAFE_VIDEO_MIME = new Set\(\['video\/mp4', 'video\/webm'\]\)/);
  assert.match(main, /fetch\(`\/api\/chat\/media\?\$\{query\}`,[\s\S]*?cache: 'no-store'/);
  assert.match(main, /message\.attachments[\s\S]*?thread\.attachmentMetadata\.set/);
  assert.match(main, /frame\.kind === 'assistant_image'[\s\S]*?frame\.data\?\.attachment/);
  assert.match(main, /syncLiveRunAttachment\(run, frame\.providerId, frame\.data\?\.attachment\)/);
  assert.match(main, /function addSnapshotAttachments[\s\S]*?run\.attachments/);
  assert.match(main, /MAX_MEDIA_RESPONSE_BYTES = 16 \* 1024 \* 1024/);
  assert.match(main, /MAX_THREAD_MEDIA_COUNT = 16/);
  assert.match(main, /MAX_THREAD_MEDIA_BYTES = 32 \* 1024 \* 1024/);
  assert.match(main, /function createAttachmentElement[\s\S]*?mediaRequestQueue\.run\([\s\S]*?fetchMedia\(thread\.projectId, safe,/);
  assert.match(main, /thread\.mediaCache\.set\(safe\.id, load\)/);
  assert.match(main, /function addAttachmentRetry/);
  assert.match(main, /MEDIA_FETCH_CONCURRENCY = 2/);
  assert.match(main, /openImageViewer\(url, safe\.name\)/);
});

test('手机本地文件链接进入安全预览，外链只允许无凭据的 HTTP(S)', async () => {
  const main = await read('main.js');
  const html = await read('index.html');
  assert.match(main, /window\.DOMPurify\.sanitize/);
  assert.match(main, /ALLOWED_URI_REGEXP: MOBILE_MARKDOWN_URI_REGEXP/);
  assert.match(main, /new URL\(source, location\.href\)/);
  assert.match(main, /\['http:', 'https:'\]\.includes\(parsed\.protocol\) \|\| parsed\.username \|\| parsed\.password/);
  assert.match(main, /data\?\.kind === 'text' \|\| data\?\.kind === 'markdown'/);
  assert.match(main, /\/api\/chat\/file/);
  assert.match(main, /function handleLocalFileClick[\s\S]*?openFilePreview/);
  assert.match(main, /attachment\.kind === 'image' \? 'img' : 'video'/);
  assert.match(main, /media\.controls = true;[\s\S]*?media\.playsInline = true/);
  assert.doesNotMatch(main, /media\.autoplay\s*=\s*true/);
  assert.match(html, /id="filePreviewMask"[\s\S]*?id="filePreviewContent"/);
  assert.match(html, /id="imageViewerMask"[\s\S]*?id="imageViewerImage"/);
});

test('净化后缺失的 href 和片段锚点不会变成文件预览链接', async () => {
  const main = await read('main.js');
  const classifier = functionSource(main, 'function classifyMarkdownHref', 'function clearMediaUrls');
  const classify = new Function('location', `return (${classifier})`)({ href: 'http://roster.test/' });
  assert.deepEqual(classify(null), { kind: 'none' });
  assert.deepEqual(classify(''), { kind: 'none' });
  assert.deepEqual(classify('#section-2'), { kind: 'anchor', href: '#section-2' });
  assert.deepEqual(classify('javascript:alert(1)'), { kind: 'blocked' });
  assert.deepEqual(classify('file:///Users/me/private.txt'), { kind: 'local', source: 'file:///Users/me/private.txt' });
  assert.deepEqual(classify('C:\\Users\\me\\private.txt'), { kind: 'local', source: 'C:\\Users\\me\\private.txt' });
  assert.deepEqual(classify('https://user:secret@example.test/'), { kind: 'blocked' });
  assert.equal(classify('/project/readme.md').kind, 'local');
  assert.equal(classify('https://example.test/docs').kind, 'external');
  const uriLiteral = main.match(/^const MOBILE_MARKDOWN_URI_REGEXP = (\/.*\/i);$/m)?.[1];
  assert.ok(uriLiteral, 'DOMPurify allowlist is defined');
  const allowUri = new Function(`return ${uriLiteral}`)();
  assert.equal(allowUri.test('file:///Users/me/readme.md'), true);
  assert.equal(allowUri.test('C:\\Users\\me\\readme.md'), true);
  assert.equal(allowUri.test('javascript:alert(1)'), false);
  assert.match(main, /const decision = classifyMarkdownHref\(link\.getAttribute\('href'\)\)/);
  assert.match(main, /decision\.kind === 'none' \|\| decision\.kind === 'blocked'[\s\S]*?link\.removeAttribute\('href'\)/);
});

test('phone transcript 仅按共享状态相同的角色过滤，空文本图片消息保持附件索引', async () => {
  const main = await read('main.js');
  const validSource = functionSource(main, 'function validAttachment', 'async function fetchMedia');
  const textSource = functionSource(main, 'function transcriptText', 'function normalizePhoneTranscript');
  const normalizeSource = functionSource(main, 'function normalizePhoneTranscript', 'async function loadTranscript');
  const safeImages = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safeVideos = new Set(['video/mp4', 'video/webm']);
  const validate = new Function('SAFE_IMAGE_MIME', 'SAFE_VIDEO_MIME', `return (${validSource})`)(safeImages, safeVideos);
  const transcript = new Function(`return (${textSource})`)();
  const normalize = new Function('validAttachment', 'transcriptText', `return (${normalizeSource})`)(
    validate,
    transcript,
  );
  const result = normalize([
    { role: 'system', text: '忽略的系统项' },
    { role: 'user', text: '', attachments: [{ id: 'u1', kind: 'image', mimeType: 'image/png', name: '问图.png' }] },
    { role: 'assistant', text: '先回答' },
    { role: 'tool', text: '忽略的工具项', attachments: [{ id: 'bad', kind: 'image', mimeType: 'image/png' }] },
    { role: 'assistant', text: '', attachments: [{ id: 'a1', kind: 'image', mimeType: 'image/jpeg', name: '结果.jpg' }] },
  ]);
  assert.deepEqual(result.messages, [
    { role: 'user', text: '' },
    { role: 'assistant', text: '先回答' },
    { role: 'assistant', text: '' },
  ]);
  assert.deepEqual(result.attachments.map(items => items.map(item => item.id)), [['u1'], [], ['a1']]);
  assert.equal(result.messages.length, result.attachments.length, '媒体元数据与共享状态消息索引严格一致');
});

test('media request queue 最多并行两项并在开始前取消失效线程的排队任务', async () => {
  const main = await read('main.js');
  const source = functionSource(main, 'function createMediaRequestQueue', 'let pin =');
  const createQueue = new Function(`return (${source})`)();
  const queue = createQueue(2);
  let running = 0;
  let peak = 0;
  const finish = [];
  const task = () => new Promise(resolve => {
    running += 1;
    peak = Math.max(peak, running);
    finish.push(() => { running -= 1; resolve('done'); });
  });
  const first = queue.run(task);
  const second = queue.run(task);
  const third = queue.run(task);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(peak, 2);
  assert.equal(queue.activeCount(), 2);
  assert.equal(queue.pendingCount(), 1);
  finish[0]();
  await first;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(queue.activeCount(), 2, '首个释放后队列补入下一项');
  finish[1]();
  finish[2]();
  await Promise.all([second, third]);
  const staleQueue = createQueue(1);
  let staleStarted = false;
  await assert.rejects(staleQueue.run(() => { staleStarted = true; }, () => false), /已离开当前内容/);
  assert.equal(staleStarted, false);
});

test('后台实时图片同步进 live-run 快照，稍后打开会话仍可从快照渲染', async () => {
  const main = await read('main.js');
  const validSource = functionSource(main, 'function validAttachment', 'async function fetchMedia');
  const syncSource = functionSource(main, 'function syncLiveRunAttachment', 'function addSnapshotAttachments');
  const addThreadSource = functionSource(main, 'function addThreadAttachment', 'function syncLiveRunAttachment');
  const snapshotSource = functionSource(main, 'function addSnapshotAttachments', '/** 电脑端');
  const safeImages = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safeVideos = new Set(['video/mp4', 'video/webm']);
  const validate = new Function('SAFE_IMAGE_MIME', 'SAFE_VIDEO_MIME', `return (${validSource})`)(safeImages, safeVideos);
  const active = new Set(['starting', 'running', 'stopping']);
  const add = new Function('validAttachment', `return (${addThreadSource})`)(validate);
  const sync = new Function('validAttachment', 'ACTIVE', `return (${syncSource})`)(validate, active);
  const addSnapshot = new Function('addThreadAttachment', `return (${snapshotSource})`)(add);
  const run = { runId: 'r1', projectId: 'p1', providerId: 'codex', status: 'running', attachments: [] };
  const image = { id: 'img-1', kind: 'image', mimeType: 'image/png', name: 'live.png' };
  assert.equal(sync(run, 'claude', image), false, '错助手事件不得进入run快照');
  assert.equal(sync({ ...run, status: 'completed' }, 'codex', image), false, '终态运行不接迟到图片');
  assert.equal(sync(run, 'codex', image), true);
  assert.equal(sync(run, 'codex', image), false, '同一媒体ID去重');
  assert.deepEqual(run.attachments, [image]);

  const thread = {
    state: { messages: [{ id: 'r1-assistant', role: 'assistant' }] },
    attachmentMetadata: new Map(),
  };
  addSnapshot(thread, run);
  assert.deepEqual(thread.attachmentMetadata.get('r1-assistant'), [image]);
  run.attachments = Array.from({ length: 8 }, (_, index) => ({ ...image, id: `img-${index}` }));
  assert.equal(sync(run, 'codex', { ...image, id: 'img-extra' }), false, '单轮附件数保持上限');
});

test('实际 fetchMedia 路径验证响应大小、MIME 与线程竞态，释放 URL 可重复调用', async () => {
  const main = await read('main.js');
  const validSource = functionSource(main, 'function validAttachment', 'async function fetchMedia');
  const fetchSource = functionSource(main, 'async function fetchMedia', 'function addAttachmentRetry');
  const releaseSource = functionSource(main, 'function releaseMediaUrl', 'function classifyMarkdownHref');
  const safeImages = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  const safeVideos = new Set(['video/mp4', 'video/webm']);
  const validate = new Function('SAFE_IMAGE_MIME', 'SAFE_VIDEO_MIME', `return (${validSource})`)(safeImages, safeVideos);
  const mediaUrls = new Map();
  const revoked = [];
  const urlApi = { createObjectURL: () => 'blob:preview-1', revokeObjectURL: url => revoked.push(url) };
  const mkFetcher = (response, isCurrent = () => true) => new Function(
    'validAttachment', 'pin', 'fetch', 'URL', 'mediaObjectUrls',
    'MAX_MEDIA_RESPONSE_BYTES', 'MAX_MEDIA_URL_COUNT', 'MAX_MEDIA_URL_BYTES', 'SAFE_IMAGE_MIME', 'SAFE_VIDEO_MIME',
    `return (${fetchSource})`,
  )(
    validate,
    '123456',
    async () => response,
    urlApi,
    mediaUrls,
    16 * 1024 * 1024,
    24,
    64 * 1024 * 1024,
    safeImages,
    safeVideos,
  );
  const response = (blob, contentLength = String(blob.size), status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => name === 'content-length' ? contentLength : blob.type },
    blob: async () => blob,
  });
  const image = { id: 'a1', kind: 'image', mimeType: 'image/png', name: '生成.png' };

  const makeUrl = mkFetcher(response({ type: 'image/png', size: 1024 }));
  assert.equal(await makeUrl('p1', image), 'blob:preview-1');
  assert.deepEqual([...mediaUrls], [['blob:preview-1', 1024]]);

  const tooLarge = mkFetcher(response({ type: 'image/png', size: 17 * 1024 * 1024 }));
  await assert.rejects(tooLarge('p1', image), /超过手机预览上限/);
  assert.equal(mediaUrls.size, 1, '超限响应不能生成 object URL');

  const badMime = mkFetcher(response({ type: 'image/svg+xml', size: 10 }));
  await assert.rejects(badMime('p1', image), /媒体类型与附件信息不符/);
  assert.equal(mediaUrls.size, 1, '不安全 MIME 不生成 object URL');

  const stale = mkFetcher(response({ type: 'image/png', size: 10 }));
  const staleFetch = new Function(
    'validAttachment', 'pin', 'fetch', 'URL', 'mediaObjectUrls',
    'MAX_MEDIA_RESPONSE_BYTES', 'MAX_MEDIA_URL_COUNT', 'MAX_MEDIA_URL_BYTES', 'SAFE_IMAGE_MIME', 'SAFE_VIDEO_MIME',
    `return (${fetchSource})`,
  )(validate, '123456', async () => response({ type: 'image/png', size: 10 }), urlApi, mediaUrls,
    16 * 1024 * 1024, 24, 64 * 1024 * 1024, safeImages, safeVideos);
  await assert.rejects(staleFetch('p1', image, () => false), /已离开当前内容/);
  assert.equal(mediaUrls.size, 1, '线程切换后的迟到响应不能生成 object URL');

  const release = new Function('mediaObjectUrls', 'URL', `return (${releaseSource})`)(mediaUrls, urlApi);
  release('blob:preview-1');
  release('blob:preview-1');
  assert.deepEqual(revoked, ['blob:preview-1'], '同一个 URL 只释放一次');
  assert.equal(mediaUrls.size, 0);
});

test('重试解码失败的图片会释放缓存 URL 并扣回线程字节预算', async () => {
  const main = await read('main.js');
  const source = functionSource(main, 'function invalidateThreadAttachment', 'function setMediaDecodeFallback');
  const objectUrls = new Map([['blob:bad-image', 4096], ['blob:other-image', 1024]]);
  const revoked = [];
  const release = url => {
    if (!objectUrls.has(url)) return;
    objectUrls.delete(url);
    revoked.push(url);
  };
  const invalidate = new Function('mediaObjectUrls', 'releaseMediaUrl', `return (${source})`)(objectUrls, release);
  const thread = {
    mediaCache: new Map([['broken', 'blob:bad-image'], ['pending', Promise.reject(new Error('404'))]]),
    mediaByteCount: 4096,
  };
  // Keep the rejected cached promise handled, as the UI attaches its own catch handler.
  thread.mediaCache.get('pending').catch(() => {});
  invalidate(thread, 'broken');
  assert.equal(thread.mediaCache.has('broken'), false);
  assert.equal(thread.mediaByteCount, 0);
  assert.deepEqual(revoked, ['blob:bad-image']);
  assert.deepEqual([...objectUrls], [['blob:other-image', 1024]]);

  thread.mediaByteCount = 1024;
  invalidate(thread, 'pending');
  assert.equal(thread.mediaCache.has('pending'), false, '失败Promise也应允许显式重试');
  assert.equal(thread.mediaByteCount, 1024, '没有object URL时不扣其它媒体预算');
  assert.deepEqual(revoked, ['blob:bad-image']);
});

test('离开线程、注销和页面隐藏时回收手机媒体 object URL', async () => {
  const main = await read('main.js');
  assert.match(main, /function releaseThreadMedia\(thread, \{ detachMessages = false \} = \{\}\)[\s\S]*?releaseMediaUrl/);
  assert.match(main, /function leaveThread\(\)[\s\S]*?releaseThreadMedia\(thread, \{ detachMessages: true \}\)/);
  assert.match(main, /function logout\([\s\S]*?clearMediaUrls\(\)/);
  assert.match(main, /window\.addEventListener\('pagehide', \(\) => \{[\s\S]*?clearMediaUrls\(\)/);
  assert.match(main, /URL\.revokeObjectURL\(url\)/);
  assert.match(main, /revision !== previewRevision \|\| app\.thread !== thread/);
  assert.match(main, /thread\.mediaGeneration \+= 1/);
  assert.match(main, /thread\.mediaGeneration === generation/);
  assert.match(main, /entry\.attachments = null/);

  const stopSource = functionSource(main, 'function stopMediaSources', 'function releaseThreadMedia');
  const releaseSource = functionSource(main, 'function releaseThreadMedia', '// ----- 渲染 -----');
  const operations = [];
  const video = {
    pause() { operations.push('pause'); },
    querySelectorAll() { return [{ removeAttribute(name) { operations.push(`source-${name}`); } }]; },
    removeAttribute(name) { operations.push(`video-${name}`); },
    load() { operations.push('load'); },
  };
  const node = {
    querySelectorAll(selector) { return selector === 'video' ? [video] : selector === 'img, video' ? [{ remove() { operations.push('remove-media'); } }] : []; },
    remove() { operations.push('remove-node'); },
  };
  const thread = {
    mediaGeneration: 4,
    mediaByteCount: 4096,
    mediaCache: new Map([['a1', 'blob:one']]),
    nodes: new Map([['msg', { node, attachments: 'stale-key' }]]),
  };
  const app = { thread };
  const body = { replaceChildren() { operations.push('clear-body'); } };
  const releaseThread = new Function('releaseMediaUrl', 'stopMediaSources', 'app', '$', `return (${releaseSource})`)(
    url => operations.push(`revoke-${url}`),
    new Function(`return (${stopSource})`)(),
    app,
    () => body,
  );
  releaseThread(thread, { detachMessages: true });
  assert.deepEqual(operations, [
    'pause', 'source-src', 'video-src', 'load', 'remove-media', 'remove-node', 'clear-body', 'revoke-blob:one',
  ], '视频先暂停、移除 source 并 load，再移除消息节点和释放 URL');
  assert.equal(thread.mediaGeneration, 5);
  assert.equal(thread.mediaByteCount, 0);
  assert.equal(thread.nodes.size, 0);

  const closeSource = functionSource(main, 'function closeFilePreview', 'async function openFilePreview');
  const previewOps = [];
  const previewVideo = {
    pause() { previewOps.push('pause'); },
    querySelectorAll() { return []; },
    removeAttribute(name) { previewOps.push(`remove-${name}`); },
    load() { previewOps.push('load'); },
  };
  const content = {
    querySelectorAll(selector) { return selector === 'video' ? [previewVideo] : []; },
    replaceChildren() { previewOps.push('remove-preview-node'); },
  };
  const elements = {
    filePreviewMask: { set hidden(_) {} },
    filePreviewTitle: { set textContent(_) {} },
    filePreviewContent: content,
  };
  new Function('$', 'stopMediaSources', 'releaseMediaUrl', 'previewUrl', 'previewRevision', `return (${closeSource})`)(
    id => elements[id],
    new Function(`return (${stopSource})`)(),
    url => previewOps.push(`revoke-${url}`),
    'blob:file-preview',
    0,
  )();
  assert.deepEqual(previewOps, ['pause', 'remove-src', 'load', 'remove-preview-node', 'revoke-blob:file-preview']);
});
