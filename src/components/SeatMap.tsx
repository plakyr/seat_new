import React, { useState } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
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
        className="bg-gray-900 text-white px-6 py-3 rounded-2xl shadow-2xl text-base font-bold"
        onClick={e => e.stopPropagation()}
      >
        {text}
      </div>
    </div>
  );
}

export default function SeatMap({ forceAdmin = false }: { forceAdmin?: boolean }) {
  const { seats, participants, user, isAdmin: storeIsAdmin, isFrozen, sessionColors, layout, timerPaused, currentTurnOrder } = useStore();
  const isAdmin = forceAdmin || storeIsAdmin;
  const socket = useSocket();

  const [selectedSeatInfo, setSelectedSeatInfo] = useState<{ seatId: string; participant: any; isPrivate?: boolean; isManual?: boolean } | null>(null);
  // 모바일 툴팁 (예약된 좌석 터치 시)
  const [tooltipText, setTooltipText] = useState<string | null>(null);
  // 좌석 선택 확인 팝업
  const [confirmSeat, setConfirmSeat] = useState<{ seatId: string; label: string } | null>(null);
  // 수동 배정 이름 입력값
  const [manualName, setManualName] = useState('');

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
    <div className="w-full h-[50vh] lg:h-[70vh] bg-gray-100 rounded-xl border border-gray-200 relative shadow-inner flex flex-col overflow-hidden">
      {seats.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-white/60">
          <p className="text-gray-500 font-bold animate-pulse">좌석 데이터를 불러오는 중입니다...</p>
        </div>
      )}

      {/* 좌석 선택 확인 팝업 */}
      {confirmSeat && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-2xl p-6 mx-4 w-full max-w-sm">
            <p className="text-base font-bold text-gray-900 mb-1 text-center">좌석 선택</p>
            <p className="text-gray-600 text-sm text-center mb-6">
              <span className="font-semibold text-blue-600">{confirmSeat.label}</span>을 선택하시겠습니까?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmSeat(null)}
                className="flex-1 py-3 rounded-xl border border-gray-300 text-gray-700 font-bold hover:bg-gray-50 active:bg-gray-100"
              >
                취소
              </button>
              <button
                onClick={handleConfirmSelect}
                style={{ backgroundColor: '#1C71E8' }}
                className="flex-1 py-3 rounded-xl text-white font-bold hover:opacity-90"
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
          <div className="w-full h-20 mb-5 rounded-t-lg rounded-b-sm bg-gray-50 border border-gray-200 shadow-sm flex items-center justify-center font-black text-lg tracking-widest text-gray-700 select-none">
            STAGE
          </div>

          {/* 좌석 그리드 */}
          <div className="bg-white rounded-xl shadow-md border border-gray-100 p-5 w-fit">
            {grid.slice(1).map((row, rIdx) => {
              const rowNum = rIdx + 1;
              const hasRowAisle = aisleAfterRows.includes(rowNum);
              return (
                <React.Fragment key={`row-${rowNum}`}>
                  <div className="flex gap-2">
                    {row.slice(1).map((seat: any, cIdx: number) => {
                      const colNum = cIdx + 1;
                      const hasColAisle = aisleAfterCols.includes(colNum);

                      if (!seat) return (
                        <React.Fragment key={`empty-${rowNum}-${colNum}`}>
                          <div className="w-9 h-9 bg-gray-50/50 rounded-sm shrink-0" />
                          {hasColAisle && <div className="w-5 shrink-0" />}
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

                      let seatClass = 'bg-gray-200 hover:bg-gray-300 active:bg-gray-400 cursor-pointer text-gray-700';
                      let customStyle: React.CSSProperties = {};

                      if (seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') {
                        customStyle = { backgroundColor: getSeatColor(seat) };
                        if (isMySeat) {
                          // 내 자리 강조 색상
                          customStyle = { backgroundColor: '#00C2D1' };
                          seatClass = 'text-white shadow-lg ring-2 ring-cyan-200 scale-110 z-10 cursor-default font-extrabold';
                        } else if (isAdmin) {
                          // 참가자 화면과 동일한 명도(opacity-80)로 표시해 양쪽 색을 일치시킨다
                          seatClass = 'text-white opacity-80 cursor-pointer hover:opacity-60 active:opacity-50';
                        } else {
                          seatClass = 'text-white opacity-80 cursor-pointer';
                        }
                      } else if (seat.status === 'MANUAL') {
                        customStyle = { backgroundColor: '#14B8A6' };
                        seatClass = isAdmin
                          ? 'text-white opacity-90 cursor-pointer hover:opacity-70 active:opacity-60'
                          : 'text-white opacity-90 cursor-default';
                      } else if (seat.status === 'FROZEN') {
                        seatClass = 'bg-red-100 border-2 border-red-300 cursor-not-allowed text-red-800';
                      } else if (seat.status === 'PRIVATE') {
                        customStyle = { backgroundColor: '#BFBFBF' };
                        seatClass = isAdmin ? 'cursor-pointer hover:opacity-80 active:opacity-60' : 'cursor-not-allowed';
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
                              'w-9 h-9 rounded-t-lg rounded-b-sm flex flex-col items-center justify-center',
                              'font-bold leading-tight transition-all duration-150',
                              'overflow-hidden shadow-sm select-none shrink-0',
                              seatClass,
                              !isAdmin && isFrozen && 'opacity-50 cursor-not-allowed',
                              isDisabled && 'pointer-events-none',
                            )}
                            style={customStyle}
                            title={displayName
                              ? `${displayName} (${seatLabelText(seat)})`
                              : seatLabelText(seat)}
                          >
                            {seat.status === 'PRIVATE' ? null : displayName ? (
                              <>
                                <span className="w-full text-center leading-none text-[6px] opacity-80">
                                  {seatShortLabel(seat)}
                                </span>
                                <span className={cn(
                                  'w-full text-center px-0.5 leading-none mt-0.5',
                                  displayName.length <= 4 ? 'text-[8px]' : 'text-[6px]',
                                )}>
                                  {displayName}
                                </span>
                              </>
                            ) : (
                              <span className="text-[8px] text-gray-500">{seatShortLabel(seat)}</span>
                            )}
                          </div>
                          {hasColAisle && <div className="w-5 shrink-0" />}
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {hasRowAisle && <div className="h-5" />}
                  <div className="h-2" />
                </React.Fragment>
              );
            })}
          </div>
        </div>
        </TransformComponent>
      </TransformWrapper>

      {/* 범례 — 한 줄에 모두 표시 (좁은 화면에선 폰트/간격 축소) */}
      {/* 항목이 줄어 한 줄 여유가 생겨 모바일 폰트를 10px → 12px로 키움 */}
      <div className="shrink-0 flex flex-nowrap justify-center items-center gap-x-3 sm:gap-x-4 bg-white/95 py-2 px-2 border-t border-gray-200 text-xs font-medium">
        <div className="flex items-center gap-1 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded shadow-sm shrink-0" style={{ backgroundColor: '#BFBFBF' }} />선택 불가</div>
        <div className="flex items-center gap-1 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded bg-gray-200 shadow-sm shrink-0" />선택 가능</div>
        {!isAdmin && <div className="flex items-center gap-1 whitespace-nowrap shrink-0"><div className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded shadow-sm shrink-0" style={{ backgroundColor: '#00C2D1' }} />내 자리</div>}
      </div>

      {/* 관리자용 좌석 팝업 */}
      {selectedSeatInfo && (
        <div className="absolute top-4 right-4 bg-white p-4 rounded-xl shadow-xl border border-gray-200 z-20 w-64 max-h-[80vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-gray-900">좌석 정보</h3>
            <button onClick={() => setSelectedSeatInfo(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
          {selectedSeatInfo.participant ? (
            <>
              <div className="space-y-2 text-sm text-gray-700 mb-4">
                <p><span className="font-medium text-gray-500">그룹:</span> {selectedSeatInfo.participant.session_id}</p>
                <p><span className="font-medium text-gray-500">이름:</span> {selectedSeatInfo.participant.name}</p>
                <p><span className="font-medium text-gray-500">순번:</span> {selectedSeatInfo.participant.turn_order}</p>
              </div>
              <button onClick={handleForceCancel} className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-colors">
                강제 취소
              </button>
            </>
          ) : selectedSeatInfo.isPrivate ? (
            <div className="space-y-3 text-sm text-gray-700">
              <p className="font-medium text-gray-500">
                사석 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <button onClick={() => handleSetSeatPrivate(false)} className="w-full py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg font-bold transition-colors">
                선택 가능으로 되돌리기
              </button>
            </div>
          ) : selectedSeatInfo.isManual ? (
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium text-gray-500">
                수동 배정 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="이름 입력"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md outline-none focus:ring-2 focus:ring-gray-900"
              />
              <button
                onClick={() => handleSetManual(manualName.trim() || null)}
                disabled={!manualName.trim()}
                style={{ backgroundColor: '#14B8A6' }}
                className="w-full py-2 text-white rounded-lg font-bold transition-opacity text-sm hover:opacity-90 disabled:opacity-40"
              >
                이름 수정
              </button>
              <button onClick={() => handleSetManual(null)} className="w-full py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg font-bold transition-colors text-sm">
                배정 삭제 (빈 좌석으로)
              </button>
            </div>
          ) : (
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium text-gray-500">
                빈 좌석 ({seatLabelText(seats.find((s: any) => s.id === selectedSeatInfo.seatId))})
              </p>
              <input
                type="text"
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                placeholder="이름 입력 (수동 배정)"
                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-md outline-none focus:ring-2 focus:ring-gray-900"
              />
              <button
                onClick={() => handleSetManual(manualName.trim() || null)}
                disabled={!manualName.trim()}
                style={{ backgroundColor: '#14B8A6' }}
                className="w-full py-2 text-white rounded-lg font-bold transition-opacity text-sm hover:opacity-90 disabled:opacity-40"
              >
                수동 배정
              </button>
              <button onClick={() => handleSetSeatPrivate(true)} className="w-full py-2 bg-gray-700 hover:bg-gray-800 text-white rounded-lg font-bold transition-colors text-sm">
                사석으로 지정
              </button>
              <div className="mt-2 space-y-1 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-1">
                {participants.filter((p: any) => !p.seat_id).length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-2">미배정 참가자가 없습니다.</p>
                ) : (
                  participants.filter((p: any) => !p.seat_id).sort((a: any, b: any) => a.turn_order - b.turn_order).map((p: any) => (
                    <button key={p.id} onClick={() => handleForceAssign(p.id)}
                      className="w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 active:bg-blue-100 rounded flex justify-between items-center border-b last:border-0 border-gray-50">
                      <span>{p.name} ({p.turn_order}번)</span>
                      <span className="text-blue-600 font-bold px-2 py-0.5 bg-blue-100 rounded text-[10px]">배정</span>
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
