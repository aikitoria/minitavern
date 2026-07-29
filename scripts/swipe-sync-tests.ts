import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterOperationEnd, afterTreeFrame } from '../client/src/state/swipeSync.ts';

const swipe = (token: number, sourceLeafId = 10) => ({
  token,
  conversationId: 1,
  sourceLeafId,
  parentKey: 5,
  outgoingId: 6,
  dir: 1 as const,
});

// Structural frames that do not move the active leaf (for example a newly
// prepared speculative sibling) must not consume the outgoing animation.
const first = swipe(1);
assert.equal(afterTreeFrame(first, 1, 10)?.token, 1);

// The authoritative branch-changing frame consumes it immediately.
assert.equal(afterTreeFrame(first, 1, 11), null);

// A delayed fail-safe from an older A -> B operation cannot clear a newer
// A -> B operation merely because both have the same outgoing message id.
const second = swipe(2);
assert.equal(afterOperationEnd(second, 1)?.token, 2);
assert.equal(afterOperationEnd(second, 2), null);

const chatView = readFileSync(
  new URL('../client/src/components/ChatView.tsx', import.meta.url),
  'utf8',
);
assert.match(chatView, /if \(event\.repeat\) return;/);

const messageNode = readFileSync(
  new URL('../client/src/components/MessageNode.tsx', import.meta.url),
  'utf8',
);
assert.match(messageNode, /onTouchCancel=\{props\.inMap \? undefined : onTouchCancel\}/);
assert.doesNotMatch(messageNode, /onTouchCancel=\{props\.inMap \? undefined : onTouchEnd\}/);
assert.match(messageNode, /ancestorNavigationBlocked\(\)/);
assert.match(messageNode, /<Show when=\{siblings\(\)\.length > 1\}>/); // TREE-02 guard survives

console.log('swipe sync tests passed');
