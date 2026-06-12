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

  useEffect(() => {
    if (serverTime) {
      offsetRef.current = new Date(serverTime).getTime() - Date.now();
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
    bgColor = '#d94f4f';
    text = `⏸ 일시정지 중${frozenReason ? ` — ${frozenReason}` : ''}`;
    pulse = true;
  } else if (announcement.type === 'AUTO_ASSIGN') {
    bgColor = '#e07b2a';
    text = '⚙️ 시스템 자동 배정 중...';
    pulse = true;
  } else if (announcement.type === 'SESSION_CHANGE') {
    bgColor = '#7c5cbf';
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
    bgColor = '#3d9e6a';
    text = '모든 그룹 좌석 지정이 완료되었습니다.';
  } else if (currentParticipant) {
    bgColor = '#4a6fa5';
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
