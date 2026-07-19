// 그룹 시작/종료 시간 문자열 처리 유틸.
// 저장 형식은 두 가지를 모두 허용한다 (Asia/Seoul 기준):
//  - "HH:MM"              : 기존 형식. "오늘"의 해당 시각으로 해석
//  - "YYYY-MM-DDTHH:MM"   : datetime-local 입력값. 날짜까지 지정된 시각
// 서버(server.ts)에도 동일한 해석 규칙의 헬퍼가 있다 — 규칙을 바꾸면 양쪽을 함께 수정할 것.

export interface SessionTimeParts {
  y?: number;
  mo?: number;
  d?: number;
  hh: number;
  mm: number;
}

export function parseSessionTime(value: string | null | undefined): SessionTimeParts | null {
  if (!value) return null;
  let m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), hh: Number(m[4]), mm: Number(m[5]) };
  m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return { hh: Number(m[1]), mm: Number(m[2]) };
  return null;
}

// 화면 표시용: 날짜가 있으면 "7/20 14:00", 없으면 "14:00"
export function formatSessionTime(value: string | null | undefined): string | null {
  const t = parseSessionTime(value);
  if (!t) return null;
  const hhmm = `${String(t.hh).padStart(2, '0')}:${String(t.mm).padStart(2, '0')}`;
  return t.y ? `${t.mo}/${t.d} ${hhmm}` : hhmm;
}

// 시작 시각의 epoch ms. "HH:MM"이면 기준 시각(nowMs, 서버 보정 시각)의 서울 날짜 기준 "오늘".
// 서울은 UTC+9 고정(DST 없음)이라 Date.UTC(…, hh-9, …)로 변환한다.
export function sessionStartEpochMs(value: string | null | undefined, nowMs: number): number | null {
  const t = parseSessionTime(value);
  if (!t) return null;
  if (t.y) return Date.UTC(t.y, t.mo! - 1, t.d!, t.hh - 9, t.mm, 0, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(nowMs));
  const y = Number(parts.find(p => p.type === 'year')?.value);
  const mo = Number(parts.find(p => p.type === 'month')?.value);
  const d = Number(parts.find(p => p.type === 'day')?.value);
  if (!y || !mo || !d) return null;
  return Date.UTC(y, mo - 1, d, t.hh - 9, t.mm, 0, 0);
}
