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
  let lastSendFailed = false;
  let sendFailures = 0;
  let starting = null;

  function enqueue(data, fatal = false) {
    if (!data || failed) return sendChain;
    sendChain = sendChain
      .catch(() => {})
      .then(() => {
        if (failed) return;
        lastSendFailed = false;
        return send(data);
      })
      .catch(error => {
        lastSendFailed = true;
        sendFailures++;
        if (fatal) markFailed();
        onError(error);
      });
    return sendChain;
  }

  /**
   * 返回是否完整收下这段输入：false 表示已失败、已溢出被截断或为空。
   * 就绪前返回 true 只是"已缓存"，真正发出后可用 flush() 确认结果。
   */
  function write(data) {
    if (!data || failed) return false;
    if (ready) {
      enqueue(data);
      return true;
    }
    const remaining = Math.max(0, maxBufferedLength - buffered.length);
    buffered += data.slice(0, remaining);
    if (remaining < data.length) {
      if (!overflowReported) {
        overflowReported = true;
        onOverflow();
      }
      return false;
    }
    return true;
  }

  /** 等待已排队的写入跑完，返回这段队列是否全部成功（供注入类调用方判断）。 */
  async function flush() {
    await sendChain;
    return !failed && !lastSendFailed;
  }

  async function markReady(prefix = '') {
    if (failed) return false;
    if (starting) return starting;
    if (ready) return flush();
    starting = (async () => {
      const failuresBefore = sendFailures;
      // Keep new keystrokes in the bounded buffer until the launch write has
      // succeeded. A failed prefix must never release user text into a shell.
      await enqueue(prefix, true);
      if (failed) return false;
      const queued = buffered;
      buffered = '';
      const drained = enqueue(queued, true);
      ready = true;
      await drained;
      return !failed && sendFailures === failuresBefore;
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  function markFailed() {
    failed = true;
    buffered = '';
  }

  return { flush, markFailed, markReady, write };
}
