import React, { useState, useRef } from 'react';
import { TransformWrapper, TransformComponent, ReactZoomPanPinchRef } from 'react-zoom-pan-pinch';
import { cn } from '../lib/utils';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

// 행 번호를 알파벳으로 변환 (1 -> A, 2 -> B, ...)
function rowToLetter(row: number): string {
  return String.fromCharCode(64 + row);
}

// 좌석 표시용 문자열: 격자 CSV 방식이면 좌석 번호(seat_label), 아니면 "A열 3번"
function seatLabelText(seat: any): string {
  if (!seat) return '';
  if (seat.seat_label) return `${seat.seat_label}번`;
  return `${rowToLetter(seat.row)}열 ${seat.col}번`;
}

// 좌석 타일 안에 짧게 표시할 문자열
function seatShortLabel(seat: any): string {
  if (seat?.seat_label) return String(seat.seat_label);
  return `${rowToLetter(seat.row)}-${seat.col}`;
}

// 모바일 툴팁 컴포넌트
function SeatTooltip({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center pb-16 px-4"
      onClick={onClose}
    >
      <div
        className="text-white px-6 py-3 rounded-2xl shadow-2xl text-base font-bold"
        style={{ background: 'var(--c-ink)' }}
        onClick={e => e.stopPropagation()}
      >
        {text}
      </div>
    </div>
  );
}

export default function SeatMap({ forceAdmin = false }: { forceAdmin?: boolean }) {
  const { seats, participants, user, isAdmin: storeIsAdmin, isFrozen, sessionColors, layout, timerPaused, currentTurnOrder, lastAssignedSeatId } = useStore();
  const isAdmin = forceAdmin || storeIsAdmin;
  const socket = useSocket();

  const [selectedSeatInfo, setSelectedSeatInfo] = useState<{ seatId: string; participant: any; isPrivate?: boolean; isManual?: boolean } | null>(null);
  // 모바일 툴팁 (예약된 좌석 터치 시)
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  // 좌석 선택 확인 팝업
  const [confirmSeat, setConfirmSeat] = useState<{ seatId: string; label: string } | null>(null);
  // 수동 배정 이름 입력값
  const [manualName, setManualName] = useState('');
  // 좌석표 이동/확대 초기화용 (자유 이동(limitToBounds=false)이라 화면 밖으로
  // 밀어버릴 수 있으므로, 원위치 복귀 버튼에서 사용)
  const transformRef = useRef<ReactZoomPanPinchRef>(null);

  const maxRow = seats.length > 0 ? Math.max(...seats.map(s => s.row)) : 0;
  const maxCol = seats.length > 0 ? Math.max(...seats.map(s => s.col)) : 0;
  const aisleAfterRows: number[] = layout?.aisle_after_rows ?? [];
  const aisleAfterCols: number[] = layout?.aisle_after_cols ?? [];

  const grid: any[][] = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(null));
  seats.forEach(seat => {
    if (seat.row <= maxRow && seat.col <= maxCol) grid[seat.row][seat.col] = seat;
  });

  const getSeatColor = (seat: any) => {
    if (seat.status === 'EMPTY') return '#FFFFFF';
    if (seat.status === 'LOCKED') return '#E5E7EB';
    if (seat.status === 'PRIVATE') return '#BFBFBF';
    if (seat.status === 'MANUAL') return '#14B8A6';
    const colorObj = sessionColors.find((sc: any) => sc.session_id === seat.session_id);
    return colorObj ? colorObj.color : '#1D4EAD';
  };

  const handleSeatClick = (seat: any) => {
    if (!socket) return;
    // 자동배정 진행 중에는 참가자 좌석 선택 불가
    if (!isAdmin && timerPaused) return;

    if (isAdmin) {
      // 관리자: 예약 좌석 클릭 → 팝업, 빈 좌석 클릭 → 확인 후 강제배정 패널
      if ((seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') && seat.assigned_to) {
        const participant = participants.find((p: any) => p.id === seat.assigned_to);
        if (participant) setSelectedSeatInfo({ seatId: seat.id, participant });
      } else if (seat.status === 'EMPTY') {
        setManualName('');
        setSelectedSeatInfo({ seatId: seat.id, participant: null });
      } else if (seat.status === 'MANUAL') {
        setManualName(seat.manual_label || '');
        setSelectedSeatInfo({ seatId: seat.id, participant: null, isManual: true });
      } else if (seat.status === 'PRIVATE') {
        setSelectedSeatInfo({ seatId: seat.id, participant: null, isPrivate: true });
      }
    } else if (user) {
      if (user.turn_status === 'COMPLETED' || user.is_final) {
        // 내 자리 터치 → 좌석 정보 툴팁 표시
        if (seat.assigned_to === user.id) {
          setTooltipText(`내 자리: ${seatLabelText(seat)}`);
        }
        return;
      }
      if (seat.status !== 'EMPTY') {
        // 다른 사람 자리 터치 → 좌석 정보 툴팁
        const assignedParticipant = participants.find((p: any) => p.id === seat.assigned_to);
        const seatName = seat.status === 'MANUAL' ? seat.manual_label : assignedParticipant?.name;
        if (seatName) {
          setTooltipText(`${seatLabelText(seat)} — ${seatName}`);
        } else {
          setTooltipText(seatLabelText(seat));
        }
        return;
      }
      // 빈 자리 → 확인 팝업
      setConfirmSeat({ seatId: seat.id, label: seatLabelText(seat) });
    }
  };

  const handleConfirmSelect = () => {
    if (!socket || !confirmSeat) return;
    socket.emit('seat:select', { seatId: confirmSeat.seatId });
    setConfirmSeat(null);
  };

  const handleForceCancel = () => {
    if (!socket || !selectedSeatInfo) return;
    if (confirm(`정말로 ${selectedSeatInfo.participant.name}님의 좌석을 강제 취소하시겠습니까?`)) {
      socket.emit('admin:cancel_seat', {
        eventId: selectedSeatInfo.participant.event_id,
        seatId: selectedSeatInfo.seatId,
        participantId: selectedSeatInfo.participant.id,
      });
      setSelectedSeatInfo(null);
    }
  };

  const handleSetSeatPrivate = (isPrivate: boolean) => {
    if (!socket || !selectedSeatInfo) return;
    const eventId = user?.event_id || (participants.length > 0 ? participants[0].event_id : null);
    if (!eventId) { alert('이벤트 ID를 찾을 수 없습니다.'); return; }
    socket.emit('admin:set_seat_private', { eventId, seatId: selectedSeatInfo.seatId, isPrivate });
    setSelectedSeatInfo(null);
  };

  const handleSetManual = (label: string | null) => {
    if (!socket || !selectedSeatInfo) return;
    const eventId = user?.event_id || (participants.length > 0 ? participants[0].event_id : null);
    if (!eventId) { alert('이벤트 ID를 찾을 수 없습니다.'); return; }
    socket.emit('admin:set_manual_seat', { eventId, seatId: selectedSeatInfo.seatId, label });
    setSelectedSeatInfo(null);
  };

  const handleForceAssign = (participantId: string) => {
    if (!socket || !selectedSeatInfo) return;
    const targetSeat = seats.find(s => s.id === selectedSeatInfo.seatId);
    const label = targetSeat ? seatLabelText(targetSeat) : '해당 좌석';
    if (!window.confirm(`이 참가자를 ${label}에 강제 배정하시겠습니까?`)) return;
    const eventId =
      selectedSeatInfo.participant?.event_id ||
      user?.event_id ||
      (participants.length > 0 ? participants[0].event_id : null);
    if (!eventId) { alert('이벤트 ID를 찾을 수 없습니다.'); return; }
    socket.emit('admin:force_assign', { eventId, seatId: selectedSeatInfo.seatId, participantId });
    setSelectedSeatInfo(null);
  };

  return (
    <div
      className="w-full h-[50vh] lg:h-[70vh] rounded-[20px] relative flex flex-col overflow-hidden"
      style={{ background: 'var(--c-surface)', boxShadow: 'var(--sh-card)' }}
    >
      {seats.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-white/60">
          <p className="font-bold animate-pulse" style={{ color: 'var(--c-muted)' }}>좌석 데이터를 불러오는 중입니다...</p>
        </div>
      )}

      {/* 좌석 선택 확인 팝업 */}
      {confirmSeat && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="rounded-3xl shadow-2xl p-6 mx-4 w-full max-w-sm" style={{ background: 'var(--c-surface)' }}>
            <p className="text-base font-extrabold mb-1 text-center">좌석 선택</p>
            <p className="text-sm font-medium text-center mb-6" style={{ color: 'var(--c-muted)' }}>
              <span className="font-extrabold" style={{ color: 'var(--c-primary)' }}>{confirmSeat.label}</span>을 선택하시겠습니까?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmSeat(null)}
                className="flex-1 py-3 rounded-2xl font-bold transition-colors"
                style={{ border: '1px solid var(--c-line)', color: 'var(--c-muted)' }}
              >
                취소
              </button>
              <button
                onClick={handleConfirmSelect}
                style={{ background: 'var(--c-primary)' }}
                className="flex-1 py-3 rounded-2xl text-white font-extrabold hover:opacity-90 active:opacity-80"
              >
                확인
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 모바일 좌석 정보 툴팁 */}
      {tooltipText && (
        <SeatTooltip text={tooltipText} onClose={() => setTooltipText(null)} />
      )}

      {/* pinch-to-zoom 지원 */}
      <TransformWrapper
        ref={transformRef}
        initialScale={1}
        minScale={0.2}
        maxScale={5}
        wheel={{ step: 0.08 }}
        doubleClick={{ step: 0.7 }}
        panning={{ velocityDisabled: true }}
        limitToBounds={false}
        centerZoomedOut={false}
      >
        <TransformComponent
          wrapperStyle={{ width: '100%', flex: 1, overflow: 'hidden' }}
          contentStyle={{ padding: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}
        >
        <div className="flex flex-col items-center">
          {/* STAGE */}
          <div
            className="w-full h-[52px] mb-4 rounded-[14px] flex items-center justify-center font-extrabold text-[13px] tracking-[.28em] select-none"
            style={{ background: 'linear-gradient(180deg, #F3F6FD 0%, #E8EDF9 100%)', color: 'var(--c-muted-2)' }}
          >
            STAGE
          </div>

          {/* 좌석 그리드 */}
          <div className="w-fit">
            {grid.slice(1).map((row, rIdx) => {
              const rowNum = rIdx + 1;
              const hasRowAisle = aisleAfterRows.includes(rowNum);
              return (
                <React.Fragment key={`row-${rowNum}`}>
                  <div className="flex gap-[7px]">
                    {row.slice(1).map((seat: any, cIdx: number) => {
                      const colNum = cIdx + 1;
                      const hasColAisle = aisleAfterCols.includes(colNum);

                      if (!seat) return (
                        <React.Fragment key={`empty-${rowNum}-${colNum}`}>
                          <div className="w-[38px] h-[38px] shrink-0" />
                          {hasColAisle && <div className="w-[18px] shrink-0" />}
                        </React.Fragment>
                      );

                      // 관리자 화면에서는 "내 자리"(초록색) 개념을 적용하지 않는다
                      const isMySeat = !isAdmin && seat.assigned_to === user?.id;
                      const assignedParticipant = seat.assigned_to
                        ? participants.find((p: any) => p.id === seat.assigned_to)
                        : null;
                      const displayName = seat.status === 'MANUAL'
                        ? (seat.manual_label ?? '')
                        : (assignedParticipant?.name ?? '');

                      let seatClass = 'cursor-pointer hover:opacity-80 active:opacity-70';
                      let customStyle: React.CSSProperties = {
                        backgroundColor: 'var(--c-seat-empty)',
                        color: 'var(--c-seat-empty-ink)',
                      };

                      if (seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') {
                        customStyle = { backgroundColor: getSeatColor(seat), color: '#fff' };
                        if (isMySeat) {
                          // 내 자리 강조 색상
                          customStyle = { backgroundColor: 'var(--c-mine)', color: '#fff' };
                          seatClass = 'shadow-lg ring-2 ring-cyan-200 scale-110 z-10 cursor-default';
                        } else if (isAdmin) {
                          if (seat.id === lastAssignedSeatId) {
                            // 관제용: 가장 최근에 배정된 좌석을 참가자 '내 자리'와 같은 색으로 강조해
                            // 방금 누가 어디를 선택했는지 즉시 확인할 수 있게 한다
                            customStyle = { backgroundColor: 'var(--c-mine)', color: '#fff' };
                            seatClass = 'shadow-lg ring-2 ring-cyan-200 cursor-pointer hover:opacity-80 active:opacity-70';
                          } else {
                            seatClass = 'cursor-pointer hover:opacity-75 active:opacity-60';
                          }
                        } else {
                          seatClass = 'cursor-pointer';
                        }
                      } else if (seat.status === 'MANUAL') {
                        customStyle = { backgroundColor: '#14B8A6', color: '#fff' };
                        seatClass = isAdmin
                          ? 'cursor-pointer hover:opacity-80 active:opacity-70'
                          : 'cursor-default';
                      } else if (seat.status === 'FROZEN') {
                        customStyle = { backgroundColor: '#FDEDEC', color: '#B03B36' };
                        seatClass = 'cursor-not-allowed';
                      } else if (seat.status === 'PRIVATE') {
                        // 사선 패턴(.seat-private)으로 "고를 수 없는 자리"임을 색만이 아니라 무늬로도 알린다
                        customStyle = {};
                        seatClass = isAdmin
                          ? 'seat-private cursor-pointer hover:opacity-80 active:opacity-70'
                          : 'seat-private cursor-not-allowed';
                      }

                      const isDisabled =
                        (!isAdmin && isFrozen) ||
                        (!isAdmin && timerPaused) || // 자동배정 진행 중 좌석 잠금
                        (!isAdmin && seat.status === 'PRIVATE') ||
                        (!isAdmin && (user?.turn_status === 'COMPLETED' || user?.is_final) && !isMySeat) ||
                        // 현재 순서가 아닌 참가자는 좌석 클릭 불가 (내 자리 툴팁은 예외)
                        (!isAdmin && user?.turn_order !== currentTurnOrder && !isMySeat);

                      return (
                        <React.Fragment key={seat.id}>
                          <div
                            role="button"
                            tabIndex={isDisabled ? -1 : 0}
                            aria-disabled={isDisabled}
                            onClick={() => { if (!isDisabled) handleSeatClick(seat); }}
                            onKeyDown={(e) => {
                              if (!isDisabled && (e.key === 'Enter' || e.key === ' ')) {
                                e.preventDefault();
                                handleSeatClick(seat);
                              }
                            }}
                            className={cn(
                              'w-[38px] h-[38px] rounded-[11px] flex flex-col items-center justify-center',
                              'transition-all duration-150 overflow-hidden select-none shrink-0',
                              seatClass,
                              !isAdmin && isFrozen && 'opacity-50 cursor-not-allowed',
                              isDisabled && 'pointer-events-none',
                            )}
                            style={customStyle}
                            title={displayName
                              ? `${displayName} (${seatLabelText(seat)})`
                              : seatLabelText(seat)}
                          >
                            {/* 글자는 칸 전체 폭을 차지한 채 text-align 으로 가운데 맞춘다.
                                (글자 상자를 flex 로 가운데 두면 글자 폭이 홀수일 때 0.5px 어긋나 한쪽으로 쏠려 보인다)
                                줄높이도 8px·10px 정수로 고정해 위아래 여백이 딱 떨어지게 한다. */}
                            {seat.status === 'PRIVATE' ? null : displayName ? (
                              <>
                                <span className="w-full text-center text-[7px] font-medium leading-[8px] opacity-75">
                                  {seatShortLabel(seat)}
                                </span>
                                <span className={cn(
                                  'w-full text-center px-0.5 box-border font-bold leading-[10px] mt-0.5',
                                  displayName.length <= 4 ? 'text-[9px]' : 'text-[7px]',
                                )}>
                                  {displayName}
                                </span>
                              </>
                            ) : (
                              <span className="w-full text-center text-[10px] font-bold leading-[10px]">{seatShortLabel(seat)}</span>
                            )}
                          </div>
                          {hasColAisle && <div className="w-[18px] shrink-0" />}
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {hasRowAisle && <div className="h-[18px]" />}
                  <div className="h-[7px]" />
                </React.Fragment>
              );
            })}
          </div>
        </div>
        </TransformComponent>
      </TransformWrapper>

      {/* 좌석표를 화면 밖으로 밀어버렸을 때 원위치/원래 배율로 복귀하는 버튼.
          (경계 제한(limitToBounds)은 모바일에서 구석 좌석 도달 불가/스냅백 버그를
          일으켜 쓰지 않고, 자유 이동 + 초기화 버튼 방식을 사용) */}
      <button
        type="button"
        onClick={() => transformRef.current?.resetTransform()}
        className="absolute right-3 bottom-12 z-10 flex items-center gap-1.5 rounded-full px-3 py-[7px] text-xs font-bold select-none hover:opacity-80 active:opacity-70"
        style={{
          background: 'var(--c-surface)',
          border: '1px solid var(--c-line)',
          color: 'var(--c-primary)',
          boxShadow: '0 3px 8px rgba(23,35,66,.10)',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 12a9 9 0 1 0 3-6.7" />
          <path d="M3 4v5h5" />
        </svg>
        위치 초기화
      </button>

      {/* 범례 — 한 줄에 모두 표시 (좁은 화면에선 폰트/간격 축소) */}
      {/* 항목이 줄어 한 줄 여유가 생겨 모바일 폰트를 10px → 12px로 키움 */}
      <div
        className="shrink-0 flex flex-nowrap justify-center items-center gap-x-3.5 sm:gap-x-4 py-2.5 px-2 text-xs font-bold"
        style={{ background: 'var(--c-tint-2)', borderTop: '1px solid var(--c-line-soft)', color: 'var(--c-muted)' }}
      >
        <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0"><div className="seat-private w-3.5 h-3.5 rounded-[5px] shrink-0" />선택 불가</div>
        <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 rounded-[5px] shrink-0" style={{ background: 'var(--c-seat-empty)' }} />선택 가능</div>
        {/* '내 자리'는 일반 참가자에게만 표시 — 관전 계정(turn_order 0, 추가신청자)은
            좌석이 계정과 연결되지 않으므로(수동 배정) 해당 없음 */}
        {!isAdmin && user?.turn_order !== 0 && <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 rounded-[5px] shrink-0" style={{ background: 'var(--c-mine)' }} />내 자리</div>}
        {/* 관리자에게는 같은 색을 '직전 선택' 의미로 표시 */}
        {isAdmin && <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 rounded-[5px] shrink-0" style={{ background: 'var(--c-mine)' }} />직전 선택</div>}
      </div>

      {/* 관리자용 좌석 팝업 */}
      {selectedSeatInfo && (
        <div
          className="absolute top-4 right-4 p-4 rounded-[20px] z-20 w-64 max-h-[80vh] overflow-y-auto"
          style={{ background: 'var(--c-surface)', boxShadow: '0 10px 24px rgba(23,35,66,.14)', border: '1px solid var(--c-line)' }}
        >
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-extrabold">좌석 정보</h3>
            <button onClick={() => setSelectedSeatInfo(null)} className="text-lg leading-none hover:opacity-70" style={{ color: 'var(--c-muted-2)' }}>✕</button>
          </div>
          {selectedSeatInfo.participant ? (
            <>
              <div className="space-y-2 text-sm mb-4" style={{ color: 'var(--c-ink-2)' }}>
                <p><span className="font-medium" style={{ color: 'var(--c-muted)' }}>그룹:</span> {selectedSeatInfo.participant.session_id}</p>
                <p><span className="font-medium" style={{ color: 'var(--c-muted)' }}>이름:</span> {selectedSeatInfo.participant.name}</p>
                <p><span className="font-medium" style={{ color: 'var(--c-muted)' }}>순번:</span> {selectedSeatInfo.participant.turn_order}</p>
              </div>
              <button onClick={handleForceCancel} className="w-full py-2.5 rounded-xl text-white font-extrabold hover:opacity-90 active:opacity-80" style={{ background: 'var(--c-red)' }}>
                강제 취소
              </button>
            </>
          ) : selectedSeatInfo.isPrivate ? (
            <div className="space-y-3 text-sm" style={{ color: 'var(--c-ink-2)' }}>
              <p className="font-medium" style={{ color: 'var(--c-muted)' }}>
                사석 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <button onClick={() => handleSetSeatPrivate(false)} className="w-full py-2.5 rounded-xl text-white font-extrabold hover:opacity-90 active:opacity-80" style={{ background: 'var(--c-muted)' }}>
                선택 가능으로 되돌리기
              </button>
            </div>
          ) : selectedSeatInfo.isManual ? (
            <div className="space-y-2 text-sm" style={{ color: 'var(--c-ink-2)' }}>
              <p className="font-medium" style={{ color: 'var(--c-muted)' }}>
                수동 배정 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="이름 입력"
                className="w-full px-3 py-2 text-sm rounded-xl outline-none focus:border-[color:var(--c-primary)]" style={{ background: 'var(--c-tint-2)', border: '1px solid var(--c-line)' }}
              />
              <button
                onClick={() => handleSetManual(manualName.trim() || null)}
                disabled={!manualName.trim()}
                style={{ backgroundColor: '#14B8A6' }}
                className="w-full py-2.5 text-white rounded-xl font-extrabold transition-opacity text-sm hover:opacity-90 disabled:opacity-40"
              >
                이름 수정
              </button>
              <button onClick={() => handleSetManual(null)} className="w-full py-2.5 rounded-xl text-white font-extrabold text-sm hover:opacity-90 active:opacity-80" style={{ background: 'var(--c-muted)' }}>
                배정 삭제 (빈 좌석으로)
              </button>
            </div>
          ) : (
            <div className="space-y-2 text-sm" style={{ color: 'var(--c-ink-2)' }}>
              <p className="font-medium" style={{ color: 'var(--c-muted)' }}>
                빈 좌석 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="이름 입력 (수동 배정)"
                className="w-full px-3 py-2 text-sm rounded-xl outline-none focus:border-[color:var(--c-primary)]" style={{ background: 'var(--c-tint-2)', border: '1px solid var(--c-line)' }}
              />
              <button
                onClick={() => handleSetManual(manualName.trim() || null)}
                disabled={!manualName.trim()}
                style={{ backgroundColor: '#14B8A6' }}
                className="w-full py-2.5 text-white rounded-xl font-extrabold transition-opacity text-sm hover:opacity-90 disabled:opacity-40"
              >
                수동 배정
              </button>
              <button onClick={() => handleSetSeatPrivate(true)} className="w-full py-2.5 rounded-xl text-white font-extrabold text-sm hover:opacity-90 active:opacity-80" style={{ background: 'var(--c-muted)' }}>
                사석으로 지정
              </button>
              {/* 강제 배정 대상 목록: 관전 계정(turn_order 0, 추가신청자)은 제외한다.
                  추가신청자는 항상 수동 배정(실명 입력)으로 처리하므로 이 목록에 필요 없음 */}
              <div className="mt-2 space-y-1 max-h-48 overflow-y-auto rounded-xl p-1" style={{ border: '1px solid var(--c-line)' }}>
                {participants.filter((p: any) => !p.seat_id && p.turn_order > 0).length === 0 ? (
                  <p className="text-xs text-center py-2" style={{ color: 'var(--c-placeholder)' }}>미배정 참가자가 없습니다.</p>
                ) : (
                  participants.filter((p: any) => !p.seat_id && p.turn_order > 0).sort((a: any, b: any) => a.turn_order - b.turn_order).map((p: any) => (
                    <button key={p.id} onClick={() => handleForceAssign(p.id)}
                      className="w-full text-left px-2 py-1.5 text-xs rounded-lg flex justify-between items-center hover:bg-[color:var(--c-tint)]">
                      <span>{p.name} ({p.turn_order}번)</span>
                      <span className="font-extrabold px-2 py-0.5 rounded-md text-[10px]" style={{ color: 'var(--c-primary)', background: '#EAEFFE' }}>배정</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
