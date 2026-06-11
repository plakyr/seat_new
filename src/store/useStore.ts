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

export interface ChatMessage {
  id: string;
  event_id: string;
  sender_type: 'ADMIN' | 'USER';
  sender_name: string;
  content: string;
  timestamp: string;
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
  rows: number;
  cols: number;
  seats: Seat[];
  participants: User[]; // For admin view
  sessionColors: { id: string; session_id: string; color: string; start_time?: string | null; end_time?: string | null }[];
  messages: ChatMessage[];
  setSessionColors: (colors: { id: string; session_id: string; color: string; start_time?: string | null; end_time?: string | null }[]) => void;
  setUser: (user: User | null, sessionToken: string | null) => void;
  logoutUser: () => void;
  setAdminAuth: (token: string | null, user: { username: string; role: string } | null) => void;
  setServerTime: (time: string) => void;
  setSystemState: (isFrozen: boolean, reason: string | null) => void;
  setSystemTurn: (order: number, startTime: string) => void;
  setRows: (rows: number) => void;
  setCols: (cols: number) => void;
  setSeats: (seats: Seat[]) => void;
  updateSeat: (seat: Seat) => void;
  setParticipants: (participants: User[]) => void;
  updateParticipant: (participant: User) => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
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
  rows: 10, // 기본값
  cols: 10, // 기본값
  seats: [],
  participants: [],
  sessionColors: [],
  messages: [],
  setSessionColors: (colors) => set({ sessionColors: colors }),
  setUser: (user, sessionToken) => set({ user, sessionToken }),
  logoutUser: () => set({ user: null, sessionToken: null }),
  setAdminAuth: (token, user) => set({ adminToken: token, adminUser: user, isAdmin: !!token }),
  setServerTime: (time) => set({ serverTime: time }),
  setSystemState: (isFrozen, reason) => set({ isFrozen, frozenReason: reason }),
  setSystemTurn: (order, startTime) => set({ currentTurnOrder: order, currentTurnStartTime: startTime }),
  setSeats: (seats) => set({ seats }),
  setRows: (rows) => set({ rows }),
  setCols: (cols) => set({ cols }),
  updateSeat: (updatedSeat) => set((state) => ({
    seats: state.seats.map(seat => seat.id === updatedSeat.id ? updatedSeat : seat)
  })),
  setParticipants: (participants) => set({ participants }),
  updateParticipant: (updatedParticipant) => set((state) => ({
    participants: state.participants.map(p => p.id === updatedParticipant.id ? updatedParticipant : p)
  })),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),
}));
