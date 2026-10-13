/** Convert the locked Wry 0.55.1 drag-drop coordinates into DOM viewport units.
 * macOS uses NSDraggingInfo.draggingLocation (points), GTK uses widget coordinates.
 * tauri-runtime-wry 2.11.2 labels both PhysicalPosition without scaling them.
 * Only WebView2 uses ScreenToClient physical pixels. Recheck on Wry upgrades.
 */
export function nativeFileDropPoint(position, isWindows = false, devicePixelRatio = 1) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  const ratio = isWindows && Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio : 1;
  return { x: position.x / ratio, y: position.y / ratio };
}
