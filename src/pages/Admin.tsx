import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';
import SeatMap from '../components/SeatMap';
import ChatWindow from '../components/ChatWindow';

export default function Admin() {
  const { adminToken, adminUser, setAdminAuth, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, sessionColors, participants } = useStore();
  const socket = useSocket();
  
  // Login State
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  // Upload State
  const [eventName, setEventName] = useState('');
  const [rows, setRows] = useState('10');
  const [cols, setCols] = useState('10');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState('');

  // Monitoring state
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'UPLOAD' | 'MONITOR'>('UPLOAD');

  // Session Edit State
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndTime, setEditEndTime] = useState('');

  useEffect(() => {
    if (adminToken && activeTab === 'MONITOR') {
      fetchEvents();
    }
  }, [adminToken, activeTab]);

  useEffect(() => {
    if (selectedEventId && socket) {
      socket.emit('admin:request_event', { eventId: selectedEventId });
    }
  }, [selectedEventId, socket]);

  useEffect(() => {
    if (selectedEventId && events.length > 0) {
      const currentEvent = events.find(ev => ev.id === selectedEventId);
      if (currentEvent) {
        console.log("선택된 이벤트 데이터 주입:", currentEvent.name);
        updateStoreWithEventData(currentEvent);
      }
    }
  }, [selectedEventId, events]);

  const fetchEvents = async () => {
    try {
      const res = await fetch('/api/admin/events', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        // 기존: setEvents(data.events); 
        // 수정: API 응답 구조가 { events: [...] }인지 확인 후 처리
        const eventList = data.events || data; 
        setEvents(eventList);

        // 만약 선택된 이벤트가 이미 있다면, 해당 데이터로 스토어 업데이트
        if (selectedEventId) {
          const selected = eventList.find((e: any) => e.id === selectedEventId);
          if (selected) updateStoreWithEventData(selected);
        }
      }
    } catch (err) {
      console.error('Failed to fetch events', err);
    }
  };

const updateStoreWithEventData = (event: any) => {
  console.log("받은 이벤트 데이터:", event);

  // 1. 좌석 및 레이아웃 주입
  if (event.seats && event.seats.length > 0) {
    useStore.getState().setRows(event.rows);
    useStore.getState().setCols(event.cols);
    useStore.getState().setSeats(event.seats);
    console.log("좌석 배치 완료!");
  } else {
    const layout = event.layouts?.[0];
    if (layout?.seats) {
      useStore.getState().setRows(layout.rows);
      useStore.getState().setCols(layout.cols);
      useStore.getState().setSeats(layout.seats);
    } else {
      console.error("이 이벤트에는 레이아웃 데이터가 없습니다.");
    }
  }

  // 2. 참가자 명단 주입
  if (event.participants) {
    useStore.getState().setParticipants(event.participants);
  }

  // 3. 세션 색상 및 시간 정보 주입
  if (event.sessionColors) {
    useStore.getState().setSessionColors(event.sessionColors);
  }
};

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        setAdminAuth(data.token, data.admin);
      } else {
        setLoginError(data.error || '로그인 실패');
      }
    } catch (err) {
      setLoginError('서버 오류가 발생했습니다.');
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !adminToken) return;

    const formData = new FormData();
    formData.append('name', eventName);
    formData.append('rows', rows);
    formData.append('cols', cols);
    formData.append('file', file);

    setStatus('업로드 중...');
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${adminToken}`
        },
        body: formData,
      });
      const data = await res.json();
      if (res.ok) {
        setStatus('업로드 성공! 이벤트 ID: ' + (data.eventId || data.event?.id));
        setEventName('');
        setFile(null);
        if (activeTab === 'MONITOR') fetchEvents();
      } else {
        setStatus('업로드 실패: ' + data.error);
      }
    } catch (err) {
      setStatus('네트워크 오류가 발생했습니다.');
    }
  };

  const handleToggleFreeze = () => {
    if (!selectedEventId || !socket) return;
    const newFreezeState = !isFrozen;
    const reason = newFreezeState ? prompt('일시정지 사유를 입력하세요 (선택):') : null;
    socket.emit('admin:toggle_freeze', { eventId: selectedEventId, isFrozen: newFreezeState, reason });
  };

  const handleNextTurn = () => {
    if (!selectedEventId || !socket) return;
    if (confirm('현재 턴을 강제로 종료하고 다음 턴으로 넘기시겠습니까?')) {
      socket.emit('admin:next_turn', { eventId: selectedEventId });
    }
  };

  const handleSaveSession = async (session: any) => {
    try {
      const res = await fetch('/api/admin/sessions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({
          eventId: selectedEventId,
          sessions: [{ id: session.id, start_time: editStartTime, end_time: editEndTime }]
        })
      });
      if (!res.ok) throw new Error('Failed to save session');
      setEditingSessionId(null);
    } catch (err) {
      alert('세션 시간 저장에 실패했습니다.');
    }
  };

  const handleSeatClick = (seat: any) => {
  console.log("관리자가 클릭한 좌석:", seat);
  
  // 만약 좌석에 이미 참가자가 있다면 정보를 보여줍니다.
  if (seat.participant) {
    const confirmCancel = confirm(
      `좌석: ${seat.label}\n참가자: ${seat.participant.participant_name}\n\n이 예약을 강제로 취소하시겠습니까?`
    );
    
    if (confirmCancel && socket && selectedEventId) {
      // 서버에 예약 취소 이벤트를 보냅니다 (서버 측 구현 필요)
      socket.emit('admin:cancel_reservation', { 
        eventId: selectedEventId, 
        seatId: seat.id 
      });
    }
  } else {
    alert(`좌석 ${seat.label}은 비어 있습니다.`);
  }
};

  if (!adminToken) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl p-8">
          <h1 className="text-2xl font-bold text-center mb-8 text-gray-900">관리자 로그인</h1>
          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">아이디</label>
              <input 
                type="text" 
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                placeholder="admin1"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">비밀번호</label>
              <input 
                type="password" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                placeholder="••••••••"
                required
              />
            </div>
            {loginError && <p className="text-red-500 text-sm font-medium">{loginError}</p>}
            <button 
              type="submit"
              className="w-full py-4 bg-gray-900 hover:bg-black text-white rounded-xl font-bold text-lg transition-colors mt-6 shadow-md"
            >
              로그인
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex">
      <aside className="w-64 bg-gray-900 text-white p-6 hidden md:flex flex-col">
        <h1 className="text-2xl font-bold mb-8 tracking-tight">Admin Panel</h1>
        <div className="mb-6 pb-6 border-b border-gray-800">
          <p className="text-sm text-gray-400">접속 계정</p>
          <p className="font-medium text-lg">{adminUser?.username}</p>
        </div>
        <nav className="space-y-2 flex-1">
          <button 
            onClick={() => setActiveTab('UPLOAD')}
            className={`w-full text-left py-2.5 px-4 rounded-lg font-medium transition-colors ${activeTab === 'UPLOAD' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            대시보드 / 업로드
          </button>
          <button 
            onClick={() => setActiveTab('MONITOR')}
            className={`w-full text-left py-2.5 px-4 rounded-lg font-medium transition-colors ${activeTab === 'MONITOR' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            실시간 관제
          </button>
        </nav>
        <button 
          onClick={() => setAdminAuth(null, null)}
          className="mt-auto py-2 px-4 text-left text-gray-400 hover:text-white transition-colors"
        >
          로그아웃
        </button>
      </aside>
      
      <main className="flex-1 p-8 overflow-y-auto">
        <div className="max-w-5xl mx-auto h-full flex flex-col">
          {activeTab === 'UPLOAD' && (
            <>
              <h2 className="text-3xl font-bold mb-8 text-gray-900">회차 및 참가자 업로드</h2>
              <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
                <form onSubmit={handleUpload} className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">회차(이벤트) 이름</label>
                    <input 
                      type="text" 
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                      placeholder="예: 2026년 3월 정기 공연"
                      required
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">좌석 행(Row) 수</label>
                      <input 
                        type="number" 
                        value={rows}
                        onChange={(e) => setRows(e.target.value)}
                        className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                        required
                        min="1"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">좌석 열(Col) 수</label>
                      <input 
                        type="number" 
                        value={cols}
                        onChange={(e) => setCols(e.target.value)}
                        className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                        required
                        min="1"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">참가자 명단 (CSV)</label>
                    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-3">
                      <p className="text-xs text-gray-600 font-mono">
                        필수 컬럼: event_id, session_id, participant_name, phone_last4, order_in_session<br/>
                        <span className="text-gray-400 mt-1 block">예시: event_1, session_1, 홍길동, 1234, 1</span>
                      </p>
                    </div>
                    <input 
                      type="file" 
                      accept=".csv"
                      onChange={(e) => setFile(e.target.files?.[0] || null)}
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-gray-900 file:text-white hover:file:bg-gray-800 cursor-pointer"
                      required
                    />
                  </div>

                  <button 
                    type="submit"
                    className="w-full py-4 bg-gray-900 hover:bg-black text-white rounded-xl font-bold text-lg transition-colors shadow-md mt-4"
                  >
                    업로드 및 생성
                  </button>
                  
                  {status && (
                    <div className={`p-4 rounded-xl font-medium text-sm ${status.includes('성공') ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}>
                      {status}
                    </div>
                  )}
                </form>
              </div>
            </>
          )}

          {activeTab === 'MONITOR' && (
            <div className="flex flex-col h-full space-y-6">
              <h2 className="text-3xl font-bold text-gray-900">실시간 관제</h2>
              
              <div className="flex flex-col md:flex-row gap-4 items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex-1 w-full">
                  <label className="block text-sm font-semibold text-gray-700 mb-2">이벤트 선택</label>
                  <select 
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 outline-none focus:ring-2 focus:ring-gray-900"
                    value={selectedEventId || ''}
                    onChange={(e) => setSelectedEventId(e.target.value)}
                  >
                    <option value="">-- 이벤트를 선택하세요 --</option>
                    {events.map(ev => (
                      <option key={ev.id} value={ev.id}>{ev.name} (참가자 {ev._count?.participants || 0}명)</option>
                    ))}
                  </select>
                </div>
                
                {selectedEventId && (
                  <div className="w-full md:w-auto mt-4 md:mt-0 md:self-end flex gap-2">
                    <button 
                      onClick={handleNextTurn}
                      className="w-full md:w-auto px-8 py-3 rounded-xl font-bold text-white transition-colors shadow-md bg-blue-600 hover:bg-blue-700"
                    >
                      다음 턴으로 넘기기
                    </button>
                    <button 
                      onClick={handleToggleFreeze}
                      className={`w-full md:w-auto px-8 py-3 rounded-xl font-bold text-white transition-colors shadow-md ${isFrozen ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
                    >
                      {isFrozen ? '시스템 재개 (Unfreeze)' : '시스템 정지 (Freeze)'}
                    </button>
                  </div>
                )}
              </div>

              {selectedEventId ? (
                <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col relative min-h-[500px]">
                  {isFrozen && (
                    <div className="absolute top-6 left-1/2 transform -translate-x-1/2 z-10 bg-red-100 border border-red-400 text-red-700 px-6 py-2 rounded-full font-bold shadow-md">
                      시스템 일시정지 중: {frozenReason || '사유 없음'}
                    </div>
                  )}
                  
                  {/* Session Info Panel */}
                  <div className="mb-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <h3 className="text-sm font-bold text-gray-700 mb-2">세션별 현황 및 시간 설정</h3>
                    <div className="flex flex-col gap-3">
                      {sessionColors.map(sc => {
                        const sessionParticipants = participants.filter(p => p.session_id === sc.session_id);
                        const completedCount = sessionParticipants.filter(p => p.seat_id).length;
                        const totalCount = sessionParticipants.length;
                        const isEditing = editingSessionId === sc.id;
                        
                        return (
                          <div key={sc.session_id} className="flex items-center justify-between bg-white px-4 py-2 rounded-lg border border-gray-200 shadow-sm">
                            <div className="flex items-center gap-3">
                              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: sc.color }}></div>
                              <span className="text-sm font-semibold text-gray-800">세션 {sc.session_id}</span>
                              <span className="text-xs text-gray-500">({completedCount}/{totalCount}명 완료)</span>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              {isEditing ? (
                                <>
                                  <input 
                                    type="time" 
                                    value={editStartTime} 
                                    onChange={e => setEditStartTime(e.target.value)}
                                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                                  />
                                  <span className="text-gray-500">-</span>
                                  <input 
                                    type="time" 
                                    value={editEndTime} 
                                    onChange={e => setEditEndTime(e.target.value)}
                                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                                  />
                                  <button 
                                    onClick={() => handleSaveSession(sc)}
                                    className="ml-2 bg-gray-900 text-white px-3 py-1 rounded text-sm hover:bg-gray-800"
                                  >
                                    저장
                                  </button>
                                  <button 
                                    onClick={() => setEditingSessionId(null)}
                                    className="bg-gray-200 text-gray-700 px-3 py-1 rounded text-sm hover:bg-gray-300"
                                  >
                                    취소
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="text-sm text-gray-600 font-mono">
                                    {sc.start_time || '--:--'} ~ {sc.end_time || '--:--'}
                                  </span>
                                  <button 
                                    onClick={() => {
                                      setEditingSessionId(sc.id);
                                      setEditStartTime(sc.start_time || '');
                                      setEditEndTime(sc.end_time || '');
                                    }}
                                    className="ml-4 text-xs bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-1 rounded border border-gray-300 transition-colors"
                                  >
                                    수정
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="flex-1 flex gap-4">
                    <div className="flex-[2] flex flex-col">
                      <div className="flex-1 border border-gray-200 rounded-xl overflow-hidden bg-gray-50 min-h-[400px]">
  <SeatMap forceAdmin={true} /> 
</div>
                      <p className="text-sm text-gray-500 mt-4 text-center font-medium">
                        예약된 좌석을 클릭하면 참가자 정보를 확인하고 강제 취소할 수 있습니다.
                      </p>
                    </div>
                    <div className="flex-1 flex flex-col min-h-[400px]">
                      <ChatWindow eventId={selectedEventId} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center bg-white rounded-2xl shadow-sm border border-gray-100 text-gray-500 min-h-[500px]">
                  <p className="text-lg font-medium">상단에서 이벤트를 선택해주세요.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
