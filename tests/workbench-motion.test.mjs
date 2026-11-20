import assert from 'node:assert/strict';
import { test } from 'node:test';

test('closing animation cannot hide a section that has been reopened', async () => {
  const { setPanelContentVisible } = await import('../plugins/source-control-proof/panel-motion.mjs');
  const animations = [];
  const node = {
    hidden: false, inert: false,
    animate(frames) {
      let finish, fail;
      const finished = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const animation = { finished, finish, cancel: () => fail(new Error('cancelled')) };
      animations.push({ frames, animation });
      return animation;
    },
  };
  let closed = 0;
  setPanelContentVisible(node, false, { motion: true, onHidden: () => closed++ });
  assert.equal(node.inert, true);
  assert.equal(node.hidden, false);
  setPanelContentVisible(node, true, { motion: true });
  await Promise.resolve();
  assert.equal(node.hidden, false);
  assert.equal(node.inert, false);
  assert.equal(closed, 0);
  assert.equal(animations.length, 2);
  setPanelContentVisible(node, false, { motion: true, onHidden: () => closed++ });
  animations.at(-1).animation.finish();
  await Promise.resolve();
  assert.equal(node.hidden, true);
  assert.equal(closed, 1);
});

test('visibility updates immediately with reduced motion or without animation support', async () => {
  const { setPanelContentVisible } = await import('../plugins/source-control-proof/panel-motion.mjs');
  const node = { hidden: false, animate: () => assert.fail('unexpected animation') };
  setPanelContentVisible(node, false, { motion: false });
  assert.equal(node.hidden, true);
  setPanelContentVisible(node, true, { motion: false });
  assert.equal(node.hidden, false);
  assert.equal(node.inert, false);
});
