import {
  CHARACTER_WORKING_QUIET_MS,
  calculateCoverLayout,
  characterStateDuration,
  isCharacterInteractionZone,
  normalizeCharacterState,
  normalizeCharacterThemeId,
  normalizeStagePointer,
  shouldEnableCharacterTheme,
  terminalEventCharacterState,
} from './terminal-theme-character-utils.js';
import {
  CHARACTER_PATCH_CANVAS_SIZE,
  CHARACTER_PATCHES,
} from './terminal-theme-character-patch-metadata.js';

const BLINK_URL = CHARACTER_PATCHES.blink.url;
const SMILE_URL = CHARACTER_PATCHES.smile.url;
const CODING_SCENE_URL = CHARACTER_PATCHES.codingScene.url;
const CODING_TYPING_URL = CHARACTER_PATCHES.typingHands.url;
const FEATURE_PATCHES = Object.freeze({
  blink: CHARACTER_PATCHES.blink,
  mouth: CHARACTER_PATCHES.smile,
  typingHands: CHARACTER_PATCHES.typingHands,
});
const SCENE_PATCHES = Object.freeze({ coding: CHARACTER_PATCHES.codingScene });
const BACKGROUND_POSITION_Y = 0.14;
const BLINK_DELAYS = Object.freeze([4200, 5100, 3700, 5600]);
const IMAGE_PRELOADS = new Map();
const RESTARTABLE_STATES = new Set(['greeting', 'success']);

function preloadImage(url, label) {
  const cached = IMAGE_PRELOADS.get(url);
  if (cached) return cached;
  const pending = new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(url);
    image.onerror = () => reject(new Error(`${label}加载失败`));
    image.src = url;
  });
  IMAGE_PRELOADS.set(url, pending);
  pending.catch(() => IMAGE_PRELOADS.delete(url));
  return pending;
}

function createFeatureLayer(className, imageUrl, featureName) {
  const layer = document.createElement('div');
  layer.className = `terminal-character-layer terminal-character-patch ${className}`;
  layer.dataset.feature = featureName;
  if (imageUrl) layer.style.backgroundImage = `url("${imageUrl}")`;
  return layer;
}

function createSceneLayer(className, imageUrl, sceneName) {
  const layer = document.createElement('div');
  layer.className = `terminal-character-layer terminal-character-patch ${className}`;
  layer.dataset.scene = sceneName;
  if (imageUrl) layer.style.backgroundImage = `url("${imageUrl}")`;
  return layer;
}

function createDecorations() {
  const decor = document.createElement('div');
  decor.className = 'terminal-character-decor';

  const silkLight = document.createElement('span');
  silkLight.className = 'terminal-character-silk-light';
  decor.append(silkLight);

  for (const className of ['earring-left', 'earring-right', 'hairpin']) {
    const glint = document.createElement('span');
    glint.className = `terminal-character-glint ${className}`;
    decor.append(glint);
  }

  const petals = document.createElement('div');
  petals.className = 'terminal-character-petals';
  for (let index = 0; index < 12; index += 1) {
    const petal = document.createElement('span');
    petal.style.setProperty('--petal-index', index);
    petal.style.setProperty('--petal-angle', `${index * 31 - 164}deg`);
    petal.style.setProperty('--petal-distance', `${54 + (index % 4) * 18}px`);
    petals.append(petal);
  }
  decor.append(petals);
  return decor;
}

function createCharacterLayers() {
  const root = document.createElement('div');
  root.className = 'terminal-character-live2d';
  root.dataset.fidelity = 'pixel-locked-retina-portrait-with-local-effects-and-coding-scenes';

  // Coding patches are intentionally attached only after the first terminal
  // output, so idle does not decode the seated scene or typing hands.
  const codingScene = createSceneLayer('terminal-character-coding-scene', '', 'coding');
  const typingHands = createFeatureLayer('terminal-character-typing-hands-layer', '', 'typingHands');
  const eyes = createFeatureLayer('terminal-character-eye-layer', BLINK_URL, 'blink');
  const mouth = createFeatureLayer('terminal-character-mouth-layer', SMILE_URL, 'mouth');
  root.append(codingScene, typingHands, eyes, mouth, createDecorations());
  return root;
}

function applyPatchLayout(layer, patch, layout) {
  if (!patch) return;
  const scaleX = layout.renderedWidth / CHARACTER_PATCH_CANVAS_SIZE.width;
  const scaleY = layout.renderedHeight / CHARACTER_PATCH_CANVAS_SIZE.height;
  const { crop } = patch;
  layer.style.inset = 'auto';
  layer.style.left = `${(layout.offsetX + crop.x * scaleX).toFixed(2)}px`;
  layer.style.top = `${(layout.offsetY + crop.y * scaleY).toFixed(2)}px`;
  layer.style.width = `${(crop.width * scaleX).toFixed(2)}px`;
  layer.style.height = `${(crop.height * scaleY).toFixed(2)}px`;
  layer.style.backgroundSize = '100% 100%';
  layer.style.backgroundPosition = 'center';
}

export function installTerminalCharacterTheme(stage, dock, {
  onAvailabilityChange = () => {},
  onError = () => {},
} = {}) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let root = null;
  let themeId = '';
  let state = 'idle';
  let stateRevision = 0;
  let dockOpen = dock.classList.contains('active');
  let windowFocused = document.hasFocus();
  let failed = false;
  let loading = false;
  let codingReady = false;
  let codingRequest = null;
  let loadGeneration = 0;
  let stateTimer = 0;
  let blinkTimer = 0;
  let blinkEndTimer = 0;
  let workingQuietTimer = 0;
  let blinkIndex = 0;
  let pointerFrame = 0;
  let pendingPointer = null;

  const isReady = () => !!root && !failed && themeId === 'guofeng-beauty';
  const canAnimate = () => isReady() && dockOpen && windowFocused && !document.hidden;

  function setStageStatus(status) {
    stage.dataset.renderState = status;
    stage.classList.toggle('active', status === 'ready');
    dock.classList.toggle('has-character-theme', status === 'ready');
    dock.classList.toggle('character-theme-fallback', status === 'fallback');
  }

  function clearTimers() {
    if (stateTimer) window.clearTimeout(stateTimer);
    if (blinkTimer) window.clearTimeout(blinkTimer);
    if (blinkEndTimer) window.clearTimeout(blinkEndTimer);
    if (workingQuietTimer) window.clearTimeout(workingQuietTimer);
    if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
    stateTimer = 0;
    blinkTimer = 0;
    blinkEndTimer = 0;
    workingQuietTimer = 0;
    pointerFrame = 0;
    pendingPointer = null;
  }

  function resetPointerDrift() {
    if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    pendingPointer = null;
    stage.style.setProperty('--ornament-drift-x', '0px');
    stage.style.setProperty('--ornament-drift-y', '0px');
  }

  function resize() {
    if (!root) return;
    const rect = stage.getBoundingClientRect();
    const layout = calculateCoverLayout({
      containerWidth: rect.width,
      containerHeight: rect.height,
      sourceWidth: CHARACTER_PATCH_CANVAS_SIZE.width,
      sourceHeight: CHARACTER_PATCH_CANVAS_SIZE.height,
      // Split mode gives the Coding surface a much narrower aspect ratio.
      // Anchor the portrait to that surface's right edge so the face and hands
      // remain visible instead of being removed by a centered cover crop.
      positionX: dock.classList.contains('has-companion') ? 1 : 0.5,
      positionY: BACKGROUND_POSITION_Y,
    });
    root.querySelectorAll('[data-feature]').forEach(layer => {
      applyPatchLayout(layer, FEATURE_PATCHES[layer.dataset.feature], layout);
    });
    root.querySelectorAll('[data-scene]').forEach(layer => {
      applyPatchLayout(layer, SCENE_PATCHES[layer.dataset.scene], layout);
    });
  }

  function scheduleBlink(delay = BLINK_DELAYS[blinkIndex % BLINK_DELAYS.length]) {
    if (blinkTimer || !canAnimate()) return;
    blinkIndex += 1;
    blinkTimer = window.setTimeout(() => {
      blinkTimer = 0;
      if (!canAnimate()) return;
      stage.classList.add('is-blinking');
      blinkEndTimer = window.setTimeout(() => {
        blinkEndTimer = 0;
        stage.classList.remove('is-blinking');
        scheduleBlink();
      }, 190);
    }, delay);
  }

  function updateRuntime() {
    const active = canAnimate();
    stage.classList.toggle('is-animation-paused', !active);
    // The portrait remains pixel-locked. Only source-aligned eyelids and tiny
    // decoration layers animate, so idle motion cannot soften or replace the face.
    if (active && state !== 'thinking') scheduleBlink(900);
    else {
      if (blinkTimer) window.clearTimeout(blinkTimer);
      if (blinkEndTimer) window.clearTimeout(blinkEndTimer);
      blinkTimer = 0;
      blinkEndTimer = 0;
      stage.classList.remove('is-blinking');
      resetPointerDrift();
    }
  }

  function setState(nextState, duration = characterStateDuration(nextState)) {
    const normalized = normalizeCharacterState(nextState);
    if (normalized !== 'thinking' && workingQuietTimer) {
      window.clearTimeout(workingQuietTimer);
      workingQuietTimer = 0;
    }
    const shouldRestart = isReady() && normalized === state && RESTARTABLE_STATES.has(normalized);
    state = normalized;
    stateRevision += 1;
    stage.dataset.characterState = state;
    stage.dataset.stateRevision = String(stateRevision);
    if (shouldRestart) {
      stage.classList.add('is-state-restarting');
      void stage.offsetWidth;
      stage.classList.remove('is-state-restarting');
    }
    if (stateTimer) window.clearTimeout(stateTimer);
    stateTimer = 0;
    if (duration > 0) {
      const revision = stateRevision;
      stateTimer = window.setTimeout(() => {
        if (revision !== stateRevision) return;
        stateTimer = 0;
        setState('idle', 0);
      }, duration);
    }
    updateRuntime();
  }

  function mount() {
    root = createCharacterLayers();
    stage.replaceChildren(root);
    stage.dataset.renderBackend = 'layered-2d';
    stage.dataset.characterState = state;
    stage.dataset.stateRevision = String(stateRevision);
    setStageStatus('ready');
    resize();
    updateRuntime();
    onAvailabilityChange(true);
    if (state === 'thinking') void ensureCodingAssets();
  }

  function applyCodingAssets() {
    if (!root) return;
    const codingScene = Array.from(root.querySelectorAll('[data-scene]'))
      .find(layer => layer.dataset.scene === 'coding');
    const typingHands = Array.from(root.querySelectorAll('[data-feature]'))
      .find(layer => layer.dataset.feature === 'typingHands');
    if (!codingScene || !typingHands) return;
    codingScene.style.backgroundImage = `url("${CODING_SCENE_URL}")`;
    typingHands.style.backgroundImage = `url("${CODING_TYPING_URL}")`;
    stage.dataset.codingAssets = 'ready';
    resize();
  }

  function ensureCodingAssets() {
    if (codingReady) return Promise.resolve(true);
    if (!isReady()) return Promise.resolve(false);
    if (codingRequest) return codingRequest.promise;
    const generation = loadGeneration;
    stage.dataset.codingAssets = 'loading';
    const request = { generation, promise: null };
    request.promise = Promise.all([
      preloadImage(CODING_SCENE_URL, '国风人物坐姿 Coding 场景'),
      preloadImage(CODING_TYPING_URL, '国风人物键盘敲击素材'),
    ]).then(() => {
      if (codingRequest !== request || generation !== loadGeneration || !isReady()) return false;
      codingRequest = null;
      codingReady = true;
      applyCodingAssets();
      return true;
    }).catch(error => {
      if (codingRequest !== request || generation !== loadGeneration) return false;
      codingRequest = null;
      fail(error);
      return false;
    });
    codingRequest = request;
    return request.promise;
  }

  function disposeScene({ notify = false } = {}) {
    loadGeneration += 1;
    loading = false;
    codingReady = false;
    codingRequest = null;
    clearTimers();
    root = null;
    state = 'idle';
    stateRevision += 1;
    stage.replaceChildren();
    stage.classList.remove('is-blinking');
    stage.style.removeProperty('--ornament-drift-x');
    stage.style.removeProperty('--ornament-drift-y');
    delete stage.dataset.renderBackend;
    delete stage.dataset.characterState;
    delete stage.dataset.stateRevision;
    delete stage.dataset.codingAssets;
    setStageStatus(themeId ? 'fallback' : 'off');
    if (notify) onAvailabilityChange(false);
  }

  function fail(error, notify = true) {
    failed = true;
    disposeScene({ notify });
    setStageStatus(themeId ? 'fallback' : 'off');
    onError(error);
  }

  function initialize() {
    if (isReady()) return true;
    if (loading || failed) return false;
    const generation = ++loadGeneration;
    loading = true;
    setStageStatus('loading');
    Promise.all([
      preloadImage(BLINK_URL, '国风人物眨眼素材'),
      preloadImage(SMILE_URL, '国风人物微笑素材'),
    ]).then(() => {
      if (generation !== loadGeneration || themeId !== 'guofeng-beauty') return;
      loading = false;
      mount();
    }).catch(error => {
      if (generation !== loadGeneration) return;
      loading = false;
      fail(error);
    });
    return false;
  }

  function applyTheme(nextThemeId) {
    const normalized = normalizeCharacterThemeId(nextThemeId);
    if (themeId !== normalized) {
      themeId = '';
      disposeScene();
      themeId = normalized;
      failed = false;
    }
    if (!themeId) {
      setStageStatus('off');
      return false;
    }
    if (!shouldEnableCharacterTheme({ themeId, reducedMotion: reducedMotion.matches })) {
      disposeScene();
      setStageStatus('fallback');
      return false;
    }
    return initialize();
  }

  function handleTerminalEvent(eventType) {
    if (eventType === 'output') {
      if (isReady()) void ensureCodingAssets();
      const alreadyWorking = state === 'thinking' && workingQuietTimer;
      if (!alreadyWorking) setState('thinking', 0);
      if (workingQuietTimer) window.clearTimeout(workingQuietTimer);
      workingQuietTimer = window.setTimeout(() => {
        workingQuietTimer = 0;
        if (state === 'thinking') setState('idle', 0);
      }, CHARACTER_WORKING_QUIET_MS);
      return;
    }
    if (workingQuietTimer) window.clearTimeout(workingQuietTimer);
    workingQuietTimer = 0;
    setState(terminalEventCharacterState(eventType));
  }

  function flushPointerMove() {
    pointerFrame = 0;
    if (!canAnimate() || !pendingPointer) {
      pendingPointer = null;
      return;
    }
    const { clientX, clientY } = pendingPointer;
    pendingPointer = null;
    const pointer = normalizeStagePointer(stage.getBoundingClientRect(), clientX, clientY);
    if (!pointer.inside) return;
    // The portrait never moves. Pointer input only nudges tiny jewelry highlights.
    stage.style.setProperty('--ornament-drift-x', `${(pointer.x * 0.9).toFixed(2)}px`);
    stage.style.setProperty('--ornament-drift-y', `${(-pointer.y * 0.6).toFixed(2)}px`);
  }

  const isCompanionSurface = target => !!target?.closest?.('.companion-panel, .companion-splitter');

  function onPointerMove(event) {
    if (!canAnimate() || isCompanionSurface(event.target)) {
      resetPointerDrift();
      return;
    }
    pendingPointer = { clientX: event.clientX, clientY: event.clientY };
    if (!pointerFrame) pointerFrame = window.requestAnimationFrame(flushPointerMove);
  }

  function onPointerLeave() {
    resetPointerDrift();
  }

  function onPointerDown(event) {
    if (!isReady() || isCompanionSurface(event.target)) return;
    if (isCharacterInteractionZone(stage.getBoundingClientRect(), event.clientX, event.clientY)) {
      setState('greeting');
    }
  }

  function onReducedMotionChange() {
    if (!themeId) return;
    const ready = applyTheme(themeId);
    onAvailabilityChange(ready);
  }

  function onWindowBlur() {
    windowFocused = false;
    updateRuntime();
  }

  function onWindowFocus() {
    windowFocused = true;
    updateRuntime();
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  dock.addEventListener('pointermove', onPointerMove, { passive: true });
  dock.addEventListener('pointerleave', onPointerLeave, { passive: true });
  dock.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);
  document.addEventListener('visibilitychange', updateRuntime);
  reducedMotion.addEventListener?.('change', onReducedMotionChange);

  return {
    applyTheme,
    handleTerminalEvent,
    isReady,
    setDockOpen(open) {
      dockOpen = !!open;
      updateRuntime();
    },
    setState,
    destroy() {
      themeId = '';
      resizeObserver.disconnect();
      dock.removeEventListener('pointermove', onPointerMove);
      dock.removeEventListener('pointerleave', onPointerLeave);
      dock.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', updateRuntime);
      reducedMotion.removeEventListener?.('change', onReducedMotionChange);
      disposeScene();
    },
  };
}
