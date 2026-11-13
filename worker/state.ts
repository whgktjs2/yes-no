import type { Choice } from '../shared/protocol';

export interface Member {
  id: string; token: string; slot: number; choice: Choice | null;
  push?: { endpoint: string; keys: { auth: string; p256dh: string }; expirationTime: number | null };
  appUrl?: string;
}
export interface RoomState { members: Member[]; nextSlot: number; revision: number; lastActivity: number }
export const emptyRoom = (): RoomState => ({ members: [], nextSlot: 1, revision: 0, lastActivity: Date.now() });

export function joinRoom(state: RoomState, token: string): Member {
  const existing = state.members.find(m => m.token === token);
  if (existing) return existing;
  if (state.members.length >= 3) throw new Error('ROOM_FULL');
  const member: Member = { id: crypto.randomUUID(), token, slot: state.nextSlot++, choice: null };
  state.members.push(member);
  state.revision++;
  return member;
}

export function setChoice(state: RoomState, id: string, choice: unknown): boolean {
  if (choice !== 'YES' && choice !== 'NO') throw new Error('INVALID_CHOICE');
  const member = state.members.find(m => m.id === id);
  if (!member) throw new Error('UNAUTHORIZED');
  if (member.choice === choice) return false;
  member.choice = choice as Choice;
  state.revision++;
  state.lastActivity = Date.now();
  return true;
}

export function validPushSubscription(value: unknown): value is NonNullable<Member['push']> {
  if (!value || typeof value !== 'object') return false;
  const s = value as NonNullable<Member['push']>;
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2000) return false;
  try {
    const u = new URL(s.endpoint);
    const allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
    if (u.protocol !== 'https:' || u.port || u.username || u.password ||
      !allowed.some(host => u.hostname === host || u.hostname.endsWith('.' + host))) return false;
    return typeof s.keys?.auth === 'string' && /^[\w-]{22}$/.test(s.keys.auth) &&
      typeof s.keys.p256dh === 'string' && /^[\w-]{87}$/.test(s.keys.p256dh);
  } catch { return false; }
}
