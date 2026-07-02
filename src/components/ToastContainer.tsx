import { useEffect } from 'react';
import { useStore, Toast } from '../store/useStore';

// alert() 대체: 화면 조작을 막지 않고 상단에 잠시 표시됐다 사라지는 알림.
// (alert는 모바일에서 화면 전체를 막고, 소켓 이벤트 타이밍에 뜨면 조작 흐름이 끊긴다)
function ToastItem({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onClick={onDone}
      className={`pointer-events-auto cursor-pointer w-full px-4 py-3 rounded-xl shadow-lg text-sm font-medium text-white text-center ${
        toast.type === 'error' ? 'bg-red-600/95' : 'bg-gray-900/95'
      }`}
    >
      {toast.message}
    </div>
  );
}

export default function ToastContainer() {
  const { toasts, removeToast } = useStore();
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none px-4 w-full max-w-md">
      {toasts.map(t => (
        <ToastItem key={t.id} toast={t} onDone={() => removeToast(t.id)} />
      ))}
    </div>
  );
}
