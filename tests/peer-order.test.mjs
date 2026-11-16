import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyPeerOrder, nextDemotionAt, reconcilePeerOrder } from '../src/peer-order.ts';

const member = (id, slot, choice = null, online = true) => ({ id, slot, choice, online });
const snapshot = (...members) => ({ type: 'snapshot', selfId: 'me', members: [member('me', 1), ...members], revision: 0 });
const sync = (state, members, now) => reconcilePeerOrder(state, '1234', snapshot(...members), now);

test('A YES/NO change moves its peer to the top without renumbering anyone', () => {
  let state = sync(emptyPeerOrder(), [member('a', 2), member('b', 3), member('c', 4)], 0);
  assert.deepEqual(state.order, ['a', 'b', 'c']);
  state = sync(state, [member('a', 2), member('b', 3, 'YES'), member('c', 4)], 100);
  assert.deepEqual(state.order, ['b', 'a', 'c']);
  state = sync(state, [member('a', 2, 'NO'), member('b', 3, 'YES'), member('c', 4)], 200);
  assert.deepEqual(state.order, ['a', 'b', 'c']);
  state = sync(state, [member('a', 2, 'NO'), member('b', 3, 'YES'), member('c', 4)], 300);
  assert.deepEqual(state.order, ['a', 'b', 'c']);
});

test('Disconnected peers move down once after ten seconds, even when several disconnect', () => {
  let state = sync(emptyPeerOrder(), [member('a', 2), member('b', 3), member('c', 4), member('d', 5)], 0);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4), member('d', 5)], 100);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false), member('d', 5)], 200);
  assert.equal(nextDemotionAt(state), 10_100);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false), member('d', 5)], 10_099);
  assert.deepEqual(state.order, ['a', 'b', 'c', 'd']);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false), member('d', 5)], 10_100);
  assert.deepEqual(state.order, ['b', 'c', 'd', 'a']);
  assert.equal(nextDemotionAt(state), 10_200);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false), member('d', 5)], 10_200);
  assert.deepEqual(state.order, ['b', 'd', 'a', 'c']);
  assert.equal(nextDemotionAt(state), null);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false), member('d', 5)], 30_000);
  assert.deepEqual(state.order, ['b', 'd', 'a', 'c']);
});

test('Reconnection leaves a peer behind active peers until YES/NO changes', () => {
  let state = sync(emptyPeerOrder(), [member('a', 2), member('b', 3), member('c', 4)], 0);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false)], 100);
  state = sync(state, [member('a', 2, null, false), member('b', 3), member('c', 4, null, false)], 10_100);
  assert.deepEqual(state.order, ['b', 'a', 'c']);
  state = sync(state, [member('a', 2), member('b', 3), member('c', 4, null, false)], 11_000);
  assert.deepEqual(state.order, ['b', 'a', 'c']);
  state = sync(state, [member('a', 2, 'YES'), member('b', 3), member('c', 4, null, false)], 12_000);
  assert.deepEqual(state.order, ['a', 'b', 'c']);
});

test('A new peer joins ahead of disconnected peers and a departed peer is removed', () => {
  let state = sync(emptyPeerOrder(), [member('a', 2), member('b', 3, null, false)], 0);
  state = sync(state, [member('a', 2), member('b', 3, null, false)], 10_000);
  state = sync(state, [member('a', 2), member('b', 3, null, false), member('c', 4)], 10_100);
  assert.deepEqual(state.order, ['a', 'c', 'b']);
  state = sync(state, [member('c', 4), member('b', 3, null, false)], 10_200);
  assert.deepEqual(state.order, ['c', 'b']);
});
