const POINTER_THEMES = new Set(['sakura', 'neon-rain', 'guofeng']);

const CLICK_FX_SHAPES = {
  sakura: [
    '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.9-9.8-9.2C.7 8.9 2.2 5.5 5.3 5c2-.3 3.6.7 4.7 2.2C11.1 5.7 12.7 4.7 14.7 5c3.1.5 4.6 3.9 3.1 6.8C15.5 16.1 12 21 12 21z" fill="#ff8fbf"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 2.5c3 3.6 3 7.4 0 11-3-3.6-3-7.4 0-11z" fill="#ffc0de" transform="rotate(35 12 12)"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" fill="#fff0f8"/></svg>',
  ],
  'neon-rain': [
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="#40e0ff" stroke-width="1.5"/><circle cx="12" cy="12" r="2" fill="#b18cff"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 2C9 7 7 10.5 7 14a5 5 0 0010 0c0-3.5-2-7-5-12z" fill="none" stroke="#66a8ff" stroke-width="1.7"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18" stroke="#83efff" stroke-width="1.4"/><circle cx="12" cy="12" r="3" fill="none" stroke="#b18cff"/></svg>',
  ],
  guofeng: [
    '<svg viewBox="0 0 24 24"><path d="M12 20c-1.2-3.5-4.6-4-7-3 1-2.7 3-4.3 5.5-4.5C8.8 10 9.5 7.1 12 4c2.5 3.1 3.2 6 1.5 8.5 2.5.2 4.5 1.8 5.5 4.5-2.4-1-5.8-.5-7 3z" fill="#d8aa53"/><circle cx="12" cy="13" r="2.2" fill="#b8d2c0"/></svg>',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="none" stroke="#d8aa53" stroke-width="1.2"/><circle cx="12" cy="12" r="3" fill="none" stroke="#72b3aa" stroke-width="1.2"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 3l1.5 6.5L20 12l-6.5 1.5L12 20l-1.5-6.5L4 12l6.5-2.5z" fill="#f3d590"/></svg>',
  ],
};

const POINTER_MARKUP = `
  <span class="theme-pointer-aura"></span>
  <svg class="theme-pointer-glyph theme-pointer-sakura" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M9 10l15 15" stroke="#f6b2d1" stroke-width="3" stroke-linecap="round"/>
    <path d="M8 2l1.8 5.2L15 9l-5.2 1.8L8 16l-1.8-5.2L1 9l5.2-1.8z" fill="#fff3fa" stroke="#ff8fc4" stroke-width="1"/>
  </svg>
  <svg class="theme-pointer-glyph theme-pointer-neon" viewBox="0 0 32 32" aria-hidden="true">
    <circle cx="16" cy="16" r="9" fill="none" stroke="#40e0ff" stroke-width="1.5"/>
    <circle cx="16" cy="16" r="2.5" fill="#d9ccff"/>
    <path d="M16 2v7M16 23v7M2 16h7M23 16h7" stroke="#8b5cf6" stroke-width="1.5" stroke-linecap="round"/>
  </svg>
  <svg class="theme-pointer-glyph theme-pointer-guofeng" viewBox="0 0 32 32" aria-hidden="true">
    <path d="M14 15l13 13" stroke="#d8aa53" stroke-width="2.4" stroke-linecap="round"/>
    <path d="M10 3c2.2 3 5.6 3.7 8 3.2-1 2.8-3 4.8-6 5.3.3 2.4-.5 4.7-2.6 6.5-1.7-2.3-1.8-4.8-.6-7-2.5-.4-4.5-2-5.8-4.6 2.6.2 5.2-.6 7-3.4z" fill="#b8d2c0" stroke="#d8aa53" stroke-width="1"/>
    <circle cx="10.5" cy="9.5" r="2" fill="#cf665b"/>
  </svg>`;

export function normalizeThemePointer(theme) {
  return POINTER_THEMES.has(theme) ? theme : '';
}

function removeLater(element, delay, setTimer) {
  setTimer(() => element.remove(), delay);
}

export function installThemePointer(dock, environment = {}) {
  const doc = environment.document || document;
  const view = environment.window || window;
  const setTimer = environment.setTimeout || setTimeout;
  const random = environment.random || Math.random;
  const now = environment.now || (() => performance.now());
  const requestFrame = environment.requestAnimationFrame
    || view.requestAnimationFrame?.bind(view)
    || (callback => setTimer(callback, 0));
  const reducedMotion = view.matchMedia?.('(prefers-reduced-motion: reduce)');

  if (!dock || !doc?.body) {
    return { applyTheme() {}, destroy() {} };
  }

  const pointer = doc.createElement('span');
  pointer.className = 'theme-pointer';
  pointer.setAttribute('aria-hidden', 'true');
  pointer.innerHTML = POINTER_MARKUP;
  doc.body.appendChild(pointer);

  let cursorTheme = '';
  let fxTheme = 'sakura';
  let clickFxEnabled = false;
  let framePending = false;
  let pointerX = 0;
  let pointerY = 0;
  let lastTrailAt = 0;

  const hide = () => {
    pointer.classList.remove('is-visible', 'is-down');
    dock.classList.remove('is-theme-pointer-active');
  };
  const usesNativeResizeCursor = target => dock.classList.contains('is-resizing')
    || dock.classList.contains('is-tree-resizing')
    || dock.classList.contains('is-session-rail-resizing')
    || !!target?.closest?.('.terminal-resize, .tree-splitter, .session-rail-splitter, .companion-splitter, .companion-panel');

  const renderPosition = () => {
    framePending = false;
    pointer.style.setProperty('--theme-pointer-x', `${pointerX}px`);
    pointer.style.setProperty('--theme-pointer-y', `${pointerY}px`);
  };

  const spawnTrail = (theme, x, y) => {
    const trail = doc.createElement('span');
    trail.className = `theme-pointer-trail theme-pointer-trail-${theme}`;
    trail.style.left = `${x + (random() * 8 - 4)}px`;
    trail.style.top = `${y + (random() * 8 - 4)}px`;
    trail.style.setProperty('--trail-drift', `${random() * 18 - 9}px`);
    trail.style.setProperty('--trail-rotate', `${random() * 120 - 60}deg`);
    doc.body.appendChild(trail);
    removeLater(trail, 720, setTimer);
  };

  const spawnClickFx = (theme, x, y) => {
    const shapes = CLICK_FX_SHAPES[theme] || CLICK_FX_SHAPES.sakura;
    for (let index = 0; index < 5; index++) {
      const particle = doc.createElement('span');
      particle.className = `term-fx term-fx-${theme}`;
      particle.innerHTML = shapes[(random() * shapes.length) | 0];
      const angle = random() * Math.PI * 2;
      const distance = 24 + random() * 36;
      particle.style.left = `${x}px`;
      particle.style.top = `${y}px`;
      particle.style.width = particle.style.height = `${10 + random() * 8}px`;
      particle.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
      particle.style.setProperty('--dy', `${Math.sin(angle) * distance - 22}px`);
      particle.style.setProperty('--rot', `${random() * 140 - 70}deg`);
      doc.body.appendChild(particle);
      removeLater(particle, 800, setTimer);
    }
  };

  const onPointerMove = event => {
    if ((event.pointerType && event.pointerType !== 'mouse')
      || !cursorTheme
      || usesNativeResizeCursor(event.target)) {
      hide();
      return;
    }

    pointerX = event.clientX;
    pointerY = event.clientY;
    dock.classList.add('is-theme-pointer-active');
    pointer.classList.add('is-visible');
    if (!framePending) {
      framePending = true;
      requestFrame(renderPosition);
    }

    const time = now();
    if (!reducedMotion?.matches && time - lastTrailAt >= 46) {
      lastTrailAt = time;
      spawnTrail(cursorTheme, pointerX, pointerY);
    }
  };

  const onPointerDown = event => {
    if ((event.pointerType && event.pointerType !== 'mouse')
      || event.button !== 0
      || usesNativeResizeCursor(event.target)) {
      hide();
      return;
    }
    if (cursorTheme) {
      dock.classList.add('is-theme-pointer-active');
      pointer.classList.add('is-down');
    }
    if (clickFxEnabled && !reducedMotion?.matches) {
      spawnClickFx(fxTheme, event.clientX, event.clientY);
    }
  };
  const onPointerUp = () => pointer.classList.remove('is-down');

  dock.addEventListener('pointermove', onPointerMove);
  dock.addEventListener('pointerleave', hide);
  dock.addEventListener('pointerdown', onPointerDown);
  doc.addEventListener('pointerup', onPointerUp);
  doc.addEventListener('pointercancel', onPointerUp);
  doc.addEventListener('visibilitychange', hide);
  view.addEventListener('blur', hide);

  return {
    applyTheme({ cursor = '', clickFx = false, effect = '' } = {}) {
      cursorTheme = normalizeThemePointer(cursor);
      fxTheme = normalizeThemePointer(effect) || cursorTheme || 'sakura';
      clickFxEnabled = !!clickFx;
      if (cursorTheme) {
        dock.dataset.cursorFx = cursorTheme;
        pointer.dataset.theme = cursorTheme;
      } else {
        delete dock.dataset.cursorFx;
        delete pointer.dataset.theme;
        hide();
      }
    },
    hide,
    destroy() {
      dock.removeEventListener('pointermove', onPointerMove);
      dock.removeEventListener('pointerleave', hide);
      dock.removeEventListener('pointerdown', onPointerDown);
      doc.removeEventListener('pointerup', onPointerUp);
      doc.removeEventListener('pointercancel', onPointerUp);
      doc.removeEventListener('visibilitychange', hide);
      view.removeEventListener('blur', hide);
      delete dock.dataset.cursorFx;
      dock.classList.remove('is-theme-pointer-active');
      pointer.remove();
    },
  };
}
