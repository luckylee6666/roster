import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const page = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function remoteMarkup() {
  const match = page.match(/<div class="modal-mask" id="remote-overlay"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(match, 'remote overlay markup exists in the application page');
  return match[0];
}

test('remote modal keeps the close control, scrollable content, and actions in three layout sections', () => {
  const markup = remoteMarkup();
  const header = markup.match(/class="modal-header"/);
  const body = markup.match(/class="modal-body"/);
  const footer = markup.match(/class="modal-footer"/);
  const close = markup.match(/id="remote-close"/);
  const actions = markup.match(/id="remote-stop"[\s\S]*?id="remote-ok"/);
  const dialog = markup.match(/class="modal modal-sm"([^>]*)>/);
  const closeAttrs = markup.match(/id="remote-close"([^>]*)>/);
  const bodyAttrs = markup.match(/class="modal-body"([^>]*)>/);
  const title = markup.match(/id="remote-title"/);
  assert.ok(header && body && footer && close && actions, 'header, close button, body, and both footer actions remain present');
  assert.ok(header.index < body.index && body.index < footer.index, 'sections stay in header/body/footer order');
  assert.ok(dialog && /role="dialog"/.test(dialog[1]) && /aria-modal="true"/.test(dialog[1]) && /aria-labelledby="remote-title"/.test(dialog[1]));
  assert.ok(closeAttrs && /aria-label=/.test(closeAttrs[1]) && /title=/.test(closeAttrs[1]));
  assert.ok(bodyAttrs && /tabindex="0"/.test(bodyAttrs[1]) && /role="region"/.test(bodyAttrs[1]) && title);

  // Check layout intent by declarations, without pinning spacing, colors, or a complete CSS rule.
  const modalLayout = styles.match(/#remote-overlay\s+\.modal\s*\{([^}]*)\}/)?.[1] ?? '';
  const bodyLayout = styles.match(/#remote-overlay\s+\.modal-body\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(modalLayout, /display\s*:\s*(?:flex|grid)/);
  assert.match(modalLayout, /flex-direction\s*:\s*column|grid-template-rows\s*:/);
  assert.match(modalLayout, /max-height\s*:\s*100%/);
  assert.match(modalLayout, /min-height\s*:\s*0/);
  assert.match(modalLayout, /overflow\s*:\s*hidden/);
  const fixedSections = styles.match(/#remote-overlay\s+\.modal-header\s*,\s*#remote-overlay\s+\.modal-footer\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(fixedSections, /flex\s*:\s*0\s+0\s+auto/);
  assert.match(bodyLayout, /overflow(?:-y)?\s*:\s*(?:auto|scroll)/);
  assert.match(bodyLayout, /min-height\s*:\s*0/);
});

test('remote modal fixture is driven by the real overlay and stylesheet', () => {
  const fixture = readFileSync(new URL('./remote-modal-fixture.html', import.meta.url), 'utf8');
  assert.match(fixture, /fetch\(['"]\.\.\/src\/index\.html/);
  assert.match(fixture, /href=\\?['"]src\/styles\.css/);
  assert.match(fixture, /remote-overlay/);
  assert.match(fixture, /height|zoom|theme/i);
  assert.match(fixture, /123456.*Synthetic fixture value only/);
  assert.match(fixture, /<body style="zoom:\$\{zoom\}">/);
  assert.doesNotMatch(fixture, /\.modal-wrap\s*\{/);
  assert.match(fixture, /复制地址/);
  assert.match(fixture, /kind-other/);
  assert.match(fixture, /<svg[\s\S]*?<rect/);
});
