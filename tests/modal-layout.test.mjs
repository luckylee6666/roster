import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./modal-layout-fixture.html', import.meta.url), 'utf8');
const ids = [
  'modal-overlay', 'proxy-overlay', 'orchestra-overlay', 'session-handoff-overlay',
  'session-preview-overlay', 'usage-overlay', 'server-modal-overlay', 'server-list-overlay',
  'scan-modal-overlay', 'companion-site-modal', 'context-modal-overlay', 'snippet-modal-overlay',
  'shared-memory-overlay', 'confirm-overlay', 'remote-overlay', 'conversation-file-preview',
  'conversation-assistant-overlay', 'conversation-create-overlay'
];

function overlayMarkup(id) {
  const start = page.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `#${id} exists`);
  const open = page.lastIndexOf('<div', start);
  let depth = 0;
  const tags = /<div\b[^>]*>|<\/div\s*>/g;
  tags.lastIndex = open;
  let match;
  while ((match = tags.exec(page))) {
    if (match[0].startsWith('</')) depth--;
    else depth++;
    if (!depth) return page.slice(open, tags.lastIndex);
  }
  assert.fail(`unclosed overlay #${id}`);
}

test('common modal layout covers the application dialogs while preserving the file preview grid', () => {
  assert.ok(ids.length >= 18);
  for (const id of ids) {
    const markup = overlayMarkup(id);
    const preview = id === 'conversation-file-preview';
    const dialog = [...markup.matchAll(/class="([^"]+)"/g)].find(([, classList]) => classList.split(/\s+/).includes('modal'));
    assert.ok(dialog, `#${id} has a modal panel`);
    assert.match(markup, /class="modal-header"/);
    assert.match(markup, /class="modal-body"|class="conversation-file-preview-body"/);
    if (preview) {
      assert.ok(dialog[1].split(/\s+/).includes('conversation-file-preview-modal'));
      const previewRule = styles.match(/\.conversation-file-preview-modal\s*\{([^}]*)\}/)?.[1] ?? '';
      assert.match(previewRule, /display\s*:\s*grid/);
      assert.match(previewRule, /grid-template-rows\s*:\s*auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/);
      const previewSelectorIndex = styles.indexOf('.conversation-file-preview-modal');
      const modalRuleIndex = styles.indexOf('.modal {');
      assert.ok(previewSelectorIndex >= 0 && modalRuleIndex > previewSelectorIndex, 'specific preview rule follows the generic modal rule');
      assert.match(styles.slice(previewSelectorIndex, previewSelectorIndex + 400), /\.conversation-file-preview-modal\s*\{[^}]*display\s*:\s*grid/);
      continue;
    }
    const rule = styles.match(/\.modal\s*\{([^}]*)\}/)?.[1] ?? '';
    assert.match(rule, /display\s*:\s*flex/);
    assert.match(rule, /flex-direction\s*:\s*column/);
    assert.match(rule, /max-height\s*:\s*100%/);
    assert.match(rule, /min-height\s*:\s*0/);
    assert.match(rule, /overflow\s*:\s*hidden/);
    assert.ok(markup.indexOf('modal-header') < markup.indexOf('modal-body'), `#${id} header precedes body`);
    if (markup.includes('class="modal-footer"')) {
      assert.ok(markup.indexOf('modal-body') < markup.indexOf('modal-footer'), `#${id} body precedes footer`);
    }
  }
  const companion = overlayMarkup('companion-site-modal');
  assert.match(companion, /<form\b[^>]*id="companion-site-form"[^>]*class="modal-form"/);
  assert.match(styles, /\.modal-header\s*,\s*\.modal-footer\s*\{[^}]*flex\s*:\s*0\s+0\s+auto/);
  assert.match(styles, /\.modal-body\s*\{[^}]*flex\s*:\s*1\s+1\s+auto/);
  assert.match(styles, /\.modal-body\s*\{[^}]*min-height\s*:\s*0/);
  assert.match(styles, /\.modal-body\s*\{[^}]*overflow(?:-y)?\s*:\s*(?:auto|scroll)/);
  assert.match(styles, /\.modal-form\s*\{[^}]*display\s*:\s*flex/);
  assert.match(styles, /\.modal-form\s*\{[^}]*flex\s*:\s*1\s+1\s+auto/);
});

test('layout fixture sources production markup and CSS, and only supplies synthetic content', () => {
  assert.match(fixture, /fetch\(['"]\.\.\/src\/index\.html/);
  assert.match(fixture, /src\/styles\.css/);
  assert.match(fixture, /snippet-modal-overlay/);
  assert.match(fixture, /shared-memory-overlay/);
  assert.match(fixture, /conversation-file-preview/);
  assert.match(fixture, /scan-modal-overlay/);
  assert.match(fixture, /width|height|zoom|scale|view/i);
  assert.match(fixture, /getBoundingClientRect/);
  assert.match(fixture, /Synthetic fixture only/);
  assert.doesNotMatch(fixture, /body\.replaceChildren\s*\(/);
  assert.doesNotMatch(fixture, /querySelectorAll\(['"]\.modal-body['"]\)[\s\S]{0,300}replaceChildren/);
  assert.match(fixture, /session-preview-body/);
  assert.match(fixture, /Synthetic fixture only[^\n]*session preview line/);
  assert.match(fixture, /shared-memory-save/);
  assert.match(fixture, /conversation-assistant-list/);
  assert.match(fixture, /conversation-assistant-item/);
  assert.match(fixture, /conversation-assistant-copy/);
  assert.match(fixture, /scan-list/);
  assert.match(fixture, /className\s*=\s*['"]snippet-row['"]/);
  assert.match(fixture, /toggle\(['"]active['"],\s*panel\.id\s*===\s*activeId\)/);
  assert.match(fixture, /reachableByBodyScroll/);
  assert.match(fixture, /panel-select/);
  assert.doesNotMatch(fixture, /main\.js|invoke\(|private data/i);
});
