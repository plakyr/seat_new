import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useStore, Seat, User } from './useStore';

let socketInstance: Socket | null = null;

export const useSocket = () => {
  const [socket, setSocket] = useState<Socket | null>(socketInstance);
  const setServerTime = useStore((state) => state.setServerTime);
  const setSystemState = useStore((state) => state.setSystemState);
  const setSeats = useStore((state) => state.setSeats);
  const updateSeat = useStore((state) => state.updateSeat);
  const user = useStore((state) => state.user);
  const sessionToken = useStore((state) => state.sessionToken);
  const logoutUser = useStore((state) => state.logoutUser);
  const setUser = useStore((state) => state.setUser);
  const adminToken = useStore((state) => state.adminToken);
  const setParticipants = useStore((state) => state.setParticipants);
  const updateParticipant = useStore((state) => state.updateParticipant);

  const setSystemTurn = useStore((state) => state.setSystemTurn);
  const setLayout = useStore((state) => state.setLayout);
  const setAnnouncement = useStore((state) => state.setAnnouncement);

  useEffect(() => {
    if (!socketInstance) {
      // Connect to the same origin
      socketInstance = io(window.location.origin);
      
      socketInstance.on('connect', () => {
        console.log('Connected to WebSocket server');
      });

      socketInstance.on('time:sync', (data: { serverTime: string }) => {
        setServerTime(data.serverTime);
      });

      socketInstance.on('system:freeze', (data: { isFrozen: boolean; reason: string | null }) => {
        setSystemState(data.isFrozen, data.reason);
      });

      socketInstance.on('system:turn', (data: { currentTurnOrder: number; currentTurnStartTime: string }) => {
        setSystemTurn(data.currentTurnOrder, data.currentTurnStartTime);
      });

      socketInstance.on('session:colors', (data: { sessionColors: { session_id: string; color: string }[] }) => {
        useStore.getState().setSessionColors(data.sessionColors);
      });

      socketInstance.on('seat:init', (data: { seats: Seat[], layout?: any }) => {
        setSeats(data.seats);
        if (data.layout) setLayout(data.layout);
      });

      socketInstance.on('seat:update', (data: { seat: Seat }) => {
        updateSeat(data.seat);
      });

      setSocket(socketInstance);
    }

    return () => {
      // We don't disconnect here to keep the connection alive across routes
    };
  }, [setServerTime, setSystemState, setSystemTurn, setSeats, updateSeat]);

  // Handle user authentication and session expiry
  useEffect(() => {
    if (!socketInstance) return;

    if (user && sessionToken) {
      socketInstance.emit('participant:auth', { participantId: user.id, sessionToken });
      // Request initial seat data for the event
      socketInstance.emit('seat:request_init', { eventId: user.event_id });
    }

    if (adminToken) {
      socketInstance.emit('admin:auth', { token: adminToken });
    }

    const handleSessionExpired = (data: { reason: string }) => {
      alert(data.reason);
      logoutUser();
    };

    const handleSeatError = (data: { error: string }) => {
      alert(data.error);
    };

    const handleParticipantUpdate = (data: { participant: User }) => {
      setUser(data.participant, sessionToken);
    };

    const handleAdminEventData = (data: { seats: Seat[], layout?: any, participants: User[], systemState: any, sessionColors?: { id: string; session_id: string; color: string; start_time?: string | null; end_time?: string | null }[], messages?: any[] }) => {
      setSeats(data.seats);
      if (data.layout) setLayout(data.layout);
      setParticipants(data.participants);
      if (data.systemState) {
        setSystemState(data.systemState.is_frozen, data.systemState.frozen_reason);
        setSystemTurn(data.systemState.current_turn_order, data.systemState.current_turn_start_time);
      } else {
        setSystemState(false, null);
      }
      if (data.sessionColors) {
        useStore.getState().setSessionColors(data.sessionColors);
      }
      if (data.messages) {
        useStore.getState().setMessages(data.messages);
      }
    };

    const handleAutoAssign = (data: { participantName: string }) => {
      setAnnouncement({ type: 'AUTO_ASSIGN', currentParticipantName: data.participantName, nextSessionId: null, nextStartTime: null });
      // 5초 후 IDLE로 복귀
      setTimeout(() => {
        setAnnouncement({ type: 'IDLE', currentParticipantName: null, nextSessionId: null, nextStartTime: null });
      }, 5000);
    };

    const handleSessionChange = (data: { prevSession: string, nextSession: string, nextStartTime: string | null }) => {
      setAnnouncement({ type: 'SESSION_CHANGE', currentParticipantName: null, nextSessionId: data.nextSession, nextStartTime: data.nextStartTime });
    };

    const handleAdminParticipantUpdate = (data: { participant: User }) => {
      updateParticipant(data.participant);
    };

    const handleAdminError = (data: { error: string }) => {
      alert(`관리자 오류: ${data.error}`);
    };

    const handleChatHistory = (data: { messages: any[] }) => {
      useStore.getState().setMessages(data.messages);
    };

    const handleChatMessage = (data: any) => {
      useStore.getState().addMessage(data);
    };

    const handleChatError = (data: { error: string }) => {
      alert(`채팅 오류: ${data.error}`);
    };

    socketInstance.on('system:auto_assign', handleAutoAssign);
    socketInstance.on('system:session_change', handleSessionChange);
    socketInstance.on('session:expired', handleSessionExpired);
    socketInstance.on('seat:error', handleSeatError);
    socketInstance.on('participant:update', handleParticipantUpdate);
    socketInstance.on('admin:event_data', handleAdminEventData);
    socketInstance.on('participant:update_admin', handleAdminParticipantUpdate);
    socketInstance.on('admin:error', handleAdminError);
    socketInstance.on('chat:history', handleChatHistory);
    socketInstance.on('chat:message', handleChatMessage);
    socketInstance.on('chat:error', handleChatError);

    return () => {
      socketInstance?.off('system:auto_assign', handleAutoAssign);
      socketInstance?.off('system:session_change', handleSessionChange);
      socketInstance?.off('session:expired', handleSessionExpired);
      socketInstance?.off('seat:error', handleSeatError);
      socketInstance?.off('participant:update', handleParticipantUpdate);
      socketInstance?.off('admin:event_data', handleAdminEventData);
      socketInstance?.off('participant:update_admin', handleAdminParticipantUpdate);
      socketInstance?.off('admin:error', handleAdminError);
      socketInstance?.off('chat:history', handleChatHistory);
      socketInstance?.off('chat:message', handleChatMessage);
      socketInstance?.off('chat:error', handleChatError);
    };
  }, [user, sessionToken, adminToken, logoutUser, setUser, setSeats, setLayout, setAnnouncement, setParticipants, setSystemState, updateParticipant]);

  return socket;
};
