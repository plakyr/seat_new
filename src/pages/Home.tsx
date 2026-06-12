import { useNavigate } from 'react-router-dom';

export default function Home() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
      <div className="max-w-md w-full bg-white rounded-xl shadow-lg p-8 text-center">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">공감 모임 좌석 지정</h1>
        <div className="space-y-4">
          <button
            onClick={() => navigate('/user')}
            style={{ backgroundColor: '#4257D9' }}
            className="w-full py-4 hover:opacity-90 text-white rounded-lg font-semibold text-lg transition-colors"
          >
            참가자 로그인
          </button>
          <button
            onClick={() => navigate('/admin')}
            className="w-full py-4 bg-gray-800 hover:bg-gray-900 text-white rounded-lg font-semibold text-lg transition-colors"
          >
            관리자 로그인
          </button>
        </div>
      </div>
    </div>
  );
}
