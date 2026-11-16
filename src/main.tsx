import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { API_URL, peerLabel, storageGet, storageRemove, storageSet, useRoom } from './connection';
import { formatRoom, MAX_PARTICIPANTS, memberLabel, normalizeRoom, ROOM_PATTERN, type MemberView } from '../shared/protocol';
import './styles.css';

function Icon({ name }: { name: 'copy' | 'bell' | 'exit' | 'arrow' | 'close' | 'edit' }) {
  const paths = {
    copy: <><rect x="8" y="8" width="12" height="12" rx="3" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    exit: <><path d="M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M9 12h12m-4-4 4 4-4 4" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    edit: <><path d="M4 20h4l11-11-4-4L4 16v4ZM13 7l4 4" /></>,
  };
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function readRoom() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('room');
  const code = normalizeRoom(fromHash || storageGet('yn:lastRoom') || '');
  return ROOM_PATTERN.test(code) ? code : null;
}
const invitation = (room: string) => `${location.origin}${location.pathname}#room=${room}`;
const workerReady = () => navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).then(() => navigator.serviceWorker.ready);

function StatusPanel({ member, label, connected, mine = false, onRename, children }: {
  member?: MemberView; label: string; connected: boolean; mine?: boolean; onRename?: () => void; children?: React.ReactNode;
}) {
  const available = connected && (mine || member?.online);
  const value = available ? member?.choice : null;
  const text = !connected ? (mine ? '연결 끊김' : '상태 확인 중') : !member ? '상대방 기다리는 중' : !available ? '연결 끊김' : value || '선택 전';
  return <section className={`status-panel ${value?.toLowerCase() || 'neutral'} ${mine ? 'mine' : 'peer'}`} aria-label={`${label} 상태`}>
    <div className="panel-top"><span className="panel-label">{label}</span><span className="panel-actions">{mine && <button className="edit-name" type="button" onClick={onRename} disabled={!connected} aria-label="내 이름 변경" title="내 이름 변경"><Icon name="edit" /></button>}<span className={`status-dot ${available && member ? 'on' : ''}`} aria-label={available && member ? '연결됨' : '연결 안 됨'} /></span></div>
    <div className={`status-value ${!value ? 'status-text' : ''}`} data-testid={mine ? 'my-status' : 'peer-status'}>{text}</div>
    {children}
  </section>;
}

function App() {
  const [room, setRoom] = useState<string | null>(readRoom);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([]);
  const [dialog, setDialog] = useState<'leave' | 'notifications' | 'share' | 'name' | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [pushKey, setPushKey] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts(items => [...items.slice(-2), { id, text }]);
    setTimeout(() => setToasts(items => items.filter(item => item.id !== id)), 4500);
  }, []);
  const connection = useRoom(room, notify);
  const { snapshot, status, error, pending, pushOn } = connection;
  const online = status === 'connected';
  const self = snapshot?.members.find(m => m.id === snapshot.selfId);
  const peers = snapshot?.members.filter(m => m.id !== snapshot.selfId).sort((a, b) => a.slot - b.slot) || [];

  useEffect(() => { if (online && room) storageSet('yn:lastRoom', room); }, [online, room]);

  useEffect(() => {
    if (!API_URL) return;
    fetch(`${API_URL}/api/config`).then(r => r.json()).then(data => setPushKey(data.pushPublicKey || null)).catch(() => {});
    if ('serviceWorker' in navigator) workerReady().catch(() => {});
  }, []);
  useEffect(() => {
    const handler = () => { const next = readRoom(); setRoom(next); };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  // Re-register an existing browser subscription after reconnecting to this room.
  useEffect(() => {
    if (!online || !pushKey || !room || storageGet(`yn:push:${room}`) !== 'on' || !('serviceWorker' in navigator)) return;
    let current = true;
    workerReady().then(reg => reg.pushManager.getSubscription()).then(subscription => {
      if (current && subscription) connection.send({ type: 'subscribe', subscription: subscription.toJSON(), appUrl: invitation(room) });
    }).catch(() => {});
    return () => { current = false; };
  }, [online, room, pushKey]);

  function enter(code: string) {
    setFormError(''); storageSet('yn:lastRoom', code);
    history.replaceState(null, '', `#room=${code}`); setRoom(code);
  }
  async function createRoom() {
    if (!API_URL) return setFormError('배포할 서버 주소를 먼저 설정해 주세요. README의 배포 안내를 확인할 수 있습니다.');
    setBusy(true); setFormError('');
    try {
      const result = await fetch(`${API_URL}/api/rooms`, { method: 'POST', signal: AbortSignal.timeout(12_000) });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || '방을 만들지 못했습니다.');
      enter(data.code);
    } catch (e) { setFormError(e instanceof TypeError ? '서버에 연결하지 못했습니다. 연결 상태를 확인해 주세요.' : (e as Error).message); }
    finally { setBusy(false); }
  }
  function join(event: React.FormEvent) {
    event.preventDefault();
    let value = input.trim();
    try { if (value.includes('://')) value = new URLSearchParams(new URL(value).hash.slice(1)).get('room') || ''; } catch { /* Validate below. */ }
    const code = normalizeRoom(value);
    if (!ROOM_PATTERN.test(code)) return setFormError('숫자 4자리 방 코드 또는 초대 링크를 입력해 주세요.');
    if (!API_URL) return setFormError('배포할 서버 주소를 먼저 설정해 주세요.');
    enter(code);
  }
  function leave() {
    connection.send({ type: 'leave' });
    if (room) { storageRemove(`yn:token:${room}`); storageRemove(`yn:push:${room}`); }
    storageRemove('yn:lastRoom'); history.replaceState(null, '', location.pathname); setRoom(null); setDialog(null);
  }
  async function share() {
    try { await navigator.clipboard.writeText(invitation(room!)); notify('초대 링크를 복사했습니다. 상대방에게 보내 주세요.'); }
    catch { setDialog('share'); }
  }
  function saveName(event: React.FormEvent) {
    event.preventDefault();
    if ([...nameInput.trim()].length > 16) return notify('이름은 16자 이내로 입력해 주세요.');
    if (connection.send({ type: 'rename', name: nameInput.trim() })) setDialog(null);
  }
  async function togglePush() {
    if (!room) return;
    if (!pushKey || !('PushManager' in window) || !('serviceWorker' in navigator)) { setDialog('notifications'); return; }
    setPushBusy(true);
    try {
      if (pushOn) { connection.send({ type: 'unsubscribe' }); storageRemove(`yn:push:${room}`); return; }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setDialog('notifications'); return; }
      const reg = await workerReady();
      const key = Uint8Array.from(atob(pushKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const subscription = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (connection.send({ type: 'subscribe', subscription: subscription.toJSON(), appUrl: invitation(room) })) storageSet(`yn:push:${room}`, 'on');
      else notify('연결된 뒤 알림을 다시 켜 주세요.');
    } catch { notify('알림을 켜지 못했습니다. 브라우저의 알림 권한을 확인해 주세요.'); }
    finally { setPushBusy(false); }
  }

  return <main className={room ? 'app in-room' : 'app lobby'}>
    <header className="app-header">
      <a className="wordmark" href="#" onClick={e => { e.preventDefault(); if (room) setDialog('leave'); }}>YES<span>/</span>NO<i /></a>
      {room ? <>
        <button className="room-code" onClick={share} aria-label="방 코드와 초대 링크 복사">{formatRoom(room)}<Icon name="copy" /></button>
        <div className="toolbar"><span className={`connection-indicator ${online ? 'is-online' : ''}`}><i />{online ? `${snapshot?.members.filter(m => m.online).length || 1}/${MAX_PARTICIPANTS} 연결됨` : status === 'error' ? '접속 확인' : status === 'offline' ? '연결 끊김' : '연결 중'}</span>
          <button className={`icon-button ${pushOn ? 'active' : ''}`} onClick={togglePush} disabled={!online || pushBusy} aria-label={pushOn ? '알림 끄기' : '알림 켜기'} title={pushOn ? '알림 켜짐' : '알림 켜기'} aria-pressed={pushOn}><Icon name="bell" /></button>
          <button className="icon-button" onClick={() => setDialog('leave')} aria-label="방 나가기" title="방 나가기"><Icon name="exit" /></button>
        </div>
      </> : <span className="header-note">작은 신호, 확실한 연결.</span>}
    </header>

    {!room ? <div className="lobby-content">
      <div className="intro"><span className="eyebrow"><i /> TOGETHER, IN REAL TIME</span><h1>말 대신,<br /><span>YES 또는 NO.</span></h1><p>같은 마음인지, 지금 괜찮은지.<br />작은 신호 하나로 서로의 상태를 확인하세요.</p></div>
      <div className="lobby-sample" aria-hidden="true"><div className="sample-no"><span>상대방</span><strong>NO</strong></div><div className="sample-yes"><span>나</span><strong>YES</strong></div></div>
      <div className="join-card"><div className="join-card-heading"><h2>함께 시작하기</h2><span>최대 {MAX_PARTICIPANTS}명</span></div>
        <button className="primary-button create-button" onClick={createRoom} disabled={busy}>{busy ? '방 만드는 중…' : '새 방 만들기'}<Icon name="arrow" /></button>
        <div className="divider"><span>초대받으셨나요?</span></div>
        <form onSubmit={join}><label htmlFor="room-input">방 코드 또는 초대 링크</label><div className="input-row"><input id="room-input" value={input} onChange={e => setInput(e.target.value)} placeholder="방 코드를 입력하세요" autoComplete="off" spellCheck={false} /><button className="join-button" type="submit" aria-label="방 참여하기"><Icon name="arrow" /></button></div></form>
        {formError && <p className="form-error" role="alert">{formError}</p>}
        <p className="card-footnote">가입 없이, 링크 하나로 연결돼요.</p>
      </div>
      <div className="lobby-foot"><span>내 상태는 오른쪽 · 상대방은 왼쪽</span><span>iPad & Laptop</span></div>
    </div> : error || !API_URL ? <div className="connection-card"><span className="eyebrow">잠시 확인해 주세요</span><h1>{error || '연결 설정이 필요합니다.'}</h1><p>{!API_URL ? 'README의 안내에 따라 서버 주소를 설정해 주세요.' : '방 코드와 연결 상태를 확인한 뒤 다시 시도해 주세요.'}</p><div className="dialog-actions"><button className="secondary-button" onClick={leave}>시작 화면으로</button><button className="primary-button" onClick={connection.retry}>다시 연결</button></div></div> : <>
      <div className="board" aria-busy={!snapshot}>
        <div className={`peers ${peers.length > 2 ? 'many-peers' : peers.length > 1 ? 'two-peers' : ''}`} aria-label="상대방 영역">
          {peers.length ? peers.map(member => <StatusPanel key={member.id} member={member} label={peerLabel(snapshot!, member.id)} connected={online} />) : <StatusPanel label="상대방" connected={online} />}
        </div>
        <StatusPanel member={self} label={self ? memberLabel(self, '나') : '나'} connected={online} mine onRename={() => { setNameInput(self?.name || ''); setDialog('name'); }}>
          <div className="my-controls"><p>{pending ? '전달하는 중…' : online ? '나의 상태를 선택하세요' : '다시 연결되면 선택할 수 있어요'}</p><div className="choice-buttons">
            <button className="choice no-choice" onClick={() => connection.choose('NO')} disabled={!online || !!pending} aria-pressed={self?.choice === 'NO'}>NO</button>
            <button className="choice yes-choice" onClick={() => connection.choose('YES')} disabled={!online || !!pending} aria-pressed={self?.choice === 'YES'}>YES</button>
          </div></div>
        </StatusPanel>
      </div>
      <footer className="room-footer"><span><i className={online ? 'live-dot' : 'offline-dot'} />{online ? '서로의 지금을 실시간으로' : '연결을 확인하고 있어요. 잠시만 기다려 주세요.'}</span><button onClick={share}>초대 링크 복사 <Icon name="copy" /></button></footer>
    </>}

    <div className="toast-stack" role="status" aria-live="polite" aria-atomic="false">{toasts.map(t => <div className="toast" key={t.id}><span className="toast-dot" />{t.text}</div>)}</div>
    {dialog && <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setDialog(null); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={e => { if (e.key === 'Escape') setDialog(null); if (e.key === 'Tab') { const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input')]; const first = buttons[0], last = buttons[buttons.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } }}>
        <button className="dialog-close icon-button" autoFocus onClick={() => setDialog(null)} aria-label="닫기"><Icon name="close" /></button>
        <h2 id="dialog-title">{dialog === 'leave' ? '방에서 나갈까요?' : dialog === 'share' ? '함께할 사람을 초대하세요' : dialog === 'name' ? '내 이름 변경' : '상태 변경 알림'}</h2>
        {dialog === 'leave' ? <><p>내 자리가 비워집니다.<br />초대 링크로 언제든 다시 참여할 수 있어요.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDialog(null)}>계속 있기</button><button className="primary-button" onClick={leave}>나가기</button></div></> : dialog === 'share' ? <><p>아래 링크를 복사해 상대방에게 보내 주세요.</p><input className="share-input" readOnly value={invitation(room!)} onFocus={e => e.currentTarget.select()} aria-label="초대 링크" /></> : dialog === 'name' ? <form onSubmit={saveName}><p>이름을 입력하면 방에 있는 사람 모두에게 표시됩니다. 비우고 저장하면 기본 표시로 돌아갑니다.</p><label htmlFor="display-name">내 이름 (최대 16자)</label><input id="display-name" className="share-input" value={nameInput} onChange={e => setNameInput(e.target.value)} maxLength={32} autoComplete="nickname" placeholder="이름을 입력하세요" /><div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setDialog(null)}>취소</button><button type="submit" className="primary-button">저장</button></div></form> : <><p>앱을 보고 있을 때는 상대방의 변경 내용을 화면에서 바로 알려 드려요.</p><p>아이패드에서 다른 앱을 사용하는 동안에도 알림을 받으려면 Safari에서 <strong>공유 → 홈 화면에 추가</strong>한 뒤, 홈 화면의 앱을 열고 알림을 허용해 주세요.</p>{!pushKey && <p className="notification-note">현재 시스템 알림은 준비되지 않았습니다. 화면 안 알림은 사용할 수 있어요.</p>}<button className="primary-button full-width" onClick={() => setDialog(null)}>확인</button></>}
      </div>
    </div>}
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
