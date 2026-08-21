import { normalizeProjectMemoryCwd } from './project-memory-utils.js';

export const PROJECT_IDEA_MAX_LENGTH = 10000;

let ideaIdSequence = 0;

function defaultIdeaId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `idea-${uuid}`;
  ideaIdSequence += 1;
  return `idea-${Date.now().toString(36)}-${ideaIdSequence.toString(36)}`;
}

function defaultNow() {
  return new Date().toISOString();
}

export function createProjectIdeaMutationGate() {
  let pending = false;
  return Object.freeze({
    get pending() {
      return pending;
    },
    begin() {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish() {
      pending = false;
    },
  });
}

export async function commitProjectIdeaSnapshot({
  previous,
  next,
  persist,
  getCurrent,
  setCurrent,
}) {
  setCurrent(next);
  try {
    await persist(next.slice());
    return true;
  } catch (_) {
    if (getCurrent() === next) setCurrent(previous);
    return false;
  }
}

function normalizedProjectId(projectId) {
  return String(projectId || '').trim();
}

function ideaTimestamp(idea) {
  const value = idea?.updatedAt || idea?.updated_at || idea?.createdAt || idea?.created_at || '';
  const parsed = Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(ideas) {
  return ideas
    .map((idea, index) => ({ idea, index }))
    .sort((left, right) => ideaTimestamp(right.idea) - ideaTimestamp(left.idea) || left.index - right.index)
    .map(entry => entry.idea);
}

function fieldsFromText(text) {
  const value = String(text || '').replace(/\r\n?/g, '\n').trim().slice(0, PROJECT_IDEA_MAX_LENGTH);
  if (!value) return null;
  const lines = value.split('\n');
  const first = (lines.shift() || '').trim();
  if (!first) return null;
  const title = first.slice(0, 200);
  const overflow = first.slice(200).trim();
  const rest = lines.join('\n').trim();
  const note = [overflow, rest].filter(Boolean).join('\n').slice(0, PROJECT_IDEA_MAX_LENGTH);
  return { title, note };
}

export function createProjectIdea(text, projectId, {
  idFactory = defaultIdeaId,
  now = defaultNow,
} = {}) {
  const project = normalizedProjectId(projectId);
  const fields = fieldsFromText(text);
  if (!project || !fields) return null;
  const at = String(typeof now === 'function' ? now() : now || defaultNow());
  return {
    id: String(idFactory()),
    title: fields.title,
    note: fields.note,
    archived: false,
    projectId: project,
    createdAt: at,
    updatedAt: at,
    lastPlacedAt: '',
    lastPlacedTool: '',
    lastPlacedSessionId: '',
  };
}

export function isProjectIdeaArchived(idea) {
  return Boolean(idea?.archived);
}

export function projectIdeasFor(ideas, projectId, {
  includeArchived = false,
  archivedOnly = false,
} = {}) {
  const project = normalizedProjectId(projectId);
  if (!project || !Array.isArray(ideas)) return [];
  const filtered = ideas.filter(idea => {
    if (normalizedProjectId(idea?.projectId ?? idea?.project_id) !== project) return false;
    const archived = isProjectIdeaArchived(idea);
    if (archivedOnly) return archived;
    return includeArchived || !archived;
  });
  return newestFirst(filtered);
}

export function orphanProjectIdeas(ideas, knownProjectIds) {
  if (!Array.isArray(ideas)) return [];
  const known = knownProjectIds instanceof Set
    ? knownProjectIds
    : new Set(Array.from(knownProjectIds || [], normalizedProjectId).filter(Boolean));
  return newestFirst(ideas.filter(idea => {
    const projectId = normalizedProjectId(idea?.projectId ?? idea?.project_id);
    return !projectId || !known.has(projectId);
  }));
}

export function findProjectIdea(ideas, id, projectId) {
  const wantedId = String(id || '');
  const project = normalizedProjectId(projectId);
  if (!wantedId || !project || !Array.isArray(ideas)) return null;
  return ideas.find(idea => (
    String(idea?.id || '') === wantedId
    && normalizedProjectId(idea?.projectId ?? idea?.project_id) === project
  )) || null;
}

export function updateProjectIdea(ideas, {
  id,
  projectId,
  title,
  note,
  archived,
  updatedAt,
  lastPlacedAt,
  lastPlacedTool,
  lastPlacedSessionId,
} = {}) {
  const current = findProjectIdea(ideas, id, projectId);
  if (!current) return ideas;
  const nextTitle = title == null ? current.title : String(title).trim().slice(0, 200);
  if (!nextTitle) return ideas;
  const replacement = {
    ...current,
    title: nextTitle,
    note: note == null ? String(current.note || '') : String(note).trim().slice(0, PROJECT_IDEA_MAX_LENGTH),
    archived: archived == null ? Boolean(current.archived) : Boolean(archived),
    updatedAt: String(updatedAt || defaultNow()),
    lastPlacedAt: lastPlacedAt == null ? String(current.lastPlacedAt || '') : String(lastPlacedAt),
    lastPlacedTool: lastPlacedTool == null ? String(current.lastPlacedTool || '') : String(lastPlacedTool),
    lastPlacedSessionId: lastPlacedSessionId == null
      ? String(current.lastPlacedSessionId || '')
      : String(lastPlacedSessionId),
  };
  return ideas.map(idea => idea === current ? replacement : idea);
}

export function removeProjectIdea(ideas, id, projectId) {
  const current = findProjectIdea(ideas, id, projectId);
  if (!current) return ideas;
  return ideas.filter(idea => idea !== current);
}

export function claimOrphanProjectIdea(ideas, {
  id,
  projectId,
  knownProjectIds,
  now = defaultNow,
} = {}) {
  if (!Array.isArray(ideas)) return ideas;
  const project = normalizedProjectId(projectId);
  const wantedId = String(id || '');
  if (!project || !wantedId) return ideas;
  const known = knownProjectIds instanceof Set
    ? knownProjectIds
    : new Set(Array.from(knownProjectIds || [], normalizedProjectId).filter(Boolean));
  if (!known.has(project)) return ideas;
  const orphans = new Set(orphanProjectIdeas(ideas, knownProjectIds));
  const current = ideas.find(idea => String(idea?.id || '') === wantedId && orphans.has(idea));
  if (!current) return ideas;
  const at = String(typeof now === 'function' ? now() : now || defaultNow());
  return ideas.map(idea => idea === current ? {
    ...idea,
    projectId: project,
    updatedAt: at,
  } : idea);
}

export function ideaConversationText(idea) {
  const title = String(idea?.title || '').trim();
  const note = String(idea?.note || '').trim();
  return [title, note]
    .filter(Boolean)
    .join('\n\n')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

export function planProjectIdeaPaste({
  idea,
  projectId,
  projectCwd,
  sessionId,
  sessionStatus,
  sessionCwd,
} = {}) {
  const project = normalizedProjectId(projectId);
  if (!idea || normalizedProjectId(idea.projectId ?? idea.project_id) !== project) return null;
  if (!sessionId || sessionStatus !== 'running') return null;
  const expectedCwd = normalizeProjectMemoryCwd(projectCwd);
  const currentCwd = normalizeProjectMemoryCwd(sessionCwd);
  if (!expectedCwd || currentCwd !== expectedCwd) return null;
  const text = ideaConversationText(idea);
  return text ? { sessionId: String(sessionId), text } : null;
}
