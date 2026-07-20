import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

export default function ChatWindow({ eventId }: { eventId: string }) {
  const { messages, user, isAdmin, adminUser, currentTurnOrder, participants } = useStore();
  const socket = useSocket();
  const [inputValue, setInputValue] = useState('');
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages]);

  // 채팅 가능 조건 (서버 검증과 동일한 규칙):
  //  - 관리자: 항상
  //  - 관전 계정(turn_order 0, '추가' 그룹): 항상
  //  - 일반 참가자: 현재 차례 참가자와 같은 그룹이면(= 자기 그룹 진행 중) 좌석 확정 여부와 무관하게 가능
  // 일시정지(isFrozen) 중에도 동일하게 허용
  const currentTurnParticipant = participants.find(p => p.turn_order === currentTurnOrder);
  const canChat = isAdmin || (user && (
    user.turn_order === 0 ||
    (currentTurnParticipant != null && currentTurnParticipant.session_id === user.session_id)
  ));

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !socket || !canChat) return;

    socket.emit('chat:send', {
      eventId,
      content: inputValue.trim(),
    });
    setInputValue('');
  };

  return (
    <div className="flex flex-col h-full bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="border-b border-gray-200 px-4 py-3" style={{ backgroundColor: '#FEE500' }}>
        <h3 className="text-base font-bold text-gray-800">실시간 채팅</h3>
      </div>
      
      <div ref={messagesContainerRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => {
          const isMe = isAdmin ? msg.sender_type === 'ADMIN' : (user && msg.sender_name === user.name && msg.sender_type === 'USER');
          return (
            <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-sm font-semibold text-gray-700">
                  {msg.sender_type === 'ADMIN' ? '👑 관리자' : msg.sender_name}
                </span>
                <span className="text-xs text-gray-400">
                  {new Date(msg.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className={`px-3 py-2 rounded-lg text-base max-w-[85%] ${isMe ? 'bg-gray-900 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 rounded-tl-none'}`}>
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-gray-200 bg-gray-50">
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            maxLength={500}
            disabled={!canChat}
            placeholder={canChat ? "메시지를 입력하세요..." : "그룹 진행 중에만 채팅이 가능합니다."}
            className="flex-1 min-w-0 px-3 py-2 text-base border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:bg-gray-100 disabled:text-gray-500"
          />
          <button
            type="submit"
            disabled={!canChat || !inputValue.trim()}
            className="flex-shrink-0 whitespace-nowrap px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-800 transition-colors"
          >
            전송
          </button>
        </form>
      </div>
    </div>
  );
}
