import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

import {
  CHARACTER_PATCH_CANVAS_SIZE,
  CHARACTER_PATCHES,
} from '../src/terminal-theme-character-patch-metadata.js';

import {
  CHARACTER_FEATURES,
  CHARACTER_WORKING_QUIET_MS,
  calculateCoverLayout,
  characterStateDuration,
  featureStageEllipse,
  isCharacterInteractionZone,
  normalizeCharacterState,
  normalizeCharacterThemeId,
  normalizeStagePointer,
  shouldEnableCharacterTheme,
  terminalEventCharacterState,
} from '../src/terminal-theme-character-utils.js';

const MEBIBYTE = 1024 * 1024;

function pngInfo(image) {
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  return {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    bitDepth: image[24],
    colorType: image[25],
    interlace: image[28],
  };
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const distanceLeft = Math.abs(prediction - left);
  const distanceAbove = Math.abs(prediction - above);
  const distanceUpperLeft = Math.abs(prediction - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

function pngAlphaExtrema(image) {
  const info = pngInfo(image);
  assert.equal(info.bitDepth, 8, '贴片必须使用 8-bit 通道');
  assert.equal(info.colorType, 6, '贴片必须是带 Alpha 的 RGBA PNG');
  assert.equal(info.interlace, 0, '贴片必须使用可确定解码的非交错 PNG');

  const idat = [];
  for (let offset = 8; offset < image.length;) {
    const length = image.readUInt32BE(offset);
    const type = image.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') idat.push(image.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = 4;
  const stride = info.width * bytesPerPixel;
  assert.equal(inflated.length, (stride + 1) * info.height);
  let previous = Buffer.alloc(stride);
  let minimum = 255;
  let maximum = 0;
  let offset = 0;
  for (let y = 0; y < info.height; y += 1) {
    const filter = inflated[offset];
    offset += 1;
    const encoded = inflated.subarray(offset, offset + stride);
    offset += stride;
    const row = Buffer.allocUnsafe(stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
      const above = previous[index];
      const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      else assert.equal(filter, 0, `不支持的 PNG filter: ${filter}`);
      row[index] = (encoded[index] + predictor) & 0xff;
    }
    for (let index = 3; index < stride; index += bytesPerPixel) {
      minimum = Math.min(minimum, row[index]);
      maximum = Math.max(maximum, row[index]);
    }
    previous = row;
  }
  return { minimum, maximum };
}

test('分层人物只为黛月华裳启用，并在减少动态时保留静态原画', () => {
  assert.equal(normalizeCharacterThemeId('guofeng-beauty'), 'guofeng-beauty');
  assert.equal(normalizeCharacterThemeId('guofeng'), '');
  assert.equal(shouldEnableCharacterTheme({ themeId: 'guofeng-beauty', reducedMotion: false }), true);
  assert.equal(shouldEnableCharacterTheme({ themeId: 'guofeng-beauty', reducedMotion: true }), false);
});

test('终端事件映射为有界人物状态', () => {
  assert.equal(terminalEventCharacterState('output'), 'thinking');
  assert.equal(terminalEventCharacterState('attention'), 'success');
  assert.equal(terminalEventCharacterState('failure'), 'error');
  assert.equal(terminalEventCharacterState('exit'), 'rest');
  assert.equal(normalizeCharacterState('arbitrary'), 'idle');
  assert.equal(characterStateDuration('success'), 2200);
  assert.equal(characterStateDuration('thinking'), CHARACTER_WORKING_QUIET_MS);
  assert.equal(CHARACTER_WORKING_QUIET_MS, 4200);
  assert.equal(characterStateDuration('idle'), 0);
});

test('鼠标坐标被限制，人物互动只响应右侧区域且不移动原画', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 400 };
  assert.deepEqual(normalizeStagePointer(rect, 510, 220), { x: 0, y: 0, inside: true });
  assert.deepEqual(normalizeStagePointer(rect, -100, 1000), { x: -1, y: -1, inside: false });
  assert.equal(isCharacterInteractionZone(rect, 850, 200), true);
  assert.equal(isCharacterInteractionZone(rect, 500, 200), false);
});

test('表情与键盘敲击区域按背景 cover 几何保持像素对齐', () => {
  const exact = calculateCoverLayout({ containerWidth: 1586, containerHeight: 992 });
  assert.equal(exact.renderedWidth, 1586);
  assert.equal(exact.renderedHeight, 992);
  assert.equal(exact.offsetX, 0);
  assert.equal(exact.offsetY, 0);

  const wide = calculateCoverLayout({ containerWidth: 1600, containerHeight: 900 });
  assert.ok(wide.renderedWidth >= 1600);
  assert.ok(wide.renderedHeight >= 900);
  const leftEye = featureStageEllipse(CHARACTER_FEATURES.eyeLeft, wide);
  const rightEye = featureStageEllipse(CHARACTER_FEATURES.eyeRight, wide);
  const mouth = featureStageEllipse(CHARACTER_FEATURES.mouth, wide);
  const typingHands = featureStageEllipse(CHARACTER_FEATURES.typingHands, wide);
  assert.ok(leftEye.x < rightEye.x);
  assert.ok(mouth.y > leftEye.y);
  assert.ok(leftEye.radiusX > leftEye.radiusY);
  assert.ok(mouth.radiusX > mouth.radiusY);
  assert.ok(typingHands.y > mouth.y);
  assert.ok(typingHands.radiusX > leftEye.radiusX * 8);
});

test('分层人物位于终端内容后方，待机锁定 Retina 原画且执行时切换坐姿打字场景', async () => {
  const [
    html,
    css,
    main,
    controller,
    fixture,
    pkg,
    retinaBuilder,
    patchMetadataSource,
    idle,
    blink,
    smile,
    codingA,
    codingB,
  ] = await Promise.all([
    readFile(new URL('../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/terminal-theme-character.js', import.meta.url), 'utf8'),
    readFile(new URL('./terminal-theme-character-fixture.html', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../design/guofeng-3d/build_retina_assets.py', import.meta.url), 'utf8'),
    readFile(new URL('../src/terminal-theme-character-patch-metadata.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/assets/term-bg-guofeng-beauty-retina.png', import.meta.url)),
    readFile(new URL('../src/assets/term-character-guofeng-beauty-blink-patch-retina.png', import.meta.url)),
    readFile(new URL('../src/assets/term-character-guofeng-beauty-smile-patch-retina.png', import.meta.url)),
    readFile(new URL('../src/assets/term-bg-guofeng-beauty-coding-a-right-patch-retina.png', import.meta.url)),
    readFile(new URL('../src/assets/term-bg-guofeng-beauty-coding-b-hands-patch-retina.png', import.meta.url)),
  ]);
  assert.ok(html.indexOf('id="terminal-theme-backdrop"') < html.indexOf('id="terminal-character-stage"'));
  assert.ok(html.indexOf('id="terminal-character-stage"') < html.indexOf('id="terminal-bodies"'));
  assert.match(main, /backdrop:\s*\$\('terminal-theme-backdrop'\)/);
  assert.match(main, /backdrop\.style\.backgroundImage\s*=/);
  assert.match(
    css,
    /\.terminal-dock\.has-companion \.terminal-theme-backdrop,\s*\.terminal-dock\.has-companion \.terminal-character-stage\s*\{\s*right:\s*calc\(var\(--companion-panel-size\) \+ 6px\);/,
  );
  assert.match(css, /\.terminal-dock\.has-companion\s*\{\s*--companion-panel-size:/);
  assert.match(
    css,
    /\.terminal-dock\.has-companion\.has-character-theme \.terminal-theme-backdrop\s*\{\s*background-position:\s*right 14% !important;/,
  );
  assert.match(controller, /positionX:\s*dock\.classList\.contains\('has-companion'\) \? 1 : 0\.5/);
  assert.match(css, /\.terminal-character-stage\s*\{[\s\S]*?z-index:\s*0;[\s\S]*?pointer-events:\s*none;/);
  assert.match(css, /\.terminal-main\s*\{[\s\S]*?z-index:\s*1;/);
  assert.match(css, /\.terminal-character-layer\s*\{[\s\S]*?opacity:\s*0;/);
  assert.match(main, /characterScene:\s*\{\s*id:\s*'guofeng-beauty'/);
  assert.match(main, /installTerminalCharacterTheme/);
  assert.match(controller, /terminal-theme-character-patch-metadata\.js/);
  assert.match(controller, /CHARACTER_PATCHES/);
  assert.doesNotMatch(controller, /term-character-guofeng-beauty-(?:blink|smile)-retina\.png/);
  assert.doesNotMatch(controller, /term-bg-guofeng-beauty-coding-[ab]-retina\.png/);
  assert.doesNotMatch(controller, /\.mp4|createElement\(['"]video['"]\)|danceVideo|DANCE_STATES/);
  assert.doesNotMatch(controller, /term-bg-guofeng-beauty-retina\.png/);
  for (const asset of [
    'term-bg-guofeng-beauty-retina.png',
    'term-character-guofeng-beauty-blink-patch-retina.png',
    'term-character-guofeng-beauty-smile-patch-retina.png',
    'term-bg-guofeng-beauty-coding-a-right-patch-retina.png',
    'term-bg-guofeng-beauty-coding-b-hands-patch-retina.png',
  ]) {
    assert.ok(retinaBuilder.includes(asset), `Retina 构建脚本应生成 ${asset}`);
    if (asset.includes('patch')) {
      assert.ok(patchMetadataSource.includes(asset), `贴片元数据应导出 ${asset}`);
    }
  }
  assert.match(retinaBuilder, /SOURCE_DIR[\s\S]*?source-frames/);
  assert.match(retinaBuilder, /patch\.putalpha\(alpha\)/);
  assert.match(retinaBuilder, /alpha\.getextrema\(\) != \(0, 255\)/);
  assert.match(controller, /workingQuietTimer[\s\S]*?CHARACTER_WORKING_QUIET_MS/);
  assert.match(controller, /normalized !== 'thinking' && workingQuietTimer[\s\S]*?clearTimeout\(workingQuietTimer\)/);
  assert.match(controller, /dataset\.renderBackend\s*=\s*'layered-2d'/);
  assert.match(controller, /The portrait never moves/);
  assert.match(controller, /Promise\.all/);
  assert.match(controller, /RESTARTABLE_STATES\.has\(normalized\)/);
  assert.match(controller, /classList\.add\('is-state-restarting'\)[\s\S]*?offsetWidth[\s\S]*?classList\.remove\('is-state-restarting'\)/);
  assert.match(controller, /IMAGE_PRELOADS\.get\(url\)/);
  assert.match(controller, /function ensureCodingAssets\(\)[\s\S]*?preloadImage\(CODING_SCENE_URL[\s\S]*?preloadImage\(CODING_TYPING_URL/);
  assert.match(controller, /if \(isReady\(\)\) void ensureCodingAssets\(\)/);
  assert.match(controller, /requestAnimationFrame\(flushPointerMove\)/);
  assert.match(css, /\.is-animation-paused[\s\S]*?animation-play-state:\s*paused/);
  assert.doesNotMatch(css, /terminal-character-dance-video|terminal-character-idle-dance-(?:left|mid|right)/);
  assert.match(css, /\.terminal-character-silk-light[\s\S]*?terminal-character-silk-breathe/);
  assert.match(css, /\.terminal-character-glint[\s\S]*?terminal-character-glint/);
  assert.match(css, /\[data-character-state="thinking"\] \.terminal-character-coding-scene[\s\S]*?opacity:\s*1/);
  assert.match(css, /\[data-character-state="thinking"\] \.terminal-character-typing-hands-layer[\s\S]*?terminal-character-coding-typing/);
  assert.match(css, /\.is-animation-paused \.terminal-character-typing-hands-layer/);
  assert.doesNotMatch(css, /\.terminal-character-coding-scene\s*\{[^}]*mask-image/);
  assert.doesNotMatch(controller, /maskImage|webkitMaskImage|radial-gradient/);
  assert.doesNotMatch(css, /\[data-character-state="thinking"\] \.terminal-character-(?:stage|live2d)[^{]*\{[^}]*?(?:transform|animation)\s*:/);
  const flatRules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const rootSelector of ['.terminal-character-stage', '.terminal-character-live2d']) {
    const rootRules = flatRules.filter(([, selectors]) => selectors.split(',').some(selector => {
      const normalized = selector.trim();
      return normalized.startsWith(rootSelector)
        && !/[\s>+~]/.test(normalized.slice(rootSelector.length));
    }));
    assert.ok(rootRules.length > 0, `${rootSelector} 必须有独立样式规则`);
    for (const [, selectors, declarations] of rootRules) {
      assert.doesNotMatch(
        declarations,
        /(?:^|;)\s*(?:transform|animation|filter)\s*:/,
        `${selectors.trim()} 不得改变或重采样待机人物根层`,
      );
    }
  }
  assert.match(main, /s\.status !== 'exited'[\s\S]*?handleTerminalEvent\('output'\)/);
  assert.doesNotMatch(controller, /THREE|WebGL|depth|mouth-speaking|\.glb|https?:\/\//);
  assert.match(fixture, /terminal-theme-character\.js/);
  assert.match(fixture, /id="terminal-theme-backdrop"/);
  assert.match(fixture, /backdrop\.style\.backgroundImage/);
  assert.match(fixture, /data-fixture-action="blink"/);
  assert.match(fixture, /data-fixture-action="toggle"/);
  assert.match(fixture, /URLSearchParams\(location\.search\)\.has\('compact'\)/);
  assert.equal(JSON.parse(pkg).dependencies?.three, undefined);
  assert.match(fixture, /data-character-state="idle">待机原画</);
  assert.match(fixture, /data-character-state="thinking">Coding 中</);
  assert.match(fixture, /nextState === 'thinking'[\s\S]*?handleTerminalEvent\('output'\)/);
  assert.deepEqual(CHARACTER_PATCH_CANVAS_SIZE, { width: 3584, height: 2240 });
  const expectedPatches = {
    blink: { file: 'term-character-guofeng-beauty-blink-patch-retina.png', crop: { x: 2670, y: 536, width: 237, height: 46 }, image: blink },
    smile: { file: 'term-character-guofeng-beauty-smile-patch-retina.png', crop: { x: 2695, y: 696, width: 123, height: 37 }, image: smile },
    codingScene: { file: 'term-bg-guofeng-beauty-coding-a-right-patch-retina.png', crop: { x: 1361, y: 0, width: 2223, height: 2240 }, image: codingA },
    typingHands: { file: 'term-bg-guofeng-beauty-coding-b-hands-patch-retina.png', crop: { x: 1777, y: 1456, width: 1076, height: 538 }, image: codingB },
  };
  for (const [key, expected] of Object.entries(expectedPatches)) {
    assert.equal(CHARACTER_PATCHES[key].file, expected.file);
    assert.deepEqual(CHARACTER_PATCHES[key].crop, expected.crop);
    const info = pngInfo(expected.image);
    assert.equal(info.width, expected.crop.width);
    assert.equal(info.height, expected.crop.height);
    assert.deepEqual(pngAlphaExtrema(expected.image), { minimum: 0, maximum: 255 });
  }
  const idleInfo = pngInfo(idle);
  assert.deepEqual(
    { width: idleInfo.width, height: idleInfo.height },
    CHARACTER_PATCH_CANVAS_SIZE,
  );
  const patchImages = [blink, smile, codingA, codingB];
  const packedPatchBytes = patchImages.reduce((total, image) => total + image.length, 0);
  assert.ok(packedPatchBytes < 10 * MEBIBYTE, '四张运行时贴片压缩后应小于 10 MiB');
  const decodedBytes = idleInfo.width * idleInfo.height * 4
    + Object.values(expectedPatches).reduce(
      (total, { crop }) => total + crop.width * crop.height * 4,
      0,
    );
  const legacyDecodedBytes = 5 * 3584 * 2240 * 4;
  assert.ok(decodedBytes < 56 * MEBIBYTE, '待机底图与四张贴片解码后应小于 56 MiB');
  assert.ok(decodedBytes < legacyDecodedBytes * 0.4, '贴片方案应至少节省 60% 解码内存');
  let braceDepth = 0;
  for (const character of css) {
    if (character === '{') braceDepth += 1;
    if (character === '}') braceDepth -= 1;
    assert.ok(braceDepth >= 0, 'CSS 不应出现游离的右花括号');
  }
  assert.equal(braceDepth, 0, 'CSS 花括号必须成对闭合');
});
