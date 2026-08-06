export const DEFAULT_GAME_ID = 'tetris';
export const GAME_IDS = Object.freeze(['tetris', '2048']);

const GAME_ID_SET = new Set(GAME_IDS);

export function normalizeGameId(value) {
  return GAME_ID_SET.has(value) ? value : DEFAULT_GAME_ID;
}
