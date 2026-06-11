import React, { useState, useEffect } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import { cn } from '../lib/utils';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

export default function SeatMap({ forceAdmin = false }: { forceAdmin?: boolean }) {
  const { seats, participants, user, isAdmin: storeIsAdmin, isFrozen, sessionColors } = useStore();
  const isAdmin = forceAdmin || storeIsAdmin; // props가 true면 무조건 관리자 모드
  const socket = useSocket();
  const [selectedSeatInfo, setSelectedSeatInfo] = useState<{ seatId: string, participant: any } | null>(null);

  const maxRow = seats.length > 0 ? Math.max(...seats.map(s => s.row)) : 0;
  const maxCol = seats.length > 0 ? Math.max(...seats.map(s => s.col)) : 0;

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
        if (participant) {
          setSelectedSeatInfo({ seatId: seat.id, participant });
        }
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
      if (!eventId) {
        alert('이벤트 ID를 찾을 수 없습니다.');
        return;
      }
      socket.emit('admin:force_assign', {
        eventId,
        seatId: selectedSeatInfo.seatId,
        participantId: participantId
      });
      setSelectedSeatInfo(null);
    }
  };

  return (
    <div className="w-full h-full min-h-[60vh] bg-gray-100 rounded-xl overflow-hidden border border-gray-200 relative shadow-inner flex flex-col">
      {seats.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 bg-white/60">
          <p className="text-gray-500 font-bold animate-pulse">좌석 데이터를 불러오는 중입니다...</p>
        </div>
      )}

      <TransformWrapper initialScale={1} minScale={0.5} maxScale={4} centerOnInit>
        <TransformComponent wrapperClass="w-full h-full flex-1" contentClass="w-full h-full flex items-center justify-center p-8">
          <div 
            className="grid gap-2 md:gap-3 p-6 bg-white rounded-xl shadow-lg border border-gray-100"
            style={{ 
              gridTemplateColumns: `repeat(${maxCol || 1}, minmax(32px, 1fr))`,
              display: 'grid'
            }}
          >
            {grid.slice(1).map((row, rIdx) => (
              <React.Fragment key={`row-${rIdx + 1}`}>
                {row.slice(1).map((seat, cIdx) => {
                  if (!seat) return <div key={`empty-${rIdx + 1}-${cIdx + 1}`} className="w-8 h-8 md:w-12 md:h-12 bg-gray-50/50 rounded-sm" />;
                  
                  const isMySeat = seat.assigned_to === user?.id;
                  const assignedParticipant = seat.assigned_to ? participants.find(p => p.id === seat.assigned_to) : null;
                  const displayName = assignedParticipant ? assignedParticipant.name : '';
                  
                  let seatColor = 'bg-gray-200 hover:bg-gray-300 cursor-pointer text-gray-800';
                  let customStyle = {};

                  if (seat.status === 'RESERVED' || seat.status === 'AUTO_ASSIGNED') {
                    const bgColor = getSeatColor(seat);
                    seatColor = isMySeat ? 'text-white shadow-md ring-2 ring-blue-400 scale-110 z-10' : 'text-white opacity-90 cursor-not-allowed';
                    if (isAdmin) seatColor = 'text-white cursor-pointer hover:opacity-80';
                    customStyle = { backgroundColor: bgColor };
                  } else if (seat.status === 'FROZEN') {
                    seatColor = 'bg-red-100 border-2 border-red-300 cursor-not-allowed text-red-800';
                  }

                  return (
                    <button
                      key={seat.id}
                      onClick={() => handleSeatClick(seat)}
                      disabled={(!isAdmin && seat.status !== 'EMPTY') || (!isAdmin && isFrozen) || (!isAdmin && (user?.turn_status === 'COMPLETED' || user?.is_final))}
                      className={cn(
                        "w-8 h-8 md:w-12 md:h-12 rounded-t-lg rounded-b-sm flex items-center justify-center text-[10px] md:text-xs font-bold transition-all duration-200 overflow-hidden text-ellipsis whitespace-nowrap px-0.5 shadow-sm",
                        seatColor,
                        (!isAdmin && isFrozen) && "opacity-50 cursor-not-allowed",
                        (!isAdmin && (user?.turn_status === 'COMPLETED' || user?.is_final)) && "opacity-70 cursor-not-allowed"
                      )}
                      style={customStyle}
                      title={displayName ? `${displayName} (Row ${seat.row}, Col ${seat.col})` : `Row ${seat.row}, Col ${seat.col}`}
                    >
                      {displayName || `${seat.row}-${seat.col}`}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </TransformComponent>
      </TransformWrapper>
      
      <div className="absolute bottom-4 left-4 right-4 flex justify-center gap-4 bg-white/90 backdrop-blur-sm py-2 px-4 rounded-full shadow-md border border-gray-200 text-xs md:text-sm font-medium">
        <div className="flex items-center gap-2"><div className="w-4 h-4 rounded bg-gray-200"></div>선택 가능</div>
        <div className="flex items-center gap-2"><div className="w-4 h-4 rounded bg-gray-800 opacity-50"></div>예약됨</div>
        {!isAdmin && <div className="flex items-center gap-2"><div className="w-4 h-4 rounded bg-blue-500"></div>내 자리</div>}
      </div>

      {selectedSeatInfo && (
        <div className="absolute top-4 right-4 bg-white p-4 rounded-xl shadow-xl border border-gray-200 z-20 w-64 max-h-[80vh] overflow-y-auto animate-in slide-in-from-right-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-gray-900">좌석 정보</h3>
            <button onClick={() => setSelectedSeatInfo(null)} className="text-gray-400 hover:text-gray-600">✕</button>
          </div>
          {selectedSeatInfo.participant ? (
            <>
              <div className="space-y-2 text-sm text-gray-700 mb-4">
                <p><span className="font-medium text-gray-500">세션:</span> {selectedSeatInfo.participant.session_id}</p>
                <p><span className="font-medium text-gray-500">이름:</span> {selectedSeatInfo.participant.name}</p>
                <p><span className="font-medium text-gray-500">순번:</span> {selectedSeatInfo.participant.turn_order}</p>
              </div>
              <button onClick={handleForceCancel} className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold transition-colors">강제 취소</button>
            </>
          ) : (
            <div className="space-y-2 text-sm text-gray-700">
              <p className="font-medium text-gray-500">빈 좌석 ({grid.find(r => r.some(s => s?.id === selectedSeatInfo.seatId))?.find(s => s?.id === selectedSeatInfo.seatId)?.row}행 {grid.find(r => r.some(s => s?.id === selectedSeatInfo.seatId))?.find(s => s?.id === selectedSeatInfo.seatId)?.col}열)</p>
              <div className="mt-2 space-y-1 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-1">
                {participants.filter(p => !p.seat_id).length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-2">미배정 참가자가 없습니다.</p>
                ) : (
                  participants.filter(p => !p.seat_id).sort((a, b) => a.turn_order - b.turn_order).map(p => (
                    <button key={p.id} onClick={() => handleForceAssign(p.id)} className="w-full text-left px-2 py-1.5 text-xs hover:bg-blue-50 rounded flex justify-between items-center border-b last:border-0 border-gray-50">
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
