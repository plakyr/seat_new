import React from 'react';
import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';
import SeatMap from '../components/SeatMap';
import ChatWindow from '../components/ChatWindow';
import AnnouncementBar from '../components/AnnouncementBar';
import { formatSessionTime } from '../utils/time';

// 저장된 시간 문자열("HH:MM" 또는 "YYYY-MM-DDTHH:MM")을 datetime-local 입력값으로 변환.
// 기존 "HH:MM" 값은 오늘 날짜를 붙여 보여준다 (저장 시에는 날짜 포함 형식으로 저장됨).
function toDatetimeLocalValue(value: string | null | undefined): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}$/.test(value)) return value;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(Number(m[1]))}:${m[2]}`;
}

export default function Admin() {
  const { adminToken, adminUser, setAdminAuth, isFrozen, frozenReason, currentTurnOrder, currentTurnStartTime, sessionColors, participants, serverTime, announcement, timerPaused, onlineParticipantIds, hasReceivedSystemState } = useStore();
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
  const [layoutMode, setLayoutMode] = useState<'simple' | 'grid'>('simple');
  const [seatFile, setSeatFile] = useState<File | null>(null);
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

  // 비밀번호 변경 모달 상태
  const [isPwModalOpen, setIsPwModalOpen] = useState(false);
  const [curPw, setCurPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwSaving, setPwSaving] = useState(false);

  // 동료 비밀번호 초기화 모달 상태
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [adminList, setAdminList] = useState<string[]>([]);
  const [resetTarget, setResetTarget] = useState('');
  const [resetMyPw, setResetMyPw] = useState('');
  const [resetError, setResetError] = useState('');
  const [resetSaving, setResetSaving] = useState(false);
  const [resetResult, setResetResult] = useState<string | null>(null);

  // 관리자 화면 진입 시 참가자 상태(메모리)만 초기화. 저장된 참가자 세션(sessionStorage)은
  // 건드리지 않는다 — 같은 탭에서 다시 /user로 돌아왔을 때 로그인이 유지되게 하기 위함
  useEffect(() => {
    useStore.getState().clearParticipantMemory();
  }, []);

  useEffect(() => {
    if (adminToken && activeTab === 'MONITOR') {
      fetchEvents();
    }
  }, [adminToken, activeTab]);

  useEffect(() => {
    // 소켓 재연결 시 자동 재입장에 쓰도록 현재 관제 중인 이벤트 ID를 스토어에 보관
    useStore.getState().setAdminEventId(selectedEventId);
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

    if (layoutMode === 'grid' && !seatFile) {
      setStatus('격자 방식에서는 좌석 배치 CSV 파일을 선택해주세요.');
      return;
    }

    const formData = new FormData();
    formData.append('name', eventName);
    formData.append('rows', rows);
    formData.append('cols', cols);
    formData.append('file', file);
    formData.append('layout_mode', layoutMode);
    if (layoutMode === 'grid' && seatFile) formData.append('seatFile', seatFile);
    if (layoutMode === 'simple') {
      if (aisleAfterRows.trim()) formData.append('aisle_after_rows', aisleAfterRows.trim());
      if (aisleAfterCols.trim()) formData.append('aisle_after_cols', aisleAfterCols.trim());
    }

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
        setSeatFile(null);
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

  const handleSkipTurn = () => {
    if (!selectedEventId || !socket) return;
    if (confirm('현재 참가자에게 좌석을 배정하지 않고 건너뛰시겠습니까?\n(불참/오류 시 사용 — 좌석 없이 다음 턴으로 넘어갑니다)')) {
      socket.emit('admin:skip_turn', { eventId: selectedEventId });
    }
  };

  const handleForceReload = () => {
    if (!selectedEventId || !socket) return;
    if (confirm('전체 참가자 화면에 강제 새로고침 신호를 보내시겠습니까?\n(화면이 멈춰 보일 때 사용)')) {
      socket.emit('admin:force_reload', { eventId: selectedEventId });
    }
  };

  // 관리자 화면의 상태(좌석/참가자/공지/채팅)만 서버에서 다시 받아온다.
  // 참가자에게는 아무 신호도 보내지 않으며(force_reload 미사용), 세션/토큰도 건드리지 않는다.
  const handleReloadState = () => {
    if (!selectedEventId || !socket) return;
    socket.emit('admin:request_event', { eventId: selectedEventId });
    // 조용한 상태 교체라 눌러도 반응이 없어 보이므로, 동작했음을 토스트로 알려준다
    useStore.getState().addToast('최신 상태를 다시 불러왔습니다.', 'info');
  };

  const handleResetEvent = async () => {
    if (!selectedEventId || !socket) return;
    const target = events.find(ev => ev.id === selectedEventId);
    const eventName = target?.name ?? '';
    const input = window.prompt(
      `[초기화 확인]\n이 이벤트의 모든 좌석 배정과 채팅 기록이 삭제되어 처음부터 다시 시작됩니다. 이 작업은 되돌릴 수 없습니다.\n\n계속하려면 아래에 이벤트 이름을 정확히 입력하세요:\n${eventName}`
    );
    if (input === null) return; // 취소
    if (input.trim() !== eventName) {
      alert('이벤트 이름이 일치하지 않아 초기화를 취소했습니다.');
      return;
    }
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
    const eventName = target?.name ?? '';
    const input = window.prompt(
      `[삭제 확인]\n이 이벤트와 모든 참가자·좌석·채팅·로그가 완전히 삭제됩니다. 이 작업은 되돌릴 수 없습니다.\n\n계속하려면 아래에 이벤트 이름을 정확히 입력하세요:\n${eventName}`
    );
    if (input === null) return; // 취소
    if (input.trim() !== eventName) {
      alert('이벤트 이름이 일치하지 않아 삭제를 취소했습니다.');
      return;
    }
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

  const openPwModal = () => {
    setCurPw(''); setNewPw(''); setNewPw2(''); setPwError('');
    setIsPwModalOpen(true);
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    setPwError('');
    if (newPw.length < 8) { setPwError('새 비밀번호는 8자 이상이어야 합니다.'); return; }
    if (newPw !== newPw2) { setPwError('새 비밀번호가 서로 일치하지 않습니다.'); return; }
    setPwSaving(true);
    try {
      const res = await fetch('/api/admin/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (res.ok) {
        setIsPwModalOpen(false);
        useStore.getState().addToast('비밀번호가 변경되었습니다.', 'info');
      } else {
        setPwError(data.error || '비밀번호 변경에 실패했습니다.');
      }
    } catch {
      setPwError('서버 오류가 발생했습니다.');
    } finally {
      setPwSaving(false);
    }
  };

  const openResetModal = async () => {
    setResetTarget(''); setResetMyPw(''); setResetError(''); setResetResult(null);
    setIsPwModalOpen(false);
    setIsResetModalOpen(true);
    try {
      const res = await fetch('/api/admin/admins', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const data = await res.json();
      if (res.ok) {
        setAdminList((data.admins || []).filter((u: string) => u !== adminUser?.username));
      }
    } catch { /* 목록 로딩 실패 시 빈 목록 유지 */ }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminToken) return;
    setResetError('');
    if (!resetTarget) { setResetError('초기화할 계정을 선택해주세요.'); return; }
    setResetSaving(true);
    try {
      const res = await fetch('/api/admin/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminToken}` },
        body: JSON.stringify({ targetUsername: resetTarget, myPassword: resetMyPw }),
      });
      const data = await res.json();
      if (res.ok) {
        setResetResult(data.tempPassword);
      } else {
        setResetError(data.error || '비밀번호 초기화에 실패했습니다.');
      }
    } catch {
      setResetError('서버 오류가 발생했습니다.');
    } finally {
      setResetSaving(false);
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
      {/* 비밀번호 변경 모달 */}
      {isPwModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">비밀번호 변경 <span className="text-sm font-medium text-gray-400">({adminUser?.username})</span></h3>
              <button onClick={() => setIsPwModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <form onSubmit={handleChangePassword} className="space-y-3">
              <input
                type="password"
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                placeholder="현재 비밀번호"
                required
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none"
              />
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder="새 비밀번호 (8자 이상)"
                required
                minLength={8}
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none"
              />
              <input
                type="password"
                value={newPw2}
                onChange={(e) => setNewPw2(e.target.value)}
                placeholder="새 비밀번호 확인"
                required
                className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none"
              />
              {pwError && <p className="text-red-500 text-sm font-medium">{pwError}</p>}
              <button
                type="submit"
                disabled={pwSaving}
                className="w-full py-3 bg-gray-900 hover:bg-black text-white rounded-xl font-bold disabled:opacity-50 transition-colors"
              >
                {pwSaving ? '변경 중...' : '변경하기'}
              </button>
            </form>
            <p className="mt-3 text-xs text-gray-400 leading-relaxed">
              본인 계정의 비밀번호만 변경됩니다. 변경 후에도 현재 로그인은 유지되며, 다른 관리자 계정에는 영향이 없습니다.
            </p>
            <button
              onClick={openResetModal}
              className="mt-2 text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2"
            >
              비밀번호를 잊은 관리자가 있나요? → 관리자 비밀번호 초기화
            </button>
          </div>
        </div>
      )}

      {/* 관리자 비밀번호 초기화 모달 */}
      {isResetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-gray-900">관리자 비밀번호 초기화</h3>
              <button onClick={() => setIsResetModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            {resetResult ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-700">
                  <span className="font-bold">{resetTarget}</span> 계정의 임시 비밀번호가 발급되었습니다:
                </p>
                <div className="bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 text-center">
                  <span className="font-mono font-bold text-2xl tracking-widest select-all">{resetResult}</span>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  이 값은 지금 한 번만 표시됩니다. 동료에게 안전한 방법으로 전달하고,
                  로그인 후 반드시 "비밀번호 변경"으로 본인만 아는 비밀번호로 바꾸도록 안내해주세요.
                </p>
                <button
                  onClick={() => setIsResetModalOpen(false)}
                  className="w-full py-3 bg-gray-900 hover:bg-black text-white rounded-xl font-bold transition-colors"
                >
                  확인
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-3">
                <select
                  value={resetTarget}
                  onChange={(e) => setResetTarget(e.target.value)}
                  required
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none bg-white"
                >
                  <option value="">-- 초기화할 계정 선택 --</option>
                  {adminList.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
                <input
                  type="password"
                  value={resetMyPw}
                  onChange={(e) => setResetMyPw(e.target.value)}
                  placeholder="본인 비밀번호 (확인용)"
                  required
                  className="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none"
                />
                {resetError && <p className="text-red-500 text-sm font-medium">{resetError}</p>}
                <button
                  type="submit"
                  disabled={resetSaving}
                  className="w-full py-3 bg-gray-900 hover:bg-black text-white rounded-xl font-bold disabled:opacity-50 transition-colors"
                >
                  {resetSaving ? '발급 중...' : '임시 비밀번호 발급'}
                </button>
                <p className="text-xs text-gray-400 leading-relaxed">
                  선택한 계정의 비밀번호가 임시 비밀번호로 교체됩니다. 도용 방지를 위해 본인 비밀번호를 다시 확인합니다.
                </p>
              </form>
            )}
          </div>
        </div>
      )}
      {/* 사이드바를 화면에 고정(sticky)해, 본문을 스크롤해도 메뉴와 하단 로그아웃
          버튼이 항상 같은 자리에 보이게 한다 */}
      <aside className="w-64 bg-gray-900 text-white p-6 hidden md:flex flex-col md:sticky md:top-0 md:h-screen shrink-0">
        <h1 className="text-2xl font-bold mb-8 tracking-tight">관리자 메뉴</h1>
        <div className="mb-6 pb-6 border-b border-gray-800">
          <p className="text-sm text-gray-400">접속 계정</p>
          <p className="font-medium text-lg">{adminUser?.username}</p>
          <div className="mt-2 flex flex-col items-start gap-1">
            <button
              onClick={openPwModal}
              className="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition-colors"
            >
              비밀번호 변경
            </button>
            <button
              onClick={openResetModal}
              className="text-xs text-gray-400 hover:text-white underline underline-offset-2 transition-colors"
            >
              관리자 비밀번호 초기화
            </button>
          </div>
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
        <div className="max-w-5xl lg:max-w-none mx-auto h-full flex flex-col">
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
            {/* 모바일용 비밀번호 변경 (사이드바가 숨겨지므로) */}
            <button
              onClick={openPwModal}
              title="비밀번호 변경"
              className="px-3 py-2.5 rounded-lg text-sm font-bold bg-white text-gray-600 border border-gray-300"
            >
              🔒
            </button>
            {/* 모바일용 로그아웃 (사이드바가 숨겨지므로) */}
            <button
              onClick={() => setAdminAuth(null, null)}
              className="px-3 py-2.5 rounded-lg text-sm font-bold bg-white text-gray-600 border border-gray-300 whitespace-nowrap"
            >
              로그아웃
            </button>
          </div>
          {activeTab === 'UPLOAD' && (
            <div className="w-full lg:max-w-4xl">
              <h2 className="text-3xl font-bold mb-8 text-gray-900">이벤트 및 참가자 정보 업로드</h2>
              <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100">
                <form onSubmit={handleUpload} className="space-y-6">
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">이벤트명</label>
                    <input 
                      type="text" 
                      value={eventName}
                      onChange={(e) => setEventName(e.target.value)}
                      className="w-full px-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-gray-900 outline-none transition-all"
                      placeholder="예: 2026년 공감 신년모임"
                      required
                    />
                  </div>
                  
                  {/* 좌석표 생성 방식 선택 */}
                  <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">좌석표 생성 방식</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setLayoutMode('simple')}
                        className={`px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all ${layoutMode === 'simple' ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'}`}
                      >
                        기존 방식 (행/열 + 통로)
                      </button>
                      <button
                        type="button"
                        onClick={() => setLayoutMode('grid')}
                        className={`px-4 py-3 rounded-xl border-2 text-sm font-bold transition-all ${layoutMode === 'grid' ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'}`}
                      >
                        격자 CSV 업로드
                      </button>
                    </div>
                  </div>

                  {layoutMode === 'simple' ? (
                    <>
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
                            가로 통로 — 해당 행 <span className="text-gray-900 font-bold">뒤</span>에 통로를 추가할 행 번호 (쉼표로 구분)
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
                            세로 통로 — 해당 열 <span className="text-gray-900 font-bold">뒤</span>에 통로를 추가할 열 번호 (쉼표로 구분)
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
                    </>
                  ) : (
                    <div>
                      <label className="block text-sm font-semibold text-gray-700 mb-2">좌석 배치 (격자 CSV)</label>
                      <div className="bg-gray-50 p-4 rounded-lg border border-gray-200 mb-3">
                        <p className="text-xs text-gray-600 leading-relaxed">
                          엑셀 격자에 <span className="font-bold text-gray-900">좌석 번호</span>를 그대로 적고, <span className="font-bold text-gray-900">빈 칸</span>은 통로/여백으로 둡니다.<br/>
                          한 칸 = 좌석 1개. 화면에는 적으신 번호가 그대로 표시됩니다.<br/>
                          <span className="text-gray-400 mt-1 block font-mono">예: 1,2,3,,4,5  →  3번 뒤에 통로</span>
                        </p>
                      </div>
                      <input
                        type="file"
                        accept=".csv"
                        onChange={(e) => setSeatFile(e.target.files?.[0] || null)}
                        className="w-full px-4 py-3 border border-gray-300 rounded-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-gray-900 file:text-white hover:file:bg-gray-800 cursor-pointer"
                      />
                    </div>
                  )}

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
            </div>
          )}

          {activeTab === 'MONITOR' && (
            <div className="flex flex-col h-full space-y-3">
              <h2 className="text-3xl font-bold text-gray-900">실시간 관제</h2>
              
              <div className="flex flex-col md:flex-row gap-4 items-center bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <div className="flex-1 w-full">
                  <label className="block text-base font-semibold text-gray-700 mb-2">이벤트 선택</label>
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
                      onClick={handleSkipTurn}
                      title="현재 참가자에게 좌석을 주지 않고 다음 턴으로 넘깁니다 (불참/오류 대응)"
                      style={{ backgroundColor: '#E8771A' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      턴넘김
                    </button>
                    <button
                      onClick={handleToggleFreeze}
                      style={{ backgroundColor: isFrozen ? '#3d9e6a' : '#E03535' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      {isFrozen ? '재개' : '일시정지'}
                    </button>
                    <button
                      onClick={handleForceReload}
                      title="전체 참가자 화면에 강제 새로고침 신호를 보냅니다 (화면 멈춤 복구용)"
                      style={{ backgroundColor: '#2f8f8f' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      새로고침(참가자)
                    </button>
                    <button
                      onClick={handleReloadState}
                      title="관리자 화면의 좌석·참가자·공지·채팅 상태만 서버에서 다시 받아옵니다 (참가자에게는 영향 없음)"
                      style={{ backgroundColor: '#2f8f8f' }}
                      className="w-[120px] py-3 rounded-lg text-base font-bold text-white transition-opacity shadow-sm hover:opacity-90"
                    >
                      새로고침(관리자)
                    </button>
                    <button
                      onClick={handleResetEvent}
                      title="테스트용: 모든 좌석 배정을 초기화합니다"
                      style={{ backgroundColor: '#2d3142' }}
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
                  {/* 현재 좌석지정자 및 남은 시간 표시.
                      턴/공지 상태가 바뀔 때마다 컴포넌트를 완전히 새로 마운트해,
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

                  <div className="flex-1 flex gap-4 min-w-0">
                    <div className="flex-[2] flex flex-col min-w-0">
                      <div className="flex-1 border border-gray-200 rounded-xl overflow-hidden bg-gray-50 min-h-[400px]">
  <SeatMap forceAdmin={true} />
</div>
                      <p className="text-sm text-gray-500 mt-4 text-center font-medium">
                        선택된 좌석을 클릭하면 참가자 정보를 확인하고 강제 취소할 수 있습니다.
                      </p>
                    </div>
                    <div className="flex-1 lg:flex-none lg:w-[370px] lg:shrink-0 flex flex-col min-w-0 h-[50vh] lg:h-[70vh]">
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
                      {[...sessionColors]
                        .sort((a, b) => (Number(a.session_id) - Number(b.session_id)) || String(a.session_id).localeCompare(String(b.session_id)))
                        .map(sc => {
                        const sessionParticipants = participants.filter(p => p.session_id === sc.session_id);
                        const completedCount = sessionParticipants.filter(p => p.seat_id).length;
                        const totalCount = sessionParticipants.length;
                        const onlineCount = sessionParticipants.filter(p => onlineParticipantIds.includes(p.id)).length;
                        const isEditing = editingSessionId === sc.id;
                        
                        return (
                          <div key={sc.session_id} className="relative group flex items-center justify-between bg-white px-4 py-2 rounded-lg border border-gray-200 shadow-sm">
                            <div className="flex items-center gap-3">
                              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: sc.color }}></div>
                              <span className="text-base font-semibold text-gray-800">그룹 {sc.session_id}</span>
                              <span className="text-sm text-gray-500">({completedCount}/{totalCount}명 완료)</span>
                              <span className="flex items-center gap-1 text-sm text-green-600">
                                <span className="w-2 h-2 rounded-full bg-green-500"></span>
                                {onlineCount}명 접속
                              </span>
                            </div>
                            {/* 마우스 오버 시 그룹 참가자 명단 (순서대로) */}
                            {totalCount > 0 && (
                              <div className="absolute left-4 bottom-full mb-2 z-30 hidden group-hover:block bg-gray-900 text-white text-sm rounded-lg shadow-xl p-3 min-w-[200px]">
                                <p className="font-bold mb-2 text-gray-300">그룹 {sc.session_id} 참가자 순서</p>
                                {/* 관전 그룹(추가)은 전원 turn_order 0이라 이름순(숫자 인식)으로 2차 정렬해
                                    로그인 등으로 DB 행 순서가 바뀌어도 표시 순서를 고정한다 */}
                                {[...sessionParticipants]
                                  .sort((a, b) => (a.turn_order - b.turn_order) || a.name.localeCompare(b.name, 'ko', { numeric: true }))
                                  .map((p, i) => (
                                    <div key={p.id} className="flex justify-between gap-4 py-0.5">
                                      <span className="flex items-center gap-1.5">
                                        <span className={`w-1.5 h-1.5 rounded-full ${onlineParticipantIds.includes(p.id) ? 'bg-green-400' : 'bg-gray-600'}`}></span>
                                        {i + 1}. {p.name}
                                      </span>
                                      <span className={p.seat_id ? 'text-green-400' : 'text-gray-400'}>{p.seat_id ? '완료' : '대기'}</span>
                                    </div>
                                  ))}
                              </div>
                            )}
                            
                            <div className="flex items-center gap-2">
                              {/* '추가' 그룹은 관전용이라 시간 설정이 동작에 영향을 주지 않으므로
                                  혼동하지 않도록 시간 설정 UI를 숨긴다 */}
                              {sc.session_id === '추가' ? (
                                <span className="text-sm text-gray-400">관전용 — 시간 설정 없음</span>
                              ) : isEditing ? (
                                <>
                                  <input 
                                    type="datetime-local"
                                    value={editStartTime} 
                                    onChange={e => setEditStartTime(e.target.value)}
                                    className="border border-gray-300 rounded px-2 py-1 text-sm"
                                  />
                                  <span className="text-gray-500">-</span>
                                  <input 
                                    type="datetime-local"
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
                                    {formatSessionTime(sc.start_time) || '--:--'} ~ {formatSessionTime(sc.end_time) || '--:--'}
                                  </span>
                                  <button
                                    onClick={() => {
                                      setEditingSessionId(sc.id);
                                      setEditStartTime(toDatetimeLocalValue(sc.start_time));
                                      setEditEndTime(toDatetimeLocalValue(sc.end_time));
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
