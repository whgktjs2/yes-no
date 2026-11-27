import { DurableObject } from 'cloudflare:workers';
import { buildPushPayload } from '@block65/webcrypto-web-push';
import { currentMemberLabel, MAX_PARTICIPANTS, ROOM_PATTERN, type ServerMessage } from '../shared/protocol';
import { emptyRoom, joinRoom, nextOfflineEviction, reconcilePresence, setChoice, setName, validPushSubscription, type RoomState, type Member } from './state';

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ALLOWED_ORIGINS: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  RTK_ACCOUNT_ID?: string;
  RTK_APP_ID?: string;
  RTK_API_TOKEN?: string;
  RTK_VOICE_PRESET?: string;
}
interface Attachment { memberId?: string; lastSeen: number; visible: boolean; lastChange?: number }
const HEARTBEAT_TIMEOUT = 25_000;
const CHECK_INTERVAL = 5_000;
const IDLE_EXPIRY = 24 * 60 * 60 * 1000;
const json = (data: unknown, status = 200) => Response.json(data, { status });
const origins = (env: Env) => env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
const pushEnabled = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    const origin = request.headers.get('Origin');
    if (!origin || !origins(env).includes(origin)) return json({ error: '허용되지 않은 접속 주소입니다.' }, 403);
    const cors = {
      'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Room-Token', 'Vary': 'Origin', 'Cache-Control': 'no-store',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response: Response;
    if (url.pathname === '/api/config' && request.method === 'GET') {
      response = json({ pushPublicKey: pushEnabled(env) ? env.VAPID_PUBLIC_KEY : null });
    } else if (url.pathname === '/api/rooms' && request.method === 'POST') {
      response = json({ error: '빈 방 코드를 찾지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 503);
      for (let attempt = 0; attempt < 32; attempt++) {
        const code = String(1000 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9000));
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const result = await stub.fetch(new Request('https://room.internal/init', { method: 'POST' }));
        if (result.status === 409) continue;
        if (!result.ok) throw new Error('ROOM_INIT_FAILED');
        response = json({ code }, 201);
        break;
      }
    } else {
      const voice = url.pathname.match(/^\/api\/rooms\/(\d{4})\/voice$/);
      const match = url.pathname.match(/^\/api\/rooms\/(\d{4})\/socket$/);
      if (voice && request.method === 'POST') response = await env.ROOMS.get(env.ROOMS.idFromName(voice[1])).fetch(request);
      else if (!match || !ROOM_PATTERN.test(match[1]) || request.method !== 'GET') response = json({ error: '주소를 찾을 수 없습니다.' }, 404);
      else if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') response = json({ error: 'WebSocket 연결이 필요합니다.' }, 426);
      else return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
    return new Response(response.body, { status: response.status, headers });
  },
};

export class Room extends DurableObject<Env> {
  private room?: RoomState;
  private voiceCreating?: Promise<string>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get<RoomState>('room'); });
  }

  private attachment(ws: WebSocket): Attachment { return ws.deserializeAttachment() as Attachment; }
  private activeSockets() {
    return this.ctx.getWebSockets().filter(ws => ws.readyState === 1 && this.attachment(ws).lastSeen > Date.now() - HEARTBEAT_TIMEOUT);
  }
  private send(ws: WebSocket, message: ServerMessage) {
    try { ws.send(JSON.stringify(message)); } catch { /* Closed sockets are cleaned by the alarm. */ }
  }
  private fail(ws: WebSocket, code: string, message: string, close = false) {
    this.send(ws, { type: 'error', code, message });
    if (close) ws.close(4000, code);
  }
  private async save() { await this.ctx.storage.put('room', this.room!); }
  private async refreshPresence(now = Date.now()) {
    if (!this.room) return false;
    const previous = [...this.room.members];
    const onlineIds = new Set(this.activeSockets().map(ws => this.attachment(ws).memberId).filter((id): id is string => !!id));
    if (!reconcilePresence(this.room, onlineIds, now)) return false;
    if (this.room.voiceMeetingId) {
      const remaining = new Set(this.room.members.map(m => m.id));
      for (const member of previous) if (!remaining.has(member.id) && member.voice) {
        this.ctx.waitUntil(this.removeVoiceParticipant(this.room.voiceMeetingId!, member.voice.id).catch(() => {}));
      }
    }
    await this.save();
    return true;
  }
  private async schedule() {
    let next = this.ctx.getWebSockets().length ? Date.now() + CHECK_INTERVAL : (this.room?.lastActivity || Date.now()) + IDLE_EXPIRY;
    const eviction = this.room && nextOfflineEviction(this.room);
    if (eviction !== null && eviction !== undefined) next = Math.min(next, eviction);
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
  }
  private broadcast() {
    if (!this.room) return;
    const sockets = this.activeSockets();
    const online = new Set(sockets.map(ws => this.attachment(ws).memberId));
    const members = this.room.members.map(({ id, slot, choice, name, voiceJoined, voiceMuted }) => ({ id, slot, choice, name, online: online.has(id), voiceJoined: online.has(id) && !!voiceJoined, voiceMuted: !!voiceMuted }));
    for (const ws of sockets) {
      const selfId = this.attachment(ws).memberId;
      if (selfId) this.send(ws, { type: 'snapshot', selfId, members, revision: this.room.revision });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith('/voice') && request.method === 'POST') return this.voiceToken(request);
    if (path === '/init' && request.method === 'POST') {
      if (this.room) return json({ error: 'ROOM_EXISTS' }, 409);
      this.room = emptyRoom(); await this.save(); await this.schedule();
      return json({ ok: true });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ lastSeen: Date.now(), visible: true } satisfies Attachment);
    if (!this.room) this.fail(server, 'ROOM_NOT_FOUND', '방을 찾을 수 없거나 만료되었습니다.', true);
    else if (this.ctx.getWebSockets().length > MAX_PARTICIPANTS * 3) this.fail(server, 'TOO_MANY_CONNECTIONS', '잠시 후 다시 연결해 주세요.', true);
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async realtime(path: string, body: unknown) {
    const { RTK_ACCOUNT_ID: account, RTK_APP_ID: app, RTK_API_TOKEN: token } = this.env;
    if (!account || !app || !token) throw new Error('VOICE_NOT_CONFIGURED');
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/realtime/kit/${encodeURIComponent(app)}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as { success?: boolean; data?: Record<string, unknown>; errors?: Array<{ code?: number }> };
    if (!response.ok || !result.success || !result.data) {
      const operation = path === '/meetings' ? '회의 생성' : '참여자 등록';
      const code = result.errors?.[0]?.code;
      console.error('RealtimeKit API failed', { operation, status: response.status, code });
      throw new Error(`${operation} 실패: HTTP ${response.status}${code ? `, 코드 ${code}` : ''}`);
    }
    return result.data;
  }

  private async removeVoiceParticipant(meetingId: string, participantId: string) {
    const { RTK_ACCOUNT_ID: account, RTK_APP_ID: app, RTK_API_TOKEN: token } = this.env;
    if (!account || !app || !token) return;
    await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/realtime/kit/${encodeURIComponent(app)}/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(participantId)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
  }

  private async voiceToken(request: Request): Promise<Response> {
    if (!this.room) return json({ error: '방이 만료되었습니다.' }, 404);
    const token = request.headers.get('X-Room-Token');
    const member = this.room.members.find(m => m.token === token);
    const online = this.activeSockets().some(ws => this.attachment(ws).memberId === member?.id);
    if (!member || !online) return json({ error: '먼저 방에 연결해 주세요.' }, 403);
    if (!this.env.RTK_VOICE_PRESET || !this.env.RTK_API_TOKEN || !this.env.RTK_APP_ID || !this.env.RTK_ACCOUNT_ID)
      return json({ error: '음성 서비스 설정이 아직 완료되지 않았습니다.' }, 503);
    if (member.voice && member.voice.expiresAt > Date.now() + 60_000) return json({ authToken: member.voice.token });
    try {
      if (!this.room.voiceMeetingId) {
        this.voiceCreating ||= this.realtime('/meetings', { title: 'YES/NO voice room' }).then(async data => {
          if (typeof data.id !== 'string') throw new Error('VOICE_SERVICE_FAILED');
          this.room!.voiceMeetingId = data.id;
          await this.save();
          return data.id;
        }).finally(() => { this.voiceCreating = undefined; });
        await this.voiceCreating;
      }
      if (member.voice) {
        this.ctx.waitUntil(this.removeVoiceParticipant(this.room.voiceMeetingId!, member.voice.id).catch(() => {}));
        delete member.voice;
      }
      const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
      const data = await this.realtime(`/meetings/${encodeURIComponent(this.room.voiceMeetingId!)}/participants`, {
        name: member.name || `Participant ${member.slot}`, preset_name: this.env.RTK_VOICE_PRESET,
        custom_participant_id: member.id,
        token: { expires_on: new Date(expiresAt).toISOString() },
      });
      const authToken = data.token ?? data.authToken;
      if (typeof authToken !== 'string' || typeof data.id !== 'string') throw new Error('VOICE_SERVICE_FAILED');
      member.voice = { id: data.id, token: authToken, expiresAt };
      await this.save();
      return json({ authToken });
    } catch (cause) {
      const detail = cause instanceof Error && /^(회의 생성|참여자 등록) 실패: HTTP \d+/.test(cause.message)
        ? ` (${cause.message})` : '';
      return json({ error: `음성 연결을 준비하지 못했습니다${detail}. 설정과 연결을 확인해 주세요.` }, 502);
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > 4096) return this.fail(ws, 'BAD_MESSAGE', '요청이 올바르지 않습니다.', true);
    let data: Record<string, unknown>;
    try { data = JSON.parse(raw); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); }
    catch { return this.fail(ws, 'BAD_MESSAGE', '요청이 올바르지 않습니다.', true); }
    if (!this.room) return this.fail(ws, 'ROOM_NOT_FOUND', '방이 만료되었습니다.', true);
    const attachment = this.attachment(ws);
    attachment.lastSeen = Date.now();
    ws.serializeAttachment(attachment);

    if (data.type === 'hello') {
      if (attachment.memberId) return;
      if (typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)) return this.fail(ws, 'BAD_TOKEN', '다시 접속해 주세요.', true);
      if (await this.refreshPresence()) this.broadcast();
      let member: Member;
      try { member = joinRoom(this.room, data.token); }
      catch { return this.fail(ws, 'ROOM_FULL', `방이 가득 찼습니다. (${MAX_PARTICIPANTS}/${MAX_PARTICIPANTS})`, true); }
      // Detach superseded sockets first so their later close events cannot hide the new connection.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && this.attachment(other).memberId === member.id) {
          other.serializeAttachment({ lastSeen: 0, visible: false });
          other.close(4001, 'REPLACED');
        }
      }
      ws.serializeAttachment({ memberId: member.id, lastSeen: Date.now(), visible: data.visible !== false } satisfies Attachment);
      member.voiceJoined = false;
      member.voiceMuted = true;
      this.room.lastActivity = Date.now();
      reconcilePresence(this.room, new Set(this.activeSockets().map(socket => this.attachment(socket).memberId).filter((id): id is string => !!id)), Date.now());
      await this.save();
      this.broadcast();
      await this.schedule();
      return;
    }

    const member = this.room.members.find(m => m.id === attachment.memberId);
    if (!member) return this.fail(ws, 'UNAUTHORIZED', '먼저 방에 접속해 주세요.', true);
    if (data.type === 'ping' || data.type === 'visibility') {
      if (typeof data.visible === 'boolean') attachment.visible = data.visible;
      ws.serializeAttachment(attachment);
      this.send(ws, { type: 'pong' });
    } else if (data.type === 'voice' && typeof data.joined === 'boolean' && typeof data.muted === 'boolean') {
      if (data.joined && !member.voice) return this.fail(ws, 'VOICE_UNAUTHORIZED', '음성 참여 자격을 확인할 수 없습니다.');
      member.voiceJoined = data.joined;
      member.voiceMuted = data.muted;
      await this.save();
      this.broadcast();
    } else if (data.type === 'rename') {
      try {
        if (setName(this.room, member.id, data.name)) { await this.save(); this.broadcast(); }
      } catch (error) {
        this.fail(ws, 'INVALID_NAME', error instanceof Error && error.message === 'NAME_TAKEN' ? '이미 사용 중인 이름입니다.' : '이름은 16자 이내로 입력해 주세요.');
      }
    } else if (data.type === 'choice') {
      if (data.choice !== 'YES' && data.choice !== 'NO') return this.fail(ws, 'INVALID_CHOICE', 'YES 또는 NO를 선택해 주세요.');
      if (Date.now() - (attachment.lastChange || 0) < 150) return this.fail(ws, 'RATE_LIMITED', '잠시 후 다시 선택해 주세요.');
      if (!setChoice(this.room, member.id, data.choice)) { this.broadcast(); return; }
      attachment.lastChange = Date.now();
      ws.serializeAttachment(attachment);
      await this.save();
      this.broadcast();
      const eventId = `${this.room.revision}-${crypto.randomUUID()}`;
      for (const other of this.activeSockets()) {
        if (this.attachment(other).memberId !== member.id) this.send(other, { type: 'changed', memberId: member.id, choice: data.choice, eventId });
      }
      this.ctx.waitUntil(this.notifyOthers(member, eventId));
    } else if (data.type === 'subscribe') {
      if (!pushEnabled(this.env)) return this.fail(ws, 'PUSH_UNAVAILABLE', '현재 화면 안 알림을 사용할 수 있습니다.');
      if (!validPushSubscription(data.subscription) || typeof data.appUrl !== 'string' || !this.validAppUrl(data.appUrl)) {
        return this.fail(ws, 'BAD_SUBSCRIPTION', '알림 등록에 실패했습니다. 다시 시도해 주세요.');
      }
      member.push = data.subscription;
      member.appUrl = data.appUrl;
      await this.save();
      this.send(ws, { type: 'subscribed', enabled: true });
    } else if (data.type === 'unsubscribe') {
      delete member.push;
      delete member.appUrl;
      await this.save();
      this.send(ws, { type: 'subscribed', enabled: false });
    } else if (data.type === 'leave') {
      if (member.voice && this.room.voiceMeetingId) {
        this.ctx.waitUntil(this.removeVoiceParticipant(this.room.voiceMeetingId, member.voice.id).catch(() => {}));
      }
      this.room.members = this.room.members.filter(m => m.id !== member.id);
      this.room.lastActivity = Date.now();
      this.room.revision++;
      ws.serializeAttachment({ lastSeen: 0, visible: false });
      await this.save();
      ws.close(1000, 'LEFT');
      this.broadcast();
      await this.schedule();
    }
  }

  private validAppUrl(value: string) {
    try { const url = new URL(value); return value.length < 1000 && origins(this.env).includes(url.origin); } catch { return false; }
  }

  private async notifyOthers(sender: Member, eventId: string) {
    if (!this.room || !pushEnabled(this.env)) return;
    const visible = new Set(this.activeSockets().filter(ws => this.attachment(ws).visible).map(ws => this.attachment(ws).memberId));
    const members = [...this.room.members];
    await Promise.allSettled(members.filter(m => m.id !== sender.id && m.push && !visible.has(m.id)).map(async recipient => {
      const subscription = recipient.push!;
      const label = currentMemberLabel(members, sender.id, '상대방');
      const payload = await buildPushPayload({ data: JSON.stringify({ title: 'YES / NO', body: `${label}의 상태가 ${sender.choice}로 변경되었습니다.`, eventId, url: recipient.appUrl }), options: { ttl: 60 } }, subscription, {
        subject: this.env.VAPID_SUBJECT!, publicKey: this.env.VAPID_PUBLIC_KEY!, privateKey: this.env.VAPID_PRIVATE_KEY!,
      });
      const result = await fetch(subscription.endpoint, { ...payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (result.status === 404 || result.status === 410) {
        // Do not overwrite a newer subscription installed while the request was in flight.
        if (recipient.push?.endpoint === subscription.endpoint && this.room?.members.includes(recipient)) {
          delete recipient.push;
          await this.save();
        }
      }
    }));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    ws.close(code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1000);
    ws.serializeAttachment({ lastSeen: 0, visible: false });
    if (this.room) {
      this.room.lastActivity = Date.now();
      if (!await this.refreshPresence()) await this.save();
    }
    this.broadcast();
    await this.schedule();
  }
  async webSocketError(ws: WebSocket) { await this.webSocketClose(ws, 1011); }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    let expiredSocket = false;
    for (const ws of sockets) {
      if (this.attachment(ws).lastSeen < Date.now() - HEARTBEAT_TIMEOUT) {
        ws.serializeAttachment({ lastSeen: 0, visible: false });
        ws.close(4002, 'HEARTBEAT_TIMEOUT');
        expiredSocket = true;
      }
    }
    if (expiredSocket && this.room) this.room.lastActivity = Date.now();
    const changed = await this.refreshPresence();
    if (expiredSocket && this.room && !changed) await this.save();
    if (expiredSocket || changed) this.broadcast();
    if (!this.activeSockets().length && this.room && Date.now() - this.room.lastActivity >= IDLE_EXPIRY) {
      this.room = undefined;
      await this.ctx.storage.deleteAll();
      return;
    }
    if (!this.room) { await this.ctx.storage.deleteAlarm(); return; }
    await this.schedule();
  }
}
