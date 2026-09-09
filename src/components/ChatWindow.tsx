import React, { useState, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useSocket } from '../store/useSocket';

export default function ChatWindow({ eventId }: { eventId: string }) {
  const { messages, user, isAdmin, currentTurnOrder, participants } = useStore();
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
    <div
      className="flex flex-col h-full rounded-[20px] overflow-hidden"
      style={{ background: 'var(--c-surface)', boxShadow: 'var(--sh-card)' }}
    >
      <div
        className="px-4 py-3 flex items-center gap-[7px] shrink-0"
        style={{ background: 'var(--c-tint-3)', borderBottom: '1px solid #E9EFFA' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-primary)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.5 9.5 0 0 1-2.8-.4L3 21l1.6-4.6A8.2 8.2 0 0 1 3.6 11.5 8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
        </svg>
        <h3 className="text-[15px] font-extrabold" style={{ color: 'var(--c-ink-2)' }}>실시간 채팅</h3>
      </div>

      {/* 아래쪽 기준으로 쌓아 최신 메시지가 항상 보이게 한다 */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 flex flex-col justify-end gap-3"
      >
        {messages.map((msg) => {
          const isMe = isAdmin ? msg.sender_type === 'ADMIN' : (user && msg.sender_name === user.name && msg.sender_type === 'USER');
          const isAdminMsg = msg.sender_type === 'ADMIN';
          return (
            <div key={msg.id} className={`flex flex-col shrink-0 ${isMe ? 'items-end' : 'items-start'}`}>
              <div className="flex items-center gap-1.5 mb-1.5">
                {isAdminMsg ? (
                  <span
                    className="inline-flex items-center rounded-full px-[7px] py-0.5 text-[11px] font-extrabold"
                    style={{ background: '#FFF0E6', color: '#D2652C' }}
                  >
                    관리자
                  </span>
                ) : (
                  <span className="text-xs font-bold" style={{ color: 'var(--c-muted)' }}>{msg.sender_name}</span>
                )}
                <span className="text-[11px] font-medium" style={{ color: 'var(--c-placeholder)' }}>
                  {new Date(msg.timestamp).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <div
                className="px-3.5 py-2.5 text-sm font-medium max-w-[86%] leading-[1.45] whitespace-pre-wrap break-words"
                style={isMe
                  ? { background: 'var(--c-primary)', color: '#fff', borderRadius: '14px 14px 4px 14px' }
                  : { background: 'var(--c-tint)', color: 'var(--c-ink-2)', borderRadius: '14px 14px 14px 4px' }}
              >
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>

      <div className="px-3 py-2.5 shrink-0 flex gap-2 items-center" style={{ borderTop: '1px solid var(--c-line-soft)' }}>
        <form onSubmit={handleSendMessage} className="flex gap-2 items-center w-full">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            maxLength={500}
            disabled={!canChat}
            placeholder={canChat ? '메시지를 입력하세요...' : '그룹 진행 중에만 채팅이 가능합니다.'}
            className="flex-1 min-w-0 px-3.5 py-2.5 text-sm font-medium rounded-full outline-none focus:shadow-[0_0_0_3px_rgba(74,107,245,.14)] transition-shadow disabled:opacity-70"
            style={{ background: 'var(--c-tint)', color: 'var(--c-ink)' }}
          />
          <button
            type="submit"
            disabled={!canChat || !inputValue.trim()}
            aria-label="전송"
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 active:opacity-80 transition-opacity"
            style={{ background: 'var(--c-primary)' }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 12h14" />
              <path d="M12.5 5.5 19 12l-6.5 6.5" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
