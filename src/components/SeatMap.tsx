import React, { useState } from 'react';
import { cn } from '../lib/utils';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

export default function SeatMap({ forceAdmin = false }: { forceAdmin?: boolean }) {
  const { seats, participants, user, isAdmin: storeIsAdmin, isFrozen, sessionColors, layout } = useStore();
  const isAdmin = forceAdmin || storeIsAdmin;
  const socket = useSocket();
  const [selectedSeatInfo, setSelectedSeatInfo] = useState<{ seatId: string, participant: any } | null>(null);

  const maxRow = seats.length > 0 ? Math.max(...seats.map(s => s.row)) : 0;
  const maxCol = seats.length > 0 ? Math.max(...seats.map(s => s.col)) : 0;

  const aisleAfterRows: number[] = layout?.aisle_after_rows ?? [];
  const aisleAfterCols: number[] = layout?.aisle_after_cols ?? [];

  const grid: any[][] = Array.from({ length: maxRow + 1 }, () => Array(maxCol + 1).fill(null));
  seats.forEach(seat => {
    if (seat.row <= maxRow && seat.col <= maxCol) {
      grid[seat.row][seat.col] = seat;
    }
  });

  const getSeatColor = (seat: any) => {
    if (seat.status === 'EMPTY') return '#FFFFFF';
    if (seat.status === 'LOCKED') return '#E5E7EB';
    const colorObj = sessionColors.find(sc => sc.session_id === seat.session_id);
    if (colorObj) return colorObj.color;
    return '#4374D9';
  };

  const handleSeatClick = (seat: any) => {
    if (!socket) return;
    if (isAdmin) {
      if ((seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') && seat.assigned_to) {
        const participant = participants.find(p => p.id === seat.assigned_to);
        if (participant) setSelectedSeatInfo({ seatId: seat.id, participant });
      } else if (seat.status === 'EMPTY') {
        setSelectedSeatInfo({ seatId: seat.id, participant: null });
      }
    } else if (user) {
      if (user.turn_status === 'COMPLETED' || user.is_final) {
        alert('이미 좌석 선택이 완료되었습니다.');
        return;
      }
      socket.emit('seat:select', { seatId: seat.id });
    }
  };

  const handleForceCancel = () => {
    if (!socket || !selectedSeatInfo) return;
    if (confirm(`정말로 ${selectedSeatInfo.participant.name}님의 좌석을 강제 취소하시겠습니까?`)) {
      socket.emit('admin:cancel_seat', {
        eventId: selectedSeatInfo.participant.event_id,
        seatId: selectedSeatInfo.seatId,
        participantId: selectedSeatInfo.participant.id
      });
      setSelectedSeatInfo(null);
    }
  };

  const handleForceAssign = (participantId: string) => {
    if (!socket || !selectedSeatInfo) return;
    if (window.confirm('이 참가자를 이 좌석에 강제 배정하시겠습니까?')) {
      const eventId = selectedSeatInfo.participant?.event_id || user?.event_id || (participants.length > 0 ? participants[0].event_id : null);
      if (!eventId) { alert('이벤트 ID를 찾을 수 없습니다.'); return; }
      socket.emit('admin:force_assign', { eventId, seatId: selectedSeatInfo.seatId, participantId });
      setSelectedSeatInfo(null);
    }
  };

  // 열 번호 툴팁: "n열 n번" 형식
  const getSeatLabel = (seat: any) => `${seat.row}열 ${seat.col}번`;

  return (
    <div className="w-full h-full min-h-[60vh] bg-gray-100 rounded-xl border border-gray-200 relative shadow-inner flex flex-col overflow-hidden">
      {seats.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-white/60">
          <p className="text-gray-500 font-bold animate-pulse">좌석 데이터를 불러오는 중입니다...</p>
        </div>
      )}

      <div
        className="flex-1 overflow-auto"
        style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-x pan-y' }}
      >
        <div className="inline-block p-4 min-w-full">

          {/* STAGE 표시 */}
          <div className="flex justify-center mb-4">
            <div className="border-2 border-gray-800 rounded px-12 py-2 font-black text-lg tracking-widest text-gray-800 bg-white shadow-sm">
              STAGE
            </div>
          </div>

          {/* 좌석 그리드 */}
          <div className="bg-white rounded-xl shadow-md border border-gray-100 p-4 mx-auto w-fit">
            {grid.slice(1).map((row, rIdx) => {
              const rowNum = rIdx + 1;
              const hasAisleAfter = aisleAfterRows.includes(rowNum);
              return (
                <React.Fragment key={`row-${rowNum}`}>
                  <div className="flex gap-1.5">
                    {row.slice(1).map((seat, cIdx) => {
                      const colNum = cIdx + 1;
                      const hasAisleAfterCol = aisleAfterCols.includes(colNum);

                      if (!seat) return (
                        <React.Fragment key={`empty-${rowNum}-${colNum}`}>
                          <div className="w-10 h-10 bg-gray-50/50 rounded-sm" />
                          {hasAisleAfterCol && <div className="w-5 shrink-0" />}
                        </React.Fragment>
                      );

                      const isMySeat = seat.assigned_to === user?.id;
                      const assignedParticipant = seat.assigned_to ? participants.find(p => p.id === seat.assigned_to) : null;
                      const displayName = assignedParticipant ? assignedParticipant.name : '';

                      let seatClass = 'bg-gray-200 hover:bg-gray-300 active:bg-gray-400 cursor-pointer text-gray-800';
                      let customStyle: React.CSSProperties = {};

                      if (seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') {
                        const bgColor = getSeatColor(seat);
                        customStyle = { backgroundColor: bgColor };
                        if (isMySeat) {
                          seatClass = 'text-white shadow-md ring-2 ring-blue-400 scale-110 z-10 cursor-default';
                        } else if (isAdmin) {
                          seatClass = 'text-white cursor-pointer hover:opacity-80 active:opacity-60';
                        } else {
                          seatClass = 'text-white opacity-90 cursor-not-allowed';
                        }
                      } else if (seat.status === 'FROZEN') {
                        seatClass = 'bg-red-100 border-2 border-red-300 cursor-not-allowed text-red-800';
                      }

                      const isDisabled = (!isAdmin && seat.status !== 'EMPTY')
                        || (!isAdmin && isFrozen)
                        || (!isAdmin && (user?.turn_status === 'COMPLETED' || user?.is_final));

                      return (
                        <React.Fragment key={seat.id}>
                          <button
                            onClick={() => handleSeatClick(seat)}
                            disabled={isDisabled}
                            className={cn(
                              'w-10 h-10 rounded-t-lg rounded-b-sm flex items-center justify-center text-[9px] font-bold transition-all duration-150 overflow-hidden whitespace-nowrap px-0.5 shadow-sm select-none shrink-0',
                              seatClass,
                              !isAdmin && isFrozen && 'opacity-50 cursor-not-allowed',
                              !isAdmin && (user?.turn_status === 'COMPLETED' || user?.is_final) && 'opacity-70 cursor-not-allowed'
                            )}
                            style={customStyle}
                            title={displayName
                              ? `${displayName} (${getSeatLabel(seat)})`
                              : getSeatLabel(seat)}
                          >
                            {displayName || `${seat.row}-${seat.col}`}
                          </button>
                          {/* 세로 복도 */}
                          {hasAisleAfterCol && <div className="w-5 shrink-0" />}
                        </React.Fragment>
                      );
                    })}
                  </div>
                  {/* 가로 복도 */}
                  {hasAisleAfter && <div className="h-5" />}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* 범례 */}
      <div className="shrink-0 flex justify-center gap-4 bg-white/95 py-2 px-4 border-t border-gray-200 text-xs font-medium">
        <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gray-200 shadow-sm" />선택 가능</div>
        <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-gray-500 opacity-60 shadow-sm" />예약됨</div>
        {!isAdmin && <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-blue-500 shadow-sm" />내 자리</div>}
      </div>

      {/* 좌석 클릭 팝업 (관리자용) */}
      {selectedSeatInfo && (
        <div className="absolute top-4 right-4 bg-white p-4 rounded-xl shadow-xl border border-gray-200 z-20 w-64 max-h-[80vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-gray-900">좌석 정보</h3>
            <button onClick={() => setSelectedSeatInfo(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
          </div>
          {selectedSeatInfo.participant ? (
            <>
              <div className="space-y-2 text-sm text-gray-700 mb-4">
                <p><span className="font-medium text-gray-500">세션:</span> {selectedSeatInfo.participant.session_id}</p>
                <p><span className="font-medium text-gray-500">이름:</span> {selectedSeatInfo.participant.name}</p>
                <p><span className="font-medium text-gray-500">순번:</span> {selectedSeatInfo.participant.turn_order}</p>
              </div>
              <button onClick={handleForceCancel} className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-colors">
                강제 취소
              </button>
            </>
          ) : (
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium text-gray-500">
                빈 좌석 ({seats.find(s => s.id === selectedSeatInfo.seatId)?.row}열 {seats.find(s => s.id === selectedSeatInfo.seatId)?.col}번)
              </p>
              <div className="mt-2 space-y-1 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-1">
                {participants.filter(p => !p.seat_id).length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-2">미배정 참가자가 없습니다.</p>
                ) : (
                  participants.filter(p => !p.seat_id).sort((a, b) => a.turn_order - b.turn_order).map(p => (
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
