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

  // 이 컴포넌트는 사용하는 쪽(User.tsx/Admin.tsx)에서 턴/공지 상태를 key로 걸어
  // 상태가 바뀔 때마다 통째로 새로 마운트한다 — 그래서 여기서는 별도 key 없이
  // 안전하게 렌더링만 하면 된다 (내부 타이머 상태까지 항상 깨끗하게 초기화됨).
  return (
    <div
      style={{ backgroundColor: bgColor }}
      className={`text-white rounded-xl px-4 py-3 mb-3 flex items-center justify-between shadow-md transition-colors duration-300 ${pulse ? 'animate-pulse' : ''}`}
    >
      <span className="font-bold text-lg truncate">{text}</span>
      {showTimer && (
        <span className={`ml-4 font-mono font-bold text-xl shrink-0 tabular-nums ${timeLeftMs <= 10000 ? 'text-red-300 animate-pulse' : ''}`}>
          {timeLeft}
        </span>
      )}
    </div>
  );
}
