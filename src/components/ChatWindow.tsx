import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

export default function ChatWindow({ eventId }: { eventId: string }) {
  const { messages, user, isAdmin, adminUser, currentTurnOrder, isFrozen } = useStore();
  const socket = useSocket();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const canChat = isAdmin || (user && user.turn_order === currentTurnOrder && !isFrozen && !user.is_final);

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
      <div className="bg-gray-50 border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-bold text-gray-800">실시간 채팅</h3>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => {
          const isMe = isAdmin ? msg.sender_type === 'ADMIN' : (user && msg.sender_name === user.name && msg.sender_type === 'USER');
          return (
            <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-xs font-semibold text-gray-700">
                  {msg.sender_type === 'ADMIN' ? '👑 관리자' : msg.sender_name}
                </span>
                <span className="text-[10px] text-gray-400">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div className={`px-3 py-2 rounded-lg text-sm max-w-[85%] ${isMe ? 'bg-gray-900 text-white rounded-tr-none' : 'bg-gray-100 text-gray-800 rounded-tl-none'}`}>
                {msg.content}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-3 border-t border-gray-200 bg-gray-50">
        <form onSubmit={handleSendMessage} className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={!canChat}
            placeholder={canChat ? "메시지를 입력하세요..." : "현재 차례인 사용자만 채팅이 가능합니다."}
            className="flex-1 px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:bg-gray-100 disabled:text-gray-500"
          />
          <button
            type="submit"
            disabled={!canChat || !inputValue.trim()}
            className="px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-800 transition-colors"
          >
            전송
          </button>
        </form>
      </div>
    </div>
  );
}
