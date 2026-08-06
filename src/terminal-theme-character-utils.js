const CHARACTER_THEME_IDS = new Set(['guofeng-beauty']);
const CHARACTER_STATES = new Set(['idle', 'thinking', 'success', 'error', 'greeting', 'rest']);

export const CHARACTER_SOURCE_SIZE = Object.freeze({ width: 1586, height: 992 });
export const CHARACTER_WORKING_QUIET_MS = 4200;

export const CHARACTER_FEATURES = Object.freeze({
  eyeLeft: Object.freeze({ x: 0.761, y: 0.249, radiusX: 0.016, radiusY: 0.0095 }),
  eyeRight: Object.freeze({ x: 0.795, y: 0.250, radiusX: 0.016, radiusY: 0.0095 }),
  // Keep the smile reveal inside the lips. A wider mask would expose the
  // generated cutout's white checkerboard just left of the profile contour.
  mouth: Object.freeze({ x: 0.769, y: 0.319, radiusX: 0.017, radiusY: 0.008 }),
  // Frame B is only revealed around both hands and the keyboard. The seated
  // scene itself comes from frame A, so no generated changes elsewhere leak in.
  typingHands: Object.freeze({ x: 0.646, y: 0.770, radiusX: 0.150, radiusY: 0.120 }),
});

export function normalizeCharacterThemeId(value) {
  return CHARACTER_THEME_IDS.has(value) ? value : '';
}

export function normalizeCharacterState(value) {
  return CHARACTER_STATES.has(value) ? value : 'idle';
}

export function characterStateDuration(state) {
  switch (normalizeCharacterState(state)) {
    case 'thinking': return CHARACTER_WORKING_QUIET_MS;
    case 'success': return 2200;
    case 'error': return 1800;
    case 'greeting': return 1700;
    default: return 0;
  }
}

export function shouldEnableCharacterTheme({ themeId, reducedMotion }) {
  return normalizeCharacterThemeId(themeId) !== '' && !reducedMotion;
}

export function calculateCoverLayout({
  containerWidth,
  containerHeight,
  sourceWidth = CHARACTER_SOURCE_SIZE.width,
  sourceHeight = CHARACTER_SOURCE_SIZE.height,
  positionX = 0.5,
  positionY = 0.14,
}) {
  const width = Math.max(1, Number(containerWidth) || 1);
  const height = Math.max(1, Number(containerHeight) || 1);
  const sourceW = Math.max(1, Number(sourceWidth) || 1);
  const sourceH = Math.max(1, Number(sourceHeight) || 1);
  const scale = Math.max(width / sourceW, height / sourceH);
  const renderedWidth = sourceW * scale;
  const renderedHeight = sourceH * scale;
  return {
    width,
    height,
    renderedWidth,
    renderedHeight,
    offsetX: (width - renderedWidth) * positionX,
    offsetY: (height - renderedHeight) * positionY,
    scale,
  };
}

export function featureStageEllipse(feature, layout) {
  const source = feature || CHARACTER_FEATURES.mouth;
  return {
    x: layout.offsetX + source.x * layout.renderedWidth,
    y: layout.offsetY + source.y * layout.renderedHeight,
    radiusX: source.radiusX * layout.renderedWidth,
    radiusY: source.radiusY * layout.renderedHeight,
  };
}

export function normalizeStagePointer(rect, clientX, clientY) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0, inside: false };
  const rx = (clientX - rect.left) / rect.width;
  const ry = (clientY - rect.top) / rect.height;
  return {
    x: Math.max(-1, Math.min(1, rx * 2 - 1)),
    y: Math.max(-1, Math.min(1, 1 - ry * 2)),
    inside: rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1,
  };
}

export function isCharacterInteractionZone(rect, clientX, clientY) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const rx = (clientX - rect.left) / rect.width;
  const ry = (clientY - rect.top) / rect.height;
  return rx >= 0.62 && rx <= 1 && ry >= 0.04 && ry <= 0.98;
}

export function terminalEventCharacterState(eventType) {
  if (eventType === 'output') return 'thinking';
  if (eventType === 'attention') return 'success';
  if (eventType === 'failure') return 'error';
  if (eventType === 'exit') return 'rest';
  return 'idle';
}
