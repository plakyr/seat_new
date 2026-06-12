import React from 'react';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';
import SeatMap from '../components/SeatMap';
import ChatWindow from '../components/ChatWindow';
import AnnouncementBar from '../components/AnnouncementBar';

export default function Admin() {
  const { adminToken, adminUser, setAdminAuth, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, sessionColors, participants, serverTime, announcement, timerPaused } = useStore();
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
  const [aisleAfterRows, setAisleAfterRows] = useState('');
  const [aisleAfterCols, setAisleAfterCols] = useState('');
  const [status, setStatus] = useState('');

  // Monitoring state
  const [events, setEvents] = useState<any[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'UPLOAD' | 'MONITOR'>('MONITOR');

  // Session Edit State
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndTime, setEditEndTime] = useState('');
  const [isSessionPanelOpen, setIsSessionPanelOpen] = useState(false);

  // 관리자 화면 진입 시 참가자 상태 초기화 (같은 브라우저에서 참가자 → 관리자 전환 시 상태 잔존 방지)
  useEffect(() => {
    useStore.getState().setUser(null, null);
  }, []);

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
    if (aisleAfterRows.trim()) formData.append('aisle_after_rows', aisleAfterRows.trim());
    if (aisleAfterCols.trim()) formData.append('aisle_after_cols', aisleAfterCols.trim());

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
        setAisleAfterRows('');
        setAisleAfterCols('');
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

  const selectedEvent = events.find(ev => ev.id === selectedEventId);

  const handleToggleLoginOpen = async () => {
    if (!selectedEventId) return;
    const open = !selectedEvent?.login_open;
    if (!confirm(open ? '참가자 입장(로그인)을 허용하시겠습니까?' : '참가자 입장(로그인)을 차단하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/admin/events/${selectedEventId}/login-open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify({ open })
      });
      const data = await res.json();
      if (res.ok) {
        fetchEvents();
      } else {
        alert(data.error || '입장 허용 설정에 실패했습니다.');
      }
    } catch (err) {
      alert('서버 오류가 발생했습니다.');
    }
  };

  const handleNextTurn = () => {
    if (!selectedEventId || !socket) return;
    if (confirm('현재 선택자의 좌석을 자동배정하고 다음 턴으로 넘기시겠습니까?')) {
      socket.emit('admin:next_turn', { eventId: selectedEventId });
    }
  };

  const handleResetEvent = async () => {
    if (!selectedEventId) return;
    if (!confirm('이 이벤트의 모든 좌석 배정을 초기화하고 처음부터 다시 시작하시겠습니까?')) return;
    try {
      const res = await fetch(`/api/admin/events/${selectedEventId}/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error();
      socket.emit('admin:request_event', { eventId: selectedEventId });
      fetchEvents();
    } catch {
      alert('이벤트 초기화에 실패했습니다.');
    }
  };

  const handleDeleteEvent = async () => {
    if (!selectedEventId) return;
    const target = events.find(ev => ev.id === selectedEventId);
    if (!confirm(`'${target?.name}' 이벤트를 완전히 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.`)) return;
    try {
      const res = await fetch(`/api/admin/events/${selectedEventId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) throw new Error();
      setSelectedEventId(null);
      fetchEvents();
    } catch {
      alert('이벤트 삭제에 실패했습니다.');
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
      alert('그룹 시간 저장에 실패했습니다.');
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
        <h1 className="text-2xl font-bold mb-8 tracking-tight">관리자 메뉴</h1>
        <div className="mb-6 pb-6 border-b border-gray-800">
          <p className="text-sm text-gray-400">접속 계정</p>
          <p className="font-medium text-lg">{adminUser?.username}</p>
        </div>
        <nav className="space-y-2 flex-1">
          <button
            onClick={() => setActiveTab('MONITOR')}
            className={`w-full text-left py-2.5 px-4 rounded-lg font-medium transition-colors ${activeTab === 'MONITOR' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            실시간 관제
          </button>
          <button
            onClick={() => setActiveTab('UPLOAD')}
            className={`w-full text-left py-2.5 px-4 rounded-lg font-medium transition-colors ${activeTab === 'UPLOAD' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            대시보드 / 업로드
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
          {/* 모바일 전용 탭 전환 바 (사이드바가 숨겨지므로) */}
          <div className="flex md:hidden gap-2 mb-6">
            <button
              onClick={() => setActiveTab('MONITOR')}
              className={`flex-1 py-2.5 rounded-lg font-bold text-sm ${activeTab === 'MONITOR' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 border border-gray-300'}`}
            >
              실시간 관제
            </button>
            <button
              onClick={() => setActiveTab('UPLOAD')}
              className={`flex-1 py-2.5 rounded-lg font-bold text-sm ${activeTab === 'UPLOAD' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 border border-gray-300'}`}
            >
              대시보드 / 업로드
            </button>
          </div>
          {activeTab === 'UPLOAD' && (
            <>
              <h2 className="text-3xl font-bold mb-8 text-gray-900">모임 및 참가자 정보 업로드</h2>
              <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
                <form onSubmit={handleUpload} className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">모임명</label>
                    <input 
                      type="text" 
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                      placeholder="예: 2026년 공감 신년모임"
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

                  {/* 복도 설정 */}
                  <div className="bg-gray-50 p-4 rounded-xl border border-gray-200 space-y-4">
                    <p className="text-sm font-semibold text-gray-700">통로 위치 설정 <span className="font-normal text-gray-400">(선택사항)</span></p>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        가로 통로 — 해당 행 <span className="text-gray-400">뒤</span>에 통로를 추가할 행 번호 (쉼표로 구분)
                      </label>
                      <input
                        type="text"
                        value={aisleAfterRows}
                        onChange={(e) => setAisleAfterRows(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-gray-900 outline-none"
                        placeholder="예: 3, 6  →  3행과 4행 사이, 6행과 7행 사이에 통로"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        세로 통로 — 해당 열 <span className="text-gray-400">뒤</span>에 통로를 추가할 열 번호 (쉼표로 구분)
                      </label>
                      <input
                        type="text"
                        value={aisleAfterCols}
                        onChange={(e) => setAisleAfterCols(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-gray-900 outline-none"
                        placeholder="예: 4, 8  →  4열과 5열 사이, 8열과 9열 사이에 통로"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">참가자 명단 (CSV)</label>
                    <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-3">
                      <p className="text-xs text-gray-600 font-mono">
                        필수 컬럼: group_id, participant_name, password_4, order_in_group<br/>
                        <span className="text-gray-400 mt-1 block">예시: 1, 이충주, 0827, 1</span>
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
            <div className="flex flex-col h-full space-y-3">
              <h2 className="text-3xl font-bold text-gray-900">실시간 관제</h2>
              
              <div className="flex flex-col md:flex-row gap-4 items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex-1 w-full">
                  <label className="block text-base font-semibold text-gray-700 mb-2">모임 선택</label>
                  <select 
                    className="w-full px-4 py-3 rounded-xl border border-gray-300 outline-none focus:ring-2 focus:ring-gray-900"
                    value={selectedEventId || ''}
                    onChange={(e) => setSelectedEventId(e.target.value)}
                  >
                    <option value="">-- 모임을 선택하세요 --</option>
                    {events.map(ev => (
                      <option key={ev.id} value={ev.id}>{ev.name} (참가자 {ev._count?.participants || 0}명)</option>
                    ))}
                  </select>
                </div>
                
                {selectedEventId && (
                  <div className="w-full md:w-auto mt-4 md:mt-0 md:self-end flex flex-wrap gap-2">
                    <button
                      onClick={handleToggleLoginOpen}
                      style={{ backgroundColor: selectedEvent?.login_open ? '#6b7590' : '#17A85A' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      {selectedEvent?.login_open ? '입장 차단' : '입장 허용'}
                    </button>
                    <button
                      onClick={handleNextTurn}
                      style={{ backgroundColor: '#E8771A' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      자동배정
                    </button>
                    <button
                      onClick={handleToggleFreeze}
                      style={{ backgroundColor: isFrozen ? '#3d9e6a' : '#E03535' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      {isFrozen ? '재개' : '일시정지'}
                    </button>
                    <button
                      onClick={handleResetEvent}
                      title="테스트용: 모든 좌석 배정을 초기화합니다"
                      style={{ backgroundColor: '#1C71E8' }}
                      className="w-[96px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      초기화
                    </button>
                    <button
                      onClick={handleDeleteEvent}
                      style={{ backgroundColor: '#2d3142' }}
                      className="w-[96px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      삭제
                    </button>
                  </div>
                )}
              </div>

              {selectedEventId ? (
                <div className="flex-1 bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col relative min-h-[500px]">
                  {/* 현재 좌석지정자 및 남은 시간 표시 */}
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

                  <div className="flex-1 flex gap-4">
                    <div className="flex-[2] flex flex-col">
                      <div className="flex-1 border border-gray-200 rounded-xl overflow-hidden bg-gray-50 min-h-[400px]">
  <SeatMap forceAdmin={true} />
</div>
                      <p className="text-sm text-gray-500 mt-4 text-center font-medium">
                        선택된 좌석을 클릭하면 참가자 정보를 확인하고 강제 취소할 수 있습니다.
                      </p>
                    </div>
                    <div className="flex-1 flex flex-col min-h-[400px]">
                      <ChatWindow eventId={selectedEventId} />
                    </div>
                  </div>

                  {/* Session Info Panel */}
                  <div className="mt-4 p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <button
                      onClick={() => setIsSessionPanelOpen(prev => !prev)}
                      className="w-full flex items-center justify-between text-base font-bold text-gray-700"
                    >
                      <span>그룹별 현황 및 시간 설정</span>
                      <span className="text-gray-400">{isSessionPanelOpen ? '▲ 접기' : '▼ 펼치기'}</span>
                    </button>
                    {isSessionPanelOpen && (
                    <div className="flex flex-col gap-3 mt-3">
                      {sessionColors.map(sc => {
                        const sessionParticipants = participants.filter(p => p.session_id === sc.session_id);
                        const completedCount = sessionParticipants.filter(p => p.seat_id).length;
                        const totalCount = sessionParticipants.length;
                        const isEditing = editingSessionId === sc.id;
                        
                        return (
                          <div key={sc.session_id} className="relative group flex items-center justify-between bg-white px-4 py-2 rounded-lg border border-gray-200 shadow-sm">
                            <div className="flex items-center gap-3">
                              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: sc.color }}></div>
                              <span className="text-base font-semibold text-gray-800">그룹 {sc.session_id}</span>
                              <span className="text-sm text-gray-500">({completedCount}/{totalCount}명 완료)</span>
                            </div>
                            {/* 마우스 오버 시 그룹 참가자 명단 (순서대로) */}
                            {totalCount > 0 && (
                              <div className="absolute left-4 bottom-full mb-2 z-30 hidden group-hover:block bg-gray-900 text-white text-sm rounded-lg shadow-xl p-3 min-w-[200px] max-h-[300px] overflow-y-auto">
                                <p className="font-bold mb-2 text-gray-300">그룹 {sc.session_id} 참가자 순서</p>
                                {[...sessionParticipants]
                                  .sort((a, b) => a.turn_order - b.turn_order)
                                  .map((p, i) => (
                                    <div key={p.id} className="flex justify-between gap-4 py-0.5">
                                      <span>{i + 1}. {p.name}</span>
                                      <span className={p.seat_id ? 'text-green-400' : 'text-gray-400'}>{p.seat_id ? '완료' : '대기'}</span>
                                    </div>
                                  ))}
                              </div>
                            )}
                            
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
                    )}
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
