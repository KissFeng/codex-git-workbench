const panelContentAnimations = new WeakMap();

function panelMotionEnabled() {
  return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const panelArrival = [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'translateY(0)' }];

function animatePanelArrival(node) {
  if (panelMotionEnabled()) node.animate?.(panelArrival, { duration: 150, easing: 'cubic-bezier(.2,.7,.2,1)' });
}

export function setPanelContentVisible(node, visible, { motion = panelMotionEnabled(), onHidden } = {}) {
  const previous = panelContentAnimations.get(node);
  panelContentAnimations.delete(node);
  previous?.cancel();
  const changed = node.hidden === visible || !!previous;
  node.inert = !visible;
  const hide = () => {
    node.hidden = true;
    onHidden?.();
  };
  if (visible) node.hidden = false;
  if (!motion || !changed || typeof node.animate !== 'function') {
    if (!visible) hide();
    return;
  }
  const frames = visible ? panelArrival : [...panelArrival].reverse();
  const animation = node.animate(frames, { duration: visible ? 150 : 100, easing: 'ease-out', fill: 'both' });
  panelContentAnimations.set(node, animation);
  animation.finished.then(() => {
    if (panelContentAnimations.get(node) !== animation) return;
    panelContentAnimations.delete(node);
    if (!visible) hide();
    animation.cancel();
  }, () => {});
}
