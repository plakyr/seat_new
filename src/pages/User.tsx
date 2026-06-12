import React from 'react';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import SeatMap from '../components/SeatMap';
import AnnouncementBar from '../components/AnnouncementBar';
import { useSocket } from '../store/useSocket';
import ChatWindow from '../components/ChatWindow';

export default function User() {
  const { user, setUser, serverTime, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, announcement, setLayout, participants, timerPaused } = useStore();
  const socket = useSocket();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [uniqueCode, setUniqueCode] = useState('');
  const [requiresCode, setRequiresCode] = useState(false);
  const [error, setError] = useState('');
  const [sessionExpiredMsg, setSessionExpiredMsg] = useState('');
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const [timerStatus, setTimerStatus] = useState<'WAITING' | 'ACTIVE' | 'EXPIRED' | 'COMPLETED'>('WAITING');

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
  
  // 2. 타이머 로직
  useEffect(() => {
    if (!user || !serverTime || !currentTurnStartTime) return;

    if (user.turn_status === 'COMPLETED' || user.is_final) {
      setTimerStatus('COMPLETED');
      setTimeLeft('00:00');
      return;
    }

    const updateTimer = () => {
      const now = new Date(serverTime).getTime();
      const turnStart = new Date(currentTurnStartTime).getTime();
      const turnEnd = turnStart + 3 * 60000;

      if (user.turn_order > currentTurnOrder) {
        setTimerStatus('WAITING');
        setTimeLeft(null);
      } else if (user.turn_order === currentTurnOrder) {
        if (now >= turnStart && now <= turnEnd) {
          setTimerStatus('ACTIVE');
          const diff = turnEnd - now;
          setTimeLeft(formatTimeDiff(diff));
        } else if (now > turnEnd) {
          setTimerStatus('EXPIRED');
          setTimeLeft('00:00');
        } else {
          setTimerStatus('WAITING');
          setTimeLeft(null);
        }
      } else {
        setTimerStatus('EXPIRED');
        setTimeLeft('00:00');
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [user, serverTime, currentTurnOrder, currentTurnStartTime]);

  const formatTimeDiff = (ms: number) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

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
    <div className="min-h-screen min-h-dvh bg-gray-50 flex flex-col">
      <header className="bg-white shadow-sm p-4 sticky top-0 z-20 flex justify-between items-center">
        <div>
          <h1 className="text-lg font-bold">{user.name}님</h1>
          <p className="text-sm text-gray-500">{user.session_id}그룹 {groupOrder}번째</p>
        </div>
      </header>
      <main className="flex-1 p-4 flex flex-col max-w-6xl mx-auto w-full">
        {/* 공지 바 */}
        <AnnouncementBar
          announcement={announcement}
          currentTurnOrder={currentTurnOrder}
          currentTurnStartTime={currentTurnStartTime}
          serverTime={serverTime}
          isFrozen={isFrozen}
          frozenReason={frozenReason}
          participants={participants}
          timerPaused={timerPaused}
        />
        <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
          <div className="flex-1 relative min-h-[300px]">
            <SeatMap />
          </div>
          <div className="h-[260px] lg:h-[70vh] lg:w-80 lg:shrink-0">
            <ChatWindow eventId={user.event_id} />
          </div>
        </div>
      </main>
    </div>
  );
}
