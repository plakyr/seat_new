import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage() });
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

// Store active participant sockets: participantId -> socketId
const activeSockets = new Map<string, string>();

// Middleware to protect admin routes
const requireAdmin = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.role !== 'admin') throw new Error();
    req.admin = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
};

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: '*' }
  });
  const PORT = Number(process.env.PORT) || 3000;

  // Seed default admins if none exist
  const adminCount = await prisma.adminUser.count();
  if (adminCount === 0) {
    const password_hash = await bcrypt.hash('admin123', 10);
    await prisma.adminUser.createMany({
      data: [
        { username: '전초롱', password_hash, role: 'admin' },
        { username: '송다빈', password_hash, role: 'admin' },
        { username: '박은진', password_hash, role: 'admin' },
      ]
    });
    console.log('Seeded 3 default admin users (전초롱, 송다빈, 박은진 / admin123)');
  } else {
    // 기존 admin1/2/3 계정명을 새 이름으로 변경
    const renames: [string, string][] = [
      ['admin1', '전초롱'],
      ['admin2', '송다빈'],
      ['admin3', '박은진'],
    ];
    for (const [oldName, newName] of renames) {
      await prisma.adminUser.updateMany({
        where: { username: oldName },
        data: { username: newName },
      });
    }
  }

  app.use(cors());
  app.use(express.json());

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
    }

    const admin = await prisma.adminUser.findUnique({ where: { username } });
    if (!admin) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    const isValid = await bcrypt.compare(password, admin.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
    return res.json({ success: true, token, admin: { username: admin.username, role: admin.role } });
  } catch (error) {
    console.error('Admin login error:', error);
    return res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});
  
  app.get('/api/admin/events', requireAdmin, async (req, res) => {
    try {
      const events = await prisma.event.findMany({
        orderBy: { date: 'desc' },
        include: {
          layouts: { include: { seats: true } },
          _count: {
            select: { participants: true }
          }
        }
      });
      res.json({ success: true, events });
    } catch (error) {
      res.status(500).json({ error: '이벤트 목록을 불러오는데 실패했습니다.' });
    }
  });

  // 참가자 입장(로그인) 허용/차단 토글
  app.post('/api/admin/events/:eventId/login-open', requireAdmin, async (req, res) => {
    const { eventId } = req.params;
    const { open } = req.body;
    try {
      const event = await prisma.event.update({
        where: { id: eventId },
        data: { login_open: !!open }
      });
      res.json({ success: true, login_open: event.login_open });
    } catch (error) {
      res.status(500).json({ error: '입장 허용 설정에 실패했습니다.' });
    }
  });

  // 테스트용: 이벤트의 모든 좌석/참가자 상태를 초기화
  app.post('/api/admin/events/:eventId/reset', requireAdmin, async (req, res) => {
    const { eventId } = req.params;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.seat.updateMany({
          where: { layout: { event_id: eventId } },
          data: { status: 'EMPTY', assigned_to: null, session_id: null }
        });
        await tx.participant.updateMany({
          where: { event_id: eventId },
          data: { seat_id: null, is_final: false, turn_status: 'WAITING', session_token: null }
        });
        await tx.systemState.upsert({
          where: { event_id: eventId },
          update: { is_frozen: false, frozen_reason: null, current_turn_order: 1, current_turn_start_time: new Date() },
          create: { event_id: eventId, current_turn_order: 1, current_turn_start_time: new Date() }
        });
      });

      // 진행 흐름 상태 초기화 (시작 대기/공지 캐시)
      waitingForStart.delete(eventId);
      flowAnnounced.delete(eventId);

      const layout = await prisma.venueLayout.findFirst({ where: { event_id: eventId }, include: { seats: true } });
      const participants = await prisma.participant.findMany({ where: { event_id: eventId } });
      const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });

      io.to(`event:${eventId}`).emit('seat:init', {
        seats: layout?.seats || [],
        layout: layout ? {
          rows: layout.rows,
          cols: layout.cols,
          aisle_after_rows: layout.aisle_after_rows ? JSON.parse(layout.aisle_after_rows) : [],
          aisle_after_cols: layout.aisle_after_cols ? JSON.parse(layout.aisle_after_cols) : [],
        } : null,
      });
      if (systemState) {
        io.to(`event:${eventId}`).emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time,
        });
        io.to(`event:${eventId}`).emit('system:freeze', { isFrozen: false, reason: null });
      }
      io.to(`admin:event:${eventId}`).emit('admin:event_data', {
        seats: layout?.seats || [],
        layout: layout ? {
          rows: layout.rows,
          cols: layout.cols,
          aisle_after_rows: layout.aisle_after_rows ? JSON.parse(layout.aisle_after_rows) : [],
          aisle_after_cols: layout.aisle_after_cols ? JSON.parse(layout.aisle_after_cols) : [],
        } : null,
        participants,
        systemState,
        sessionColors: await prisma.sessionColor.findMany({ where: { event_id: eventId } }),
        messages: [],
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '이벤트 초기화에 실패했습니다.' });
    }
  });

  // 이벤트 완전 삭제 (관련 데이터 전체 삭제)
  app.delete('/api/admin/events/:eventId', requireAdmin, async (req, res) => {
    const { eventId } = req.params;
    try {
      await prisma.$transaction(async (tx) => {
        const layouts = await tx.venueLayout.findMany({ where: { event_id: eventId } });
        for (const layout of layouts) {
          await tx.seat.deleteMany({ where: { layout_id: layout.id } });
        }
        await tx.venueLayout.deleteMany({ where: { event_id: eventId } });
        await tx.participant.deleteMany({ where: { event_id: eventId } });
        await tx.chatMessage.deleteMany({ where: { event_id: eventId } });
        await tx.adminLog.deleteMany({ where: { event_id: eventId } });
        await tx.sessionColor.deleteMany({ where: { event_id: eventId } });
        await tx.systemState.deleteMany({ where: { event_id: eventId } });
        await tx.event.delete({ where: { id: eventId } });
      });

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: '이벤트 삭제에 실패했습니다.' });
    }
  });

  app.post('/api/admin/upload', requireAdmin, upload.single('file'), async (req, res) => {
    try {
      const { name, rows, cols } = req.body;
      const file = req.file;
      if (!file) return res.status(400).json({ error: 'No file uploaded' });

      const rawRecords = parse(file.buffer, { columns: true, skip_empty_lines: true, bom: true });
      
      // Trim keys to handle spaces in column names
      let records = rawRecords.map((record: any) => {
        const newRecord: any = {};
        for (const key in record) {
          // Remove BOM and trim
          const cleanKey = key.replace(/^\uFEFF/, '').trim();
          newRecord[cleanKey] = record[key]?.trim();
        }
        return newRecord;
      });
      
      // Filter out rows that are completely empty (e.g. just commas)
      records = records.filter((r: any) => Object.values(r).some(v => v !== ''));
      
      if (records.length > 0) {
        const firstRecordKeys = Object.keys(records[0]);
        if (firstRecordKeys.length === 1 && firstRecordKeys[0].includes(';')) {
          throw new Error('CSV 파일의 구분자가 쉼표(,)가 아닌 세미콜론(;)입니다. 쉼표로 구분된 CSV 파일을 업로드해주세요.');
        }
      }
      
      console.log("First parsed record:", records[0]);
      
      // Deactivate all previous events so the new one becomes the active event
      await prisma.event.updateMany({
        where: { is_active: true },
        data: { is_active: false }
      });

      // Create Event
      const event = await prisma.event.create({
        data: { name, date: new Date() }
      });

      // Create Layout & Seats
      // 복도 정보 파싱 (body에서 aisle_after_rows, aisle_after_cols 받음)
      const aisleAfterRows = req.body.aisle_after_rows ? JSON.stringify(
        String(req.body.aisle_after_rows).split(',').map((v: string) => parseInt(v.trim())).filter((n: number) => !isNaN(n))
      ) : null;
      const aisleAfterCols = req.body.aisle_after_cols ? JSON.stringify(
        String(req.body.aisle_after_cols).split(',').map((v: string) => parseInt(v.trim())).filter((n: number) => !isNaN(n))
      ) : null;

      const layout = await prisma.venueLayout.create({
        data: { event_id: event.id, rows: parseInt(rows), cols: parseInt(cols), aisle_after_rows: aisleAfterRows, aisle_after_cols: aisleAfterCols }
      });

      const seatsData = [];
      for (let r = 1; r <= parseInt(rows); r++) {
        for (let c = 1; c <= parseInt(cols); c++) {
          seatsData.push({ layout_id: layout.id, row: r, col: c, status: 'EMPTY' });
        }
      }
      await prisma.seat.createMany({ data: seatsData });

      // Process Participants
      const participantCounts = new Map<string, number>();
      records.forEach((r: any) => {
        const key = `${r.participant_name}-${r.phone_last4}`;
        participantCounts.set(key, (participantCounts.get(key) || 0) + 1);
      });

      // Extract unique sessions
      const sessions = Array.from(new Set(records.map((r: any) => r.session_id))).filter(Boolean).sort() as string[];
      
      // Generate colors for sessions
      const defaultColors = ['#1D4EAD', '#4374D9', '#6799FF', '#B2D5FF', '#D4E9FF', '#E6F2FF'];
      const sessionColorsData = sessions.map((session_id, index) => {
        let color;
        if (index < defaultColors.length) {
          color = defaultColors[index];
        } else {
          // Generate a lighter blue shade for sessions 6+
          // HSL: Hue ~215 (blue), Saturation ~100%, Lightness increasing from 95%
          const lightness = Math.min(98, 95 + (index - 5));
          color = `hsl(215, 100%, ${lightness}%)`;
        }
        return {
          event_id: event.id,
          session_id: session_id,
          color: color
        };
      });
      await prisma.sessionColor.createMany({ data: sessionColorsData });

      // Calculate global turn_order
      const turnGroups = new Set<string>();
      records.forEach((r: any) => {
        turnGroups.add(`${r.session_id}|${r.order_in_session}`);
      });
      
      const sortedTurnGroups = Array.from(turnGroups).sort((a, b) => {
        const [sA, oA] = a.split('|');
        const [sB, oB] = b.split('|');
        if (sA !== sB) {
          // Try to extract numbers for natural sorting
          const numA = parseInt(sA.replace(/\D/g, ''));
          const numB = parseInt(sB.replace(/\D/g, ''));
          if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
            return numA - numB;
          }
          return sA.localeCompare(sB);
        }
        return parseInt(oA) - parseInt(oB);
      });

      const turnOrderMap = new Map<string, number>();
      sortedTurnGroups.forEach((group, index) => {
        turnOrderMap.set(group, index + 1);
      });

      const participantsData = records.map((r: any, index: number) => {
        if (!r.session_id || !r.participant_name || !r.phone_last4) {
          const availableKeys = Object.keys(r).join(', ');
          throw new Error(`CSV 파일 ${index + 1}번째 행에 필수 데이터가 누락되었습니다. (발견된 컬럼: ${availableKeys})`);
        }
        const key = `${r.participant_name}-${r.phone_last4}`;
        const isDuplicate = (participantCounts.get(key) || 0) > 1;
        const globalTurnOrder = turnOrderMap.get(`${r.session_id}|${r.order_in_session}`) || 1;
        return {
          event_id: event.id,
          session_id: String(r.session_id),
          name: String(r.participant_name),
          phone_last4: String(r.phone_last4),
          unique_code: isDuplicate ? Math.random().toString(36).substring(2, 6).toUpperCase() : null,
          turn_order: globalTurnOrder,
        };
      });

      await prisma.participant.createMany({ data: participantsData });

      // Initialize System State
      await prisma.systemState.create({
        data: {
          event_id: event.id,
          current_turn_order: 1,
          current_turn_start_time: new Date()
        }
      });

      res.json({ success: true, eventId: event.id });
    } catch (error: any) {
      console.error("Upload failed with error:", error);
      if (error.code) {
        console.error("Prisma Error Code:", error.code);
      }
      if (error.meta) {
        console.error("Prisma Error Meta:", error.meta);
      }
      res.status(500).json({ error: 'Upload failed: ' + error.message });
    }
  });

  app.post('/api/admin/sessions', requireAdmin, async (req, res) => {
    try {
      const { eventId, sessions } = req.body;
      
      await prisma.$transaction(
        sessions.map((s: any) => 
          prisma.sessionColor.update({
            where: { id: s.id },
            data: { start_time: s.start_time, end_time: s.end_time }
          })
        )
      );
      
      const updatedSessions = await prisma.sessionColor.findMany({ where: { event_id: eventId } });
      io.to(`admin:event:${eventId}`).emit('session:colors', { sessionColors: updatedSessions });
      io.to(`event:${eventId}`).emit('session:colors', { sessionColors: updatedSessions });
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("Update sessions failed:", error);
      res.status(500).json({ error: '세션 시간 업데이트에 실패했습니다.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const { name, phone_last4, unique_code } = req.body;
    try {
      const activeEvent = await prisma.event.findFirst({
        where: { is_active: true },
        orderBy: { date: 'desc' }
      });
      if (!activeEvent) {
        return res.status(400).json({ error: '현재 진행 중인 이벤트가 없습니다.' });
      }

      if (!activeEvent.login_open) {
        return res.status(403).json({ error: '아직 입장이 허용되지 않았습니다. 관리자의 안내를 기다려주세요.' });
      }

      const participants = await prisma.participant.findMany({
        where: { name, phone_last4: String(phone_last4), event_id: activeEvent.id }
      });

      if (participants.length === 0) {
        return res.status(404).json({ error: '참가자 정보를 찾을 수 없습니다. 이름과 번호를 확인해주세요.' });
      }

      if (participants.length > 1 && !unique_code) {
        return res.status(409).json({ error: '동명이인이 존재합니다. 고유 코드를 입력해주세요.', requiresUniqueCode: true });
      }

      const participant = unique_code 
        ? participants.find(p => p.unique_code === unique_code)
        : participants[0];

      if (!participant) {
        return res.status(404).json({ error: '잘못된 고유 코드입니다.' });
      }

      // Generate new session token
      const session_token = crypto.randomUUID();
      const updatedParticipant = await prisma.participant.update({
        where: { id: participant.id },
        data: { session_token }
      });

      // Kick out existing socket if any
      const existingSocketId = activeSockets.get(participant.id);
      if (existingSocketId) {
        io.to(existingSocketId).emit('session:expired', { reason: '다른 기기에서 로그인하여 세션이 만료되었습니다.' });
        // We don't disconnect immediately here to allow the client to show the message,
        // the client will handle the disconnect.
      }

      res.json({ success: true, user: updatedParticipant, sessionToken: session_token });
    } catch (error) {
      console.error('Participant login error:', error);
      res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    }
  });

  // Public endpoint: seats/participants/colors for the currently active event
  app.get('/api/seats', async (req, res) => {
    try {
      const event = await prisma.event.findFirst({
        where: { is_active: true },
        orderBy: { date: 'desc' },
        include: {
          layouts: { include: { seats: true } },
          participants: true,
          sessionColors: true
        }
      });

      if (!event) {
        return res.status(404).json({ error: '활성화된 이벤트가 없습니다.' });
      }

      const layout0 = event.layouts[0];
      res.json({
        eventId: event.id,
        seats: layout0?.seats || [],
        layout: layout0 ? {
          rows: layout0.rows,
          cols: layout0.cols,
          aisle_after_rows: layout0.aisle_after_rows ? JSON.parse(layout0.aisle_after_rows) : [],
          aisle_after_cols: layout0.aisle_after_cols ? JSON.parse(layout0.aisle_after_cols) : [],
        } : null,
        // 공개 응답에는 민감 정보(세션 토큰, 전화번호) 제외
        participants: (event.participants || []).map(p => ({
          id: p.id,
          name: p.name,
          session_id: p.session_id,
          turn_order: p.turn_order,
          turn_status: p.turn_status,
          is_final: p.is_final,
          seat_id: p.seat_id,
          event_id: p.event_id
        })),
        sessionColors: event.sessionColors || []
      });
    } catch (error: any) {
      console.error('Seats fetch error:', error);
      res.status(500).json({ error: '좌석 정보를 불러오는 중 오류가 발생했습니다.' });
    }
  });

  // Socket.io logic
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send initial server time
    socket.emit('time:sync', { serverTime: new Date().toISOString() });

    // Authenticate participant socket
    socket.on('participant:auth', async (data: { participantId: string, sessionToken: string }) => {
      const { participantId, sessionToken } = data;
      const participant = await prisma.participant.findUnique({ where: { id: participantId } });
      
      if (!participant || participant.session_token !== sessionToken) {
        socket.emit('session:expired', { reason: '유효하지 않은 세션입니다. 다시 로그인해주세요.' });
        return;
      }

      // Register active socket
      activeSockets.set(participantId, socket.id);
      socket.data.participantId = participantId;
      socket.data.eventId = participant.event_id;
      socket.join(`event:${participant.event_id}`);
      console.log(`Participant ${participant.name} authenticated on socket ${socket.id}`);
    });

    // Authenticate admin socket
    socket.on('admin:auth', async (data: { token: string }) => {
      try {
        const decoded = jwt.verify(data.token, JWT_SECRET) as any;
        if (decoded.role === 'admin') {
          socket.data.isAdmin = true;
          socket.data.adminId = decoded.id;
          console.log(`Admin authenticated on socket ${socket.id}`);
        }
      } catch (err) {
        socket.emit('admin:error', { error: 'Invalid admin token' });
      }
    });

    // Admin request event details (seats + participants)
    socket.on('admin:request_event', async (data: { eventId: string }) => {
      if (!socket.data.isAdmin) return;
      
      socket.join(`admin:event:${data.eventId}`);
      socket.join(`event:${data.eventId}`); // Join regular event room to receive seat updates
      
      const layout = await prisma.venueLayout.findFirst({
        where: { event_id: data.eventId },
        include: { seats: true }
      });
      
      const participants = await prisma.participant.findMany({
        where: { event_id: data.eventId }
      });

      const systemState = await prisma.systemState.findUnique({
        where: { event_id: data.eventId }
      });

      const sessionColors = await prisma.sessionColor.findMany({
        where: { event_id: data.eventId }
      });

      const messages = await prisma.chatMessage.findMany({
        where: { event_id: data.eventId },
        orderBy: { timestamp: 'asc' },
        take: 100
      });

      socket.emit('admin:event_data', {
        seats: layout?.seats || [],
        layout: layout ? {
          rows: layout.rows,
          cols: layout.cols,
          aisle_after_rows: layout.aisle_after_rows ? JSON.parse(layout.aisle_after_rows) : [],
          aisle_after_cols: layout.aisle_after_cols ? JSON.parse(layout.aisle_after_cols) : [],
        } : null,
        participants,
        systemState,
        sessionColors,
        messages
      });

      const flow = await getFlowAnnouncement(data.eventId);
      if (flow) socket.emit(flow.event, flow.payload);
    });

    // Admin freeze/unfreeze system
    socket.on('admin:toggle_freeze', async (data: { eventId: string, isFrozen: boolean, reason?: string }) => {
      if (!socket.data.isAdmin) return;

      const state = await prisma.systemState.upsert({
        where: { event_id: data.eventId },
        update: { is_frozen: data.isFrozen, frozen_reason: data.reason || null },
        create: { event_id: data.eventId, is_frozen: data.isFrozen, frozen_reason: data.reason || null }
      });

      io.to(`event:${data.eventId}`).emit('system:freeze', { 
        isFrozen: state.is_frozen, 
        reason: state.frozen_reason 
      });
      io.to(`admin:event:${data.eventId}`).emit('system:freeze', { 
        isFrozen: state.is_frozen, 
        reason: state.frozen_reason 
      });
    });

    // Admin force cancel seat
    socket.on('admin:cancel_seat', async (data: { seatId: string, eventId: string }) => {
      if (!socket.data.isAdmin) return;

      try {
        const result = await prisma.$transaction(async (tx) => {
          const seat = await tx.seat.findUnique({ where: { id: data.seatId } });
          if (!seat || (seat.status !== 'RESERVED' && seat.status !== 'AUTO_ASSIGNED') || !seat.assigned_to) {
            throw new Error('취소할 수 없는 좌석입니다.');
          }

          const participantId = seat.assigned_to;

          const updatedSeat = await tx.seat.update({
            where: { id: data.seatId },
            data: { status: 'EMPTY', assigned_to: null, session_id: null }
          });

          const updatedParticipant = await tx.participant.update({
            where: { id: participantId },
            data: { 
              seat_id: null,
              is_final: false,
              turn_status: 'WAITING'
            }
          });

          return { updatedSeat, updatedParticipant };
        });

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('participant:update_admin', { participant: result.updatedParticipant });

        // Notify the specific user that their seat was cancelled
        const userSocketId = activeSockets.get(result.updatedParticipant.id);
        if (userSocketId) {
          io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
          io.to(userSocketId).emit('seat:error', { error: '관리자에 의해 좌석 예약이 취소되었습니다.' });
        }

      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    // Admin force assign seat
    // 관리자: 좌석을 '사석'으로 지정하거나 다시 선택 가능 상태로 되돌리기
    socket.on('admin:set_seat_private', async (data: { seatId: string, eventId: string, isPrivate: boolean }) => {
      if (!socket.data.isAdmin) return;

      try {
        const seat = await prisma.seat.findUnique({ where: { id: data.seatId } });
        if (!seat) throw new Error('좌석을 찾을 수 없습니다.');
        if (seat.status !== 'EMPTY' && seat.status !== 'PRIVATE') {
          throw new Error('이미 배정된 좌석은 변경할 수 없습니다.');
        }

        const updatedSeat = await prisma.seat.update({
          where: { id: data.seatId },
          data: { status: data.isPrivate ? 'PRIVATE' : 'EMPTY' }
        });

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    socket.on('admin:force_assign', async (data: { seatId: string, participantId: string, eventId: string }) => {
      if (!socket.data.isAdmin) return;

      try {
        const result = await prisma.$transaction(async (tx) => {
          const seat = await tx.seat.findUnique({ where: { id: data.seatId } });
          if (!seat || seat.status !== 'EMPTY') {
            throw new Error('선택할 수 없는 좌석입니다.');
          }

          const participant = await tx.participant.findUnique({ where: { id: data.participantId } });
          if (!participant) {
            throw new Error('참가자를 찾을 수 없습니다.');
          }

          // If participant already has a seat, free it
          let oldSeat = null;
          if (participant.seat_id) {
            oldSeat = await tx.seat.update({
              where: { id: participant.seat_id },
              data: { status: 'EMPTY', assigned_to: null, session_id: null }
            });
          }

          const updatedSeat = await tx.seat.update({
            where: { id: data.seatId },
            data: { status: 'RESERVED', assigned_to: data.participantId, session_id: participant.session_id }
          });

          const updatedParticipant = await tx.participant.update({
            where: { id: data.participantId },
            data: { 
              seat_id: data.seatId,
              is_final: true,
              turn_status: 'COMPLETED'
            }
          });

          return { updatedSeat, updatedParticipant, oldSeat };
        });

        if (result.oldSeat) {
          io.to(`event:${data.eventId}`).emit('seat:update', { seat: result.oldSeat });
          io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: result.oldSeat });
        }

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('participant:update_admin', { participant: result.updatedParticipant });

        // Notify the specific user
        const userSocketId = activeSockets.get(result.updatedParticipant.id);
        if (userSocketId) {
          io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
          io.to(userSocketId).emit('seat:error', { error: '관리자에 의해 좌석이 강제 배정되었습니다.' });
        }

      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    // Admin: 현재 선택자 좌석 자동배정 후 다음 턴으로 넘기기
    socket.on('admin:next_turn', async (data: { eventId: string }) => {
      if (!socket.data.isAdmin) return;

      try {
        await forceAssignAndAdvanceTurn(data.eventId);
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    // Request initial seats
    socket.on('seat:request_init', async (data: { eventId: string }) => {
      const layout = await prisma.venueLayout.findFirst({
        where: { event_id: data.eventId },
        include: { seats: true }
      });
      if (layout) {
        socket.emit('seat:init', { seats: layout.seats });
      }

      const systemState = await prisma.systemState.findUnique({
        where: { event_id: data.eventId }
      });
      if (systemState) {
        socket.emit('system:freeze', { 
          isFrozen: systemState.is_frozen, 
          reason: systemState.frozen_reason 
        });
        socket.emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time
        });
      }

      const flow = await getFlowAnnouncement(data.eventId);
      if (flow) socket.emit(flow.event, flow.payload);

      const sessionColors = await prisma.sessionColor.findMany({
        where: { event_id: data.eventId }
      });
      socket.emit('session:colors', { sessionColors });

      const messages = await prisma.chatMessage.findMany({
        where: { event_id: data.eventId },
        orderBy: { timestamp: 'asc' },
        take: 100 // Limit to last 100 messages for performance
      });
      socket.emit('chat:history', { messages });
    });

    // Handle seat selection
    socket.on('seat:select', async (data: { seatId: string }) => {
      const participantId = socket.data.participantId;
      if (!participantId) {
        return socket.emit('seat:error', { error: '로그인이 필요합니다.' });
      }

      try {
        // Use a transaction to ensure concurrency safety
        const result = await prisma.$transaction(async (tx) => {
          const systemState = await tx.systemState.findUnique({ where: { event_id: socket.data.eventId } });
          if (systemState?.is_frozen) {
            throw new Error(`시스템이 일시정지되었습니다: ${systemState.frozen_reason || '사유 없음'}`);
          }

          const participant = await tx.participant.findUnique({ where: { id: participantId } });
          if (!participant) throw new Error('참가자를 찾을 수 없습니다.');

          if (participant.is_final) {
            throw new Error('이미 선택 완료된 자리입니다.');
          }

          // Dynamic turn check
          if (!systemState || participant.turn_order !== systemState.current_turn_order) {
            throw new Error('아직 좌석 선택 차례가 아닙니다.');
          }

          // 그룹 시작 시간 전에는 차례여도 선택 불가
          const sess = await tx.sessionColor.findFirst({
            where: { event_id: socket.data.eventId, session_id: participant.session_id }
          });
          if (sess?.start_time && !isSessionStartTimeReached(sess.start_time)) {
            throw new Error(`아직 그룹 시작 시간이 아닙니다. (시작: ${sess.start_time})`);
          }

          const now = new Date();
          const turnStartTime = new Date(systemState.current_turn_start_time);
          const turnEndTime = new Date(turnStartTime.getTime() + 3 * 60000); // 3 minutes

          if (now > turnEndTime) {
            throw new Error('좌석 선택 시간이 지났습니다.');
          }

          if (participant.seat_id) {
            throw new Error('이미 좌석을 선택하셨습니다.');
          }

          const seat = await tx.seat.findUnique({ where: { id: data.seatId } });
          if (!seat) throw new Error('좌석을 찾을 수 없습니다.');
          if (seat.status !== 'EMPTY') throw new Error('이미 선택되었거나 사용할 수 없는 좌석입니다.');

          // Update seat and participant
          const updatedSeat = await tx.seat.update({
            where: { id: data.seatId },
            data: { status: 'RESERVED', assigned_to: participantId, session_id: participant.session_id }
          });

          const updatedParticipant = await tx.participant.update({
            where: { id: participantId },
            data: { 
              seat_id: data.seatId,
              is_final: true,
              turn_status: 'COMPLETED'
            }
          });

          // Move to next turn
          const nextTurnOrder = systemState.current_turn_order + 1;
          const updatedSystemState = await tx.systemState.update({
            where: { event_id: socket.data.eventId },
            data: {
              current_turn_order: nextTurnOrder,
              current_turn_start_time: new Date()
            }
          });

          return { updatedSeat, updatedParticipant, updatedSystemState };
        });

        // Broadcast the updated seat to everyone in the event room
        io.to(`event:${socket.data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        
        // Update the specific user's info so they know they have a seat
        socket.emit('participant:update', { participant: result.updatedParticipant });
        
        // Notify admins about the participant update
        io.to(`admin:event:${socket.data.eventId}`).emit('participant:update_admin', { participant: result.updatedParticipant });

        // Broadcast turn update
        io.to(`event:${socket.data.eventId}`).emit('system:turn', {
          currentTurnOrder: result.updatedSystemState.current_turn_order,
          currentTurnStartTime: result.updatedSystemState.current_turn_start_time
        });
        io.to(`admin:event:${socket.data.eventId}`).emit('system:turn', {
          currentTurnOrder: result.updatedSystemState.current_turn_order,
          currentTurnStartTime: result.updatedSystemState.current_turn_start_time
        });

      } catch (error: any) {
        socket.emit('seat:error', { error: error.message || '좌석 선택 중 오류가 발생했습니다.' });
      }
    });

    socket.on('chat:send', async (data: { eventId: string, content: string }) => {
      try {
        const { eventId, content } = data;
        if (!content || !content.trim()) return;

        let senderType = 'USER';
        let senderName = 'Unknown';

        if (socket.data.isAdmin) {
          senderType = 'ADMIN';
          senderName = '관리자';
        } else if (socket.data.participantId) {
          const participant = await prisma.participant.findUnique({ where: { id: socket.data.participantId } });
          const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
          
          if (!participant || !systemState) return;
          
          // Check if user is allowed to chat (it's their turn and they haven't finished)
          if (systemState.is_frozen || participant.turn_order !== systemState.current_turn_order || participant.is_final) {
            socket.emit('chat:error', { error: '채팅 권한이 없습니다.' });
            return;
          }

          // 그룹 시작 시간 전에는 채팅 불가
          const chatSession = await prisma.sessionColor.findFirst({
            where: { event_id: eventId, session_id: participant.session_id }
          });
          if (chatSession?.start_time && !isSessionStartTimeReached(chatSession.start_time)) {
            socket.emit('chat:error', { error: `아직 그룹 시작 시간이 아닙니다. (시작: ${chatSession.start_time})` });
            return;
          }
          
          senderType = 'USER';
          senderName = participant.name;
        } else {
          return; // Unauthorized
        }

        const message = await prisma.chatMessage.create({
          data: {
            event_id: eventId,
            sender_type: senderType,
            sender_name: senderName,
            content: content.trim(),
          }
        });

        io.to(`event:${eventId}`).emit('chat:message', message);
        io.to(`admin:event:${eventId}`).emit('chat:message', message);
      } catch (error) {
        console.error('Chat error:', error);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      if (socket.data.participantId) {
        if (activeSockets.get(socket.data.participantId) === socket.id) {
          activeSockets.delete(socket.data.participantId);
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 모든 클라이언트가 동일한 서버 시간을 사용하도록 주기적으로 동기화 (시계 오차 방지)
  setInterval(() => {
    io.emit('time:sync', { serverTime: new Date().toISOString() });
  }, 10000);

  // ─── 자동 타이머 & 자동 배정 스케줄러 (1초마다 실행) ───────────────────
  const TURN_DURATION_MS = 3 * 60 * 1000; // 3분
  const AUTO_ASSIGN_NOTICE_MS = 700; // 자동배정 문구 표시 후 좌석 배정까지
  const AUTO_ASSIGN_NEXT_MS = 800;   // 좌석 배정 후 다음 턴 전환까지 (총 1.5초)
  const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
  const autoAssignInProgress = new Set<string>(); // 진행 중인 이벤트 (재진입 방지)

  function emitTurn(eventId: string, state: { current_turn_order: number; current_turn_start_time: Date }) {
    const payload = {
      currentTurnOrder: state.current_turn_order,
      currentTurnStartTime: state.current_turn_start_time,
    };
    io.to(`event:${eventId}`).emit('system:turn', payload);
    io.to(`admin:event:${eventId}`).emit('system:turn', payload);
  }


  // "HH:MM" 형식의 시작 시간이 현재 시각(한국 시간 기준)에 도달했는지 확인
  // 서버가 UTC 등 다른 시간대에서 돌아도 항상 Asia/Seoul 기준으로 비교
  function isSessionStartTimeReached(startTime: string | null | undefined): boolean {
    if (!startTime) return true;
    const m = startTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return true;
    const seoulNow = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date());
    const [nowH, nowM] = seoulNow.split(':').map(Number);
    return nowH * 60 + nowM >= Number(m[1]) * 60 + Number(m[2]);
  }

  // 이벤트별 진행 흐름 상태 추적 (시작 대기 / 공지 중복 방지)
  const waitingForStart = new Map<string, string>(); // eventId → 시작 대기 중인 그룹
  const flowAnnounced = new Map<string, string>();   // eventId → 마지막 공지 키

  // 현재 이벤트의 진행 흐름 공지 상태 계산
  // - 현재 그룹 시작 시간 전: 시작 시간 안내 (prevSession: null)
  // - 그룹 사이 대기: 이전 그룹 완료 + 다음 그룹 시작 시간 안내
  // - 전원 배정 완료: 완료 공지
  // - 정상 진행 중: null
  async function getFlowAnnouncement(eventId: string): Promise<{ event: string; payload: any } | null> {
    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (!systemState) return null;
    const total = await prisma.participant.count({ where: { event_id: eventId } });
    if (total === 0) return null;
    const remaining = await prisma.participant.count({ where: { event_id: eventId, is_final: false } });
    if (remaining === 0) return { event: 'system:all_complete', payload: {} };
    const cur = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });
    if (cur && !cur.is_final) {
      const sess = await prisma.sessionColor.findFirst({
        where: { event_id: eventId, session_id: cur.session_id }
      });
      if (sess?.start_time && !isSessionStartTimeReached(sess.start_time)) {
        return {
          event: 'system:session_change',
          payload: { prevSession: null, nextSession: cur.session_id, nextStartTime: sess.start_time }
        };
      }
      return null;
    }
    const gap = await checkSessionGap(eventId);
    if (gap) return { event: 'system:session_change', payload: gap };
    return null;
  }

  // 현재 턴이 그룹의 마지막 참가자이고, 다음 그룹의 시작 시간이 아직 안 됐는지 확인
  async function checkSessionGap(eventId: string) {
    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (!systemState) return null;
    const currentParticipant = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });
    if (!currentParticipant || !currentParticipant.is_final) return null;
    const nextParticipant = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order + 1 }
    });
    if (!nextParticipant || nextParticipant.session_id === currentParticipant.session_id) return null;
    const nextSession = await prisma.sessionColor.findFirst({
      where: { event_id: eventId, session_id: nextParticipant.session_id }
    });
    if (!nextSession?.start_time || isSessionStartTimeReached(nextSession.start_time)) return null;
    return {
      prevSession: currentParticipant.session_id,
      nextSession: nextParticipant.session_id,
      nextStartTime: nextSession.start_time
    };
  }

  function sortSeatsForAutoAssign(seats: any[], totalCols: number) {
    return [...seats]
      .filter(s => s.status === 'EMPTY')
      .sort((a, b) => {
        if (a.row !== b.row) return a.row - b.row;
        const centerCol = (totalCols + 1) / 2;
        const distA = Math.abs(a.col - centerCol);
        const distB = Math.abs(b.col - centerCol);
        if (distA !== distB) return distA - distB;
        return a.col - b.col;
      });
  }

  // 관리자가 "다음 턴으로 넘기기"를 누르면, 현재 선택자의 좌석을 자동배정 기준에 맞춰 즉시 배정한 뒤 다음 턴으로 전환
  async function forceAssignAndAdvanceTurn(eventId: string) {
    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (!systemState) throw new Error('시스템 상태를 찾을 수 없습니다.');

    // 그룹 시작 전 / 그룹 간 대기 / 전원 완료 상태에서는 수동 진행 불가 (시작 시간 엄수)
    const flow = await getFlowAnnouncement(eventId);
    if (flow) {
      if (flow.event === 'system:all_complete') throw new Error('모든 그룹 좌석 지정이 완료되었습니다.');
      throw new Error(`아직 그룹 시작 시간이 아닙니다. (그룹 ${flow.payload.nextSession} 시작: ${flow.payload.nextStartTime})`);
    }

    const currentParticipant = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });

    if (currentParticipant && !currentParticipant.is_final) {
      const layout = await prisma.venueLayout.findFirst({ where: { event_id: eventId }, include: { seats: true } });
      const sortedSeats = layout ? sortSeatsForAutoAssign(layout.seats, layout.cols) : [];

      let updatedParticipant;
      if (sortedSeats.length > 0) {
        const targetSeat = sortedSeats[0];
        const result = await prisma.$transaction(async (tx) => {
          const updatedSeat = await tx.seat.update({
            where: { id: targetSeat.id },
            data: { status: 'AUTO_ASSIGNED', assigned_to: currentParticipant.id, session_id: currentParticipant.session_id }
          });
          const updatedParticipant = await tx.participant.update({
            where: { id: currentParticipant.id },
            data: { seat_id: targetSeat.id, is_final: true, turn_status: 'COMPLETED' }
          });
          return { updatedSeat, updatedParticipant };
        });
        io.to(`event:${eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${eventId}`).emit('seat:update', { seat: result.updatedSeat });
        updatedParticipant = result.updatedParticipant;
      } else {
        updatedParticipant = await prisma.participant.update({
          where: { id: currentParticipant.id },
          data: { turn_status: 'EXPIRED' }
        });
      }

      io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: updatedParticipant });
      const userSocketId = activeSockets.get(currentParticipant.id);
      if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: updatedParticipant });
    }

    const gap = await checkSessionGap(eventId);
    if (gap) {
      io.to(`event:${eventId}`).emit('system:session_change', gap);
      io.to(`admin:event:${eventId}`).emit('system:session_change', gap);
      return;
    }

    const nextTurnOrder = systemState.current_turn_order + 1;
    const updatedState = await prisma.systemState.update({
      where: { event_id: eventId },
      data: { current_turn_order: nextTurnOrder, current_turn_start_time: new Date() }
    });
    emitTurn(eventId, updatedState);
  }

  async function runAutoAssignIfExpired(eventId: string) {
    // 이미 자동배정 시퀀스가 진행 중이면 건너뜀 (중복 방지)
    if (autoAssignInProgress.has(eventId)) return;

    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (!systemState || systemState.is_frozen) return;

    // 진행 흐름 상태 확인: 그룹 시작 대기 / 그룹 간 대기 / 전원 완료 시 턴 진행 보류
    const flow = await getFlowAnnouncement(eventId);
    if (flow) {
      const key = flow.event + JSON.stringify(flow.payload);
      if (flowAnnounced.get(eventId) !== key) {
        flowAnnounced.set(eventId, key);
        io.to(`event:${eventId}`).emit(flow.event, flow.payload);
        io.to(`admin:event:${eventId}`).emit(flow.event, flow.payload);
      }
      // 현재 차례 참가자의 그룹 시작 대기 중이면 표시 (시작 시 타이머 리셋용)
      if (flow.event === 'system:session_change' && !flow.payload.prevSession) {
        waitingForStart.set(eventId, flow.payload.nextSession);
      }
      return;
    }
    flowAnnounced.delete(eventId);

    // 그룹 시작 시간이 막 도래한 경우: 타이머를 지금부터 새로 시작
    if (waitingForStart.has(eventId)) {
      waitingForStart.delete(eventId);
      const updated = await prisma.systemState.update({
        where: { event_id: eventId },
        data: { current_turn_start_time: new Date() }
      });
      emitTurn(eventId, updated);
      return;
    }

    const now = Date.now();
    const turnStart = new Date(systemState.current_turn_start_time).getTime();
    // 제한시간(정확히 3분) 이전이면 아무것도 안 함
    if (now - turnStart < TURN_DURATION_MS) return;

    const currentParticipant = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });

    const maxTurnResult = await prisma.participant.aggregate({
      where: { event_id: eventId },
      _max: { turn_order: true }
    });
    const maxTurn = maxTurnResult._max.turn_order || 0;
    const nextTurnOrder = systemState.current_turn_order + 1;

    // 이미 완료됐거나 참가자 없으면 (자동배정 문구 없이) 조용히 다음 턴으로
    if (!currentParticipant || currentParticipant.is_final) {
      if (nextTurnOrder > maxTurn) return;
      const gap = await checkSessionGap(eventId);
      if (gap) {
        io.to(`event:${eventId}`).emit('system:session_change', gap);
        io.to(`admin:event:${eventId}`).emit('system:session_change', gap);
        return;
      }
      const updated = await prisma.systemState.update({
        where: { event_id: eventId },
        data: { current_turn_order: nextTurnOrder, current_turn_start_time: new Date() }
      });
      emitTurn(eventId, updated);
      return;
    }

    // ── 자동배정 시퀀스 시작 (총 1.5초) ──
    autoAssignInProgress.add(eventId);
    try {
      // 1) 즉시 자동배정 문구 표시 → 클라이언트 좌석 잠금 + 타이머 정지
      console.log(`[AutoAssign] 시간 초과 - ${currentParticipant.name} 자동 배정 시작`);
      io.to(`event:${eventId}`).emit('system:auto_assign', { participantName: currentParticipant.name });
      io.to(`admin:event:${eventId}`).emit('system:auto_assign', { participantName: currentParticipant.name });

      // 2) 0.7초 후 좌석 자동배정
      await delay(AUTO_ASSIGN_NOTICE_MS);

      const layout = await prisma.venueLayout.findFirst({
        where: { event_id: eventId },
        include: { seats: true }
      });
      const sortedSeats = layout ? sortSeatsForAutoAssign(layout.seats, layout.cols) : [];

      if (sortedSeats.length === 0) {
        // 빈 좌석이 없으면 만료 처리만
        await prisma.participant.update({ where: { id: currentParticipant.id }, data: { turn_status: 'EXPIRED' } });
      } else {
        const targetSeat = sortedSeats[0];
        const result = await prisma.$transaction(async (tx) => {
          const updatedSeat = await tx.seat.update({
            where: { id: targetSeat.id },
            data: { status: 'AUTO_ASSIGNED', assigned_to: currentParticipant.id, session_id: currentParticipant.session_id }
          });
          const updatedParticipant = await tx.participant.update({
            where: { id: currentParticipant.id },
            data: { seat_id: targetSeat.id, is_final: true, turn_status: 'COMPLETED' }
          });
          return { updatedSeat, updatedParticipant };
        });

        io.to(`event:${eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: result.updatedParticipant });
        const userSocketId = activeSockets.get(currentParticipant.id);
        if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
        console.log(`[AutoAssign] ${currentParticipant.name} → ${targetSeat.row}행 ${targetSeat.col}열 완료`);
      }

      // 3) 0.8초 후 다음 턴으로 전환 (다음 사람 정확히 3:00 시작)
      await delay(AUTO_ASSIGN_NEXT_MS);

      if (nextTurnOrder <= maxTurn) {
        const gap = await checkSessionGap(eventId);
        if (gap) {
          io.to(`event:${eventId}`).emit('system:session_change', gap);
          io.to(`admin:event:${eventId}`).emit('system:session_change', gap);
        } else {
          const updatedState = await prisma.systemState.update({
            where: { event_id: eventId },
            data: { current_turn_order: nextTurnOrder, current_turn_start_time: new Date() }
          });
          emitTurn(eventId, updatedState);
        }
      } else {
        // 마지막 참가자까지 완료 → 자동배정 오버레이만 해제
        const finalState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
        if (finalState) emitTurn(eventId, finalState);
      }
    } catch (err) {
      console.error('[AutoAssign] 오류:', err);
    } finally {
      autoAssignInProgress.delete(eventId);
    }
  }

  setInterval(async () => {
    try {
      const activeEvents = await prisma.event.findMany({ where: { is_active: true } });
      // 각 이벤트를 비동기로 실행 (재진입 가드가 중복을 막아줌)
      for (const event of activeEvents) {
        runAutoAssignIfExpired(event.id);
      }
    } catch (err) {
      console.error('[Timer] 오류:', err);
    }
  }, 1000);
  // ────────────────────────────────────────────────────────────────────────

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
