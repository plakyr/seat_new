import { useEffect, useRef, useState } from 'react';
import { AnnouncementState } from '../store/useStore';

interface Props {
  announcement: AnnouncementState;
  currentTurnOrder: number;
  currentTurnStartTime: string | null;
  serverTime: string | null;
  isFrozen: boolean;
  frozenReason: string | null;
  participants: any[];
  timerPaused: boolean;
}

export default function AnnouncementBar({
  announcement,
  currentTurnOrder,
  currentTurnStartTime,
  serverTime,
  isFrozen,
  frozenReason,
  participants,
  timerPaused,
}: Props) {
  const [timeLeft, setTimeLeft] = useState<string>('03:00');
  const [timeLeftMs, setTimeLeftMs] = useState<number>(3 * 60 * 1000);
  // 클라이언트 기준 시작 시각 보정값 (서버 시간 - 클라이언트 시간)
  const offsetRef = useRef<number>(0);
  const offsetInitialized = useRef<boolean>(false);

  // 그룹 시작 전 카운트다운 오버레이 상태 (null = 표시 안 함)
  const [countdown, setCountdown] = useState<{ kind: 'intro' | 'num'; n?: number } | null>(null);

  useEffect(() => {
    if (!serverTime) return;
    const candidate = new Date(serverTime).getTime() - Date.now();
    // 최초 동기화는 즉시 반영. 이후에는 네트워크 지터로 인한 잦은 점프를 막기 위해
    // 보정값이 크게(1.5초 초과) 어긋났을 때만 갱신한다. (실제 시계 드리프트만 보정)
    if (!offsetInitialized.current || Math.abs(candidate - offsetRef.current) > 1500) {
      offsetRef.current = candidate;
      offsetInitialized.current = true;
    }
  }, [serverTime]);

  useEffect(() => {
    if (!currentTurnStartTime) return;

    const update = () => {
      if (timerPaused) return; // 자동배정 중 멈춤
      const now = Date.now() + offsetRef.current;
      const start = new Date(currentTurnStartTime).getTime();
      const end = start + 3 * 60 * 1000;
      // 시계 오차로 인해 3:00을 초과해 표시되지 않도록 상한 고정
      const diff = Math.min(end - now, 3 * 60 * 1000);
      if (diff <= 0) {
        setTimeLeft('00:00');
        setTimeLeftMs(0);
      } else {
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        setTimeLeft(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
        setTimeLeftMs(diff);
      }
    };

    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [currentTurnStartTime, timerPaused]);

  // ── 그룹 시작 전 카운트다운 ──────────────────────────────────────────
  // 대기(SESSION_CHANGE) 상태에서 다음 그룹 시작시간(HH:MM)까지 6초 이내가 되면
  // 오버레이를 띄운다. 6~3초: 인트로 문구, 3·2·1: 큰 숫자. 서버 부하 없이 클라에서만 계산.
  const COUNTDOWN_ENABLED = true; // 끄고 싶으면 false
  const nextStartTime = announcement.nextStartTime;
  useEffect(() => {
    if (!COUNTDOWN_ENABLED || announcement.type !== 'SESSION_CHANGE' || !nextStartTime) {
      setCountdown(null);
      return;
    }
    const m = nextStartTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) { setCountdown(null); return; }
    const startSec = Number(m[1]) * 3600 + Number(m[2]) * 60;

    const tick = () => {
      // 서버 보정 시각을 Asia/Seoul 벽시계(초 단위)로 변환해 시작까지 남은 초 계산
      const nowServer = new Date(Date.now() + offsetRef.current);
      const seoul = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).format(nowServer);
      const [h, mm, s] = seoul.split(':').map(Number);
      const remaining = startSec - (h * 3600 + mm * 60 + s);
      if (remaining > 0 && remaining <= 6) {
        setCountdown(remaining > 3 ? { kind: 'intro' } : { kind: 'num', n: Math.ceil(remaining) });
      } else {
        setCountdown(null);
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [announcement.type, nextStartTime]);

  const currentParticipant = participants.find(p => p.turn_order === currentTurnOrder);

  let bgColor = '#4a6fa5';
  let text = '';
  let pulse = false;

  if (isFrozen) {
    bgColor = '#E03535';
    text = `⏸ 일시정지 중${frozenReason ? ` — ${frozenReason}` : ''}`;
    pulse = true;
  } else if (announcement.type === 'AUTO_ASSIGN') {
    bgColor = '#E8771A';
    text = '⚙️ 시스템 자동 배정 중...';
    pulse = true;
  } else if (announcement.type === 'SESSION_CHANGE') {
    bgColor = '#7253C4';
    if (announcement.prevSessionId) {
      text = announcement.nextStartTime
        ? `그룹 ${announcement.prevSessionId} 좌석지정 완료. 그룹 ${announcement.nextSessionId} 시작시간은 ${announcement.nextStartTime} 입니다.`
        : `그룹 ${announcement.prevSessionId} 좌석지정 완료. 다음 그룹을 준비 중입니다.`;
    } else {
      text = announcement.nextStartTime
        ? `그룹 ${announcement.nextSessionId} 시작시간은 ${announcement.nextStartTime} 입니다.`
        : '그룹 시작을 준비 중입니다.';
    }
  } else if (announcement.type === 'ALL_COMPLETE') {
    bgColor = '#17A85A';
    text = '모든 그룹 좌석 지정이 완료되었습니다.';
  } else if (currentParticipant) {
    bgColor = '#1C71E8';
    text = `현재 순서 '${currentParticipant.name}'님`;
  } else {
    bgColor = '#6b7590';
    text = '대기 중';
  }

  const showTimer =
    !isFrozen &&
    !timerPaused &&
    announcement.type !== 'SESSION_CHANGE' &&
    announcement.type !== 'AUTO_ASSIGN' &&
    announcement.type !== 'ALL_COMPLETE';

  // 임박(10초 이하) 여부. 같은 턴 안에서 흰색→빨간 깜빡임으로 바뀌는 이 경계가
  // 겹침/잔상이 보고된 지점이므로, 아래에서 이 값을 key로 걸어 강제로 새로 그린다.
  const isUrgent = timeLeftMs <= 10000;

  return (
    <>
      <div
        style={{ backgroundColor: bgColor }}
        className={`text-white rounded-xl px-4 py-3 mb-3 flex items-center justify-between shadow-md transition-colors duration-300 ${pulse ? 'animate-pulse' : ''}`}
      >
        {/* 모바일에서 그룹 안내처럼 긴 문구가 잘리지 않도록, 자르는 대신 2줄까지 줄바꿈되게 한다 */}
        <span className="font-bold text-base sm:text-lg leading-snug line-clamp-2 flex-1 min-w-0">{text}</span>
        {showTimer && (
          // key로 일반↔임박 전환마다 엘리먼트를 완전히 새로 그려, 이전 상태(흰 숫자)가
          // 남은 채로 새 상태(빨간 깜빡임)와 겹쳐 보이는 것을 막는다.
          <span
            key={isUrgent ? 'urgent-timer' : 'normal-timer'}
            className={`ml-4 font-mono font-bold text-xl shrink-0 tabular-nums inline-block w-[5ch] text-right ${isUrgent ? 'text-red-300 animate-pulse' : 'text-white'}`}
          >
            {timeLeft}
          </span>
        )}
      </div>

      {/* 그룹 시작 전 카운트다운 오버레이 (클릭을 막지 않도록 pointer-events-none) */}
      {countdown && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-none px-6">
          {countdown.kind === 'intro' ? (
            <div className="countdown-pop text-white text-3xl sm:text-5xl font-black text-center leading-snug">
              '그룹 {announcement.nextSessionId}'<br />곧 좌석 배정 시작합니다
            </div>
          ) : (
            <div
              key={countdown.n}
              className="countdown-pop text-white font-black tabular-nums leading-none"
              style={{ fontSize: 'min(40vw, 40vh)' }}
            >
              {countdown.n}
            </div>
          )}
        </div>
      )}
    </>
  );
}
