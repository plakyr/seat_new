import React from 'react';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import SeatMap from '../components/SeatMap';
import AnnouncementBar from '../components/AnnouncementBar';
import { useSocket } from '../store/useSocket';
import ChatWindow from '../components/ChatWindow';

export default function User() {
  const { user, setUser, logoutUser, serverTime, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, announcement, setLayout, participants, timerPaused, hasReceivedSystemState } = useStore();
  const socket = useSocket();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [uniqueCode, setUniqueCode] = useState('');
  const [requiresCode, setRequiresCode] = useState(false);
  const [error, setError] = useState('');
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState('');

  // 참가자 화면 진입 시 관리자 상태(메모리)만 초기화. 저장된 관리자 세션은 건드리지 않는다
  // (sessionStorage도 탭 간 공유되므로, 여기서 지우면 다른 탭의 관리자가 로그아웃됨)
  useEffect(() => {
    useStore.getState().clearAdminMemory();
  }, []);

  // User.tsx 내부
  useEffect(() => {
    const fetchInitialData = async () => {
      console.log("좌석 데이터 요청 시작..."); // 콘솔 확인용
      try {
        const res = await fetch('/api/seats');
        console.log("응답 상태:", res.status);
        
        if (res.ok) {
          const data = await res.json();
          console.log("받은 데이터:", data);
          
          if (data.seats) useStore.getState().setSeats(data.seats);
          if (data.layout) useStore.getState().setLayout(data.layout);
          if (data.participants) useStore.getState().setParticipants(data.participants);
          if (data.sessionColors) useStore.getState().setSessionColors(data.sessionColors);
        }
      } catch (err) {
        console.error('Fetch Error:', err);
      }
    };

    fetchInitialData(); // 의존성 없이 무조건 실행
  }, []); // 페이지 로드 시 최초 1회 실행
  
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
        setSessionExpiredMsg('');
      }
    } catch (err) { setError('서버 오류가 발생했습니다.'); }
  };

  if (!user) {
    return (
      <div className="min-h-screen min-h-dvh bg-gray-50 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-2xl font-bold text-center mb-8">참가자 로그인</h1>
          <form onSubmit={handleLogin} className="space-y-5">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-4 py-3 rounded-xl border" placeholder="이름" required />
            <input type="text" maxLength={4} value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-4 py-3 rounded-xl border" placeholder="비밀번호" required />
            {requiresCode && <input type="text" value={uniqueCode} onChange={(e) => setUniqueCode(e.target.value)} className="w-full px-4 py-3 rounded-xl border" placeholder="고유 코드" required />}
            {error && <p className="text-red-500 text-sm">{error}</p>}
            <button type="submit" style={{ backgroundColor: '#1C71E8' }} className="w-full py-4 text-white rounded-xl font-bold text-lg hover:opacity-90">입장하기</button>
          </form>
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

  return (
    <div className="h-screen h-dvh bg-gray-50 flex flex-col overflow-hidden">
      <header className="bg-white shadow-sm p-4 shrink-0 z-20 flex justify-between items-center">
        <div>
          <h1 className="text-lg font-bold">{user.name}님</h1>
          <p className="text-sm text-gray-500">{user.session_id}그룹 {groupOrder}번째</p>
        </div>
        <button
          onClick={() => { if (confirm('로그아웃 하시겠습니까?')) logoutUser(); }}
          className="px-3 py-2 rounded-lg text-sm font-semibold text-gray-600 border border-gray-300 hover:bg-gray-100 active:bg-gray-200 transition-colors shrink-0"
        >
          로그아웃
        </button>
      </header>
      <main className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col max-w-6xl lg:max-w-none mx-auto w-full">
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
          />
        </React.Fragment>
        <div className="flex flex-col lg:flex-row lg:flex-1 gap-4 lg:min-h-0 min-w-0">
          <div className="flex-1 relative min-h-[300px] min-w-0">
            <SeatMap />
          </div>
          <div className="h-[260px] lg:h-[70vh] lg:w-[370px] lg:shrink-0">
            <ChatWindow eventId={user.event_id} />
          </div>
        </div>
      </main>
    </div>
  );
}
