import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeConversationSlash,
  conversationSlashHelpText,
  filterConversationSlash,
  inspectConversationSlash,
  mergeConversationSlashCommands,
  planConversationSlash,
  ROSTER_EFFORT_ACTION,
  ROSTER_SLASH_ACTIONS,
  validateConversationEffort,
  validateConversationModel,
} from '../src/conversation-slash.js';

const local = mergeConversationSlashCommands([]);
const mixed = mergeConversationSlashCommands([
  { id: 'animejs', title: 'Anime.js 动效', source: 'inspect' },
  { id: 'deploy', title: '发布当前项目' },
  { id: 'model', title: '来自 CLI 的重复项，应被 Roster 覆盖' },
  { id: 'bad name', title: '非法' },
  { id: 'team/../unsafe', title: '非法路径段' },
]);

test('斜杠补全只内置 Roster 动作，其余命令来自当前项目动态发现', () => {
  assert.deepEqual(ROSTER_SLASH_ACTIONS.map(command => command.id), ['model', 'new', 'help']);
  assert.equal(local.some(command => command.id === 'compact'), false);
  assert.deepEqual(mixed.map(command => command.id), ['model', 'new', 'help', 'animejs', 'deploy']);
  assert.equal(mixed.find(command => command.id === 'model').action, 'model');
  assert.equal(mixed.find(command => command.id === 'animejs').action, 'skill');
  assert.deepEqual(
    mergeConversationSlashCommands([], { includeModel: false }).map(command => command.id),
    ['new', 'help'],
  );
});

test('斜杠菜单按当前发现结果过滤，前缀优先于包含匹配', () => {
  const model = inspectConversationSlash('/mod', mixed);
  assert.equal(model.active, true);
  assert.deepEqual(model.matches.map(command => command.id), ['model']);
  const all = inspectConversationSlash('/', mixed);
  assert.ok(all.matches.length > 3);
  assert.equal(all.matches[0].id, 'model');
  const anime = filterConversationSlash(mixed, 'ani');
  assert.deepEqual(anime.map(command => command.id), ['animejs']);
});

test('回车对 /model、/new 走本地动作，发现的 skill 保留原命令交给后端校验执行', () => {
  assert.equal(planConversationSlash('/new', mixed).type, 'new-chat');
  assert.equal(planConversationSlash('/clear', mixed).type, 'new-chat');
  assert.equal(planConversationSlash('/help', mixed).type, 'help');
  assert.equal(planConversationSlash('/model', mixed).type, 'complete');
  assert.equal(planConversationSlash('/model', mixed).text, '/model ');
  assert.equal(planConversationSlash('/model grok-4', mixed).type, 'set-model');
  assert.equal(planConversationSlash('/ani', mixed).type, 'complete');
  assert.equal(planConversationSlash('/ani', mixed).text, '/animejs ');
  assert.equal(planConversationSlash('/animejs 做一个片头', mixed).type, 'prompt');
  assert.equal(planConversationSlash('帮我看看项目', mixed).type, 'prompt');
  assert.equal(completeConversationSlash({ id: 'model', takesArgs: true }), '/model ');
});

test('/help 输出当前 CLI 动态发现后的完整命令清单', () => {
  const help = conversationSlashHelpText(mixed, 'Grok');
  assert.match(help, /^Grok 当前可用命令：/);
  assert.match(help, /\/model — 选择当前 CLI 的模型/);
  assert.match(help, /\/animejs — Anime\.js 动效/);
  assert.match(help, /\/deploy — 发布当前项目/);
});

test('/model 在有动态模型列表时进入选择器，而不是只补全命令', () => {
  const models = [
    { id: 'grok-4.6', current: true },
    { id: 'grok-4.5', current: false },
  ];
  const picking = inspectConversationSlash('/model', mixed, models);
  assert.equal(picking.mode, 'models');
  assert.deepEqual(picking.matches.map(item => item.id), ['grok-4.6', 'grok-4.5']);
  assert.equal(picking.matches[0].title, '当前');
  assert.equal(planConversationSlash('/model', mixed, 0, models).type, 'set-model');
  assert.equal(planConversationSlash('/model', mixed, 0, models).model, 'grok-4.6');
  assert.equal(planConversationSlash('/model', mixed, 1, models).model, 'grok-4.5');
  const filtered = inspectConversationSlash('/model 4.5', mixed, models);
  assert.deepEqual(filtered.matches.map(item => item.id), ['grok-4.5']);
  const prefix = inspectConversationSlash('/mod', mixed, models);
  assert.equal(prefix.mode, 'commands');
  assert.deepEqual(prefix.matches.map(item => item.id), ['model']);
  const empty = inspectConversationSlash('/model', mixed, []);
  assert.equal(empty.mode, 'models');
  assert.equal(empty.matches.length, 0);
  const selected = inspectConversationSlash('/model', mixed, models, 'grok-4.5');
  assert.equal(selected.matches[0].title, '默认');
  assert.equal(selected.matches[1].title, '当前');
});

test('模型名称只接受安全的有界标识，拒绝参数注入', () => {
  assert.deepEqual(validateConversationModel('grok-4'), { ok: true, model: 'grok-4', error: '' });
  assert.deepEqual(validateConversationModel('opencode/gpt-5.6'), {
    ok: true,
    model: 'opencode/gpt-5.6',
    error: '',
  });
  assert.equal(validateConversationModel('').ok, false);
  assert.equal(validateConversationModel('--sandbox').ok, false);
  assert.equal(validateConversationModel('a b').ok, false);
  assert.equal(planConversationSlash('/model --help', mixed).type, 'error');
});

test('/effort 只在当前 CLI 提供推理强度时出现，并进入选择器', () => {
  assert.equal(ROSTER_EFFORT_ACTION.id, 'effort');
  assert.equal(mergeConversationSlashCommands([]).some(command => command.id === 'effort'), false);
  const withEffort = mergeConversationSlashCommands([], { includeEffort: true });
  assert.deepEqual(withEffort.map(command => command.id), ['model', 'effort', 'new', 'help']);
  const efforts = [
    { id: 'xhigh', label: '最高' },
    { id: 'high', label: '高' },
    { id: 'medium', label: '中' },
    { id: 'low', label: '低' },
  ];
  const picking = inspectConversationSlash('/effort', withEffort, [], '', efforts);
  assert.equal(picking.mode, 'efforts');
  assert.deepEqual(picking.matches.map(item => item.id), ['xhigh', 'high', 'medium', 'low']);
  assert.equal(planConversationSlash('/effort', withEffort, 1, [], '', efforts).type, 'set-effort');
  assert.equal(planConversationSlash('/effort', withEffort, 1, [], '', efforts).effort, 'high');
  assert.equal(planConversationSlash('/effort high', withEffort, 0, [], '', efforts).type, 'set-effort');
  assert.equal(validateConversationEffort('xhigh').ok, true);
  assert.equal(validateConversationEffort('--sandbox').ok, false);
  assert.equal(planConversationSlash('/effort high', withEffort).type, 'set-effort');
});
