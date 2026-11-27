import { useState } from 'react';
import { API_URL } from './connection';

export function Admin() {
  const [password, setPassword] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const request = async (method: 'GET' | 'PUT', next?: boolean) => {
    if (!API_URL) throw new Error('서버 주소가 설정되지 않았습니다.');
    const response = await fetch(`${API_URL}/api/admin/voice`, {
      method,
      headers: { Authorization: `Bearer ${password}`, ...(method === 'PUT' ? { 'Content-Type': 'application/json' } : {}) },
      ...(method === 'PUT' ? { body: JSON.stringify({ enabled: next }) } : {}),
      cache: 'no-store',
    });
    const data = await response.json() as { enabled?: boolean; error?: string };
    if (typeof data.enabled === 'boolean') setEnabled(data.enabled);
    if (!response.ok) throw new Error(data.error || '설정을 확인하지 못했습니다.');
    return data;
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await request('GET'); setAuthenticated(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '접속에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  const toggle = async () => {
    setBusy(true); setError('');
    try { await request('PUT', !enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '변경에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  return <main className="admin-page">
    <div className="admin-card">
      <a href="#" className="admin-back">← YES / NO로 돌아가기</a>
      <h1>음성 대화 관리</h1>
      {!authenticated ? <form onSubmit={login}>
        <p>관리자 암호를 입력해 주세요.</p>
        <label htmlFor="admin-password">관리자 암호</label>
        <input id="admin-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="off" required />
        <button type="submit" disabled={busy}>{busy ? '확인 중…' : '관리 화면 열기'}</button>
      </form> : <>
        <p className="admin-state">현재 모든 방의 음성 대화: <strong>{enabled ? '켜짐' : '꺼짐'}</strong></p>
        <p>끄면 새 음성 참여가 차단되고, 진행 중인 음성 회의도 종료됩니다. YES/NO 상태 기능은 계속 사용할 수 있습니다.</p>
        <button type="button" onClick={toggle} disabled={busy}>{busy ? '변경 중…' : enabled ? '모든 방의 음성 끄기' : '모든 방의 음성 켜기'}</button>
        <button type="button" className="admin-logout" onClick={() => { setPassword(''); setAuthenticated(false); setError(''); }}>관리 화면 닫기</button>
      </>}
      {error && <p role="alert" className="admin-error">{error}</p>}
    </div>
  </main>;
}
