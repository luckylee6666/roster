import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignSessionToTerminalPane,
  closeTerminalPaneSession,
  normalizeTerminalPaneLayout,
  reconcileTerminalPanes,
  removeTerminalPaneSession,
  removeSessionFromTerminalPanes,
  selectTerminalPaneSession,
  terminalPaneCapacity,
  terminalSessionIdAtPoint,
  visibleTerminalSessionIds,
} from '../src/terminal-pane-layout.js';

test('终端布局只接受单窗、左右、上下和四宫格', () => {
  assert.equal(normalizeTerminalPaneLayout('grid'), 'grid');
  assert.equal(normalizeTerminalPaneLayout('unknown'), 'single');
  assert.equal(terminalPaneCapacity('single'), 1);
  assert.equal(terminalPaneCapacity('columns'), 2);
  assert.equal(terminalPaneCapacity('rows'), 2);
  assert.equal(terminalPaneCapacity('grid'), 4);
});

test('切到四宫格会保留当前会话并按标签顺序填满空槽', () => {
  assert.deepEqual(reconcileTerminalPanes({
    assignments: ['b'],
    sessionIds: ['a', 'b', 'c', 'd', 'e'],
    activeSessionId: 'b',
    layout: 'grid',
  }), ['b', 'a', 'c', 'd']);
});

test('第五个会话替换聚焦槽位但不改动其他三个槽位', () => {
  assert.deepEqual(
    assignSessionToTerminalPane(['a', 'b', 'c', 'd'], 'e', 'b', 'grid'),
    ['a', 'e', 'c', 'd'],
  );
});

test('点击已显示会话不改变槽位，空槽则优先接纳隐藏会话', () => {
  assert.deepEqual(
    assignSessionToTerminalPane(['a', 'b', 'c', 'd'], 'c', 'b', 'grid'),
    ['a', 'b', 'c', 'd'],
  );
  assert.deepEqual(
    assignSessionToTerminalPane(['a', null, 'c', 'd'], 'e', 'a', 'grid'),
    ['a', 'e', 'c', 'd'],
  );
});

test('移出布局只清空视图槽位且保留其他会话顺序', () => {
  const assignments = removeSessionFromTerminalPanes(['a', 'b', 'c', 'd'], 'b', 'grid');
  assert.deepEqual(assignments, ['a', null, 'c', 'd']);
  assert.deepEqual(visibleTerminalSessionIds(assignments), ['a', 'c', 'd']);
});

test('收回单窗时确保当前聚焦会话仍然可见', () => {
  assert.deepEqual(reconcileTerminalPanes({
    assignments: ['a', 'b', 'c', 'd'],
    sessionIds: ['a', 'b', 'c', 'd', 'e'],
    activeSessionId: 'c',
    layout: 'single',
  }), ['c']);
});

test('五个会话下选择、移出和关闭只改变目标窗格的视图状态', () => {
  const selected = selectTerminalPaneSession({
    assignments: ['a', 'b', 'c', 'd'],
    activeSessionId: 'b',
    layout: 'grid',
  }, 'e');
  assert.deepEqual(selected, {
    assignments: ['a', 'e', 'c', 'd'],
    activeSessionId: 'e',
  });

  const removed = removeTerminalPaneSession({ ...selected, layout: 'grid' }, 'e');
  assert.deepEqual(removed, {
    assignments: ['a', null, 'c', 'd'],
    activeSessionId: 'a',
  });

  const closed = closeTerminalPaneSession({
    ...selected,
    layout: 'grid',
    remainingSessionIds: ['a', 'b', 'd', 'e'],
  }, 'c');
  assert.deepEqual(closed, {
    assignments: ['a', 'e', 'b', 'd'],
    activeSessionId: 'e',
  });
});

test('拖放命中测试返回鼠标所在窗格而非当前活动窗格', () => {
  const panes = [
    { id: 'a', left: 0, right: 99, top: 0, bottom: 99 },
    { id: 'b', left: 100, right: 200, top: 0, bottom: 99 },
  ];
  assert.equal(terminalSessionIdAtPoint(panes, 30, 40), 'a');
  assert.equal(terminalSessionIdAtPoint(panes, 150, 40), 'b');
  assert.equal(terminalSessionIdAtPoint(panes, 250, 40), null);
});
