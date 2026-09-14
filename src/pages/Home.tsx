import { useNavigate } from 'react-router-dom';

// 진입 화면 상단의 좌석표 모티프. 실제 좌석표를 축소한 모양이라
// 열자마자 "자리를 정하는 곳"이라는 게 보인다. 색도 그룹 색을 그대로 쓴다.
const MOTIF: string[][] = [
  ['#A63A4C', '#A63A4C', '#A63A4C', '#7A5AD1', '#7A5AD1', '#E8771A'],
  ['#7A5AD1', '#DDE4F2', '#00BFD0', '#DDE4F2', '#E8771A', '#DDE4F2'],
  ['#DDE4F2', '#DDE4F2', '#DDE4F2', '#DDE4F2', '#DDE4F2', '#DDE4F2'],
];

export default function Home() {
  const navigate = useNavigate();

  return (
    <div
      className="min-h-screen min-h-dvh flex flex-col items-center justify-center p-6"
      style={{ background: 'var(--c-bg)', color: 'var(--c-ink)' }}
    >
      <div className="w-full max-w-sm flex flex-col items-center">
        {/* 좌석표 모티프 */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-[156px] h-5 rounded-[7px] flex items-center justify-center text-[8.5px] font-extrabold tracking-[.3em]"
            style={{ background: 'linear-gradient(180deg, #FFFFFF 0%, #E4EAF7 100%)', color: '#9AA4BE' }}
          >
            STAGE
          </div>
          <div className="flex flex-col gap-[5px]">
            {MOTIF.map((row, r) => (
              <div key={r} className="flex gap-[5px]">
                {row.map((color, c) => (
                  <div key={c} className="w-5 h-5 rounded-md" style={{ background: color }} />
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="h-[34px]" />

        <div className="text-center">
          <div className="text-[17.5px] font-extrabold tracking-[.02em]" style={{ color: 'var(--c-muted)' }}>
            〈공감 모임〉
          </div>
          <h1 className="text-4xl font-extrabold tracking-[-.03em] leading-tight mt-1.5">좌석 지정</h1>
        </div>

        <div className="h-[30px]" />

        <div className="w-full flex flex-col gap-2.5">
          <button
            onClick={() => navigate('/user')}
            className="w-full h-[58px] rounded-[18px] text-white text-[17px] font-extrabold transition-opacity hover:opacity-90 active:opacity-80"
            style={{ background: 'var(--c-primary)', boxShadow: 'var(--sh-primary)' }}
          >
            참가자 로그인
          </button>
          {/* 관리자는 소수라, 참가자가 잘못 누르지 않도록 톤을 낮춘다 */}
          <button
            onClick={() => navigate('/admin')}
            className="w-full h-[54px] rounded-[18px] text-[15px] font-bold transition-colors"
            style={{ background: 'var(--c-surface)', border: '1px solid var(--c-line)', color: 'var(--c-muted)' }}
          >
            관리자 로그인
          </button>
        </div>
      </div>
    </div>
  );
}
