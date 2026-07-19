import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useStore, Seat, User } from './useStore';
import { sessionStartEpochMs } from '../utils/time';

let socketInstance: Socket | null = null;

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(socketInstance);

  // useRef로 최신 값 유지 → 리스너 재등록 없이 항상 최신 상태 접근 가능
  const storeRef = useRef(useStore.getState());
  useEffect(() => {
    return useStore.subscribe((state) => { storeRef.current = state; });
  }, []);

  // 서버 시간 보정 오프셋 (서버시각 - 클라시각). time:sync 때마다 갱신.
  const offsetRef = useRef<number>(0);

  useEffect(() => {
    if (socketInstance) {
      setSocket(socketInstance);
      return;
    }

    socketInstance = io(window.location.origin);

    // ── 인증 불필요한 전역 이벤트 ──────────────────────────────────────
    socketInstance.on('connect', () => {
      console.log('Connected:', socketInstance?.id);
      // 재연결 시 재인증
      const { user, sessionToken, adminToken, adminEventId } = storeRef.current;
      if (user && sessionToken) {
        socketInstance!.emit('participant:auth', { participantId: user.id, sessionToken });
        socketInstance!.emit('seat:request_init', { eventId: user.event_id });
      }
      if (adminToken) {
        socketInstance!.emit('admin:auth', { token: adminToken });
        // 관제 중이던 이벤트가 있으면 방에 자동 재입장 + 최신 상태 재수신.
        // (재연결 시 서버의 방 정보가 사라지므로, 이걸 안 보내면 접속자 수·좌석
        //  변화 등 실시간 갱신이 멈춘 채 마지막 값으로 굳어 보인다)
        if (adminEventId) {
          socketInstance!.emit('admin:request_event', { eventId: adminEventId });
        }
      }
    });

    socketInstance.on('time:sync', (data: { serverTime: string }) => {
      offsetRef.current = new Date(data.serverTime).getTime() - Date.now();
      storeRef.current.setServerTime(data.serverTime);
    });

    socketInstance.on('system:freeze', (data: { isFrozen: boolean; reason: string | null }) => {
      storeRef.current.setSystemState(data.isFrozen, data.reason);
    });

    // 관리자의 강제 재동기화 신호 → 참가자 화면만 새로고침 (관리자는 무시)
    // 참가자 세션은 sessionStorage에 저장돼 있어 새로고침해도 로그인이 유지된다.
    socketInstance.on('force_reload', () => {
      if (storeRef.current.isAdmin) return;
      window.location.reload();
    });

    socketInstance.on('system:turn', (data: { currentTurnOrder: number; currentTurnStartTime: string }) => {
      // 새 차례 공지 뜨는 순간 타이머 재개 + 시작 시간 갱신
      storeRef.current.setTimerPaused(false);
      storeRef.current.setAnnouncement({
        type: 'IDLE', currentParticipantName: null, prevSessionId: null, nextSessionId: null, nextStartTime: null,
      });
      storeRef.current.setSystemTurn(data.currentTurnOrder, data.currentTurnStartTime);
    });

    socketInstance.on('session:colors', (data: { sessionColors: any[] }) => {
      storeRef.current.setSessionColors(data.sessionColors);
    });

    socketInstance.on('seat:init', (data: { seats: Seat[]; layout?: any }) => {
      storeRef.current.setSeats(data.seats);
      if (data.layout) storeRef.current.setLayout(data.layout);
    });

    socketInstance.on('seat:update', (data: { seat: Seat }) => {
      storeRef.current.updateSeat(data.seat);
    });

    // ── 인증 관련 이벤트 ────────────────────────────────────────────────
    socketInstance.on('session:expired', (data: { reason: string }) => {
      storeRef.current.addToast(data.reason, 'error');
      storeRef.current.logoutUser();
    });

    // 알림 중복 방지: 마지막으로 보낸 시각 추적
    let lastSeatErrorAt = 0;
    socketInstance.on('seat:error', (data: { error: string }) => {
      const now = Date.now();
      if (now - lastSeatErrorAt > 1000) { // 1초 내 중복 무시
        lastSeatErrorAt = now;
        storeRef.current.addToast(data.error, 'error');
      }
    });

    socketInstance.on('participant:update', (data: { participant: User }) => {
      const { sessionToken } = storeRef.current;
      storeRef.current.setUser(data.participant, sessionToken);
    });

    socketInstance.on('admin:event_data', (data: {
      seats: Seat[]; layout?: any; participants: User[];
      systemState: any; sessionColors?: any[]; messages?: any[]
    }) => {
      storeRef.current.setSeats(data.seats);
      if (data.layout) storeRef.current.setLayout(data.layout);
      storeRef.current.setParticipants(data.participants);
      if (data.systemState) {
        storeRef.current.setSystemState(data.systemState.is_frozen, data.systemState.frozen_reason);
        storeRef.current.setSystemTurn(data.systemState.current_turn_order, data.systemState.current_turn_start_time);
      } else {
        storeRef.current.setSystemState(false, null);
        storeRef.current.setSystemReady();
      }
      if (data.sessionColors) storeRef.current.setSessionColors(data.sessionColors);
      if (data.messages) storeRef.current.setMessages(data.messages);
    });

    socketInstance.on('participant:update_admin', (data: { participant: User }) => {
      storeRef.current.updateParticipant(data.participant);
    });

    socketInstance.on('admin:error', (data: { error: string }) => {
      storeRef.current.addToast(`관리자 오류: ${data.error}`, 'error');
    });

    socketInstance.on('admin:info', (data: { message: string }) => {
      storeRef.current.addToast(data.message, 'info');
    });

    socketInstance.on('presence:update', (data: { online: string[] }) => {
      storeRef.current.setOnlineParticipantIds(data.online);
    });

    socketInstance.on('chat:history', (data: { messages: any[] }) => {
      storeRef.current.setMessages(data.messages);
    });

    socketInstance.on('chat:message', (data: any) => {
      storeRef.current.addMessage(data);
    });

    socketInstance.on('chat:error', (data: { error: string }) => {
      storeRef.current.addToast(`채팅 오류: ${data.error}`, 'error');
    });

    socketInstance.on('system:auto_assign', (data: { participantName: string }) => {
      // 자동배정 진행 중 타이머 멈춤
      storeRef.current.setTimerPaused(true);
      storeRef.current.setAnnouncement({
        type: 'AUTO_ASSIGN',
        currentParticipantName: data.participantName,
        prevSessionId: null,
        nextSessionId: null,
        nextStartTime: null,
      });
      // system:turn 이벤트에서 타이머 재개되므로 setTimeout 제거
    });

    socketInstance.on('system:session_change', (data: { prevSession: string | null; nextSession: string; nextStartTime: string | null }) => {
      storeRef.current.setSystemReady();
      storeRef.current.setAnnouncement({
        type: 'SESSION_CHANGE',
        currentParticipantName: null,
        prevSessionId: data.prevSession,
        nextSessionId: data.nextSession,
        nextStartTime: data.nextStartTime,
      });
    });

    socketInstance.on('system:all_complete', () => {
      storeRef.current.setSystemReady();
      storeRef.current.setAnnouncement({
        type: 'ALL_COMPLETE',
        currentParticipantName: null,
        prevSessionId: null,
        nextSessionId: null,
        nextStartTime: null,
      });
    });

    // 재동기화 안전망: 그룹 시작 시각이 지났는데도 여전히 대기(SESSION_CHANGE) 상태로
    // 남아 있으면(실시간 push 유실 등) 서버에 현재 상태를 다시 요청해 강제로 동기화한다.
    // 정상 상태(비대기/시작 전)에서는 아무것도 하지 않으며, 비정상 상태에서도 3초에 한 번만
    // 요청해 서버 부하를 최소화한다.
    let lastResyncAt = 0;
    setInterval(() => {
      const st = storeRef.current;
      if (st.announcement.type !== 'SESSION_CHANGE') return;
      const startStr = st.announcement.nextStartTime;
      if (!startStr) return;
      // 서버 보정 시각 기준으로 시작 시각이 지났는지 확인
      // ("HH:MM"은 오늘, "YYYY-MM-DDTHH:MM"은 지정 날짜 기준 — utils/time 참고)
      const nowMs = Date.now() + offsetRef.current;
      const startMs = sessionStartEpochMs(startStr, nowMs);
      if (startMs == null) return;
      if (nowMs < startMs) return; // 아직 시작 전 → 정상 대기
      if (Date.now() - lastResyncAt < 3000) return; // 3초 스로틀
      lastResyncAt = Date.now();
      // 참가자는 seat:request_init로 현재 상태를 다시 받아온다 (관리자는 '새로고침(관리자)' 버튼 사용)
      const { user } = st;
      if (user) socketInstance!.emit('seat:request_init', { eventId: user.event_id });
    }, 1000);

    setSocket(socketInstance);
  }, []); // 딱 한 번만 실행 → 리스너 중복 등록 원천 차단

  // 로그인/로그아웃 시 인증 이벤트 전송
  // useStore()로 직접 구독해야, 이 훅을 호출한 컴포넌트가 다른 이유로 리렌더링되길
  // 기다리지 않고도 로그인/로그아웃 시점에 정확히 재실행된다.
  const userId = useStore((state) => state.user?.id);
  const sessionToken = useStore((state) => state.sessionToken);
  const adminToken = useStore((state) => state.adminToken);

  useEffect(() => {
    if (!socketInstance) return;
    const { user, sessionToken, adminToken } = useStore.getState();
    if (user && sessionToken) {
      socketInstance.emit('participant:auth', { participantId: user.id, sessionToken });
      socketInstance.emit('seat:request_init', { eventId: user.event_id });
    }
    if (adminToken) {
      socketInstance.emit('admin:auth', { token: adminToken });
    }
  }, [userId, sessionToken, adminToken]);

  return socket;
};
