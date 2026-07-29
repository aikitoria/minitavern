import assert from 'node:assert/strict';
import {
  applyImageProgress,
  retainPendingImageProgress,
} from '../client/src/state/imageProgressSync.ts';

const messages = {
  1: { imagePending: true },
  2: { imagePending: false },
};
const initial = { 1: { value: 2, max: 10 }, 3: { value: 9, max: 10 } };

const updated = applyImageProgress(initial, messages, 1, 3, 10);
assert.deepEqual(updated[1], { value: 3, max: 10 });

// Duplicate events must not trigger another reactive store write.
assert.equal(applyImageProgress(updated, messages, 1, 3, 10), updated);

// Late events cannot recreate progress for completed or deleted messages.
assert.equal(applyImageProgress(updated, messages, 2, 4, 10), updated);
assert.equal(applyImageProgress(updated, messages, 99, 4, 10), updated);

// An authoritative frame purges both completed and deleted message ids.
assert.deepEqual(retainPendingImageProgress(initial, messages), { 1: { value: 2, max: 10 } });
const retained = { 1: { value: 2, max: 10 } };
assert.equal(retainPendingImageProgress(retained, messages), retained);

console.log('image progress sync tests passed');
