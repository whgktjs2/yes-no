import { MAX_PARTICIPANTS, type Choice } from '../shared/protocol.ts';

export interface Member {
  id: string; token: string; slot: number; choice: Choice | null; name?: string; offlineSince?: number;
  push?: { endpoint: string; keys: { auth: string; p256dh: string }; expirationTime: number | null };
  appUrl?: string;
}
export interface RoomState { members: Member[]; nextSlot: number; revision: number; lastActivity: number }
export const emptyRoom = (): RoomState => ({ members: [], nextSlot: 1, revision: 0, lastActivity: Date.now() });
export const OFFLINE_EVICTION_MS = 10 * 60 * 1000;

export function reconcilePresence(state: RoomState, onlineIds: Set<string>, now: number): boolean {
  let changed = false;
  const remaining: Member[] = [];
  for (const member of state.members) {
    if (onlineIds.has(member.id)) {
      if (member.offlineSince !== undefined) { delete member.offlineSince; changed = true; }
      remaining.push(member);
    } else if (member.offlineSince === undefined) {
      member.offlineSince = now;
      changed = true;
      remaining.push(member);
    } else if (now - member.offlineSince >= OFFLINE_EVICTION_MS) {
      changed = true;
    } else {
      remaining.push(member);
    }
  }
  if (changed) {
    state.members = remaining;
    state.revision++;
    state.lastActivity = now;
  }
  return changed;
}

export function nextOfflineEviction(state: RoomState): number | null {
  const deadlines = state.members.flatMap(member => member.offlineSince === undefined ? [] : [member.offlineSince + OFFLINE_EVICTION_MS]);
  return deadlines.length ? Math.min(...deadlines) : null;
}

export function joinRoom(state: RoomState, token: string): Member {
  const existing = state.members.find(m => m.token === token);
  if (existing) return existing;
  if (state.members.length >= MAX_PARTICIPANTS) throw new Error('ROOM_FULL');
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

export function setName(state: RoomState, id: string, input: unknown): boolean {
  if (typeof input !== 'string') throw new Error('INVALID_NAME');
  const name = input.trim();
  if ([...name].length > 16 || /[\u0000-\u001f\u007f<>]/u.test(name)) throw new Error('INVALID_NAME');
  const member = state.members.find(m => m.id === id);
  if (!member) throw new Error('UNAUTHORIZED');
  if ((member.name || '') === name) return false;
  if (name && state.members.some(m => m.id !== id && m.name?.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('NAME_TAKEN');
  if (name) member.name = name;
  else delete member.name;
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
