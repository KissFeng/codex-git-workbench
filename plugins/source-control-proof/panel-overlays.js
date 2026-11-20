let workbenchPopup = null;
let workbenchTooltip = null;
let workbenchTooltipId = 0;

function workbenchOverlayPosition(size, anchor, viewport, { point, tooltip = false } = {}) {
  const margin = 8;
  const gap = 6;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  const below = point ? point.y : anchor.bottom + gap;
  const above = (point ? point.y : anchor.top - gap) - size.height;
  const x = point ? point.x : tooltip ? (anchor.left + anchor.right - size.width) / 2 : anchor.left;
  return {
    left: Math.max(viewport.left + margin, Math.min(x, right - size.width)),
    top: Math.max(viewport.top + margin, Math.min(below + size.height > bottom && above >= viewport.top + margin ? above : below, bottom - size.height)),
  };
}

function positionWorkbenchOverlay(node, anchor, options) {
  const visible = window.visualViewport;
  const viewport = {
    left: visible?.offsetLeft ?? 0,
    top: visible?.offsetTop ?? 0,
    width: visible?.width ?? document.documentElement.clientWidth,
    height: visible?.height ?? document.documentElement.clientHeight,
  };
  node.style.setProperty('--sc-overlay-width', Math.max(1, viewport.width - 16) + 'px');
  node.style.setProperty('--sc-overlay-height', Math.max(1, viewport.height - 16) + 'px');
  const position = workbenchOverlayPosition(node.getBoundingClientRect(), anchor.getBoundingClientRect(), viewport, options);
  node.style.left = position.left + 'px';
  node.style.top = position.top + 'px';
}

function monitorWorkbenchOverlay(node, anchor, position, close) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const anchorVisible = () => anchor.isConnected && !anchor.closest('[hidden]');
  const update = () => {
    if (anchorVisible()) position();
    else close();
  };
  const observer = new MutationObserver(() => {
    if (!anchorVisible()) close();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', update, { signal });
  window.addEventListener('scroll', event => {
    if (!(event.target instanceof Node) || !node.contains(event.target)) update();
  }, { capture: true, signal });
  window.visualViewport?.addEventListener('resize', update, { signal });
  window.visualViewport?.addEventListener('scroll', update, { signal });
  return { signal, disconnect: () => { observer.disconnect(); lifecycle.abort(); } };
}

function dismissWorkbenchTooltip() {
  if (!workbenchTooltip) return;
  const { anchor, timer, node, disconnect } = workbenchTooltip;
  workbenchTooltip = null;
  clearTimeout(timer);
  disconnect?.();
  if (node) {
    node.remove();
    const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== node.id);
    if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
    else anchor.removeAttribute('aria-describedby');
  }
}

function closeWorkbenchOverlays({ restoreFocus = false } = {}) {
  dismissWorkbenchTooltip();
  if (!workbenchPopup) return;
  const { node, anchor, expanded, disconnect } = workbenchPopup;
  workbenchPopup = null;
  disconnect();
  node.remove();
  if (expanded === null) anchor.removeAttribute('aria-expanded');
  else anchor.setAttribute('aria-expanded', expanded);
  if (restoreFocus && anchor.isConnected && !anchor.closest('[hidden]')) anchor.focus({ preventScroll: true });
}

function openWorkbenchPopup(node, { anchor, event, initialFocus = node } = {}) {
  if (!anchor?.isConnected || anchor.closest('[hidden]')) return null;
  closeWorkbenchOverlays();
  node.classList.add('sc-workbench-overlay');
  const expanded = anchor.getAttribute('aria-expanded');
  if (anchor.matches('[aria-haspopup]:not([aria-haspopup=false])')) anchor.setAttribute('aria-expanded', 'true');
  const point = event?.type === 'contextmenu' && (event.clientX || event.clientY)
    ? { x: event.clientX, y: event.clientY }
    : undefined;
  const position = () => positionWorkbenchOverlay(node, anchor, { point });
  document.body.append(node);
  position();
  const { signal, disconnect } = monitorWorkbenchOverlay(node, anchor, position, closeWorkbenchOverlays);
  workbenchPopup = { node, anchor, expanded, disconnect };
  document.addEventListener('pointerdown', pointer => {
    if (!node.contains(pointer.target) && !anchor.contains(pointer.target)) closeWorkbenchOverlays({ restoreFocus: true });
  }, { capture: true, signal });
  document.addEventListener('focusin', focus => {
    if (!node.contains(focus.target)) closeWorkbenchOverlays();
  }, { signal });
  node.addEventListener('keydown', key => {
    if (key.key === 'Escape') {
      key.preventDefault();
      key.stopPropagation();
      closeWorkbenchOverlays({ restoreFocus: true });
    }
  }, { signal });
  initialFocus.focus({ preventScroll: true });
  return node;
}

function workbenchMenuTarget(items, current, key) {
  const enabled = items.filter(item => !item.disabled);
  const index = enabled.indexOf(current);
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1);
  if (key === 'ArrowDown') return enabled[(index + 1) % enabled.length];
  if (key === 'ArrowUp') return index < 0 ? enabled.at(-1) : enabled[(index - 1 + enabled.length) % enabled.length];
}

function openContextMenu(entries, { anchor, event, label = 'Actions' } = {}) {
  if (!entries.some(entry => !entry.separator)) return null;
  const menu = element('div', 'sc-context-menu');
  menu.tabIndex = -1;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  const items = [];
  let separated = false;
  for (const entry of entries) {
    if (entry.separator) {
      separated = items.length > 0;
      continue;
    }
    if (separated) {
      const divider = element('div', 'sc-menu-divider');
      divider.setAttribute('role', 'separator');
      menu.append(divider);
      separated = false;
    }
    const item = control(entry.label, () => {
      closeWorkbenchOverlays({ restoreFocus: true });
      entry.run?.(anchor);
    }, 'sc-menu-item');
    item.tabIndex = -1;
    item.disabled = !!entry.disabled;
    item.setAttribute('role', 'menuitem');
    item.addEventListener('pointerenter', () => {
      if (!item.disabled) item.focus({ preventScroll: true });
    });
    items.push(item);
    menu.append(item);
  }
  menu.addEventListener('keydown', key => {
    if (key.key === 'Tab') {
      closeWorkbenchOverlays({ restoreFocus: true });
      return;
    }
    const target = workbenchMenuTarget(items, document.activeElement, key.key);
    if (target) {
      key.preventDefault();
      target.focus();
    }
  });
  return openWorkbenchPopup(menu, { anchor, event, initialFocus: items.find(item => !item.disabled) || menu });
}

function bindContextMenu(node, getEntries, { anchor = node } = {}) {
  const open = event => {
    const entries = getEntries(event);
    if (!entries?.length) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.target.closest('button');
    openContextMenu(entries, { anchor: trigger && node.contains(trigger) ? trigger : anchor, event });
  };
  node.addEventListener('contextmenu', open);
  node.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) open(event);
  });
}

function bindTooltip(anchor, content) {
  anchor.removeAttribute('title');
  const hide = () => {
    if (workbenchTooltip?.anchor === anchor) dismissWorkbenchTooltip();
  };
  const show = () => {
    if (workbenchPopup || workbenchTooltip?.anchor === anchor) return;
    dismissWorkbenchTooltip();
    const pending = { anchor };
    workbenchTooltip = pending;
    pending.timer = setTimeout(() => {
      if (!anchor.isConnected || anchor.closest('[hidden]')) { hide(); return; }
      const value = typeof content === 'function' ? content() : content;
      const node = element('div', 'sc-workbench-overlay sc-tooltip');
      if (value instanceof Node) node.append(value);
      else if (value) node.textContent = String(value);
      else { hide(); return; }
      node.id = 'sc-tooltip-' + ++workbenchTooltipId;
      node.setAttribute('role', 'tooltip');
      const describedBy = anchor.getAttribute('aria-describedby');
      anchor.setAttribute('aria-describedby', [describedBy, node.id].filter(Boolean).join(' '));
      document.body.append(node);
      pending.node = node;
      const position = () => positionWorkbenchOverlay(node, anchor, { tooltip: true });
      position();
      const { signal, disconnect } = monitorWorkbenchOverlay(node, anchor, position, hide);
      pending.disconnect = disconnect;
      document.addEventListener('pointerdown', hide, { capture: true, signal });
    }, 350);
  };
  anchor.addEventListener('pointerenter', show);
  anchor.addEventListener('pointerleave', hide);
  anchor.addEventListener('focus', show);
  anchor.addEventListener('blur', hide);
  anchor.addEventListener('pointerdown', hide);
  anchor.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
  });
}
