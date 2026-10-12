"use client";
import { useState } from "react";
import { TopBar } from "@/components/TopBar";

// In-app help (2026-10-12): everything a new user needs without leaving the app — video, quick start,
// the ANDON alert sound (preview / download / how to set it), manual and contact. No login needed.
const SECTIONS = [
  { id: "video", label: "사용법 동영상" },
  { id: "quick", label: "빠른 시작" },
  { id: "sound", label: "알림음 받기" },
  { id: "more", label: "매뉴얼 · 문의" },
];

export default function HelpPage() {
  const [playing, setPlaying] = useState(false);
  function preview() {
    const a = new Audio("/andon-alert.mp3");
    setPlaying(true);
    a.onended = () => setPlaying(false);
    a.play().catch(() => setPlaying(false));
  }

  return (
    <>
      <TopBar />
      <main className="page">
        <h1>
          도움말 <span className="muted" style={{ fontSize: 16 }}>Help</span>
        </h1>
        <nav className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }} aria-label="도움말 바로가기">
          {SECTIONS.map((s) => (
            <a key={s.id} className="btn" href={`#${s.id}`}>{s.label}</a>
          ))}
        </nav>

        <section id="video" className="card">
          <h2 style={{ marginTop: 0 }}>사용법 동영상 <span className="muted" style={{ fontSize: 14 }}>1분 50초 · 소리를 켜고 보세요</span></h2>
          <video controls preload="none" playsInline poster="/andon-guide.jpg" style={{ width: "100%", borderRadius: 10, background: "#000", aspectRatio: "16 / 9" }}>
            <source src="/andon-guide.mp4" type="video/mp4" />
          </video>
        </section>

        <section id="quick" className="card">
          <h2 style={{ marginTop: 0 }}>빠른 시작 <span className="muted" style={{ fontSize: 14 }}>아이콘 · 로그인 · 알림음 · 카카오, 5분</span></h2>
          <p className="muted" style={{ fontSize: 14 }}>그림을 누르면 크게 열립니다.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            {["/quickstart.png", "/quickstart-2.png"].map((src, i) => (
              <a key={src} href={src} target="_blank" rel="noopener">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`빠른 시작 ${i + 1}장`} loading="lazy" style={{ width: "100%", borderRadius: 10, border: "1px solid var(--line, #dde3ec)" }} />
              </a>
            ))}
          </div>
          <p style={{ marginTop: 10 }}>
            <a className="btn" href="/quickstart.pdf" target="_blank" rel="noopener">PDF로 보기 (인쇄용)</a>
          </p>
        </section>

        <section id="sound" className="card" data-testid="help-sound">
          <h2 style={{ marginTop: 0 }}>ANDON 전용 알림음 <span className="muted" style={{ fontSize: 14 }}>딩동 + &ldquo;안돈 호출입니다&rdquo;</span></h2>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <button className="btn" type="button" onClick={preview} disabled={playing}>{playing ? "♪ 재생 중…" : "▶ 미리 듣기"}</button>
            <a className="btn btn-primary" href="/andon-alert.mp3" download="ANDON-알림음.mp3">알림음 받기</a>
          </div>
          <ol style={{ lineHeight: 1.7, paddingLeft: 20, marginTop: 12 }}>
            <li><span className="muted">[ANDON 앱]</span> 위의 <b>[알림음 받기]</b> → 휴대폰 <b>다운로드</b> 폴더에 <b>ANDON-알림음</b>으로 저장</li>
            <li>
              <span className="muted">[휴대폰 설정]</span> 홈 화면의 <b>ANDON 아이콘을 길게 누르기 → ⓘ (애플리케이션 정보) → 알림 → 소리</b>
              <div className="muted" style={{ fontSize: 13 }}>또는 휴대폰 <b>설정</b>(톱니바퀴 앱) → 애플리케이션 → ANDON → 알림 → 소리 · ANDON이 목록에 없으면 Chrome → 알림 → 사이트</div>
            </li>
            <li><span className="muted">[휴대폰 설정]</span> 소리 목록 오른쪽 위 <b>+</b> <span className="muted">(또는 &lsquo;내 파일&rsquo;)</span> → <b>다운로드</b> 폴더의 <b>ANDON-알림음</b> 선택</li>
            <li><span className="muted">[ANDON 앱]</span> 오른쪽 위 <b>이름 ⚙ → 내 정보 → [테스트 알림]</b> → &ldquo;딩동, 안돈 호출입니다&rdquo;가 나오면 완료</li>
          </ol>
          <p className="muted" style={{ fontSize: 13 }}>소리는 휴대폰이 관리하기 때문에 2·3번은 ANDON 앱이 아니라 <b>휴대폰 설정</b>에서 합니다. 휴대폰 기종에 따라 메뉴 이름이 조금 다를 수 있습니다.</p>
          <div className="alert" style={{ background: "#fff4d6", border: "1px solid #f5b800", fontSize: 14 }}>
            <b>안드로이드만 가능합니다.</b> 아이폰은 웹 알림 소리를 바꿀 수 없어 기본 알림음이 울립니다.
            먼저 &lsquo;내 정보&rsquo;에서 <b>[이 기기 알림 켜기]</b>가 되어 있어야 합니다.
          </div>
        </section>

        <section id="more" className="card">
          <h2 style={{ marginTop: 0 }}>매뉴얼 · 문의</h2>
          <p>
            <a className="btn" href="/manual.html" target="_blank" rel="noopener">전체 사용 매뉴얼</a>
          </p>
          <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li><b>비밀번호를 잊었으면:</b> 로그인 화면 → &lsquo;비밀번호를 잊으셨나요?&rsquo; → 카카오톡 인증번호</li>
            <li><b>알림이 안 울리면:</b> 무음·방해금지 모드, 휴대폰 설정 → 애플리케이션 → Chrome(또는 ANDON) → 알림 허용·소리 켜짐 확인</li>
            <li><b>화면이 예전 그대로면:</b> 화면을 아래로 당겨 새로고침, 또는 앱을 닫았다가 다시 열기</li>
            <li><b>문의:</b> 시스템 담당자 오영환 책임 (QC)</li>
          </ul>
        </section>
      </main>
    </>
  );
}
