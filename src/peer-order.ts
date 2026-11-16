import type { Choice, Snapshot } from '../shared/protocol';

const DISCONNECT_DELAY_MS = 10_000;

interface Observation { online: boolean; choice: Choice | null }
export interface PeerOrderState {
  room: string | null;
  selfId: string | null;
  order: string[];
  previous: Record<string, Observation>;
  offlineSince: Record<string, number>;
  demoted: string[];
}

export const emptyPeerOrder = (): PeerOrderState => ({
  room: null, selfId: null, order: [], previous: {}, offlineSince: {}, demoted: [],
});

export function reconcilePeerOrder(state: PeerOrderState, room: string | null, snapshot: Snapshot | null, now: number): PeerOrderState {
  if (!room) return emptyPeerOrder();
  if (!snapshot) return state.room === room ? state : { ...emptyPeerOrder(), room };

  const peers = snapshot.members.filter(member => member.id !== snapshot.selfId).sort((a, b) => a.slot - b.slot);
  if (state.room !== room || state.selfId !== snapshot.selfId) {
    return {
      room, selfId: snapshot.selfId, order: peers.map(member => member.id),
      previous: Object.fromEntries(peers.map(member => [member.id, { online: member.online, choice: member.choice }])),
      offlineSince: Object.fromEntries(peers.filter(member => !member.online).map(member => [member.id, now])),
      demoted: [],
    };
  }

  const byId = new Map(peers.map(member => [member.id, member]));
  let order = state.order.filter(id => byId.has(id));
  let demoted = state.demoted.filter(id => byId.has(id));
  const offlineSince = Object.fromEntries(Object.entries(state.offlineSince).filter(([id]) => byId.has(id)));
  const previous: Record<string, Observation> = {};

  const moveBeforeOffline = (id: string) => {
    order = order.filter(item => item !== id);
    const firstOffline = order.findIndex(item => demoted.includes(item));
    order.splice(firstOffline < 0 ? order.length : firstOffline, 0, id);
  };

  for (const member of peers) {
    const prior = state.previous[member.id];
    if (!order.includes(member.id)) moveBeforeOffline(member.id);

    if (member.online) {
      delete offlineSince[member.id];
      if (demoted.includes(member.id)) {
        demoted = demoted.filter(id => id !== member.id);
        moveBeforeOffline(member.id);
      }
      if (prior && prior.choice !== member.choice) {
        order = [member.id, ...order.filter(id => id !== member.id)];
      }
    } else if (!prior || prior.online) {
      offlineSince[member.id] = now;
    }
    previous[member.id] = { online: member.online, choice: member.choice };
  }

  for (const id of [...order]) {
    const since = offlineSince[id];
    if (!byId.get(id)?.online && since !== undefined && now - since >= DISCONNECT_DELAY_MS && !demoted.includes(id)) {
      order = [...order.filter(item => item !== id), id];
      demoted.push(id);
    }
  }

  return { room, selfId: snapshot.selfId, order, previous, offlineSince, demoted };
}

export function nextDemotionAt(state: PeerOrderState): number | null {
  const pending = Object.entries(state.offlineSince).filter(([id]) => !state.demoted.includes(id));
  return pending.length ? Math.min(...pending.map(([, since]) => since + DISCONNECT_DELAY_MS)) : null;
}
