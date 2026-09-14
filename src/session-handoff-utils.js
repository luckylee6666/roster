import { CLI_TOOLS, normalizeInstalledCliIds } from './cli-tools.js';

export const SESSION_HANDOFF_MAX_BYTES = 48 * 1024;
export const SESSION_HANDOFF_FILE_MAX_BYTES = 64 * 1024;

function toolLabel(id, tools = CLI_TOOLS) {
  return tools.find(tool => tool.id === id)?.label || String(id || 'CLI');
}

export function handoffTargetTools(installedIds, sourceTool, tools = CLI_TOOLS) {
  const installed = new Set(normalizeInstalledCliIds(installedIds, tools.map(tool => tool.id)));
  return tools.filter(tool => tool.id !== sourceTool && installed.has(tool.id));
}

export function sessionHandoffAvailability({ running, sourceTool, hasProject, busy } = {}, tools = CLI_TOOLS) {
  const source = tools.find(tool => tool.id === sourceTool);
  const sourceLabel = source?.label || '当前 CLI';
  if (!running) return { enabled: false, title: '请先切到运行中的 CLI 终端' };
  if (!source) return { enabled: false, title: '当前终端不是受支持的 CLI' };
  if (!hasProject) return { enabled: false, title: `当前 ${sourceLabel} 终端未关联已登记项目` };
  if (busy) return { enabled: false, title: '正在交接会话…' };
  return { enabled: true, title: `把 ${sourceLabel} 最新会话交给其他 CLI` };
}

export function latestHandoffSession(groups, sourceTool) {
  const group = (Array.isArray(groups) ? groups : []).find(item => item?.tool === sourceTool);
  return (Array.isArray(group?.sessions) ? group.sessions : []).reduce((latest, session) => {
    if (!session?.id) return latest;
    if (!latest) return session;
    return Number(session.atMs || 0) > Number(latest.atMs || 0) ? session : latest;
  }, null);
}

function cleanInline(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

export function validateSessionHandoffContent(value, maxBytes = SESSION_HANDOFF_FILE_MAX_BYTES) {
  const content = String(value || '').trim();
  const bytes = utf8Bytes(content).length;
  if (!content) return { valid: false, bytes, error: '交接稿不能为空' };
  if (content.includes('\0')) return { valid: false, bytes, error: '交接稿不能包含 NUL' };
  if (bytes > maxBytes) {
    return {
      valid: false,
      bytes,
      error: `交接稿超过 ${Math.floor(maxBytes / 1024)} KiB 上限`,
    };
  }
  return { valid: true, bytes, error: '' };
}

function truncateUtf8(value, maxBytes) {
  const text = String(value || '');
  if (utf8Bytes(text).length <= maxBytes) return text;
  const suffix = '\n\n> 交接稿已按安全上限截断，请结合工作区实际代码继续检查。\n';
  const suffixBytes = utf8Bytes(suffix).length;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (utf8Bytes(text.slice(0, mid)).length + suffixBytes <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low).replace(/\s+$/, '') + suffix;
}

function conversationMarkdown(messages, sourceLabel) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    const role = message?.role === 'assistant' ? sourceLabel : '用户';
    const text = String(message?.text || '').trim();
    return text ? `### ${role}\n\n${text}` : '';
  }).filter(Boolean).join('\n\n');
}

function workspaceMarkdown(context) {
  if (!context?.exists) return '项目目录当前不可用，请先确认路径。';
  if (!context.isRepo) return '这不是 Git 仓库，请直接检查项目目录中的实际文件。';
  const lines = [
    `- 分支：${cleanInline(context.branch) || '未知'}`,
    `- 工作区：${context.dirty ? '有未提交改动' : '干净'}`,
    `- 已跟踪改动：${Number(context.changed || 0)}`,
    `- 未跟踪文件：${Number(context.untracked || 0)}`,
  ];
  if (context.ahead || context.behind) {
    lines.push(`- 远端差异：领先 ${Number(context.ahead || 0)}，落后 ${Number(context.behind || 0)}`);
  }
  const files = (Array.isArray(context.files) ? context.files : []).slice(0, 20);
  if (files.length) {
    lines.push('', '### 改动文件', '');
    for (const file of files) lines.push(`- ${cleanInline(file.status) || '?'} ${cleanInline(file.path)}`);
    if (context.filesMore) lines.push(`- 另有 ${Number(context.filesMore)} 个文件未列出`);
  }
  const commits = (Array.isArray(context.commits) ? context.commits : []).slice(0, 5);
  if (commits.length) {
    lines.push('', '### 最近提交', '');
    for (const commit of commits) {
      lines.push(`- ${cleanInline(commit.hash)} ${cleanInline(commit.subject)} (${cleanInline(commit.rel)})`);
    }
  }
  return lines.join('\n');
}

export function buildSessionHandoffMarkdown({
  project,
  sourceTool,
  targetTool,
  preview,
  context,
  generatedAt = new Date().toISOString(),
  tools = CLI_TOOLS,
} = {}) {
  const sourceLabel = toolLabel(sourceTool, tools);
  const targetLabel = toolLabel(targetTool, tools);
  const conversation = conversationMarkdown(preview?.messages, sourceLabel) || '没有可用的自然语言对话。';
  const truncation = preview?.truncated
    ? '\n\n> 来源会话较长，这里只保留最近一段自然语言对话。'
    : '';
  const markdown = `# Roster 会话交接

- 项目：${cleanInline(project?.name) || '未命名项目'}
- 路径：${cleanInline(project?.localPath)}
- 来源：${sourceLabel}
- 接手：${targetLabel}
- 来源会话：${cleanInline(preview?.sourceTitle) || cleanInline(preview?.sourceId)}
- 生成时间：${cleanInline(generatedAt)}

## 最近对话

${conversation}${truncation}

## 当前工作区

${workspaceMarkdown(context)}

## 接手要求

1. 先阅读项目内的 AGENTS.md、CLAUDE.md 和其他适用约束。
2. 检查当前工作区和实际代码，不要假设来源 CLI 的结论一定正确。
3. 对照最近对话确认未完成项，保留已有有效改动，再继续实现。
4. 完成后运行与改动风险相称的测试，并清楚说明结果。
`;
  return truncateUtf8(markdown, SESSION_HANDOFF_MAX_BYTES);
}

export function handoffLaunchPrompt(relativePath, sourceTool, targetTool, tools = CLI_TOOLS) {
  const path = cleanInline(relativePath);
  const sourceLabel = toolLabel(sourceTool, tools);
  const targetLabel = toolLabel(targetTool, tools);
  return `这是从 ${sourceLabel} 交给 ${targetLabel} 的继续工作。请先读取项目内 ${path}，再检查当前 Git 工作区和项目约束，核对已有实现后继续未完成任务。`
    .replace(/[\r\n]+/g, ' ')
    .trim();
}
