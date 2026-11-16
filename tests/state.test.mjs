import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFLINE_EVICTION_MS, emptyRoom, joinRoom, nextOfflineEviction, reconcilePresence, setChoice, setName, validPushSubscription } from '../worker/state.ts';
import { MAX_PARTICIPANTS, ROOM_PATTERN, formatRoom, memberLabel, normalizeRoom } from '../shared/protocol.ts';

test('Only four digit room codes are accepted and displayed', () => {
  assert.equal(ROOM_PATTERN.test('4827'), true);
  assert.equal(ROOM_PATTERN.test('0000'), true);
  assert.equal(ROOM_PATTERN.test('ABCD1234ABCD1234'), false);
  assert.equal(ROOM_PATTERN.test('123'), false);
  assert.equal(ROOM_PATTERN.test('12345'), false);
  assert.equal(ROOM_PATTERN.test('12A4'), false);
  assert.equal(normalizeRoom(' 4827 '), '4827');
  assert.equal(formatRoom('4827'), '4827');
});

test('A display name replaces the default label while the join number stays visible', () => {
  assert.equal(memberLabel({ slot: 1 }, '나'), '#1 나');
  assert.equal(memberLabel({ slot: 1, name: 'dkd' }, '나'), '#1 dkd');
  assert.equal(memberLabel({ slot: 2, name: '고릴라' }, '상대방'), '#2 고릴라');
});

test('A room has twenty slots; the same credential rejoins even when full', () => {
  const room = emptyRoom();
  const first = joinRoom(room, 'first');
  for (let i = 1; i < MAX_PARTICIPANTS; i++) joinRoom(room, `participant-${i}`);
  assert.throws(() => joinRoom(room, 'extra'), /ROOM_FULL/);
  assert.equal(joinRoom(room, 'first').id, first.id);
  assert.equal(room.members.length, MAX_PARTICIPANTS);
});

test('A disconnected member keeps their place until ten minutes and then frees it', () => {
  const room = emptyRoom(), a = joinRoom(room, 'a'), b = joinRoom(room, 'b');
  assert.equal(reconcilePresence(room, new Set([a.id, b.id]), 100), false);
  assert.equal(reconcilePresence(room, new Set([a.id]), 200), true);
  assert.equal(b.offlineSince, 200);
  assert.equal(nextOfflineEviction(room), 200 + OFFLINE_EVICTION_MS);
  assert.equal(reconcilePresence(room, new Set([a.id]), 200 + OFFLINE_EVICTION_MS - 1), false);
  assert.equal(room.members.length, 2);
  assert.equal(reconcilePresence(room, new Set([a.id]), 200 + OFFLINE_EVICTION_MS), true);
  assert.deepEqual(room.members.map(m => m.id), [a.id]);
  assert.equal(nextOfflineEviction(room), null);
  const returned = joinRoom(room, 'b');
  assert.notEqual(returned.id, b.id);
  assert.equal(returned.slot, 3);
});

test('Reconnecting before ten minutes cancels eviction and multiple offline deadlines stay separate', () => {
  const room = emptyRoom(), a = joinRoom(room, 'a'), b = joinRoom(room, 'b'), c = joinRoom(room, 'c');
  reconcilePresence(room, new Set([a.id, c.id]), 100);
  reconcilePresence(room, new Set([a.id]), 200);
  assert.equal(nextOfflineEviction(room), 100 + OFFLINE_EVICTION_MS);
  reconcilePresence(room, new Set([a.id, b.id]), 100 + OFFLINE_EVICTION_MS - 1);
  assert.equal(b.offlineSince, undefined);
  assert.equal(nextOfflineEviction(room), 200 + OFFLINE_EVICTION_MS);
  reconcilePresence(room, new Set([a.id, b.id]), 200 + OFFLINE_EVICTION_MS);
  assert.deepEqual(room.members.map(m => m.id), [a.id, b.id]);
  assert.equal(joinRoom(room, 'b').id, b.id);
});

test('Expired disconnected seats are available to a new participant in a formerly full room', () => {
  const room = emptyRoom();
  const members = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => joinRoom(room, `p${i}`));
  reconcilePresence(room, new Set(members.slice(1).map(m => m.id)), 100);
  assert.throws(() => joinRoom(room, 'new'), /ROOM_FULL/);
  reconcilePresence(room, new Set(members.slice(1).map(m => m.id)), 100 + OFFLINE_EVICTION_MS);
  assert.equal(room.members.length, MAX_PARTICIPANTS - 1);
  assert.equal(joinRoom(room, 'new').slot, MAX_PARTICIPANTS + 1);
});

test('Names can be set, changed, reset and kept with the same room credential', () => {
  const room = emptyRoom(), a = joinRoom(room, 'a'), b = joinRoom(room, 'b');
  assert.equal(setName(room, a.id, '  민지  '), true);
  assert.equal(a.name, '민지');
  const revision = room.revision;
  assert.equal(setName(room, a.id, '민지'), false);
  assert.equal(room.revision, revision);
  assert.equal(joinRoom(room, 'a').name, '민지');
  assert.throws(() => setName(room, b.id, '민지'), /NAME_TAKEN/);
  assert.throws(() => setName(room, b.id, 'x'.repeat(17)), /INVALID_NAME/);
  assert.throws(() => setName(room, b.id, '<script>'), /INVALID_NAME/);
  assert.throws(() => setName(room, 'missing', '민수'), /UNAUTHORIZED/);
  assert.equal(setName(room, a.id, ''), true);
  assert.equal(a.name, undefined);
});
test('Changes affect only the authenticated participant and duplicate selections do not create events', () => {
  const room = emptyRoom(), a = joinRoom(room, 'a'), b = joinRoom(room, 'b');
  assert.equal(setChoice(room, a.id, 'YES'), true);
  const revision = room.revision;
  assert.equal(setChoice(room, a.id, 'YES'), false);
  assert.equal(room.revision, revision);
  assert.equal(b.choice, null);
  assert.equal(setChoice(room, b.id, 'NO'), true);
  assert.equal(a.choice, 'YES');
  assert.throws(() => setChoice(room, a.id, 'MAYBE'), /INVALID_CHOICE/);
  assert.throws(() => setChoice(room, 'unknown', 'YES'), /UNAUTHORIZED/);
});
test('A departed slot does not rename remaining members', () => {
  const room = emptyRoom(), a = joinRoom(room, 'a'), b = joinRoom(room, 'b');
  room.members = room.members.filter(m => m.id !== a.id);
  const c = joinRoom(room, 'c');
  assert.equal(b.slot, 2); assert.equal(c.slot, 3);
});
test('Push registration only permits HTTPS push services, not arbitrary server-side URLs', () => {
  const keys = { auth: 'a'.repeat(22), p256dh: 'b'.repeat(87) };
  const s = endpoint => ({ endpoint, keys, expirationTime: null });
  assert.equal(validPushSubscription(s('https://web.push.apple.com/abc')), true);
  assert.equal(validPushSubscription(s('https://fcm.googleapis.com/fcm/send/abc')), true);
  for (const endpoint of ['http://localhost/push', 'https://example.com/push', 'https://web.push.apple.com.evil.test/push', 'https://user@web.push.apple.com/push', 'https://web.push.apple.com:8443/push']) {
    assert.equal(validPushSubscription(s(endpoint)), false);
  }
  assert.equal(validPushSubscription({ endpoint: 'https://web.push.apple.com/abc', keys: {} }), false);
});
