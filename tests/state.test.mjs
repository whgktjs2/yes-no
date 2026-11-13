import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyRoom, joinRoom, setChoice, validPushSubscription } from '../worker/state.ts';

test('A room has three slots; the same credential rejoins even when full', () => {
  const room = emptyRoom();
  const first = joinRoom(room, 'first');
  joinRoom(room, 'second'); joinRoom(room, 'third');
  assert.throws(() => joinRoom(room, 'fourth'), /ROOM_FULL/);
  assert.equal(joinRoom(room, 'first').id, first.id);
  assert.equal(room.members.length, 3);
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
