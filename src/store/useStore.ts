import { create } from 'zustand';

export interface User {
  id: string;
  name: string;
  phone_last4: string;
  turn_order: number;
  allowed_start_time: string | null;
  allowed_end_time: string | null;
  seat_id: string | null;
  is_final: boolean;
  turn_status: string;
  session_id: string;
  event_id: string;
}

export interface Seat {
  id: string;
  row: number;
  col: number;
  status: 'EMPTY' | 'RESERVED' | 'FROZEN' | 'AUTO_ASSIGNED' | 'LOCKED';
  assigned_to: string | null;
  session_id: string | null;
}

export interface LayoutInfo {
  rows: number;
  cols: number;
  aisle_after_rows: number[];
  aisle_after_cols: number[];
}

export interface ChatMessage {
  id: string;
  event_id: string;
  sender_type: 'ADMIN' | 'USER';
  sender_name: string;
  content: string;
  timestamp: string;
}

// 공지 바 상태
export type AnnouncementType = 'IDLE' | 'ACTIVE' | 'AUTO_ASSIGN' | 'SESSION_CHANGE';

export interface AnnouncementState {
  type: AnnouncementType;
  currentParticipantName: string | null;
  nextSessionId: string | null;
  nextStartTime: string | null;
}

interface AppState {
  user: User | null;
  sessionToken: string | null;
  isAdmin: boolean;
  adminToken: string | null;
  adminUser: { username: string; role: string } | null;
  serverTime: string | null;
  isFrozen: boolean;
  frozenReason: string | null;
  currentTurnOrder: number;
  currentTurnStartTime: string | null;
  seats: Seat[];
  layout: LayoutInfo | null;
  participants: User[];
  sessionColors: { id: string; session_id: string; color: string; start_time?: string | null; end_time?: string | null }[];
  messages: ChatMessage[];
  announcement: AnnouncementState;
  timerPaused: boolean; // 자동배정 중 타이머 멈춤

  setUser: (user: User | null, sessionToken: string | null) => void;
  logoutUser: () => void;
  setAdminAuth: (token: string | null, user: { username: string; role: string } | null) => void;
  setServerTime: (time: string) => void;
  setSystemState: (isFrozen: boolean, reason: string | null) => void;
  setSystemTurn: (order: number, startTime: string) => void;
  setSeats: (seats: Seat[]) => void;
  setLayout: (layout: LayoutInfo | null) => void;
  updateSeat: (seat: Seat) => void;
  setParticipants: (participants: User[]) => void;
  updateParticipant: (participant: User) => void;
  setSessionColors: (colors: { id: string; session_id: string; color: string; start_time?: string | null; end_time?: string | null }[]) => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  setAnnouncement: (a: AnnouncementState) => void;
  setTimerPaused: (paused: boolean) => void;

  // 하위 호환용 (Admin.tsx에서 rows/cols 직접 쓰는 곳 대비)
  rows: number;
  cols: number;
  setRows: (rows: number) => void;
  setCols: (cols: number) => void;
}

export const useStore = create<AppState>((set) => ({
  user: null,
  sessionToken: null,
  isAdmin: false,
  adminToken: null,
  adminUser: null,
  serverTime: null,
  isFrozen: false,
  frozenReason: null,
  currentTurnOrder: 1,
  currentTurnStartTime: null,
  seats: [],
  layout: null,
  participants: [],
  sessionColors: [],
  messages: [],
  announcement: { type: 'IDLE', currentParticipantName: null, nextSessionId: null, nextStartTime: null },
  timerPaused: false,
  rows: 10,
  cols: 10,

  setUser: (user, sessionToken) => set({ user, sessionToken }),
  logoutUser: () => set({ user: null, sessionToken: null }),
  setAdminAuth: (token, user) => set({ adminToken: token, adminUser: user, isAdmin: !!token }),
  setServerTime: (time) => set({ serverTime: time }),
  setSystemState: (isFrozen, reason) => set({ isFrozen, frozenReason: reason }),
  setSystemTurn: (order, startTime) => set({ currentTurnOrder: order, currentTurnStartTime: startTime }),
  setSeats: (seats) => set({ seats }),
  setLayout: (layout) => set({
    layout,
    rows: layout?.rows ?? 10,
    cols: layout?.cols ?? 10,
  }),
  setRows: (rows) => set({ rows }),
  setCols: (cols) => set({ cols }),
  updateSeat: (updatedSeat) => set((state) => ({
    seats: state.seats.map(seat => seat.id === updatedSeat.id ? updatedSeat : seat)
  })),
  setParticipants: (participants) => set({ participants }),
  updateParticipant: (updatedParticipant) => set((state) => ({
    participants: state.participants.map(p => p.id === updatedParticipant.id ? updatedParticipant : p)
  })),
  setSessionColors: (colors) => set({ sessionColors: colors }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) =>
    state.messages.some(m => m.id === message.id)
      ? {}
      : { messages: [...state.messages, message] }
  ),
  setAnnouncement: (announcement) => set({ announcement }),
  setTimerPaused: (timerPaused) => set({ timerPaused }),
}));
