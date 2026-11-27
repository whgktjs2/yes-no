export type Choice = 'YES' | 'NO';
export const MAX_PARTICIPANTS = 10;
export interface MemberView { id: string; slot: number; choice: Choice | null; online: boolean; name?: string; voiceJoined?: boolean; voiceMuted?: boolean }
export const memberLabel = (member: Pick<MemberView, 'slot' | 'name'>, fallback: '나' | '상대방') => `#${member.slot} ${member.name || fallback}`;
export function currentMemberLabel(members: readonly Pick<MemberView, 'id' | 'slot' | 'name'>[], memberId: string, fallback: '나' | '상대방') {
  const member = members.find(item => item.id === memberId);
  if (!member) return fallback;
  const currentNumber = members.filter(item => item.slot <= member.slot).length;
  return memberLabel({ slot: currentNumber, name: member.name }, fallback);
}
export interface Snapshot { type: 'snapshot'; selfId: string; members: MemberView[]; revision: number }
export type ServerMessage = Snapshot
  | { type: 'changed'; memberId: string; choice: Choice; eventId: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'subscribed'; enabled: boolean }
  | { type: 'voicePolicy'; enabled: boolean }
  | { type: 'pong' };
export const ROOM_PATTERN = /^\d{4}$/;
export const normalizeRoom = (value: string) => value.toUpperCase().replace(/[\s-]/g, '');
export const formatRoom = (code: string) => code;
