import { useEffect, useRef, useState } from 'react';
import { AnnouncementState } from '../store/useStore';
import { formatSessionTime, sessionStartEpochMs } from '../utils/time';

interface Props {
  announcement: AnnouncementState;
  currentTurnOrder: number | null;
  currentTurnStartTime: string | null;
  serverTime: string | null;
  isFrozen: boolean;
  frozenReason: string | null;
  participants: any[];
  timerPaused: boolean;
  hasReceivedSystemState: boolean;
  /** 보고 있는 참가자의 순번. 자기 차례인지에 따라 표시를 다르게 한다.
   *  관리자 화면에서는 넘기지 않는다(관제용 표시). */
  viewerTurnOrder?: number;
}

/** 상태 바(자동배정·일시정지·그룹전환·완료·대기)에 쓰는 한 줄짜리 색 바 */
function StatusBar({ color, icon, children, pulse }: {
  color: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <div
      className={`rounded-[20px] px-[18px] py-[15px] mb-3 flex items-center gap-2.5 text-white ${pulse ? 'animate-pulse' : ''}`}
      style={{ background: color }}
    >
      <span className="shrink-0 flex">{icon}</span>
      <span className="text-base font-extrabold leading-[1.35] min-w-0">{children}</span>
    </div>
  );
}

const iconProps = {
  width: 19, height: 19, viewBox: '0 0 24 24', fill: 'none', stroke: '#ffffff',
  strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

const ClockIcon = <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
const GearIcon = (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
const PauseIcon = <svg {...iconProps} strokeWidth={2.4}><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>;
const CheckIcon = <svg {...iconProps} strokeWidth={2.4}><path d="M20 6 9 17l-5-5" /></svg>;

export default function AnnouncementBar({
  announcement,
  currentTurnOrder,
  currentTurnStartTime,
  serverTime,
  isFrozen,
  frozenReason,
  participants,
  timerPaused,
  hasReceivedSystemState,
  viewerTurnOrder,
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
  // 대기(SESSION_CHANGE) 상태에서 다음 그룹 시작시간까지 6초 이내가 되면
  // 오버레이를 띄운다. 6~3초: 인트로 문구, 3·2·1: 큰 숫자. 서버 부하 없이 클라에서만 계산.
  const COUNTDOWN_ENABLED = true; // 끄고 싶으면 false
  const nextStartTime = announcement.nextStartTime;
  useEffect(() => {
    if (!COUNTDOWN_ENABLED || announcement.type !== 'SESSION_CHANGE' || !nextStartTime) {
      setCountdown(null);
      return;
    }
    const tick = () => {
      // 서버 보정 시각 기준으로 시작 순간까지 남은 초 계산
      // ("HH:MM"은 오늘, "YYYY-MM-DDTHH:MM"은 지정 날짜 기준 — utils/time 참고)
      const nowMs = Date.now() + offsetRef.current;
      const startMs = sessionStartEpochMs(nextStartTime, nowMs);
      if (startMs == null) { setCountdown(null); return; }
      const remaining = (startMs - nowMs) / 1000;
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

  // 서버로부터 실제 진행 상태(system:turn / system:session_change / system:all_complete)를
  // 받기 전에는 currentTurnOrder 기본값으로 첫 번째 참가자를 잘못 표시하지 않도록 계산을 건너뛴다.
  const currentParticipant = hasReceivedSystemState && currentTurnOrder != null
    ? participants.find(p => p.turn_order === currentTurnOrder)
    : undefined;

  const showTimer =
    !!currentTurnStartTime &&
    !isFrozen &&
    !timerPaused &&
    announcement.type !== 'SESSION_CHANGE' &&
    announcement.type !== 'AUTO_ASSIGN' &&
    announcement.type !== 'ALL_COMPLETE';

  // 임박(10초 이하)이면 타이머 숫자만 빨갛게 깜빡인다
  const isUrgent = timeLeftMs <= 10000;

  const countdownOverlay = countdown && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 pointer-events-none px-6">
      {countdown.kind === 'intro' ? (
        <div className="countdown-pop text-white text-3xl sm:text-5xl font-extrabold text-center leading-snug">
          '그룹 {announcement.nextSessionId}'<br />곧 좌석 배정 시작합니다
        </div>
      ) : (
        <div
          key={countdown.n}
          className="countdown-pop text-white font-extrabold tabular-nums leading-none"
          style={{ fontSize: 'min(40vw, 40vh)' }}
        >
          {countdown.n}
        </div>
      )}
    </div>
  );

  // ── 상태별 바 ───────────────────────────────────────────────────────
  let bar: React.ReactNode;

  if (isFrozen) {
    bar = (
      <StatusBar color="var(--c-red)" icon={PauseIcon} pulse>
        일시정지 중{frozenReason ? ` — ${frozenReason}` : ' — 잠시만 기다려주세요'}
      </StatusBar>
    );
  } else if (announcement.type === 'AUTO_ASSIGN') {
    bar = <StatusBar color="var(--c-orange)" icon={GearIcon} pulse>시스템 자동 배정 중...</StatusBar>;
  } else if (announcement.type === 'SESSION_CHANGE') {
    const nextStartLabel = formatSessionTime(announcement.nextStartTime);
    bar = (
      <StatusBar color="var(--c-purple)" icon={ClockIcon}>
        {announcement.prevSessionId && (
          <>그룹 {announcement.prevSessionId} 좌석지정 완료<br /></>
        )}
        {nextStartLabel
          ? `그룹 ${announcement.nextSessionId} 시작시간은 ${nextStartLabel} 입니다`
          : '다음 그룹을 준비 중입니다'}
      </StatusBar>
    );
  } else if (announcement.type === 'ALL_COMPLETE') {
    bar = <StatusBar color="var(--c-green)" icon={CheckIcon}>모든 그룹 좌석 지정이 완료되었습니다</StatusBar>;
  } else if (currentParticipant) {
    const timer = (
      <span className={`tabular-nums ${isUrgent ? 'urgent-timer' : ''}`} style={isUrgent ? { color: 'var(--c-red-soft)' } : undefined}>
        {timeLeft}
      </span>
    );
    const isMyTurn = viewerTurnOrder != null && viewerTurnOrder === currentTurnOrder;

    // 그룹 내 순번 계산: 전체 turn_order가 아닌, 같은 그룹 안에서 몇 번째인지 표시
    const groupMembers = participants
      .filter(p => p.session_id === currentParticipant.session_id)
      .sort((a, b) => a.turn_order - b.turn_order);
    const groupIndex = groupMembers.findIndex(p => p.id === currentParticipant.id);
    const groupOrder = groupIndex >= 0 ? groupIndex + 1 : currentParticipant.turn_order;
    const who = `${currentParticipant.session_id}그룹 ${groupOrder}번째 ${currentParticipant.name}님`;

    if (isMyTurn) {
      // 내 차례 — 가장 강한 표시. 노란 배지와 큰 타이머로 힐끗 봐도 잡히게 한다.
      bar = (
        <div
          className="rounded-[20px] px-[18px] py-4 mb-3 flex items-center justify-between gap-3 text-white"
          style={{ background: 'var(--c-primary)', boxShadow: 'var(--sh-primary)' }}
        >
          <div className="min-w-0">
            <span
              className="inline-flex items-center gap-1.5 rounded-full text-[12.5px] font-extrabold leading-none pt-1.5 pb-[5px] px-[11px]"
              style={{ background: 'var(--c-amber)', color: 'var(--c-amber-ink)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--c-amber-ink)' }} />
              내 차례
            </span>
            <div className="text-xl font-extrabold leading-[1.3] mt-2">좌석을 선택해주세요</div>
          </div>
          {showTimer && (
            <div className="shrink-0 text-center rounded-2xl px-3 py-2.5 min-w-[82px]" style={{ background: 'rgba(255,255,255,.16)' }}>
              <div className="text-[11px] font-bold opacity-85 tracking-[.04em]">남은 시간</div>
              <div className="text-[25px] font-extrabold leading-[1.1] mt-0.5">{timer}</div>
            </div>
          )}
        </div>
      );
    } else if (viewerTurnOrder != null) {
      // 다른 사람 차례 — 색을 낮춰서, 화면을 힐끗 봐도 내 차례가 아님이 바로 보이게 한다
      bar = (
        <div
          className="rounded-[20px] px-[18px] py-3.5 mb-3 flex items-center justify-between gap-3"
          style={{ background: 'var(--c-primary-soft)', color: 'var(--c-ink-2)' }}
        >
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-[11.5px] font-extrabold" style={{ color: 'var(--c-primary)' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--c-primary)' }} />
              진행 중
            </div>
            <div className="text-base font-bold leading-[1.35] mt-1 truncate">{who}</div>
          </div>
          {showTimer && (
            <div className="shrink-0 text-xl font-extrabold" style={{ color: 'var(--c-muted)' }}>{timer}</div>
          )}
        </div>
      );
    } else {
      // 관리자 관제 화면 — 누구 차례인지와 남은 시간을 한 줄로
      bar = (
        <div
          className="rounded-2xl px-[18px] py-3.5 mb-3 flex items-center justify-between gap-3 text-white"
          style={{ background: 'var(--c-primary)', boxShadow: '0 6px 16px rgba(74,107,245,.24)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <span className="inline-flex items-center gap-1.5 rounded-full px-[11px] py-1 text-xs font-extrabold shrink-0" style={{ background: 'rgba(255,255,255,.22)' }}>
              <span className="w-1.5 h-1.5 rounded-full bg-white" />
              진행 중
            </span>
            <span className="text-lg font-extrabold truncate">현재 순서 {who}</span>
          </div>
          {showTimer && <span className="text-2xl font-extrabold shrink-0">{timer}</span>}
        </div>
      );
    }
  } else if (!hasReceivedSystemState) {
    bar = <StatusBar color="var(--c-slate)" icon={ClockIcon}>상태 불러오는 중...</StatusBar>;
  } else {
    bar = <StatusBar color="var(--c-slate)" icon={ClockIcon}>대기 중</StatusBar>;
  }

  return (
    <>
      {bar}
      {/* 그룹 시작 전 카운트다운 오버레이 (클릭을 막지 않도록 pointer-events-none) */}
      {countdownOverlay}
    </>
  );
}
