import 'dotenv/config';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const prisma = new PrismaClient();
// CSV 업로드 용도이므로 파일당 2MB, 최대 2개 파일로 제한
// (제한이 없으면 대용량 업로드 한 번에 서버 메모리가 그대로 부풀어 오른다)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 2 },
});

// 프로덕션에서는 JWT_SECRET이 반드시 설정되어 있어야 한다.
// 기본값(하드코딩된 시크릿)으로 토큰을 서명하면 누구나 관리자 토큰을 위조할 수 있으므로,
// 미설정 시 조용히 기본값을 쓰지 말고 서버 시작 자체를 실패시킨다.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: 프로덕션 환경에서는 JWT_SECRET 환경변수가 반드시 필요합니다. 서버를 종료합니다.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';

// Store active participant sockets: participantId -> socketId
const activeSockets = new Map<string, string>();

// 관리자 화면으로 보내는 참가자 정보에서 세션 토큰을 제거한다.
// 토큰은 해당 참가자의 신분 증명값이라 관제 화면에 쓰일 일이 없고,
// 불필요하게 클라이언트(개발자 도구)에 노출할 이유가 없다.
const stripSessionToken = (p: any) => {
  if (!p) return p;
  const { session_token, ...rest } = p;
  return rest;
};

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

  // CORS 정책: 프론트엔드가 이 서버에서 함께 서빙되므로(동일 출처) 기본적으로
  // 교차 출처 허용이 필요 없다. 다른 도메인에서 API/소켓 접근을 허용해야 할 때만
  // ALLOWED_ORIGIN 환경변수로 해당 출처를 지정한다. (기존: 전 출처 허용 '*')
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

  const io = new Server(httpServer, ALLOWED_ORIGIN ? { cors: { origin: ALLOWED_ORIGIN } } : {});
  const PORT = Number(process.env.PORT) || 3000;

  // 해당 이벤트의 현재 접속 중인 참가자 ID 목록을 관리자에게 실시간 전송
  const broadcastOnlineParticipants = async (eventId: string) => {
    if (!eventId) return;
    const sockets = await io.in(`event:${eventId}`).fetchSockets();
    const online = [...new Set(sockets.map(s => s.data.participantId).filter(Boolean))];
    io.to(`admin:event:${eventId}`).emit('presence:update', { online });
  };

  // 특정 소켓에 이벤트의 초기 상태(좌석/시스템/공지/색상/채팅 이력)를 전송한다.
  // 인증 완료 시점(participant:auth)과 seat:request_init 양쪽에서 재사용한다.
  const emitInitialStateToSocket = async (targetSocket: any, eventId: string) => {
    const layout = await prisma.venueLayout.findFirst({
      where: { event_id: eventId },
      include: { seats: true }
    });
    if (layout) {
      targetSocket.emit('seat:init', { seats: layout.seats });
    }

    // 진행 흐름(그룹 대기/전원 완료 등)을 먼저 계산한다.
    const flow = await getFlowAnnouncement(eventId);

    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (systemState) {
      targetSocket.emit('system:freeze', {
        isFrozen: systemState.is_frozen,
        reason: systemState.frozen_reason
      });
      // flow가 있으면(그룹 시작 대기/그룹 간 대기/전원 완료 등) system:turn을 보내지 않는다.
      // 클라이언트는 system:turn을 받으면 announcement를 IDLE로 초기화하므로, 여기서 보내면
      // flow 이벤트가 도착하기 전까지 "현재 순서 000님"이 잠깐 잘못 표시된다.
      if (!flow) {
        targetSocket.emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time
        });
      }
    }

    // flow가 있으면 해당 공지(system:session_change / system:all_complete)를 전송한다.
    if (flow) targetSocket.emit(flow.event, flow.payload);

    const sessionColors = await prisma.sessionColor.findMany({ where: { event_id: eventId } });
    targetSocket.emit('session:colors', { sessionColors });

    // 최신 100개를 가져온 뒤 시간순(오래된 → 최신)으로 뒤집어 보낸다.
    // (asc + take는 "가장 오래된 100개"가 되어 100개 초과 시 최신 메시지가 누락된다)
    const messages = await prisma.chatMessage.findMany({
      where: { event_id: eventId },
      orderBy: { timestamp: 'desc' },
      take: 100
    });
    messages.reverse();
    targetSocket.emit('chat:history', { messages });
  };

  // Seed default admins if none exist
  const adminCount = await prisma.adminUser.count();
  if (adminCount === 0) {
    // 초기 비밀번호를 소스코드에 고정하지 않는다: 환경변수로 지정하거나,
    // 없으면 무작위로 생성해 서버 시작 로그에만 1회 출력한다.
    const seedPassword = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(9).toString('base64url');
    const password_hash = await bcrypt.hash(seedPassword, 10);
    await prisma.adminUser.createMany({
      data: [
        { username: '전초롱', password_hash, role: 'admin' },
        { username: '송다빈', password_hash, role: 'admin' },
        { username: '박은진', password_hash, role: 'admin' },
      ]
    });
    if (process.env.ADMIN_SEED_PASSWORD) {
      console.log('Seeded 3 default admin users (전초롱, 송다빈, 박은진) using ADMIN_SEED_PASSWORD env var.');
    } else {
      console.log(`Seeded 3 default admin users (전초롱, 송다빈, 박은진) with random password: ${seedPassword}`);
      console.log('이 비밀번호는 다시 표시되지 않습니다. 로그인 후 반드시 별도 계정 관리 절차로 교체하세요.');
    }
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

  // Render 등 리버스 프록시 뒤에서 클라이언트 실제 IP(X-Forwarded-For)를 신뢰
  // (rate limit이 프록시 IP가 아닌 사용자 IP 기준으로 동작하기 위해 필요)
  app.set('trust proxy', 1);

  // 보안 응답 헤더 (클릭재킹 방지 X-Frame-Options, MIME 스니핑 방지, HSTS 등).
  // CSP는 Vite 번들의 인라인 스타일과 충돌할 수 있어 비활성화 (필요 시 별도 도입)
  app.use(helmet({ contentSecurityPolicy: false }));

  // 교차 출처 허용이 필요한 경우에만 CORS 미들웨어 적용 (기본: 동일 출처만)
  if (ALLOWED_ORIGIN) {
    app.use(cors({ origin: ALLOWED_ORIGIN }));
  }
  app.use(express.json());

  // 관리자 로그인: IP당 15분에 10회. 관리자는 소수이므로 낮게 잡아 무차별 대입을 차단.
  const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: '로그인 시도가 너무 많습니다. 15분 후 다시 시도해주세요.' },
  });

  // 참가자 로그인: IP+이름 조합당 1분에 10회.
  // 비밀번호가 4자리 숫자(최대 1만 조합)라 IP 기준만으로는 부족하고,
  // 행사장 와이파이처럼 여러 참가자가 한 IP를 공유하는 경우 서로 막지 않도록
  // 이름별로 나눠서 제한한다. (특정인 계정에 대한 무차별 대입을 차단)
  const participantLoginLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip || '')}|${String(req.body?.name ?? '').trim()}`,
    message: { error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' },
  });

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

app.post('/api/admin/login', adminLoginLimiter, async (req, res) => {
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
        // 채팅 이력도 함께 삭제 (DB에서 실제 제거)
        await tx.chatMessage.deleteMany({ where: { event_id: eventId } });
      });

      // 진행 흐름 상태 초기화 (공지 캐시)
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
      io.to(`event:${eventId}`).emit('system:freeze', { isFrozen: false, reason: null });
      io.to(`admin:event:${eventId}`).emit('system:freeze', { isFrozen: false, reason: null });

      // 접속 중인 모든 화면의 채팅창을 즉시 비운다 (관리자는 admin:event_data의 messages: []로도 반영됨)
      io.to(`event:${eventId}`).emit('chat:history', { messages: [] });
      io.to(`admin:event:${eventId}`).emit('chat:history', { messages: [] });

      io.to(`admin:event:${eventId}`).emit('admin:event_data', {
        seats: layout?.seats || [],
        layout: layout ? {
          rows: layout.rows,
          cols: layout.cols,
          aisle_after_rows: layout.aisle_after_rows ? JSON.parse(layout.aisle_after_rows) : [],
          aisle_after_cols: layout.aisle_after_cols ? JSON.parse(layout.aisle_after_cols) : [],
        } : null,
        participants: participants.map(stripSessionToken),
        systemState,
        sessionColors: await prisma.sessionColor.findMany({ where: { event_id: eventId } }),
        messages: [],
      });

      // 초기화 직후 공지: 그룹 시작 대기 상태면 system:turn(현재 순서)로 깜빡이지 않도록
      // flow(대기/완료)를 우선 보내고, 그렇지 않을 때만 system:turn을 보낸다.
      const flow = await getFlowAnnouncement(eventId);
      if (flow) {
        io.to(`event:${eventId}`).emit(flow.event, flow.payload);
        io.to(`admin:event:${eventId}`).emit(flow.event, flow.payload);
      } else if (systemState) {
        io.to(`event:${eventId}`).emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time,
        });
        io.to(`admin:event:${eventId}`).emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time,
        });
      }

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

  // multer 미들웨어 오류(파일 크기 초과 등)를 HTML 500 대신 JSON으로 응답하기 위한 래퍼
  const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'seatFile', maxCount: 1 }]);
  const handleUploadFiles = (req: any, res: any, next: any) => {
    uploadFields(req, res, (err: any) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? '파일이 너무 큽니다. CSV 파일은 2MB 이하여야 합니다.'
          : '파일 업로드에 실패했습니다: ' + err.message;
        return res.status(400).json({ error: msg });
      }
      next();
    });
  };

  app.post('/api/admin/upload', requireAdmin, handleUploadFiles, async (req, res) => {
    try {
      const { name, rows, cols } = req.body;
      const layoutMode = req.body.layout_mode === 'grid' ? 'grid' : 'simple';
      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
      const file = files?.file?.[0];
      const seatFile = files?.seatFile?.[0];
      if (!file) return res.status(400).json({ error: 'No file uploaded' });
      if (layoutMode === 'grid' && !seatFile) {
        return res.status(400).json({ error: '격자 방식에서는 좌석 배치 CSV 파일이 필요합니다.' });
      }

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

      // 필수 컬럼 사전 검증: order_in_group이 누락된 채 뒤의 그룹/순번 중복 검사로 넘어가면
      // "그룹 1 순번 undefined 중복" 같은 엉뚱한 에러가 떠서 원인을 찾기 어렵다.
      // 어떤 행에 무엇이 빠졌는지 여기서 먼저 정확히 알려준다.
      records.forEach((r: any, index: number) => {
        if (!r.group_id || !r.participant_name || !r.password_4 || !r.order_in_group) {
          const availableKeys = Object.keys(r).join(', ');
          throw new Error(`CSV 파일 ${index + 1}번째 행에 필수 데이터가 누락되었습니다. (필수 컬럼: group_id, participant_name, password_4, order_in_group / 발견된 컬럼: ${availableKeys})`);
        }
        if (!Number.isInteger(Number(r.order_in_group))) {
          throw new Error(`CSV 파일 ${index + 1}번째 행의 order_in_group 값("${r.order_in_group}")이 올바른 숫자가 아닙니다.`);
        }
      });

      // 복도 정보 파싱 (body에서 aisle_after_rows, aisle_after_cols 받음)
      const aisleAfterRows = req.body.aisle_after_rows ? JSON.stringify(
        String(req.body.aisle_after_rows).split(',').map((v: string) => parseInt(v.trim())).filter((n: number) => !isNaN(n))
      ) : null;
      const aisleAfterCols = req.body.aisle_after_cols ? JSON.stringify(
        String(req.body.aisle_after_cols).split(',').map((v: string) => parseInt(v.trim())).filter((n: number) => !isNaN(n))
      ) : null;

      // ── 아래는 DB에 아무것도 쓰지 않는 순수 계산/검증 단계 ──────────────
      // 여기서 던지는 에러는 DB 반영 전이므로 "반쪽짜리" 이벤트가 남지 않는다.

      let parsedRows = 0;
      let parsedCols = 0;
      let gridSeatsData: { row: number; col: number; status: string; seat_label: string }[] = [];

      if (layoutMode === 'grid') {
        // ── 격자 CSV 방식: 각 칸이 좌석번호(있으면 좌석) 또는 빈칸(통로/여백) ──
        // 헤더 없이 원본 격자 그대로 파싱한다.
        const gridRowsRaw: string[][] = parse(seatFile!.buffer, {
          columns: false, skip_empty_lines: false, relax_column_count: true, bom: true
        });
        // 완전히 빈 줄(모든 칸이 빈 값)은 무시
        const cleanRows = gridRowsRaw.filter(row => row.some(cell => (cell ?? '').trim() !== ''));
        if (cleanRows.length === 0) {
          throw new Error('좌석 배치 CSV에서 좌석을 찾을 수 없습니다.');
        }
        parsedRows = cleanRows.length;
        parsedCols = Math.max(...cleanRows.map(r => r.length));

        const seenLabels = new Set<string>();
        cleanRows.forEach((row, rIdx) => {
          row.forEach((cell, cIdx) => {
            const label = (cell ?? '').trim();
            if (label === '') return; // 빈 칸 = 통로/여백 → 좌석 생성 안 함
            if (seenLabels.has(label)) {
              throw new Error(`좌석 배치 CSV에 중복된 좌석 번호가 있습니다: ${label}`);
            }
            seenLabels.add(label);
            gridSeatsData.push({ row: rIdx + 1, col: cIdx + 1, status: 'EMPTY', seat_label: label });
          });
        });
      } else {
        // ── 기존 방식: 행/열 전체를 꽉 찬 직사각형으로 생성 ──
        parsedRows = parseInt(rows);
        parsedCols = parseInt(cols);
        if (!Number.isInteger(parsedRows) || parsedRows <= 0 || !Number.isInteger(parsedCols) || parsedCols <= 0) {
          throw new Error('좌석 행(Row)/열(Col) 수는 1 이상의 정수여야 합니다.');
        }
      }

      // Process Participants
      const participantCounts = new Map<string, number>();
      records.forEach((r: any) => {
        const key = `${r.participant_name}-${r.password_4}`;
        participantCounts.set(key, (participantCounts.get(key) || 0) + 1);
      });

      // Extract unique sessions
      const sessions = Array.from(new Set(records.map((r: any) => r.group_id))).filter(Boolean).sort() as string[];

      // Generate colors for sessions
      const defaultColors = ['#8B2942', '#6B3FA0', '#D2691E', '#C43D8E', '#2A5C8A', '#1F6F5C'];
      const sessionColorsData = sessions.map((session_id, index) => {
        let color;
        if (index < defaultColors.length) {
          color = defaultColors[index];
        } else {
          // 7번째 그룹부터: 황금각(137.5°)으로 색상(hue)을 회전시켜 서로 구분되는 진한 색 생성.
          // (기존 방식은 lightness 95~98%의 거의 흰색이라 좌석 구분이 안 되고 흰 글자도 안 보였다)
          const hue = Math.round(20 + (index - defaultColors.length) * 137.5) % 360;
          color = `hsl(${hue}, 55%, 40%)`;
        }
        return { session_id, color };
      });

      // group_id + order_in_group 조합은 전역 순번(turn_order)을 결정하므로 유일해야 한다.
      // 중복되면 두 명 이상이 같은 순번을 갖게 되어 진행이 꼬이므로 업로드를 거부한다.
      const comboCounts = new Map<string, number>();
      records.forEach((r: any) => {
        const combo = `${r.group_id}|${r.order_in_group}`;
        comboCounts.set(combo, (comboCounts.get(combo) || 0) + 1);
      });
      const duplicateCombos = [...comboCounts.entries()].filter(([, count]) => count > 1);
      if (duplicateCombos.length > 0) {
        const detail = duplicateCombos
          .map(([combo, count]) => {
            const [g, o] = combo.split('|');
            return `그룹 ${g} 순번 ${o} (${count}명)`;
          })
          .join(', ');
        throw new Error(`참가자 명단에 그룹/순번이 중복된 항목이 있습니다: ${detail}. group_id와 order_in_group 조합은 고유해야 합니다.`);
      }

      // '추가' 그룹은 관전(추가신청) 계정: 로그인해서 좌석 현황만 볼 수 있고
      // 좌석 선택 순번을 부여하지 않는다 (turn_order 0 = 관전 계정 표식).
      // 완료 판정·진행 흐름에서도 제외되어, 미배정으로 남아도 완료 공지에 영향 없음.
      const OBSERVER_GROUP_ID = '추가';

      // Calculate global turn_order
      const turnGroups = new Set<string>();
      records.forEach((r: any) => {
        if (String(r.group_id) === OBSERVER_GROUP_ID) return; // 관전 계정은 순번 계산 제외
        turnGroups.add(`${r.group_id}|${r.order_in_group}`);
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

      const participantsData = records.map((r: any) => {
        // 필수 컬럼은 위 사전 검증에서 이미 확인됨
        const key = `${r.participant_name}-${r.password_4}`;
        const isDuplicate = (participantCounts.get(key) || 0) > 1;
        const isObserver = String(r.group_id) === OBSERVER_GROUP_ID;
        const globalTurnOrder = isObserver ? 0 : (turnOrderMap.get(`${r.group_id}|${r.order_in_group}`) || 1);
        return {
          session_id: String(r.group_id),
          name: String(r.participant_name),
          phone_last4: String(r.password_4),
          unique_code: isDuplicate ? Math.random().toString(36).substring(2, 6).toUpperCase() : null,
          turn_order: globalTurnOrder,
        };
      });

      // ── 여기부터 실제 DB 반영. 하나의 트랜잭션으로 묶어 중간에 실패해도
      // "반쪽짜리" 이벤트가 남지 않도록 한다. ──────────────────────────
      const { event, prevActiveIds } = await prisma.$transaction(async (tx) => {
        // 비활성화 대상(기존 활성 이벤트) ID를 먼저 확보해 둔다
        // → 업로드 완료 후 해당 이벤트의 접속 참가자들을 로그아웃시키는 데 사용
        const prevActive = await tx.event.findMany({
          where: { is_active: true },
          select: { id: true }
        });

        // Deactivate all previous events so the new one becomes the active event
        await tx.event.updateMany({
          where: { is_active: true },
          data: { is_active: false }
        });

        const event = await tx.event.create({
          data: { name, date: new Date() }
        });

        const layout = layoutMode === 'grid'
          ? await tx.venueLayout.create({
              data: {
                event_id: event.id, rows: parsedRows, cols: parsedCols,
                aisle_after_rows: null, aisle_after_cols: null, layout_mode: 'grid'
              }
            })
          : await tx.venueLayout.create({
              data: {
                event_id: event.id, rows: parsedRows, cols: parsedCols,
                aisle_after_rows: aisleAfterRows, aisle_after_cols: aisleAfterCols, layout_mode: 'simple'
              }
            });

        if (layoutMode === 'grid') {
          await tx.seat.createMany({
            data: gridSeatsData.map(s => ({ ...s, layout_id: layout.id }))
          });
        } else {
          const seatsData = [];
          for (let r = 1; r <= parsedRows; r++) {
            for (let c = 1; c <= parsedCols; c++) {
              seatsData.push({ layout_id: layout.id, row: r, col: c, status: 'EMPTY' });
            }
          }
          await tx.seat.createMany({ data: seatsData });
        }

        await tx.sessionColor.createMany({
          data: sessionColorsData.map(s => ({ ...s, event_id: event.id }))
        });

        await tx.participant.createMany({
          data: participantsData.map(p => ({ ...p, event_id: event.id }))
        });

        await tx.systemState.create({
          data: {
            event_id: event.id,
            current_turn_order: 1,
            current_turn_start_time: new Date()
          }
        });

        return { event, prevActiveIds: prevActive.map(e => e.id) };
      });

      // ── 이전 활성 이벤트의 참가자들을 즉시 로그아웃 처리 ──────────────
      // 새 이벤트가 활성화되면 이전 이벤트 화면을 켜둔 참가자는 갱신이 멈춘 채
      // 이전 좌석표만 계속 보게 되고, 세션 토큰도 유효해서 새로고침해도 그대로였다.
      // 토큰을 무효화하고 session:expired를 보내 로그인 화면으로 돌려보낸다.
      for (const oldId of prevActiveIds) {
        await prisma.participant.updateMany({
          where: { event_id: oldId },
          data: { session_token: null }
        });
        const oldSockets = await io.in(`event:${oldId}`).fetchSockets();
        for (const s of oldSockets) {
          if (!s.data.participantId) continue; // 같은 방의 관리자 소켓은 건드리지 않음
          activeSockets.delete(s.data.participantId);
          s.data.participantId = null;
          s.data.eventId = null;
          s.leave(`event:${oldId}`);
          s.emit('session:expired', { reason: '새로운 이벤트가 시작되었습니다. 다시 로그인해주세요.' });
        }
        flowAnnounced.delete(oldId);
        broadcastOnlineParticipants(oldId);
      }

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

  app.post('/api/auth/login', participantLoginLimiter, async (req, res) => {
    // 입력값 앞뒤 공백 자동 제거 (모바일 키보드 자동완성 등으로 공백이 붙어
    // "참가자 정보를 찾을 수 없습니다"가 뜨는 것 방지). 이름 중간 공백은 그대로 구분한다.
    const name = String(req.body.name ?? '').trim();
    const phone_last4 = String(req.body.phone_last4 ?? '').trim();
    const uniqueCodeRaw = req.body.unique_code;
    const unique_code = typeof uniqueCodeRaw === 'string' && uniqueCodeRaw.trim() ? uniqueCodeRaw.trim() : undefined;
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
        // 이전 소켓을 이벤트 방/presence에서 즉시 정리한다
        // (연결 자체는 끊지 않아 클라이언트가 만료 안내를 표시할 수 있다)
        const oldSocket = io.sockets.sockets.get(existingSocketId);
        if (oldSocket) {
          const oldEventId = oldSocket.data.eventId;
          oldSocket.data.participantId = null;
          oldSocket.data.eventId = null;
          if (oldEventId) {
            oldSocket.leave(`event:${oldEventId}`);
            broadcastOnlineParticipants(oldEventId);
          }
        }
        activeSockets.delete(participant.id);
      }

      res.json({ success: true, user: updatedParticipant, sessionToken: session_token });
    } catch (error) {
      console.error('Participant login error:', error);
      res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
    }
  });

  // 현재 활성 이벤트의 좌석/참가자/색상 조회.
  // 참가자 명단(이름·순번)이 포함되므로 로그인한 참가자만 조회할 수 있게 한다.
  // (기존엔 완전 공개 API여서 로그인 없이 전체 명단을 볼 수 있었다)
  app.get('/api/seats', async (req, res) => {
    try {
      const participantId = req.headers['x-participant-id'];
      const sessionToken = req.headers['x-session-token'];
      if (typeof participantId !== 'string' || typeof sessionToken !== 'string' || !participantId || !sessionToken) {
        return res.status(401).json({ error: '로그인이 필요합니다.' });
      }
      const requester = await prisma.participant.findUnique({ where: { id: participantId } });
      if (!requester || !requester.session_token || requester.session_token !== sessionToken) {
        return res.status(401).json({ error: '유효하지 않은 세션입니다.' });
      }

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

      // 요청자가 현재 활성 이벤트의 참가자인지 확인 (지난 이벤트 세션으로 조회 불가)
      if (requester.event_id !== event.id) {
        return res.status(403).json({ error: '현재 이벤트의 참가자가 아닙니다.' });
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

      // 안전망: 참가자의 이벤트가 더 이상 활성이 아니면(새 이벤트로 교체됨) 세션 만료 처리.
      // 업로드 시점의 일괄 로그아웃 신호를 놓친 기기(당시 오프라인이었던 폰 등)도
      // 다음 재연결/새로고침 때 여기서 확실히 걸러진다.
      const participantEvent = await prisma.event.findUnique({ where: { id: participant.event_id } });
      if (!participantEvent || !participantEvent.is_active) {
        socket.emit('session:expired', { reason: '이벤트가 종료되었습니다. 다시 로그인해주세요.' });
        return;
      }

      // 역할 상호 배타: 참가자로 인증한 소켓은 관리자 권한을 내려놓는다.
      // (같은 탭에서 관리자 → 참가자로 이동해 테스트하면 소켓에 관리자 표식이 남아,
      //  참가자 채팅이 '관리자' 이름으로 나가고 차례 제한도 우회되는 문제 방지)
      if (socket.data.isAdmin) {
        socket.data.isAdmin = false;
        socket.data.adminToken = null;
        if (socket.data.adminEventId) {
          socket.leave(`admin:event:${socket.data.adminEventId}`);
          socket.data.adminEventId = null;
        }
      }

      // Register active socket
      activeSockets.set(participantId, socket.id);
      socket.data.participantId = participantId;
      socket.data.eventId = participant.event_id;
      socket.join(`event:${participant.event_id}`);
      console.log(`Participant ${participant.name} authenticated on socket ${socket.id}`);
      broadcastOnlineParticipants(participant.event_id);

      // 인증 완료 시점에 초기 상태를 전송한다.
      // (클라이언트가 접속 직후 participant:auth와 seat:request_init를 함께 보내는데,
      //  auth가 비동기 처리되는 동안 seat:request_init가 먼저 도착하면 아직 인증 전이라
      //  거절될 수 있으므로, 여기서 확실하게 한 번 보내 초기 로딩 누락을 방지한다)
      await emitInitialStateToSocket(socket, participant.event_id);
    });

    // Authenticate admin socket
    socket.on('admin:auth', async (data: { token: string }) => {
      try {
        const decoded = jwt.verify(data.token, JWT_SECRET) as any;
        if (decoded.role === 'admin') {
          // 역할 상호 배타: 관리자로 인증한 소켓은 참가자 상태를 정리한다.
          // (같은 탭에서 참가자 → 관리자로 이동한 경우 접속자 수에 잔류하는 것 방지)
          const prevPid = socket.data.participantId;
          const prevEid = socket.data.eventId;
          if (prevPid) {
            if (activeSockets.get(prevPid) === socket.id) activeSockets.delete(prevPid);
            socket.data.participantId = null;
            socket.data.eventId = null;
            if (prevEid) {
              socket.leave(`event:${prevEid}`);
              broadcastOnlineParticipants(prevEid);
            }
          }

          socket.data.isAdmin = true;
          socket.data.adminId = decoded.id;
          // 매 관리자 요청마다 만료를 재검증할 수 있도록 토큰을 보관한다
          socket.data.adminToken = data.token;
          console.log(`Admin authenticated on socket ${socket.id}`);
        }
      } catch (err) {
        socket.emit('admin:error', { error: 'Invalid admin token' });
      }
    });

    // 관리자 소켓 검증: admin:auth 때 저장해 둔 토큰을 요청마다 다시 검증한다.
    // (한 번 인증됐다고 소켓이 살아있는 동안 무기한 관리자 권한이 유지되지 않도록.
    //  HTTP 라우트의 requireAdmin은 매 요청 검증하지만 소켓은 그동안 최초 1회뿐이었다)
    const verifyAdminSocket = (): boolean => {
      if (!socket.data.isAdmin || !socket.data.adminToken) return false;
      try {
        const decoded = jwt.verify(socket.data.adminToken, JWT_SECRET) as any;
        if (decoded.role !== 'admin') throw new Error();
        return true;
      } catch {
        socket.data.isAdmin = false;
        socket.data.adminToken = null;
        socket.emit('admin:error', { error: '관리자 인증이 만료되었습니다. 다시 로그인해주세요.' });
        return false;
      }
    };

    // Admin request event details (seats + participants)
    socket.on('admin:request_event', async (data: { eventId: string }) => {
      if (!verifyAdminSocket()) return;

      // 이벤트를 전환할 때 이전에 선택했던 이벤트의 방에서 나간다.
      // (나가지 않으면 이전 이벤트의 좌석/턴 브로드캐스트가 계속 섞여 들어온다)
      const prevEventId = socket.data.adminEventId;
      if (prevEventId && prevEventId !== data.eventId) {
        socket.leave(`admin:event:${prevEventId}`);
        socket.leave(`event:${prevEventId}`);
      }
      socket.data.adminEventId = data.eventId;

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

      // 최신 100개를 시간순으로 (emitInitialStateToSocket와 동일한 이유)
      const messages = await prisma.chatMessage.findMany({
        where: { event_id: data.eventId },
        orderBy: { timestamp: 'desc' },
        take: 100
      });
      messages.reverse();

      socket.emit('admin:event_data', {
        seats: layout?.seats || [],
        layout: layout ? {
          rows: layout.rows,
          cols: layout.cols,
          aisle_after_rows: layout.aisle_after_rows ? JSON.parse(layout.aisle_after_rows) : [],
          aisle_after_cols: layout.aisle_after_cols ? JSON.parse(layout.aisle_after_cols) : [],
        } : null,
        participants: participants.map(stripSessionToken),
        systemState,
        sessionColors,
        messages
      });

      const flow = await getFlowAnnouncement(data.eventId);
      if (flow) {
        socket.emit(flow.event, flow.payload);
      } else if (systemState) {
        // flow가 없으면 system:turn을 보내 관리자 화면의 announcement를 IDLE로 초기화한다.
        // (이벤트를 전환했을 때 이전 이벤트의 공지 상태가 그대로 남는 것을 방지)
        socket.emit('system:turn', {
          currentTurnOrder: systemState.current_turn_order,
          currentTurnStartTime: systemState.current_turn_start_time,
        });
      }

      // 관리자 입장 시 현재 접속자 목록 즉시 전송
      broadcastOnlineParticipants(data.eventId);
    });

    // Admin freeze/unfreeze system
    socket.on('admin:toggle_freeze', async (data: { eventId: string, isFrozen: boolean, reason?: string }) => {
      if (!verifyAdminSocket()) return;

      const now = new Date();
      const existing = await prisma.systemState.findUnique({ where: { event_id: data.eventId } });

      let updateData: any;
      let turnStartShifted = false;
      if (data.isFrozen) {
        // 일시정지: 정지 시각을 기록해 둔다 (재개 시 흐른 시간 계산용)
        updateData = { is_frozen: true, frozen_reason: data.reason || null, frozen_at: now };
      } else {
        // 재개: 정지된 동안 흐른 시간만큼 턴 시작 시각을 뒤로 밀어 남은 시간을 보존한다
        updateData = { is_frozen: false, frozen_reason: null, frozen_at: null };
        if (existing?.frozen_at && existing?.current_turn_start_time) {
          const pausedMs = now.getTime() - new Date(existing.frozen_at).getTime();
          updateData.current_turn_start_time = new Date(new Date(existing.current_turn_start_time).getTime() + pausedMs);
          turnStartShifted = true;
        }
      }

      const state = await prisma.systemState.upsert({
        where: { event_id: data.eventId },
        update: updateData,
        create: { event_id: data.eventId, is_frozen: data.isFrozen, frozen_reason: data.reason || null, frozen_at: data.isFrozen ? now : null }
      });

      io.to(`event:${data.eventId}`).emit('system:freeze', {
        isFrozen: state.is_frozen,
        reason: state.frozen_reason
      });
      io.to(`admin:event:${data.eventId}`).emit('system:freeze', {
        isFrozen: state.is_frozen,
        reason: state.frozen_reason
      });

      // 재개하면서 턴 시작 시각을 밀었으면 모든 클라이언트 타이머를 재동기화한다.
      // 단, 무조건 system:turn만 보내면 "그룹 완료 후 다음 그룹 시작 대기" 같은
      // 상태에서 이미 끝난 마지막 참가자의 타이머가 다시 도는 것처럼 보인다.
      // notifyTurnAdvance로 현재 흐름(대기/완료 여부)을 먼저 확인한 뒤 알린다.
      if (!data.isFrozen && turnStartShifted) {
        await notifyTurnAdvance(data.eventId, state);
      }
    });

    // Admin force cancel seat
    socket.on('admin:cancel_seat', async (data: { seatId: string, eventId: string }) => {
      if (!verifyAdminSocket()) return;
      // 자동배정 시퀀스와 동시에 같은 좌석/참가자를 건드리지 않도록 잠금을 공유한다.
      if (autoAssignInProgress.has(data.eventId)) {
        return socket.emit('admin:error', { error: '자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      }
      autoAssignInProgress.add(data.eventId);

      try {
        const result = await prisma.$transaction(async (tx) => {
          const seat = await tx.seat.findUnique({ where: { id: data.seatId } });
          if (!seat || (seat.status !== 'RESERVED' && seat.status !== 'AUTO_ASSIGNED') || !seat.assigned_to) {
            throw new Error('취소할 수 없는 좌석입니다.');
          }

          const participantId = seat.assigned_to;
          const participant = await tx.participant.findUnique({ where: { id: participantId } });
          const systemState = await tx.systemState.findUnique({ where: { event_id: data.eventId } });
          const currentTurn = systemState?.current_turn_order ?? 1;

          const updatedSeat = await tx.seat.update({
            where: { id: data.seatId },
            data: { status: 'EMPTY', assigned_to: null, session_id: null }
          });

          // 이미 지난 순번(turn_order < 현재 순번)의 좌석을 취소하는 경우:
          // is_final: false로 되돌리면 전체 완료 판단(remaining 카운트)이 꼬이고,
          // 정작 그 참가자는 차례가 지나 재선택도 못 하는 교착이 생긴다.
          // 따라서 좌석만 회수하고 is_final은 true로 유지(완료 취급), 상태는 CANCELLED로 표시한다.
          // 다시 앉히려면 관리자가 수동 배정(force_assign)으로 처리한다.
          // 반면 현재/미래 순번이면 재선택이 가능하도록 WAITING으로 되돌린다.
          const isPastTurn = participant ? participant.turn_order < currentTurn : false;

          const updatedParticipant = await tx.participant.update({
            where: { id: participantId },
            data: isPastTurn
              ? { seat_id: null, is_final: true, turn_status: 'CANCELLED' }
              : { seat_id: null, is_final: false, turn_status: 'WAITING' }
          });

          return { updatedSeat, updatedParticipant };
        });

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: result.updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('participant:update_admin', { participant: stripSessionToken(result.updatedParticipant) });

        // Notify the specific user that their seat was cancelled
        const userSocketId = activeSockets.get(result.updatedParticipant.id);
        if (userSocketId) {
          io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
          io.to(userSocketId).emit('seat:error', { error: '관리자에 의해 좌석 예약이 취소되었습니다.' });
        }

      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      } finally {
        autoAssignInProgress.delete(data.eventId);
      }
    });

    // Admin force assign seat
    // 관리자: 좌석을 '사석'으로 지정하거나 다시 선택 가능 상태로 되돌리기
    socket.on('admin:set_seat_private', async (data: { seatId: string, eventId: string, isPrivate: boolean }) => {
      if (!verifyAdminSocket()) return;
      if (autoAssignInProgress.has(data.eventId)) {
        return socket.emit('admin:error', { error: '자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      }
      autoAssignInProgress.add(data.eventId);

      try {
        const seat = await prisma.seat.findUnique({ where: { id: data.seatId } });
        if (!seat) throw new Error('좌석을 찾을 수 없습니다.');
        if (seat.status !== 'EMPTY' && seat.status !== 'PRIVATE') {
          throw new Error('이미 배정된 좌석은 변경할 수 없습니다.');
        }

        const updatedSeat = await prisma.seat.update({
          where: { id: data.seatId, status: seat.status },
          data: { status: data.isPrivate ? 'PRIVATE' : 'EMPTY' }
        });

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      } finally {
        autoAssignInProgress.delete(data.eventId);
      }
    });

    // Admin: 수동 배정 (참가자 계정 없이 좌석에 이름만 표기)
    socket.on('admin:set_manual_seat', async (data: { seatId: string, eventId: string, label: string | null }) => {
      if (!verifyAdminSocket()) return;
      if (autoAssignInProgress.has(data.eventId)) {
        return socket.emit('admin:error', { error: '자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      }
      autoAssignInProgress.add(data.eventId);

      try {
        const seat = await prisma.seat.findUnique({ where: { id: data.seatId } });
        if (!seat) throw new Error('좌석을 찾을 수 없습니다.');
        if (seat.status !== 'EMPTY' && seat.status !== 'MANUAL') {
          throw new Error('빈 좌석 또는 수동 배정 좌석만 변경할 수 있습니다.');
        }

        const label = (data.label || '').trim();
        const updatedSeat = await prisma.seat.update({
          where: { id: data.seatId, status: seat.status },
          data: label
            ? { status: 'MANUAL', manual_label: label, assigned_to: null, session_id: null }
            : { status: 'EMPTY', manual_label: null }
        });

        io.to(`event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
        io.to(`admin:event:${data.eventId}`).emit('seat:update', { seat: updatedSeat });
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      } finally {
        autoAssignInProgress.delete(data.eventId);
      }
    });

    socket.on('admin:force_assign', async (data: { seatId: string, participantId: string, eventId: string }) => {
      if (!verifyAdminSocket()) return;
      if (autoAssignInProgress.has(data.eventId)) {
        return socket.emit('admin:error', { error: '자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      }
      autoAssignInProgress.add(data.eventId);

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
            where: { id: data.seatId, status: 'EMPTY' },
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
        io.to(`admin:event:${data.eventId}`).emit('participant:update_admin', { participant: stripSessionToken(result.updatedParticipant) });

        // Notify the specific user
        const userSocketId = activeSockets.get(result.updatedParticipant.id);
        if (userSocketId) {
          io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
          io.to(userSocketId).emit('seat:error', { error: '관리자에 의해 좌석이 강제 배정되었습니다.' });
        }

      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      } finally {
        autoAssignInProgress.delete(data.eventId);
      }
    });

    // Admin: 현재 선택자 좌석 자동배정 후 다음 턴으로 넘기기
    socket.on('admin:next_turn', async (data: { eventId: string }) => {
      if (!verifyAdminSocket()) return;

      try {
        await forceAssignAndAdvanceTurn(data.eventId);
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    // Admin: 좌석 배정 없이 현재 참가자를 건너뛰고 다음 턴으로 (불참/오류 대응)
    socket.on('admin:skip_turn', async (data: { eventId: string }) => {
      if (!verifyAdminSocket()) return;

      try {
        await skipCurrentTurn(data.eventId);
      } catch (error: any) {
        socket.emit('admin:error', { error: error.message });
      }
    });

    // Admin: 전체 참가자 화면 강제 새로고침 신호 전송 (화면 멈춤 복구용)
    socket.on('admin:force_reload', async (data: { eventId: string }) => {
      if (!verifyAdminSocket()) return;
      io.to(`event:${data.eventId}`).emit('force_reload', {});
      socket.emit('admin:info', { message: '전체 참가자 화면에 새로고침 신호를 보냈습니다.' });
    });

    // Request initial seats
    // 참가자 소켓 전용: 클라이언트가 보낸 eventId를 신뢰하지 않고 인증된 소켓의 eventId만 사용한다.
    // 인증되지 않은 소켓이거나 다른 이벤트를 요청하면 조용히 무시한다.
    socket.on('seat:request_init', async (data: { eventId: string }) => {
      const eventId = socket.data.eventId;
      if (!socket.data.participantId || !eventId) return; // 인증되지 않은 소켓 거절
      if (data.eventId && data.eventId !== eventId) return; // 다른 이벤트 요청 거절

      await emitInitialStateToSocket(socket, eventId);
    });

    // Handle seat selection
    socket.on('seat:select', async (data: { seatId: string }) => {
      const participantId = socket.data.participantId;
      if (!participantId) {
        return socket.emit('seat:error', { error: '로그인이 필요합니다.' });
      }

      const eventId = socket.data.eventId;
      // 자동배정/관리자 강제배정과 동일한 잠금을 공유하여, 타이머 만료 직전 클릭과의 경합을 막는다.
      if (autoAssignInProgress.has(eventId)) {
        return socket.emit('seat:error', { error: '자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      }
      autoAssignInProgress.add(eventId);

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

          // 관전 계정(turn_order 0)은 좌석 선택 불가 — 차례가 영원히 오지 않지만
          // "차례가 아닙니다" 대신 명확한 안내를 준다.
          if (participant.turn_order === 0) {
            throw new Error('관람용 계정은 좌석을 선택할 수 없습니다. 좌석 지정은 운영진이 도와드립니다.');
          }

          // Dynamic turn check
          if (!systemState || participant.turn_order !== systemState.current_turn_order) {
            throw new Error('아직 좌석 선택 차례가 아닙니다.');
          }

          // 그룹이 시작되기 전(시작시간 미지정 또는 미도달)에는 차례여도 선택 불가
          const sess = await tx.sessionColor.findFirst({
            where: { event_id: socket.data.eventId, session_id: participant.session_id }
          });
          if (!isGroupStarted(sess?.start_time)) {
            throw new Error(sess?.start_time
              ? `아직 그룹 시작 시간이 아닙니다. (시작: ${sess.start_time})`
              : '아직 그룹 시작 시간이 지정되지 않았습니다.');
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

          const seat = await tx.seat.findUnique({ where: { id: data.seatId }, include: { layout: true } });
          if (!seat) throw new Error('좌석을 찾을 수 없습니다.');
          // 좌석이 이 참가자의 이벤트 소속인지 확인
          // (과거 이벤트의 좌석 ID 등으로 다른 이벤트 좌석이 배정되는 데이터 오염 방지)
          if (seat.layout.event_id !== socket.data.eventId) {
            throw new Error('이 이벤트의 좌석이 아닙니다.');
          }
          if (seat.status !== 'EMPTY') throw new Error('이미 선택되었거나 사용할 수 없는 좌석입니다.');

          // Update seat and participant
          // where에 status: 'EMPTY' 조건을 함께 걸어(다른 배정 경로들과 동일),
          // 위에서 읽은 뒤 다른 경로가 먼저 좌석을 차지했으면 덮어쓰지 않고 실패하게 한다.
          const updatedSeat = await tx.seat.update({
            where: { id: data.seatId, status: 'EMPTY' },
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
        io.to(`admin:event:${socket.data.eventId}`).emit('participant:update_admin', { participant: stripSessionToken(result.updatedParticipant) });

        // 턴 전환 알림: 전원 완료/그룹 간 대기 여부를 먼저 확인한 뒤 emit한다
        // (무조건 system:turn만 보내면 마지막 참가자가 선택한 순간 "대기 중"으로 잘못 보임)
        await notifyTurnAdvance(socket.data.eventId, result.updatedSystemState);

      } catch (error: any) {
        socket.emit('seat:error', { error: error.message || '좌석 선택 중 오류가 발생했습니다.' });
      } finally {
        autoAssignInProgress.delete(eventId);
      }
    });

    socket.on('chat:send', async (data: { eventId: string, content: string }) => {
      try {
        const { content } = data;
        if (!content || !content.trim()) return;
        // 길이 제한: 제한이 없으면 요청 본문 한도(~100KB)까지의 메시지를 저장·전체
        // 브로드캐스트할 수 있어 화면 도배/저장소 낭비에 악용될 수 있다.
        if (content.trim().length > 500) {
          socket.emit('chat:error', { error: '메시지는 500자 이내로 입력해주세요.' });
          return;
        }

        let senderType = 'USER';
        let senderName = 'Unknown';
        let eventId: string;

        if (socket.data.isAdmin) {
          if (!verifyAdminSocket()) return; // 토큰 만료된 관리자 소켓의 채팅 차단
          senderType = 'ADMIN';
          senderName = '관리자';
          eventId = data.eventId;
        } else if (socket.data.participantId && socket.data.eventId) {
          // 참가자는 클라이언트가 보낸 eventId를 신뢰하지 않고, 인증된 소켓의 eventId만 사용한다.
          // (타 이벤트 채팅방에 메시지를 주입하는 것을 방지)
          eventId = socket.data.eventId;
          if (data.eventId && data.eventId !== eventId) {
            socket.emit('chat:error', { error: '잘못된 이벤트 요청입니다.' });
            return;
          }
          const participant = await prisma.participant.findUnique({ where: { id: socket.data.participantId } });
          const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
          
          if (!participant || !systemState) return;
          
          // 채팅 권한: 자기 차례이고 아직 선택 완료 전이면 가능.
          // 일시정지(is_frozen) 중에도 현재 차례였던 참가자는 채팅 가능하게 허용.
          if (participant.turn_order !== systemState.current_turn_order || participant.is_final) {
            socket.emit('chat:error', { error: '채팅 권한이 없습니다.' });
            return;
          }

          // 그룹이 시작되기 전(시작시간 미지정 또는 미도달)에는 채팅 불가
          const chatSession = await prisma.sessionColor.findFirst({
            where: { event_id: eventId, session_id: participant.session_id }
          });
          if (!isGroupStarted(chatSession?.start_time)) {
            socket.emit('chat:error', { error: chatSession?.start_time
              ? `아직 그룹 시작 시간이 아닙니다. (시작: ${chatSession.start_time})`
              : '아직 그룹 시작 시간이 지정되지 않았습니다.' });
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

    // 참가자 명시적 로그아웃: presence(접속자 수)에서 즉시 제거하고 세션 토큰을 무효화한다.
    // (기존엔 클라이언트 상태만 지워져서, 소켓이 끊길 때까지 관리자 화면에 '접속 중'으로 남았다)
    socket.on('participant:logout', async () => {
      const pid = socket.data.participantId;
      const eid = socket.data.eventId;
      if (!pid) return;
      try {
        await prisma.participant.update({ where: { id: pid }, data: { session_token: null } });
      } catch { /* 이미 삭제된 참가자 등은 무시 */ }
      if (activeSockets.get(pid) === socket.id) activeSockets.delete(pid);
      socket.data.participantId = null;
      socket.data.eventId = null;
      if (eid) {
        socket.leave(`event:${eid}`);
        broadcastOnlineParticipants(eid);
      }
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
      if (socket.data.participantId) {
        if (activeSockets.get(socket.data.participantId) === socket.id) {
          activeSockets.delete(socket.data.participantId);
        }
        if (socket.data.eventId) broadcastOnlineParticipants(socket.data.eventId);
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
  }, 3000);

  // ─── 자동 타이머 & 자동 배정 스케줄러 (1초마다 실행) ───────────────────
  const TURN_DURATION_MS = 3 * 60 * 1000; // 3분
  const AUTO_ASSIGN_NOTICE_MS = 700; // 자동배정 문구 표시 후 좌석 배정까지
  const AUTO_ASSIGN_NEXT_MS = 800;   // 좌석 배정 후 다음 턴 전환까지 (총 1.5초)
  const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
  // 실제 배정(자동 시퀀스/수동 강제배정/건너뛰기)이 진행 중인 이벤트.
  // 이 잠금이 있을 때만 참가자 seat:select를 막는다.
  const autoAssignInProgress = new Set<string>();
  // 1초 스케줄러의 평가(evaluation) 중복 실행만 막는 용도. seat:select는 막지 않는다.
  const autoEvalInProgress = new Set<string>();

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

  // "HH:MM"(Asia/Seoul) 시작 시간을 "오늘" 날짜의 실제 UTC 순간(Date)으로 변환한다.
  // 타이머가 그룹 시작 이전 시각으로 설정돼 있는지 판단하는 데 사용한다. (서울은 UTC+9, DST 없음)
  function sessionStartMomentToday(startTime: string | null | undefined): Date | null {
    if (!startTime) return null;
    const m = startTime.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    const y = Number(parts.find(p => p.type === 'year')?.value);
    const mo = Number(parts.find(p => p.type === 'month')?.value);
    const d = Number(parts.find(p => p.type === 'day')?.value);
    if (!y || !mo || !d) return null;
    // 서울(UTC+9) 기준 시각을 UTC instant로 변환 (hh-9가 음수여도 Date.UTC가 롤오버 처리)
    return new Date(Date.UTC(y, mo - 1, d, Number(m[1]) - 9, Number(m[2]), 0, 0));
  }

  // 진행 흐름 판단용: 그룹이 "시작되었는지" 여부.
  // start_time이 설정되어 있고(비어있지 않고) 그 시각에 도달했을 때만 true.
  // start_time이 지정되지 않은 그룹은 아직 시작하지 않은 것으로 보아 대기시킨다.
  // (isSessionStartTimeReached는 null을 "제한 없음"으로 보지만, 흐름 제어에서는 반대로 취급)
  function isGroupStarted(startTime: string | null | undefined): boolean {
    return !!startTime && isSessionStartTimeReached(startTime);
  }

  // 이벤트별 마지막 공지 키 (동일 공지 중복 emit 방지)
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
    // 관전 계정(turn_order 0, '추가' 그룹)은 좌석을 배정받지 않아도 완료 판정에서 제외한다.
    // (제외하지 않으면 미사용 관전 계정 때문에 전원 완료 공지가 영원히 뜨지 않는다)
    const remaining = await prisma.participant.count({
      where: { event_id: eventId, is_final: false, turn_order: { gt: 0 } }
    });
    if (remaining === 0) return { event: 'system:all_complete', payload: {} };
    const cur = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });
    if (cur && !cur.is_final) {
      const sess = await prisma.sessionColor.findFirst({
        where: { event_id: eventId, session_id: cur.session_id }
      });
      // 현재 그룹이 아직 시작되지 않았으면(시작시간 미지정 또는 미도달) 대기 상태로 유지한다.
      if (!isGroupStarted(sess?.start_time)) {
        return {
          event: 'system:session_change',
          payload: { prevSession: null, nextSession: cur.session_id, nextStartTime: sess?.start_time ?? null }
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
    // 다음 그룹이 이미 시작되었으면 대기(gap) 없이 바로 진행. 아직 시작 전(미지정 포함)이면 대기.
    if (isGroupStarted(nextSession?.start_time)) return null;
    return {
      prevSession: currentParticipant.session_id,
      nextSession: nextParticipant.session_id,
      nextStartTime: nextSession?.start_time ?? null
    };
  }

  // 턴을 넘긴 직후 호출: 무조건 system:turn만 보내면 방금 막 전원이 완료되었거나
  // 그룹 간 대기 상태로 넘어간 경우를 놓쳐서, 참가자 화면에 "대기 중"이 잘못 표시된 채로
  // 다음 1초 스케줄러 틱까지 방치될 수 있다. 여기서 즉시 흐름을 재확인해 올바른 이벤트를 보낸다.
  async function notifyTurnAdvance(eventId: string, updatedState: { current_turn_order: number; current_turn_start_time: Date }) {
    const flow = await getFlowAnnouncement(eventId);
    if (flow) {
      flowAnnounced.set(eventId, flow.event + JSON.stringify(flow.payload));
      io.to(`event:${eventId}`).emit(flow.event, flow.payload);
      io.to(`admin:event:${eventId}`).emit(flow.event, flow.payload);
      return;
    }
    flowAnnounced.delete(eventId);
    emitTurn(eventId, updatedState);
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
    // 자동배정 타이머 및 다른 관리자의 동시 클릭과의 경합 방지:
    // 자동 경로(runAutoAssignIfExpired)와 동일한 잠금을 공유하여 직렬화한다.
    if (autoAssignInProgress.has(eventId)) {
      throw new Error('이미 자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.');
    }
    autoAssignInProgress.add(eventId);
    try {
    const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
    if (!systemState) throw new Error('시스템 상태를 찾을 수 없습니다.');

    // 그룹 시작 전 / 그룹 간 대기 / 전원 완료 상태에서는 수동 진행 불가 (시작 시간 엄수)
    const flow = await getFlowAnnouncement(eventId);
    if (flow) {
      if (flow.event === 'system:all_complete') throw new Error('모든 그룹 좌석 지정이 완료되었습니다.');
      throw new Error(flow.payload.nextStartTime
        ? `아직 그룹 시작 시간이 아닙니다. (그룹 ${flow.payload.nextSession} 시작: ${flow.payload.nextStartTime})`
        : `그룹 ${flow.payload.nextSession}의 시작 시간이 지정되지 않았습니다. 먼저 그룹 시작 시간을 설정해주세요.`);
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
            where: { id: targetSeat.id, status: 'EMPTY' },
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
        // 빈 좌석이 없어 배정 불가: 만료 처리하되 is_final도 true로 하여
        // 전체 완료 판단(is_final: false 카운트)에서 미완료로 남지 않게 한다.
        updatedParticipant = await prisma.participant.update({
          where: { id: currentParticipant.id },
          data: { turn_status: 'EXPIRED', is_final: true }
        });
      }

      io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: stripSessionToken(updatedParticipant) });
      const userSocketId = activeSockets.get(currentParticipant.id);
      if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: updatedParticipant });
    }

    const gap = await checkSessionGap(eventId);
    if (gap) {
      io.to(`event:${eventId}`).emit('system:session_change', gap);
      io.to(`admin:event:${eventId}`).emit('system:session_change', gap);
      return;
    }

    // 조건부 턴 증가: 읽어둔 current_turn_order가 그대로일 때만 다음으로 넘긴다.
    // (만에 하나 잠금 밖에서 상태가 바뀌었다면 중복 증가를 막는 안전장치)
    const nextTurnOrder = systemState.current_turn_order + 1;
    const advanced = await prisma.systemState.updateMany({
      where: { event_id: eventId, current_turn_order: systemState.current_turn_order },
      data: { current_turn_order: nextTurnOrder, current_turn_start_time: new Date() }
    });
    if (advanced.count > 0) {
      const updatedState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
      if (updatedState) await notifyTurnAdvance(eventId, updatedState);
    }
    } finally {
      autoAssignInProgress.delete(eventId);
    }
  }

  // 관리자가 "건너뛰기"를 누르면, 현재 참가자에게 좌석을 배정하지 않고
  // turn_status를 EXPIRED로만 표시한 뒤 다음 턴으로 넘긴다. (불참/오류 대응)
  async function skipCurrentTurn(eventId: string) {
    if (autoAssignInProgress.has(eventId)) {
      throw new Error('이미 자동배정이 진행 중입니다. 잠시 후 다시 시도해주세요.');
    }
    autoAssignInProgress.add(eventId);
    try {
      const systemState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
      if (!systemState) throw new Error('시스템 상태를 찾을 수 없습니다.');

      // 그룹 시작 전 / 그룹 간 대기 / 전원 완료 상태에서는 진행 불가
      const flow = await getFlowAnnouncement(eventId);
      if (flow) {
        if (flow.event === 'system:all_complete') throw new Error('모든 그룹 좌석 지정이 완료되었습니다.');
        throw new Error(`아직 그룹 시작 시간이 아닙니다. (그룹 ${flow.payload.nextSession} 시작: ${flow.payload.nextStartTime})`);
      }

      const currentParticipant = await prisma.participant.findFirst({
        where: { event_id: eventId, turn_order: systemState.current_turn_order }
      });

      // 아직 좌석을 선택하지 않은 참가자만 만료 처리 (이미 완료된 경우는 건드리지 않음)
      // is_final도 true로 하여 전체 완료 판단에서 미완료로 남지 않게 한다.
      if (currentParticipant && !currentParticipant.is_final) {
        const updatedParticipant = await prisma.participant.update({
          where: { id: currentParticipant.id },
          data: { turn_status: 'EXPIRED', is_final: true }
        });
        io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: stripSessionToken(updatedParticipant) });
        const userSocketId = activeSockets.get(currentParticipant.id);
        if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: updatedParticipant });
      }

      const gap = await checkSessionGap(eventId);
      if (gap) {
        io.to(`event:${eventId}`).emit('system:session_change', gap);
        io.to(`admin:event:${eventId}`).emit('system:session_change', gap);
        return;
      }

      // 조건부 턴 증가 (중복 증가 방지)
      const nextTurnOrder = systemState.current_turn_order + 1;
      const advanced = await prisma.systemState.updateMany({
        where: { event_id: eventId, current_turn_order: systemState.current_turn_order },
        data: { current_turn_order: nextTurnOrder, current_turn_start_time: new Date() }
      });
      if (advanced.count > 0) {
        const updatedState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
        if (updatedState) await notifyTurnAdvance(eventId, updatedState);
      }
    } finally {
      autoAssignInProgress.delete(eventId);
    }
  }

  async function runAutoAssignIfExpired(eventId: string) {
    // 스케줄러 평가의 중복 실행만 방지 (이 단계에서는 seat:select를 막지 않는다).
    // 실제 배정을 시작할 때만 autoAssignInProgress 잠금을 잡는다.
    if (autoEvalInProgress.has(eventId)) return;
    autoEvalInProgress.add(eventId);
    let holdingAssignLock = false;
    try {
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
      return;
    }
    flowAnnounced.delete(eventId);

    // 그룹 시작 시각 기준으로 타이머 재정렬(rebase):
    // current_turn_start_time이 현재 그룹의 시작 시각(오늘 HH:MM)보다 이전이면
    // (업로드 시각, 이전 그룹 종료 시각 등) 아직 이 그룹의 3분 카운트다운이 시작되지 않은 것이므로
    // 지금(new Date())으로 재설정한다. 이렇게 하면 참가자가 미리 입장해도 좌석 선택 시간이
    // 줄어들지 않고, 그룹 시작 순간부터 정확히 3분이 시작된다. (in-memory 상태에 의존하지 않아
    // 서버 재시작이나 그룹 간 대기에도 안전)
    const curP = await prisma.participant.findFirst({
      where: { event_id: eventId, turn_order: systemState.current_turn_order }
    });
    if (curP && !curP.is_final) {
      const curSess = await prisma.sessionColor.findFirst({
        where: { event_id: eventId, session_id: curP.session_id }
      });
      const startMoment = sessionStartMomentToday(curSess?.start_time);
      if (startMoment && new Date(systemState.current_turn_start_time).getTime() < startMoment.getTime()) {
        const updated = await prisma.systemState.update({
          where: { event_id: eventId },
          data: { current_turn_start_time: new Date() }
        });
        emitTurn(eventId, updated);
        return;
      }
    }

    // 현재 순번이 이미 완료됐거나(그룹 마지막 참가자 자동배정 후 그룹 간 대기 등) 없는
    // 참가자면, 3분(TURN_DURATION_MS)을 기다리지 않고 즉시 다음 순번으로 넘어간다.
    // (이 처리가 없으면 그룹 시작 후에도 이전 그룹 마지막 참가자에 순번이 머물러
    //  "현재 순서 000님"으로 넘어가지 못하고 3분간 멈춰 보인다)
    if (!curP || curP.is_final) {
      if (autoAssignInProgress.has(eventId)) return;
      autoAssignInProgress.add(eventId);
      holdingAssignLock = true;

      // 잠금을 잡는 사이 상태가 바뀌었을 수 있으므로 최신 상태를 다시 확인한다.
      const latest = await prisma.participant.findFirst({
        where: { event_id: eventId, turn_order: systemState.current_turn_order }
      });
      if (latest && !latest.is_final) return; // 그 사이 미완료 참가자로 바뀜 → 이번 틱은 넘김

      const maxTurnResult = await prisma.participant.aggregate({
        where: { event_id: eventId }, _max: { turn_order: true }
      });
      const maxTurn = maxTurnResult._max.turn_order || 0;
      const nextTurnOrder = systemState.current_turn_order + 1;
      if (nextTurnOrder > maxTurn) return; // 더 진행할 순번 없음 (전원 완료는 위 flow에서 처리)

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
      await notifyTurnAdvance(eventId, updated);
      return;
    }

    const now = Date.now();
    const turnStart = new Date(systemState.current_turn_start_time).getTime();
    // 제한시간(정확히 3분) 이전이면 아무것도 안 함 (여기까지는 잠금 없이 평가만)
    // (여기 도달 시 curP는 미완료 참가자이므로, 완료된 참가자의 3분 제한은 위에서 이미 처리됨)
    if (now - turnStart < TURN_DURATION_MS) return;

    // 여기부터 실제로 상태를 변경한다 → 이제 seat:select/수동 경로와 직렬화하기 위해
    // autoAssignInProgress 잠금을 잡는다. 수동 배정이 진행 중이면 다음 틱에 재시도.
    if (autoAssignInProgress.has(eventId)) return;
    autoAssignInProgress.add(eventId);
    holdingAssignLock = true;

    // 잠금을 잡는 사이에 참가자가 직접 좌석을 선택했을 수 있으므로 최신 상태로 다시 읽는다.
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
      await notifyTurnAdvance(eventId, updated);
      return;
    }

    // ── 자동배정 시퀀스 시작 (총 1.5초) ──
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
        // 빈 좌석이 없으면 만료 처리만 (is_final도 true로 하여 미완료로 남지 않게 함)
        const expiredParticipant = await prisma.participant.update({
          where: { id: currentParticipant.id },
          data: { turn_status: 'EXPIRED', is_final: true }
        });
        // 관리자 화면과 해당 참가자 화면에 만료 상태를 반영한다.
        io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: stripSessionToken(expiredParticipant) });
        const userSocketId = activeSockets.get(currentParticipant.id);
        if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: expiredParticipant });
      } else {
        const targetSeat = sortedSeats[0];
        try {
          // where에 status: 'EMPTY'를 함께 걸어, 이 좌석이 그 사이 다른 경로로
          // 이미 바뀌었다면(정상적으로는 잠금 때문에 발생하지 않지만, 방어적으로) 조용히 덮어쓰지 않고
          // 업데이트 자체가 실패하도록 한다.
          const result = await prisma.$transaction(async (tx) => {
            const updatedSeat = await tx.seat.update({
              where: { id: targetSeat.id, status: 'EMPTY' },
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
          io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: stripSessionToken(result.updatedParticipant) });
          const userSocketId = activeSockets.get(currentParticipant.id);
          if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: result.updatedParticipant });
          console.log(`[AutoAssign] ${currentParticipant.name} → ${targetSeat.row}행 ${targetSeat.col}열 완료`);
        } catch (assignErr) {
          // 좌석 배정이 충돌로 실패한 경우 참가자를 좌석 없이 방치하지 않고 만료 처리한다.
          // (is_final도 true로 하여 전체 완료 판단에서 미완료로 남지 않게 함)
          console.error(`[AutoAssign] 좌석 배정 충돌 - ${currentParticipant.name} 만료 처리:`, assignErr);
          const expiredParticipant = await prisma.participant.update({
            where: { id: currentParticipant.id },
            data: { turn_status: 'EXPIRED', is_final: true }
          });
          io.to(`admin:event:${eventId}`).emit('participant:update_admin', { participant: stripSessionToken(expiredParticipant) });
          const userSocketId = activeSockets.get(currentParticipant.id);
          if (userSocketId) io.to(userSocketId).emit('participant:update', { participant: expiredParticipant });
        }
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
          await notifyTurnAdvance(eventId, updatedState);
        }
      } else {
        // 마지막 참가자까지 완료 → 전원 완료 여부를 다시 확인해 정확한 상태를 알린다.
        // (그냥 system:turn만 다시 보내면 방금 자동배정된 마지막 참가자가 여전히
        // "현재 순서"인 것처럼 잘못 표시된다.)
        const finalState = await prisma.systemState.findUnique({ where: { event_id: eventId } });
        if (finalState) await notifyTurnAdvance(eventId, finalState);
      }
    } catch (err) {
      console.error('[AutoAssign] 오류:', err);
    }
    } catch (err) {
      console.error('[AutoAssign] 평가 단계 오류:', err);
    } finally {
      if (holdingAssignLock) autoAssignInProgress.delete(eventId);
      autoEvalInProgress.delete(eventId);
    }
  }

  setInterval(async () => {
    try {
      const activeEvents = await prisma.event.findMany({ where: { is_active: true } });
      // 각 이벤트를 비동기로 실행 (재진입 가드가 중복을 막아줌)
      for (const event of activeEvents) {
        runAutoAssignIfExpired(event.id).catch(err => console.error('[AutoAssign] 처리 실패:', err));
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
