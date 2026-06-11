import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useStore, Seat, User } from './useStore';

let socketInstance: Socket | null = null;

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(socketInstance);

  // useRef로 최신 값 유지 → 리스너 재등록 없이 항상 최신 상태 접근 가능
  const storeRef = useRef(useStore.getState());
  useEffect(() => {
    return useStore.subscribe((state) => { storeRef.current = state; });
  }, []);

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
      const { user, sessionToken, adminToken } = storeRef.current;
      if (user && sessionToken) {
        socketInstance!.emit('participant:auth', { participantId: user.id, sessionToken });
        socketInstance!.emit('seat:request_init', { eventId: user.event_id });
      }
      if (adminToken) {
        socketInstance!.emit('admin:auth', { token: adminToken });
      }
    });

    socketInstance.on('time:sync', (data: { serverTime: string }) => {
      storeRef.current.setServerTime(data.serverTime);
    });

    socketInstance.on('system:freeze', (data: { isFrozen: boolean; reason: string | null }) => {
      storeRef.current.setSystemState(data.isFrozen, data.reason);
    });

    socketInstance.on('system:turn', (data: { currentTurnOrder: number; currentTurnStartTime: string }) => {
      // 새 차례 공지 뜨는 순간 타이머 재개 + 시작 시간 갱신
      storeRef.current.setTimerPaused(false);
      storeRef.current.setAnnouncement({
        type: 'IDLE', currentParticipantName: null, nextSessionId: null, nextStartTime: null,
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
      alert(data.reason);
      storeRef.current.logoutUser();
    });

    // 팝업 중복 방지: 마지막으로 보낸 시각 추적
    let lastSeatErrorAt = 0;
    socketInstance.on('seat:error', (data: { error: string }) => {
      const now = Date.now();
      if (now - lastSeatErrorAt > 1000) { // 1초 내 중복 무시
        lastSeatErrorAt = now;
        alert(data.error);
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
      }
      if (data.sessionColors) storeRef.current.setSessionColors(data.sessionColors);
      if (data.messages) storeRef.current.setMessages(data.messages);
    });

    socketInstance.on('participant:update_admin', (data: { participant: User }) => {
      storeRef.current.updateParticipant(data.participant);
    });

    socketInstance.on('admin:error', (data: { error: string }) => {
      alert(`관리자 오류: ${data.error}`);
    });

    socketInstance.on('chat:history', (data: { messages: any[] }) => {
      storeRef.current.setMessages(data.messages);
    });

    socketInstance.on('chat:message', (data: any) => {
      storeRef.current.addMessage(data);
    });

    socketInstance.on('chat:error', (data: { error: string }) => {
      alert(`채팅 오류: ${data.error}`);
    });

    socketInstance.on('system:auto_assign', (data: { participantName: string }) => {
      // 자동배정 진행 중 타이머 멈춤
      storeRef.current.setTimerPaused(true);
      storeRef.current.setAnnouncement({
        type: 'AUTO_ASSIGN',
        currentParticipantName: data.participantName,
        nextSessionId: null,
        nextStartTime: null,
      });
      // system:turn 이벤트에서 타이머 재개되므로 setTimeout 제거
    });

    socketInstance.on('system:session_change', (data: { prevSession: string; nextSession: string; nextStartTime: string | null }) => {
      storeRef.current.setAnnouncement({
        type: 'SESSION_CHANGE',
        currentParticipantName: null,
        nextSessionId: data.nextSession,
        nextStartTime: data.nextStartTime,
      });
    });

    setSocket(socketInstance);
  }, []); // 딱 한 번만 실행 → 리스너 중복 등록 원천 차단

  // 로그인/로그아웃 시 인증 이벤트 전송
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
  }, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useStore.getState().user?.id,
    useStore.getState().sessionToken,
    useStore.getState().adminToken,
  ]);

  return socket;
};
