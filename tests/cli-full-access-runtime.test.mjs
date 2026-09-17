import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CLI_TOOLS } from '../src/cli-tools.js';
import { launchCliCommand, restoredCliCommand } from '../src/session-restore-utils.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

test('完全访问档只挂在 cmd 上，且默认启动命令不带任何绕过参数', () => {
  const cmd = CLI_TOOLS.find(tool => tool.id === 'cmd');
  assert.deepEqual(
    cmd.launchVariants.map(item => item.args),
    ['--yolo'],
  );
  assert.equal(cmd.launchVariants[0].danger, true, '完全访问档要标 danger');
  for (const tool of CLI_TOOLS.filter(item => item.id !== 'cmd')) {
    assert.equal(tool.launchVariants, undefined, `${tool.id} 不该有启动变体`);
  }
  // 默认（左键）路径：裸命令 / 精确续接，都不带绕过参数。
  assert.equal(launchCliCommand('cmd'), 'cmd');
  assert.equal(launchCliCommand('cmd', 'b0f7bf92-a27b-4236-a282-dad7d7892099'), 'cmd --session b0f7bf92-a27b-4236-a282-dad7d7892099');
  assert.ok(!launchCliCommand('cmd', 'x').includes('--yolo'));
  // 恢复标签时变体不能被吃掉（cmd 的恢复路径由 resumeCommandForRestoredTab 查精确 ID，
  // 但它必须把 --yolo 一起带过去）。
  assert.equal(restoredCliCommand('cmd --yolo'), 'cmd --yolo');
  assert.equal(restoredCliCommand('cmd'), 'cmd');
  assert.ok(
    main.includes('const variant = cliLaunchVariants(tool).find(item => trimmed.includes(item.args));'),
    '重算续接命令时要留住启动变体',
  );
});

test('卡片右键菜单、变体透传与 danger 标记都接上了', () => {
  assert.match(main, /function openCliLaunchMenu\(/);
  assert.ok(main.includes('data-variants="1"'), '有色标的按钮要带变体标记');
  assert.ok(main.includes('btn.oncontextmenu = event => {'), '右键要能开菜单');
  assert.ok(
    main.includes('const variant = cliLaunchVariants(tool).find(item => String(cmd).includes(item.args));'),
    '启动命令要透传选中的变体',
  );
  // 只有右键选中变体时才追加参数，左键默认路径不带。
  assert.ok(main.includes("${variant ? ` ${variant.args}` : ''}"));
  // 以绕过参数启动的终端标签必须看得出来（danger 徽标 + title）。
  assert.ok(main.includes('--yolo(\\s|$)'), '要能识别绕过参数');
  assert.ok(main.includes('is-full-access'), '绕过参数启动的标签要有 danger 标记');
  assert.match(styles, /\.term-tab-tool\.is-full-access \{/);
  assert.match(styles, /\.cli-launch-menu \{/);
  assert.match(styles, /\.cli-launch-item\.is-danger \{/);
});
