import { useEffect, useState } from 'react';
import { AnnouncementState } from '../store/useStore';

interface Props {
  announcement: AnnouncementState;
  currentTurnOrder: number;
  currentTurnStartTime: string | null;
  serverTime: string | null;
  isFrozen: boolean;
  frozenReason: string | null;
  participants: any[];
}

export default function AnnouncementBar({
  announcement,
  currentTurnOrder,
  currentTurnStartTime,
  serverTime,
  isFrozen,
  frozenReason,
  participants,
}: Props) {
  const [timeLeft, setTimeLeft] = useState<string>('');

  useEffect(() => {
    if (!currentTurnStartTime) return;

    const update = () => {
      const now = serverTime ? new Date(serverTime).getTime() + (Date.now() - Date.now()) : Date.now();
      const start = new Date(currentTurnStartTime).getTime();
      const end = start + 3 * 60 * 1000;
      const diff = end - Date.now();
      if (diff <= 0) {
        setTimeLeft('00:00');
      } else {
        const m = Math.floor(diff / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        setTimeLeft(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
      }
    };

    update();
    const interval = setInterval(update, 500);
    return () => clearInterval(interval);
  }, [currentTurnStartTime, serverTime]);

  const currentParticipant = participants.find(p => p.turn_order === currentTurnOrder);

  // 우선순위: 일시정지 > 자동배정 > 세션전환 > 진행중
  let bgColor = 'bg-blue-600';
  let text = '';
  let pulse = false;

  if (isFrozen) {
    bgColor = 'bg-red-600';
    text = `⏸ 일시정지 중${frozenReason ? ` — ${frozenReason}` : ''}`;
    pulse = true;
  } else if (announcement.type === 'AUTO_ASSIGN') {
    bgColor = 'bg-orange-500';
    text = '⚙️ 시스템 자동 배정';
    pulse = true;
  } else if (announcement.type === 'SESSION_CHANGE') {
    bgColor = 'bg-purple-600';
    text = announcement.nextStartTime
      ? `다음 세션 시작 시간은 ${announcement.nextStartTime} 입니다.`
      : '다음 세션을 준비 중입니다.';
  } else if (currentParticipant) {
    bgColor = 'bg-blue-600';
    text = `현재 순서 '${currentParticipant.name}'님`;
  } else {
    bgColor = 'bg-gray-500';
    text = '대기 중';
  }

  const showTimer = !isFrozen && announcement.type !== 'SESSION_CHANGE' && announcement.type !== 'AUTO_ASSIGN' && timeLeft;

  return (
    <div
      className={`${bgColor} text-white rounded-xl px-4 py-3 mb-3 flex items-center justify-between shadow-md transition-all duration-300 ${pulse ? 'animate-pulse' : ''}`}
    >
      <span className="font-bold text-sm md:text-base truncate">{text}</span>
      {showTimer && (
        <span className="ml-4 font-mono font-bold text-lg shrink-0 tabular-nums">
          {timeLeft}
        </span>
      )}
    </div>
  );
}
