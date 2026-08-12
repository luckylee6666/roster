export function createTerminalSessionCloseCoordinator({
  closeBackend,
  onClosed,
  onError = () => {},
} = {}) {
  if (typeof closeBackend !== 'function' || typeof onClosed !== 'function') {
    throw new TypeError('closeBackend 和 onClosed 必须是函数');
  }

  const closingIds = new Set();

  return {
    isClosing(id) {
      return closingIds.has(id);
    },

    async close(id) {
      if (!id || closingIds.has(id)) return false;
      closingIds.add(id);
      try {
        await closeBackend(id);
        await onClosed(id);
        return true;
      } catch (error) {
        onError(error, id);
        return false;
      } finally {
        closingIds.delete(id);
      }
    },
  };
}
