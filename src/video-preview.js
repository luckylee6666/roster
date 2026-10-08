const VIDEO_OPEN_COMMAND = 'open_project_video';
const VIDEO_CLOSE_COMMAND = 'close_project_video';

export const VIDEO_PREVIEW_ERROR_MESSAGE =
  '视频无法播放或编码不受支持。请尝试 MP4（H.264/AAC）格式。';

/** Owns the short-lived backend token and media element for one local preview. */
export function createProjectVideoPreview({ video, invoke, onError = () => {}, replaceVideo = (current, next) => current.replaceWith(next) }) {
  let requestSeq = 0;
  let token = null;
  let mediaErrorListener = null;

  function releaseToken(value) {
    if (!value) return;
    try {
      Promise.resolve(invoke(VIDEO_CLOSE_COMMAND, { token: value })).catch(() => {});
    } catch (_) {}
  }

  function detachMediaErrorListener() {
    if (!mediaErrorListener) return;
    const { node, listener } = mediaErrorListener;
    mediaErrorListener = null;
    try { node.removeEventListener('error', listener); } catch (_) {}
  }

  function clearMedia() {
    try { video.pause(); } catch (_) {}
    try { video.removeAttribute('src'); } catch (_) {}
    try { video.load(); } catch (_) {}
  }

  function close() {
    requestSeq++;
    detachMediaErrorListener();
    clearMedia();
    const oldToken = token;
    token = null;
    releaseToken(oldToken);
  }

  async function open(projectId, path) {
    close();
    const seq = requestSeq;
    if (!projectId) {
      onError('该终端目录没有关联的本地项目，无法播放视频。');
      return false;
    }
    try {
      const result = await invoke(VIDEO_OPEN_COMMAND, { projectId, path });
      if (seq !== requestSeq) {
        releaseToken(result?.token);
        return false;
      }
      if (!result?.token || !result?.url) {
        releaseToken(result?.token);
        onError(VIDEO_PREVIEW_ERROR_MESSAGE);
        return false;
      }
      // Own the resource before touching DOM APIs: clone/replacement/src assignment can throw.
      token = result.token;
      const nextVideo = video.cloneNode(false);
      replaceVideo(video, nextVideo);
      video = nextVideo;
      const openedSeq = requestSeq;
      const listener = () => {
        if (openedSeq !== requestSeq || mediaErrorListener?.node !== video) return;
        close();
        onError(VIDEO_PREVIEW_ERROR_MESSAGE);
      };
      video.addEventListener('error', listener);
      mediaErrorListener = { node: video, listener };
      video.src = result.url;
      return true;
    } catch (error) {
      if (seq === requestSeq) {
        close();
        const detail = error?.message || (typeof error === 'string' ? error : '');
        onError(`${VIDEO_PREVIEW_ERROR_MESSAGE}${detail ? `（${detail}）` : ''}`);
      }
      return false;
    }
  }

  function pause() {
    try { video.pause(); } catch (_) {}
  }

  return { open, close, pause };
}
