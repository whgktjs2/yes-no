import { useCallback, useEffect, useRef, useState } from 'react';
import type { Choice, ServerMessage, Snapshot } from '../shared/protocol';

export const API_URL = (import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '')).replace(/\/$/, '');
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';
export function storageGet(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
export function storageSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Session still works without persistence. */ } }
export function storageRemove(key: string) { try { localStorage.removeItem(key); } catch { /* Ignore unavailable storage. */ } }
const sessionTokens = new Map<string, string>();
function tokenFor(room: string) {
  const key = `yn:token:${room}`;
  let token = storageGet(key) || sessionTokens.get(key);
  if (!token) { token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join(''); storageSet(key, token); sessionTokens.set(key, token); }
  return token;
}
export const peerLabel = (snapshot: Snapshot, memberId: string) => {
  const peers = snapshot.members.filter(m => m.id !== snapshot.selfId).sort((a, b) => a.slot - b.slot);
  return peers.length > 1 ? `상대방 ${peers.findIndex(m => m.id === memberId) + 1}` : '상대방';
};

export function useRoom(room: string | null, notify: (text: string) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Choice | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const latest = useRef<Snapshot | null>(null);
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    if (!room || !API_URL) return;
    let stopped = false, fatal = false, failures = 0, lastReceived = Date.now();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const seen = new Set<string>();
    latest.current = null;
    setSnapshot(null); setError(''); setPending(null); setPushOn(false);
    const connect = () => {
      if (stopped || fatal) return;
      if (!navigator.onLine) { setStatus('offline'); return; }
      setStatus(failures ? 'reconnecting' : 'connecting');
      const url = new URL(`${API_URL}/api/rooms/${room}/socket`);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(url);
      wsRef.current = ws;
      lastReceived = Date.now();
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: tokenFor(room), visible: !document.hidden }));
      ws.onmessage = event => {
        if (stopped || ws !== wsRef.current) return;
        lastReceived = Date.now();
        let message: ServerMessage;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'snapshot') {
          latest.current = message;
          setSnapshot(message); setStatus('connected'); setError(''); setPending(null); failures = 0;
        } else if (message.type === 'changed' && latest.current && !seen.has(message.eventId)) {
          seen.add(message.eventId);
          if (seen.size > 100) seen.delete(seen.values().next().value!);
          notifyRef.current(`${peerLabel(latest.current, message.memberId)}의 상태가 ${message.choice}로 변경되었습니다.`);
        } else if (message.type === 'error') {
          setPending(null);
          if (['ROOM_FULL', 'ROOM_NOT_FOUND', 'BAD_TOKEN', 'UNAUTHORIZED', 'TOO_MANY_CONNECTIONS'].includes(message.code)) {
            fatal = true; setError(message.message); setStatus('error');
          } else notifyRef.current(message.message);
        } else if (message.type === 'subscribed') {
          setPushOn(message.enabled);
          notifyRef.current(message.enabled ? '상대방의 변경 알림을 켰습니다.' : '시스템 알림을 껐습니다.');
        }
      };
      ws.onclose = event => {
        if (stopped || ws !== wsRef.current) return;
        setPending(null);
        if (event.code === 4001) { fatal = true; setError('같은 방을 다른 탭에서 열었습니다. 여기서 다시 연결할 수 있습니다.'); setStatus('error'); }
        if (fatal) return;
        setStatus(navigator.onLine ? 'reconnecting' : 'offline');
        failures++;
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(failures - 1, 4), 15_000));
      };
      ws.onerror = () => { /* onclose owns retry to avoid overlapping connections. */ };
    };
    const interval = setInterval(() => {
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        if (Date.now() - lastReceived > 20_000) { setStatus('reconnecting'); ws.close(); }
        else if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', visible: !document.hidden }));
      }
    }, 5000);
    const onOffline = () => { setStatus('offline'); setPending(null); wsRef.current?.close(); };
    const onOnline = () => { if (fatal) return; clearTimeout(retryTimer); if (!wsRef.current || wsRef.current.readyState > WebSocket.OPEN) connect(); };
    const onVisible = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        if (!document.hidden && Date.now() - lastReceived > 20_000) { setStatus('reconnecting'); ws.close(); }
        else ws.send(JSON.stringify({ type: 'visibility', visible: !document.hidden }));
      } else if (!document.hidden) onOnline();
    };
    window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    connect();
    return () => {
      stopped = true; clearTimeout(retryTimer); clearInterval(interval);
      window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      wsRef.current?.close(); wsRef.current = null;
    };
  }, [room, attempt]);

  const send = useCallback((message: unknown) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify(message)); return true;
  }, []);
  const choose = (choice: Choice) => {
    if (status !== 'connected' || pending) return;
    if (send({ type: 'choice', choice })) setPending(choice);
  };
  return { snapshot, status, error, pending, pushOn, send, choose, retry: () => setAttempt(n => n + 1) };
}
