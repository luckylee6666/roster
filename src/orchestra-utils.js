import { cliToolName } from './session-restore-utils.js';

export const ORCHESTRA_KIT = Object.freeze(['claude', 'codex', 'grok']);
export const ORCHESTRA_DIR = '.vibe/orchestra';
export const ORCHESTRA_GOAL_FILE = 'goal.md';
export const ORCHESTRA_PLAN_FILE = 'plan.md';
export const DEFAULT_ORCHESTRA_BRAIN = 'claude';

const ALLOWED_FILES = new Set([
  'goal.md',
  'plan.md',
  'README.md',
  'inbox/claude.md',
  'inbox/codex.md',
  'inbox/grok.md',
  'inbox/opencode.md',
  'inbox/gemini.md',
  'inbox/agy.md',
]);

export function normalizeOrchestraTool(tool) {
  const name = cliToolName(tool);
  return ORCHESTRA_KIT.includes(name) ? name : '';
}

export function normalizeOrchestraBrain(brain, kit = ORCHESTRA_KIT) {
  const name = normalizeOrchestraTool(brain);
  return kit.includes(name) ? name : DEFAULT_ORCHESTRA_BRAIN;
}

export function orchestraWorkers(brain, kit = ORCHESTRA_KIT) {
  const lead = normalizeOrchestraBrain(brain, kit);
  return kit.filter(tool => tool !== lead);
}

export function normalizeOrchestraConfig({
  brain = DEFAULT_ORCHESTRA_BRAIN,
  workers,
  kit = ORCHESTRA_KIT,
} = {}) {
  const tools = (Array.isArray(kit) ? kit : ORCHESTRA_KIT).filter(Boolean);
  const lead = normalizeOrchestraBrain(brain, tools);
  const rest = Array.isArray(workers) && workers.length
    ? workers.map(normalizeOrchestraTool).filter(tool => tool && tool !== lead && tools.includes(tool))
    : orchestraWorkers(lead, tools);
  return {
    brain: lead,
    workers: [...new Set(rest)],
    kit: tools,
  };
}

export function orchestraRoleForTool(config, tool) {
  const name = normalizeOrchestraTool(tool);
  if (!name || !config) return '';
  if (name === config.brain) return 'brain';
  if (config.workers?.includes(name)) return 'worker';
  return '';
}

export function orchestraRoleLabel(role) {
  if (role === 'brain') return '大脑';
  if (role === 'worker') return '干活';
  return '';
}

export function isAllowedOrchestraFile(name) {
  return ALLOWED_FILES.has(String(name || '').trim());
}

export function orchestraInboxFile(tool) {
  const name = normalizeOrchestraTool(tool) || String(tool || '').trim();
  const file = `inbox/${name}.md`;
  return isAllowedOrchestraFile(file) ? file : '';
}

function headingForTool(tool) {
  if (tool === 'claude') return 'Claude';
  if (tool === 'codex') return 'Codex';
  if (tool === 'grok') return 'Grok';
  return tool;
}

export function orchestraBrainPrompt({ goal, workers = [], planFile = `${ORCHESTRA_DIR}/${ORCHESTRA_PLAN_FILE}` } = {}) {
  const task = String(goal || '').trim() || '（用户还没写具体目标，先根据当前仓库判断该拆什么。）';
  const names = workers.map(headingForTool).join('、') || '另外两个干活的人';
  const sections = workers.map(tool => `## ${headingForTool(tool)}\n- \n`).join('\n');
  return [
    `你是这场协作的大脑，只负责拆活和验收，不要亲自改业务代码。`,
    ``,
    `目标：`,
    task,
    ``,
    `请把可执行计划写入 \`${planFile}\`，按干活的人分开：`,
    ``,
    sections || `## Worker\n- \n`,
    `规则：`,
    `- 干活的人是 ${names}。`,
    `- 每个任务写到具体文件或具体行为。`,
    `- 写完计划就停，等用户把任务派出去。`,
    `- 不要重写别人已经在做的部分。`,
  ].join('\n');
}

export function orchestraWorkerPrompt({
  tool,
  brain,
  goal,
  plan = '',
  extra = '',
  planFile = `${ORCHESTRA_DIR}/${ORCHESTRA_PLAN_FILE}`,
  inboxFile = '',
} = {}) {
  const name = headingForTool(normalizeOrchestraTool(tool) || tool);
  const lead = headingForTool(normalizeOrchestraBrain(brain));
  const report = inboxFile || `${ORCHESTRA_DIR}/inbox/${normalizeOrchestraTool(tool) || 'worker'}.md`;
  const task = String(extra || goal || '').trim();
  const planText = String(plan || '').trim();
  return [
    `你是这场协作里负责动手的 ${name}。大脑是 ${lead}，不要抢大脑的拆活，也不要做别人的任务。`,
    ``,
    task ? `当前目标：\n${task}\n` : '',
    planText
      ? `大脑已经写好的计划：\n\n${planText}\n\n只做「## ${name}」下面或明确写给你的部分。`
      : `先读 \`${planFile}\`。如果还没有你的章节，先在终端里说一声，不要瞎改。`,
    ``,
    `做完把结果写入 \`${report}\`：做了什么、改了哪些文件、还剩什么。`,
  ].filter(Boolean).join('\n');
}

export function orchestraBroadcastPrompt({ role, tool, text }) {
  const body = String(text || '').trim();
  if (!body) return '';
  if (role === 'brain') {
    return `补充给大脑：\n${body}\n\n如果计划有变，更新 \`${ORCHESTRA_DIR}/${ORCHESTRA_PLAN_FILE}\`，不要直接改业务代码。`;
  }
  if (role === 'worker') {
    return `补充任务（${headingForTool(normalizeOrchestraTool(tool) || tool)}）：\n${body}\n\n做完更新 \`${ORCHESTRA_DIR}/inbox/${normalizeOrchestraTool(tool) || 'worker'}.md\`。`;
  }
  return body;
}
