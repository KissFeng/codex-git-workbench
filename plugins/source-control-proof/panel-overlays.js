let workbenchPopup = null;
let workbenchTooltip = null;
let workbenchTooltipId = 0;

function workbenchOverlayPosition(size, anchor, viewport, { point, tooltip = false, placement } = {}) {
  const margin = 8;
  const gap = 6;
  const right = viewport.left + viewport.width - margin;
  const bottom = viewport.top + viewport.height - margin;
  if (placement === 'side') {
    const side = anchor.right + gap + size.width <= right ? anchor.right + gap
      : anchor.left - gap - size.width >= viewport.left + margin ? anchor.left - gap - size.width : null;
    if (side !== null) return {
      left: side,
      top: Math.max(viewport.top + margin, Math.min(anchor.top, bottom - size.height)),
    };
  }
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
  const bounds = anchor.getBoundingClientRect();
  const right = viewport.left + viewport.width - bounds.right - 14;
  const left = bounds.left - viewport.left - 14;
  const sideWidth = options?.placement === 'side' && (right >= 260 ? right : left >= 260 ? left : 0);
  node.style.setProperty('--sc-overlay-width', Math.max(1, sideWidth || viewport.width - 16) + 'px');
  node.style.setProperty('--sc-overlay-height', Math.max(1, viewport.height - 16) + 'px');
  const position = workbenchOverlayPosition(node.getBoundingClientRect(), bounds, viewport, options);
  node.style.left = position.left + 'px';
  node.style.top = position.top + 'px';
}

function monitorWorkbenchOverlay(node, anchor, position, close) {
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  const anchorVisible = () => anchor.isConnected && !anchor.closest('[hidden], [inert]');
  const update = () => {
    if (anchorVisible()) position();
    else close();
  };
  const observer = new MutationObserver(() => {
    if (!anchorVisible()) close();
  });
  const overlayResize = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  overlayResize?.observe(node);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', update, { signal });
  window.addEventListener('scroll', event => {
    if (!(event.target instanceof Node) || !node.contains(event.target)) update();
  }, { capture: true, signal });
  window.visualViewport?.addEventListener('resize', update, { signal });
  window.visualViewport?.addEventListener('scroll', update, { signal });
  return { signal, disconnect: () => { observer.disconnect(); overlayResize?.disconnect(); lifecycle.abort(); } };
}

function dismissWorkbenchTooltip() {
  if (!workbenchTooltip) return;
  const { anchor, timer, leaveTimer, node, disconnect, attribute } = workbenchTooltip;
  workbenchTooltip = null;
  clearTimeout(timer);
  clearTimeout(leaveTimer);
  disconnect?.();
  if (node) {
    node.remove();
    const ids = (anchor.getAttribute(attribute) || '').split(/\s+/).filter(id => id && id !== node.id);
    if (ids.length) anchor.setAttribute(attribute, ids.join(' '));
    else anchor.removeAttribute(attribute);
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
  uiAttr(menu, 'aria-label', msg(label));
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
    const item = control(entry.rawLabel ? entry.label : msg(entry.label), () => {
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

function bindTooltip(anchor, content, { interactive = false, placement } = {}) {
  anchor.removeAttribute('title');
  const attribute = interactive ? 'aria-details' : 'aria-describedby';
  let returningFocus = false, deferredShow;
  const current = () => workbenchTooltip?.anchor === anchor ? workbenchTooltip : null;
  const hide = () => { if (current()) dismissWorkbenchTooltip(); };
  const hold = () => {
    const pending = current();
    if (!pending) return;
    clearTimeout(pending.leaveTimer);
    pending.leaveTimer = null;
  };
  const leave = (event, pointer = false) => {
    clearTimeout(deferredShow);
    const pending = current();
    const card = pending?.node;
    if (!interactive || !card) return hide();
    const target = event.relatedTarget;
    if (target instanceof Node && (anchor.contains(target) || card.contains(target))) return;
    if (pointer && card.contains(document.activeElement)) return;
    hold();
    pending.leaveTimer = setTimeout(hide, 180);
  };
  const show = () => {
    if (returningFocus || workbenchPopup) return;
    if (current()) return hold();
    const previous = workbenchTooltip;
    // An open card may be several pixels away from its row. Keep its grace
    // period intact if the pointer briefly crosses the next row on the way.
    if (previous?.node && previous.attribute === 'aria-details' && previous.leaveTimer) {
      clearTimeout(deferredShow);
      deferredShow = setTimeout(() => {
        if (anchor.isConnected && (anchor.matches(':hover') || document.activeElement === anchor)) show();
      }, 185);
      return;
    }
    dismissWorkbenchTooltip();
    const pending = { anchor, attribute };
    workbenchTooltip = pending;
    pending.timer = setTimeout(() => {
      if (!anchor.isConnected || anchor.closest('[hidden], [inert]')) { hide(); return; }
      const value = typeof content === 'function' ? content() : content;
      const node = element('div', 'sc-workbench-overlay ' + (interactive ? 'sc-commit-popover' : 'sc-tooltip'));
      if (value instanceof Node) node.append(value);
      else if (value) uiText(node, value);
      else { hide(); return; }
      node.id = 'sc-tooltip-' + ++workbenchTooltipId;
      node.setAttribute('role', interactive ? 'dialog' : 'tooltip');
      if (interactive) {
        uiAttr(node, 'aria-label', msg('Commit information'));
        node.addEventListener('pointerenter', hold);
        node.addEventListener('pointerleave', event => leave(event, true));
        node.addEventListener('focusin', hold);
        node.addEventListener('focusout', leave);
        node.addEventListener('keydown', event => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          returningFocus = true;
          hide();
          anchor.focus({ preventScroll: true });
          returningFocus = false;
        });
      }
      const describedBy = anchor.getAttribute(attribute);
      anchor.setAttribute(attribute, [describedBy, node.id].filter(Boolean).join(' '));
      document.body.append(node);
      pending.node = node;
      const position = () => positionWorkbenchOverlay(node, anchor, { tooltip: true, placement });
      position();
      const { signal, disconnect } = monitorWorkbenchOverlay(node, anchor, position, hide);
      pending.disconnect = disconnect;
      document.addEventListener('pointerdown', event => {
        if (!interactive || !node.contains(event.target)) hide();
      }, { capture: true, signal });
    }, 350);
  };
  anchor.addEventListener('pointerenter', show);
  anchor.addEventListener('pointerleave', event => leave(event, true));
  anchor.addEventListener('focus', show);
  anchor.addEventListener('blur', leave);
  anchor.addEventListener('pointerdown', hide);
  anchor.addEventListener('keydown', event => {
    if (event.key === 'Escape') hide();
    if (interactive && event.key === 'Tab' && !event.shiftKey) {
      const first = current()?.node?.querySelector('button:not(:disabled), a[href], [tabindex="0"]');
      if (!first) return;
      event.preventDefault();
      first.focus();
    }
  });
}
