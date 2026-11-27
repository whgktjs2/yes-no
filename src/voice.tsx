import { useEffect, useRef, useState } from 'react';
import RealtimeKitClient from '@cloudflare/realtimekit';
import { RtkParticipantsAudio } from '@cloudflare/realtimekit-react-ui';
import { API_URL, tokenFor } from './connection';

type Meeting = Awaited<ReturnType<typeof RealtimeKitClient.init>>;

function VoiceIcon({ name }: { name: 'mic' | 'micOff' | 'leave' | 'headset' }) {
  const paths = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" /></>,
    micOff: <><path d="m4 4 16 16M9.2 5.2A3 3 0 0 1 15 6v5c0 .5-.1 1-.3 1.4M6 11a6 6 0 0 0 10.5 4M12 18v3M9 21h6" /></>,
    leave: <><path d="M14 5h5v14h-5M10 8l-4 4 4 4M6 12h10" /></>,
    headset: <><path d="M4 13v-2a8 8 0 0 1 16 0v2M4 13h3v6H5a1 1 0 0 1-1-1v-5ZM20 13h-3v6h2a1 1 0 0 0 1-1v-5Z" /></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export function VoiceControls({ room, connected, enabled, selfId, send, onSpeakingChange }: {
  room: string; connected: boolean; enabled: boolean; selfId: string | null;
  send: (message: unknown) => boolean; onSpeakingChange: (ids: Set<string>) => void;
}) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [status, setStatus] = useState<'idle' | 'joining' | 'joined' | 'error'>('idle');
  const [muted, setMuted] = useState(true);
  const [error, setError] = useState('');
  const meetingRef = useRef<Meeting | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const generation = useRef(0);
  const remoteSpeakers = useRef(new Set<string>());
  const localSpeaking = useRef(false);

  const updateSpeaking = () => {
    const ids = new Set(remoteSpeakers.current);
    if (localSpeaking.current && selfId) ids.add(selfId);
    onSpeakingChange(ids);
  };

  const leave = () => {
    remoteSpeakers.current.clear();
    localSpeaking.current = false;
    onSpeakingChange(new Set());
    send({ type: 'voice', joined: false, muted: true });
    generation.current++;
    const current = meetingRef.current;
    meetingRef.current = null;
    setMeeting(null);
    setMuted(true);
    setStatus('idle');
    if (current) void current.leave().catch(() => {});
  };

  useEffect(() => {
    if (!connected || !enabled) leave();
  }, [connected, enabled, room]);
  useEffect(() => () => { generation.current++; if (meetingRef.current) void meetingRef.current.leave().catch(() => {}); }, [room]);

  useEffect(() => {
    if (!meeting) return;
    const syncRemoteSpeakers = () => {
      remoteSpeakers.current = new Set(meeting.participants.active.toArray()
        .filter(participant => participant.audioEnabled)
        .map(participant => participant.customParticipantId)
        .filter((id): id is string => !!id));
      updateSpeaking();
    };
    meeting.participants.active.on('participantsUpdate', syncRemoteSpeakers);
    syncRemoteSpeakers();
    return () => {
      meeting.participants.active.off('participantsUpdate', syncRemoteSpeakers);
      remoteSpeakers.current.clear();
      updateSpeaking();
    };
  }, [meeting, selfId, onSpeakingChange]);

  useEffect(() => {
    if (!meeting || muted || !selfId || !meeting.self.audioTrack) {
      if (localSpeaking.current) { localSpeaking.current = false; updateSpeaking(); }
      return;
    }
    const context = audioContextRef.current || new AudioContext();
    audioContextRef.current = context;
    const source = context.createMediaStreamSource(new MediaStream([meeting.self.audioTrack]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let frame = 0;
    let lastSound = 0;
    let stopped = false;
    const measure = () => {
      analyser.getFloatTimeDomainData(samples);
      const level = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      if (level > 0.035) lastSound = performance.now();
      const speaking = performance.now() - lastSound < 350;
      if (speaking !== localSpeaking.current) { localSpeaking.current = speaking; updateSpeaking(); }
      frame = requestAnimationFrame(measure);
    };
    void context.resume().then(() => { if (!stopped) frame = requestAnimationFrame(measure); }).catch(() => {});
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      source.disconnect();
      void context.close();
      if (audioContextRef.current === context) audioContextRef.current = null;
      if (localSpeaking.current) { localSpeaking.current = false; updateSpeaking(); }
    };
  }, [meeting, muted, selfId, onSpeakingChange]);

  const join = async () => {
    if (!connected || !enabled || status === 'joining') return;
    const currentGeneration = ++generation.current;
    setStatus('joining');
    setError('');
    let client: Meeting | null = null;
    try {
      const response = await fetch(`${API_URL}/api/rooms/${room}/voice`, {
        method: 'POST', headers: { 'X-Room-Token': tokenFor(room) }, signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json() as { authToken?: string; error?: string };
      if (!response.ok || !data.authToken) throw new Error(data.error || '음성 참여 토큰을 받지 못했습니다.');
      client = await RealtimeKitClient.init({ authToken: data.authToken,
        defaults: { audio: false, video: false, autoSwitchAudioDevice: true } });
      if (generation.current !== currentGeneration) { await client.leave().catch(() => {}); return; }
      await client.join();
      if (generation.current !== currentGeneration) { await client.leave().catch(() => {}); return; }
      await client.self.disableAudio();
      meetingRef.current = client;
      setMeeting(client);
      setMuted(true);
      setStatus('joined');
      send({ type: 'voice', joined: true, muted: true });
    } catch (cause) {
      if (client) await client.leave().catch(() => {});
      if (generation.current !== currentGeneration) return;
      setError(cause instanceof Error ? cause.message : '음성 연결에 실패했습니다.');
      setStatus('error');
    }
  };

  const toggleMic = async () => {
    const client = meetingRef.current;
    if (!client) return;
    try {
      if (muted && !audioContextRef.current) {
        audioContextRef.current = new AudioContext();
        void audioContextRef.current.resume().catch(() => {});
      }
      if (muted) await client.self.enableAudio();
      else await client.self.disableAudio();
      setMuted(!client.self.audioEnabled);
      send({ type: 'voice', joined: true, muted: !client.self.audioEnabled });
      setError('');
    } catch {
      if (muted && audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }
      setError('마이크를 사용할 수 없습니다. 브라우저 권한과 이어폰 연결을 확인해 주세요.');
    }
  };

  return <div className="voice-controls" aria-label="음성 대화">
    {meeting && <RtkParticipantsAudio meeting={meeting} />}
    {!enabled ? <span className="voice-state voice-disabled"><i />음성 사용 중지</span> : status === 'joined' ? <>
      <span className="voice-state voice-connected"><i />음성 연결됨</span>
      <button className={`voice-button mic-button ${muted ? '' : 'mic-active'}`} type="button" onClick={toggleMic} aria-pressed={!muted}>
        <VoiceIcon name={muted ? 'mic' : 'micOff'} /><span>{muted ? '마이크 켜기' : '마이크 끄기'}</span>
      </button>
      <button className="voice-button leave-voice" type="button" onClick={leave}>
        <VoiceIcon name="leave" /><span>나가기</span>
      </button>
    </> : <button className="voice-button join-voice" type="button" onClick={join} disabled={!connected || status === 'joining'}>
      <VoiceIcon name="headset" /><span>{status === 'joining' ? '연결 중…' : status === 'error' ? '다시 연결' : '음성 참여'}</span>
    </button>}
    {error && <span className="voice-error" role="alert"><strong>음성 연결 오류</strong>{error}</span>}
  </div>;
}
