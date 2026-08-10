const DEFAULT_MAX_BUFFERED_LENGTH = 1024 * 1024;

/**
 * PTY 创建完成前缓存键入，并在就绪后严格按顺序写出。所有后续写入也串行，避免
 * 启动命令、启动阶段键入和正常键入在异步 IPC 上互相超车。
 */
export function createTerminalInputBuffer({
  send,
  maxBufferedLength = DEFAULT_MAX_BUFFERED_LENGTH,
  onError = () => {},
  onOverflow = () => {},
}) {
  let ready = false;
  let failed = false;
  let overflowReported = false;
  let buffered = '';
  let sendChain = Promise.resolve();

  function enqueue(data) {
    if (!data || failed) return sendChain;
    sendChain = sendChain
      .catch(() => {})
      .then(() => send(data))
      .catch(error => onError(error));
    return sendChain;
  }

  function write(data) {
    if (!data || failed) return;
    if (ready) {
      enqueue(data);
      return;
    }
    const remaining = Math.max(0, maxBufferedLength - buffered.length);
    buffered += data.slice(0, remaining);
    if (remaining < data.length && !overflowReported) {
      overflowReported = true;
      onOverflow();
    }
  }

  async function markReady(prefix = '') {
    if (failed) return;
    ready = true;
    const queued = buffered;
    buffered = '';
    enqueue(prefix);
    enqueue(queued);
    await sendChain;
  }

  function markFailed() {
    failed = true;
    buffered = '';
  }

  return { markFailed, markReady, write };
}
