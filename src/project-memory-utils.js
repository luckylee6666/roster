export const WORKSPACE_MEMORY_LINK = '.memory';
export const MEMORY_POINTER_START = '<!-- vibe-memory -->';
export const MEMORY_POINTER_END = '<!-- /vibe-memory -->';
export const MEMORY_GITIGNORE_COMMENT = '# Vibe Coding Manager — 项目记忆窗口';

export const PROJECT_MEMORY_UNIFY_STORAGE_KEY = 'project-memory-unify-v1';

export const MEMORY_POINTER_BODY = [
  '长期记忆只在 `.memory/`（指向 Claude 项目记忆，不进 Git）。',
  '读：先看 `.memory/MEMORY.md`。写：用户说「更新记忆」时改专题；否则写入 `.memory/inbox/`。',
  '不要把记忆写进本文件或仓库里的 `memory/`。',
].join('\n');

const ROOT_PATHS = new Set(['/', '\\']);

export function normalizeProjectMemoryCwd(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  return raw.replace(/[\\/]+$/, '') || raw;
}

export function encodeClaudeProjectDir(cwd) {
  const normalized = normalizeProjectMemoryCwd(cwd);
  return [...normalized].map(ch => (ch === '/' || ch === '\\' || ch === '.' ? '-' : ch)).join('');
}

export function canonicalProjectMemoryDir(home, cwd) {
  const encoded = encodeClaudeProjectDir(cwd);
  if (!encoded) return '';
  const root = String(home || '').replace(/[\\/]+$/, '');
  if (!root) return '';
  return `${root}/.claude/projects/${encoded}/memory`;
}

export function workspaceMemoryLinkPath(cwd) {
  const dir = normalizeProjectMemoryCwd(cwd);
  return dir ? `${dir}/${WORKSPACE_MEMORY_LINK}` : '';
}

export function shouldMountProjectMemory(cwd, home = '') {
  const dir = normalizeProjectMemoryCwd(cwd);
  if (!dir || ROOT_PATHS.has(dir) || /^[A-Za-z]:$/.test(dir)) return false;
  const homeDir = normalizeProjectMemoryCwd(home);
  return !homeDir || dir !== homeDir;
}

export function loadProjectMemoryUnifyPaths(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const paths = Array.isArray(parsed?.paths) ? parsed.paths : [];
    return [...new Set(paths.map(normalizeProjectMemoryCwd).filter(Boolean))];
  } catch {
    return [];
  }
}

export function isProjectMemoryUnifyEnabled(cwd, savedPaths = []) {
  const key = normalizeProjectMemoryCwd(cwd);
  return Boolean(key && savedPaths.includes(key));
}

export function setProjectMemoryUnifyEnabled(cwd, enabled, savedPaths = []) {
  const key = normalizeProjectMemoryCwd(cwd);
  const next = new Set(loadProjectMemoryUnifyPaths({ paths: savedPaths }));
  if (!key) return [...next];
  if (enabled) next.add(key);
  else next.delete(key);
  return [...next];
}

export function shouldAutoMountProjectMemory(cwd, home = '', savedPaths = []) {
  return shouldMountProjectMemory(cwd, home) && isProjectMemoryUnifyEnabled(cwd, savedPaths);
}

export function memoryPointerBlock() {
  return `${MEMORY_POINTER_START}\n${MEMORY_POINTER_BODY}\n${MEMORY_POINTER_END}\n`;
}

export function removeMemoryPointer(existing) {
  const text = String(existing || '');
  const start = text.indexOf(MEMORY_POINTER_START);
  const end = text.indexOf(MEMORY_POINTER_END);
  if (start < 0 || end < start) return text;
  const after = end + MEMORY_POINTER_END.length;
  const prefix = text.slice(0, start).replace(/\s*$/, '');
  const suffix = text.slice(after).replace(/^\s*/, '');
  if (!prefix && !suffix) return '';
  return `${prefix}${prefix && suffix ? '\n\n' : ''}${suffix}`.replace(/\s*$/, suffix ? '\n' : '');
}

export function upsertMemoryPointer(existing) {
  const block = memoryPointerBlock().trimEnd();
  const text = String(existing || '');
  const start = text.indexOf(MEMORY_POINTER_START);
  const end = text.indexOf(MEMORY_POINTER_END);
  if (start >= 0 && end > start) {
    const after = end + MEMORY_POINTER_END.length;
    const prefix = text.slice(0, start).replace(/\s*$/, '');
    const suffix = text.slice(after).replace(/^\s*/, '');
    return `${prefix}${prefix ? '\n\n' : ''}${block}\n${suffix ? `\n${suffix}` : ''}`.replace(/\s*$/, '\n');
  }
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}

export function ensureMemoryGitignore(existing) {
  const text = String(existing || '');
  const lines = text.split(/\r?\n/);
  const hasLink = lines.some(line => line.trim() === WORKSPACE_MEMORY_LINK);
  if (hasLink) return text.endsWith('\n') || !text ? text : `${text}\n`;
  const prefix = text.replace(/\s*$/, '');
  const section = `${MEMORY_GITIGNORE_COMMENT}\n${WORKSPACE_MEMORY_LINK}\n`;
  return `${prefix}${prefix ? '\n\n' : ''}${section}`;
}

export function parseMemoryTopics(markdown, limit = 12) {
  const topics = [];
  const seen = new Set();
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (!match) continue;
    const title = match[1].trim();
    const file = match[2].trim();
    if (!title || seen.has(file)) continue;
    seen.add(file);
    topics.push({ title, file });
    if (topics.length >= limit) break;
  }
  return topics;
}

export function memoryBannerText(state) {
  if (!state?.mounted) {
    return state?.warning ? `[项目记忆] ${state.warning}` : '';
  }
  const topicLabel = Number.isFinite(state.topicCount)
    ? `${state.topicCount} 个专题`
    : '已挂载';
  const inbox = Number(state.inboxCount) > 0 ? `，inbox ${state.inboxCount}` : '';
  return `[项目记忆] 已挂载 .memory（${topicLabel}${inbox}）`;
}
