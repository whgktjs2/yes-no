export type Choice = 'YES' | 'NO';
export const MAX_PARTICIPANTS = 20;
export interface MemberView { id: string; slot: number; choice: Choice | null; online: boolean; name?: string }
export interface Snapshot { type: 'snapshot'; selfId: string; members: MemberView[]; revision: number }
export type ServerMessage = Snapshot
  | { type: 'changed'; memberId: string; choice: Choice; eventId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'subscribed'; enabled: boolean }
  | { type: 'pong' };
export const ROOM_PATTERN = /^\d{4}$/;
export const normalizeRoom = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
export const formatRoom = (code: string) => code;
