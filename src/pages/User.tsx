import React from 'react';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import SeatMap from '../components/SeatMap';
import AnnouncementBar from '../components/AnnouncementBar';
import { useSocket } from '../store/useSocket';
import ChatWindow from '../components/ChatWindow';

// 로그인 실패 문구를 원인별로 나눈다. 참가자가 "내가 뭘 잘못했나" 하고
// 같은 입력을 반복하지 않도록, 고쳐야 하는 것(빨강)과 기다리면 풀리는 것(노랑),
// 시스템 상태(회색)를 색으로 구분한다.
type ErrorTone = 'error' | 'warn' | 'info';

const TONES: Record<ErrorTone, { bg: string; border: string; title: string; body: string; stroke: string }> = {
  error: { bg: '#FDEDEC', border: '#F6D2CF', title: '#B03B36', body: '#99544F', stroke: '#D14944' },
  warn:  { bg: '#FFF6E3', border: '#F2DFB4', title: '#96690A', body: '#8A7233', stroke: '#B8860B' },
  info:  { bg: '#F1F4FB', border: '#DDE4F2', title: '#4A5570', body: '#6C7590', stroke: '#6C7590' },
};

function describeError(message: string): { tone: ErrorTone; title: string; hint: string } {
  const tone: ErrorTone =
    /아직 입장|시도가 너무 많/.test(message) ? 'warn' :
    /진행 중인 이벤트가 없/.test(message) ? 'info' : 'error';

  // 서버 문구가 "무엇이 잘못됐는지. 어떻게 하면 되는지." 두 문장이면 그대로 나눠 쓴다.
  const split = message.match(/^(.+?[^.]*)\.\s+(.+)$/);
  if (split) return { tone, title: split[1], hint: split[2] };

  const hint =
    tone === 'warn' ? '잠시 후 다시 시도해주세요.' :
    tone === 'info' ? '운영진에게 문의해주세요.' :
    /서버 오류/.test(message) ? '잠시 후 다시 시도해주세요.' :
    '이름과 비밀번호를 다시 확인해주세요.';
  return { tone, title: message.replace(/\.$/, ''), hint };
}

function ErrorNotice({ message }: { message: string }) {
  const { tone, title, hint } = describeError(message);
  const c = TONES[tone];
  return (
    <div
      className="flex gap-2.5 rounded-[15px] px-3.5 py-3"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
      role="alert"
    >
      <svg
        width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={c.stroke}
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
        className="shrink-0 mt-px"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16.5h.01" />
      </svg>
      <div className="min-w-0">
        <div className="text-[13.5px] font-extrabold leading-[1.4]" style={{ color: c.title }}>{title}</div>
        <div className="text-[12.5px] font-medium leading-[1.6] mt-1" style={{ color: c.body }}>{hint}</div>
      </div>
    </div>
  );
}

export default function User() {
  const { user, setUser, logoutUser, serverTime, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, announcement, participants, sessionColors, timerPaused, hasReceivedSystemState } = useStore();
  const socket = useSocket();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [uniqueCode, setUniqueCode] = useState('');
  const [requiresCode, setRequiresCode] = useState(false);
  const [error, setError] = useState('');
  // 로그아웃 확인 팝업. 브라우저 내장 confirm()은 모바일에서 "추가 대화상자 생성 방지"
  // 체크박스가 붙고, 사용자가 체크하면 이후 버튼이 조용히 무반응이 되므로 자체 팝업을 쓴다.
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // 참가자 화면 진입 시 관리자 상태(메모리)만 초기화. 저장된 관리자 세션은 건드리지 않는다
  // (sessionStorage도 탭 간 공유되므로, 여기서 지우면 다른 탭의 관리자가 로그아웃됨)
  useEffect(() => {
    useStore.getState().clearAdminMemory();
  }, []);

  // 초기 좌석/참가자 데이터 로딩.
  // /api/seats가 참가자 명단을 포함하므로 로그인(세션 보유) 후에만 인증 헤더와 함께 요청한다.
  useEffect(() => {
    if (!user) return;
    const fetchInitialData = async () => {
      try {
        const { sessionToken } = useStore.getState();
        const res = await fetch('/api/seats', {
          headers: {
            'x-participant-id': user.id,
            'x-session-token': sessionToken || '',
          },
        });

        if (res.ok) {
          const data = await res.json();
          if (data.seats) useStore.getState().setSeats(data.seats);
          if (data.layout) useStore.getState().setLayout(data.layout);
          if (data.participants) useStore.getState().setParticipants(data.participants);
          if (data.sessionColors) useStore.getState().setSessionColors(data.sessionColors);
        }
      } catch (err) {
        console.error('Fetch Error:', err);
      }
    };

    fetchInitialData();
  }, [user?.id]); // 로그인 완료(또는 새로고침 후 세션 복원) 시 실행

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone_last4: phone, unique_code: uniqueCode || undefined })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) { setRequiresCode(true); setError(data.error); }
        else { setError(data.error || '로그인 실패'); }
        return;
      }
      if (data.user) {
        setUser(data.user, data.sessionToken);
      }
    } catch (err) { setError('서버 오류가 발생했습니다.'); }
  };

  if (!user) {
    const fieldStyle: React.CSSProperties = error
      ? { background: '#FFFAFA', border: '1.5px solid #E9B5B1' }
      : { background: 'var(--c-tint-2)', border: '1px solid var(--c-line)' };

    return (
      <div
        className="min-h-screen min-h-dvh flex flex-col justify-center p-6"
        style={{ background: 'var(--c-bg)', color: 'var(--c-ink)' }}
      >
        <div className="w-full max-w-sm mx-auto">
          <div
            className="rounded-3xl px-6 py-7"
            style={{ background: 'var(--c-surface)', boxShadow: '0 2px 14px rgba(23,35,66,.07)' }}
          >
            <h1 className="text-[23px] font-extrabold tracking-[-.02em]">참가자 로그인</h1>

            <form onSubmit={handleLogin} className="mt-6 flex flex-col gap-4">
              <div>
                <label htmlFor="login-name" className="block text-[13px] font-bold mb-[7px]" style={{ color: 'var(--c-ink-2)' }}>
                  이름
                </label>
                <input
                  id="login-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full h-[54px] rounded-[15px] px-4 text-[15.5px] font-bold outline-none focus:border-[color:var(--c-primary)] focus:shadow-[0_0_0_4px_rgba(74,107,245,.14)] transition-shadow"
                  style={fieldStyle}
                  required
                />
              </div>

              <div>
                <label htmlFor="login-pw" className="block text-[13px] font-bold mb-[7px]" style={{ color: 'var(--c-ink-2)' }}>
                  비밀번호
                </label>
                {/* 비밀번호 형식은 명단 CSV의 password_4 값 그대로 — 참가자가 직접 정한 숫자라
                    자릿수가 사람마다 다르므로 길이를 좁게 제한하지 않는다 */}
                <input
                  id="login-pw"
                  type="password"
                  inputMode="numeric"
                  maxLength={20}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full h-[54px] rounded-[15px] px-4 text-[15.5px] font-bold tracking-[.35em] outline-none focus:border-[color:var(--c-primary)] focus:shadow-[0_0_0_4px_rgba(74,107,245,.14)] transition-shadow"
                  style={fieldStyle}
                  required
                />
              </div>

              {requiresCode && (
                <div>
                  <label htmlFor="login-code" className="block text-[13px] font-bold mb-[7px]" style={{ color: 'var(--c-ink-2)' }}>
                    고유 코드
                  </label>
                  <input
                    id="login-code"
                    type="text"
                    value={uniqueCode}
                    onChange={(e) => setUniqueCode(e.target.value)}
                    className="w-full h-[54px] rounded-[15px] px-4 text-[15.5px] font-bold outline-none focus:border-[color:var(--c-primary)] focus:shadow-[0_0_0_4px_rgba(74,107,245,.14)] transition-shadow"
                    style={fieldStyle}
                    required
                  />
                </div>
              )}

              {error && <ErrorNotice message={error} />}

              <button
                type="submit"
                className="w-full h-[58px] rounded-[18px] text-white text-[17px] font-extrabold mt-2 transition-opacity hover:opacity-90 active:opacity-80"
                style={{ background: 'var(--c-primary)', boxShadow: 'var(--sh-primary)' }}
              >
                {error ? '다시 시도' : '로그인'}
              </button>
            </form>
          </div>

          <div className="flex items-start gap-2 px-1.5 mt-[18px]">
            <svg
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--c-muted-2)"
              strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            <p className="text-[12.5px] font-medium leading-[1.65]" style={{ color: 'var(--c-muted-2)' }}>
              신청 시 제출한 정보를 입력해주세요.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 같은 그룹(세션) 내에서의 순서 계산 (전체 turn_order가 아닌 그룹 내 순번)
  const groupMembers = participants
    .filter(p => p.session_id === user.session_id)
    .sort((a, b) => a.turn_order - b.turn_order);
  const groupIndex = groupMembers.findIndex(p => p.id === user.id);
  const groupOrder = groupIndex >= 0 ? groupIndex + 1 : user.turn_order;
  // 프로필 원은 내 그룹 색으로 칠해, 원 자체가 "몇 그룹인지" 표시가 되게 한다
  const myColor = sessionColors.find(sc => sc.session_id === user.session_id)?.color ?? 'var(--c-primary)';

  return (
    <div className="h-screen h-dvh flex flex-col overflow-hidden" style={{ background: 'var(--c-bg)', color: 'var(--c-ink)' }}>
      <header
        className="shrink-0 z-20 flex justify-between items-center px-4 py-3.5"
        style={{ background: 'var(--c-surface)', borderBottom: '1px solid #E1E7F5' }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-10 h-10 rounded-[14px] flex items-center justify-center text-[17px] font-extrabold text-white shrink-0"
            style={{ background: myColor }}
            aria-hidden
          >
            {user.name.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <h1 className="text-[17px] font-extrabold leading-[1.25] truncate">{user.name}님</h1>
            {/* 관전 계정(turn_order 0, '추가' 그룹)은 그룹/순번 대신 '추가신청자'로 표기 */}
            <p className="text-[13px] font-medium mt-0.5" style={{ color: 'var(--c-muted)' }}>
              {user.turn_order === 0 ? '추가신청자' : `${user.session_id}그룹 · ${groupOrder}번째`}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowLogoutConfirm(true)}
          className="px-3.5 py-2.5 rounded-xl text-[13px] font-bold shrink-0 transition-opacity hover:opacity-80 active:opacity-70"
          style={{ background: 'var(--c-tint)', color: 'var(--c-muted)' }}
        >
          로그아웃
        </button>
      </header>

      {/* 로그아웃 확인 팝업 (좌석 선택 확인 팝업과 동일한 스타일) */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="rounded-3xl shadow-2xl p-6 w-full max-w-sm" style={{ background: 'var(--c-surface)' }}>
            <p className="text-base font-extrabold mb-1 text-center">로그아웃</p>
            <p className="text-sm font-medium text-center mb-6" style={{ color: 'var(--c-muted)' }}>로그아웃 하시겠습니까?</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 rounded-2xl font-bold transition-colors"
                style={{ border: '1px solid var(--c-line)', color: 'var(--c-muted)' }}
              >
                취소
              </button>
              <button
                onClick={() => {
                  setShowLogoutConfirm(false);
                  // 서버에 알려 presence(접속자 수) 정리 + 세션 토큰 무효화
                  socket?.emit('participant:logout');
                  logoutUser();
                }}
                className="flex-1 py-3 rounded-2xl text-white font-extrabold hover:opacity-90 active:opacity-80"
                style={{ background: 'var(--c-primary)' }}
              >
                로그아웃
              </button>
            </div>
          </div>
        </div>
      )}
      <main className="flex-1 min-h-0 overflow-y-auto px-4 pt-3.5 pb-4 flex flex-col max-w-6xl lg:max-w-none mx-auto w-full">
        {/* 공지 바 */}
        {/* 턴/공지 상태가 바뀔 때마다 컴포넌트를 완전히 새로 마운트해,
            내부 타이머 상태(timeLeft 등)까지 깨끗하게 초기화한다.
            key는 AnnouncementBar props가 아닌 Fragment에 둬서 tsc가
            커스텀 컴포넌트에 key를 전달하는 것으로 오인하지 않게 한다. */}
        <React.Fragment key={`${announcement.type}-${currentTurnStartTime}`}>
          <AnnouncementBar
            announcement={announcement}
            currentTurnOrder={currentTurnOrder}
            currentTurnStartTime={currentTurnStartTime}
            serverTime={serverTime}
            isFrozen={isFrozen}
            frozenReason={frozenReason}
            participants={participants}
            timerPaused={timerPaused}
            hasReceivedSystemState={hasReceivedSystemState}
            viewerTurnOrder={user.turn_order}
          />
        </React.Fragment>
        <div className="flex flex-col lg:flex-row lg:flex-1 gap-3 lg:min-h-0 min-w-0">
          <div className="flex-1 relative min-h-[300px] min-w-0">
            <SeatMap />
          </div>
          <div className="h-[272px] lg:h-[70vh] lg:w-[370px] lg:shrink-0">
            <ChatWindow eventId={user.event_id} />
          </div>
        </div>
      </main>
    </div>
  );
}
