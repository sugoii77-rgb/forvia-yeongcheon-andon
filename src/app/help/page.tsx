"use client";
import { useState } from "react";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { useLang } from "@/lib/i18n";

// In-app help (2026-10-12): everything a new user needs without leaving the app — video, quick start,
// the ANDON alert sound (preview / download / how to set it), manual and contact. No login needed.
const SECTIONS = [
  { id: "video", label: "사용법 동영상" },
  { id: "quick", label: "빠른 시작" },
  { id: "sound", label: "알림음 받기" },
  { id: "more", label: "매뉴얼 · 문의" },
];

export default function HelpPage() {
  const lang = useLang();
  const [playing, setPlaying] = useState(false);
  function preview() {
    const a = new Audio("/andon-alert.mp3");
    setPlaying(true);
    a.onended = () => setPlaying(false);
    a.play().catch(() => setPlaying(false));
  }

  if (lang === "en") return <HelpEn />;
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
          <h2 style={{ marginTop: 0 }}>빠른 시작 <span className="muted" style={{ fontSize: 14 }}>아이콘 · 로그인 · 알림음 · 카카오, 5분 (3장은 선택: 전용 알림음)</span></h2>
          <p className="muted" style={{ fontSize: 14 }}>그림을 누르면 크게 열립니다.</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10 }}>
            {["/quickstart.png", "/quickstart-2.png", "/quickstart-3.png"].map((src, i) => (
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
          <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
            <b>선택 사항</b>입니다 — 기본 알림음으로도 ANDON 알림은 울립니다. 삼성 휴대폰에서 확인한 순서입니다.
          </p>
          <ol style={{ lineHeight: 1.7, paddingLeft: 20, marginTop: 6 }}>
            <li><span className="muted">[ANDON 앱]</span> 위의 <b>[알림음 받기]</b> → 다운로드 폴더에 <b>ANDON-알림음</b>으로 저장</li>
            <li>
              <span className="muted">[내 파일 앱]</span> <b>다운로드</b> → ANDON-알림음 <b>길게 누르기 → 이동 → 내장 저장공간 → Notifications</b> 폴더 → <b>여기로 이동</b>
              <div className="muted" style={{ fontSize: 13 }}>이 폴더에 있어야 휴대폰 소리 목록에 나타납니다.</div>
            </li>
            <li>
              <span className="muted">[휴대폰 설정 · 처음 한 번]</span> <b>설정 → 알림 → 고급 설정 → &lsquo;앱별 알림 카테고리 관리&rsquo; 켜기</b>
              <div className="muted" style={{ fontSize: 13 }}>삼성은 이 설정이 꺼져 있으면 앱 알림 화면에 &lsquo;소리&rsquo;가 보이지 않습니다.</div>
            </li>
            <li><span className="muted">[ANDON 앱]</span> 오른쪽 위 <b>이름 ⚙ → 내 정보 → [테스트 알림]</b>을 한 번 받기 <span className="muted">(그래야 알림 카테고리가 생깁니다)</span></li>
            <li>
              <span className="muted">[휴대폰 설정]</span> <b>설정 → 애플리케이션 → ANDON → 알림 → 알림 카테고리 → (카테고리 이름) → 소리 → ANDON-알림음</b>
              <div className="muted" style={{ fontSize: 13 }}>더 빠른 길: 알림이 왔을 때 <b>알림을 길게 누르기 → ⚙</b>. ANDON에 카테고리가 없으면 <b>Chrome → 알림 → 알림 카테고리 → 사이트 → forvia-yeongcheon-andon…</b></div>
            </li>
            <li><span className="muted">[ANDON 앱]</span> 다시 <b>[테스트 알림]</b> → &ldquo;딩동, 안돈 호출입니다&rdquo;가 나오면 완료</li>
          </ol>
          <div className="alert" style={{ background: "#fff4d6", border: "1px solid #f5b800", fontSize: 14 }}>
            <b>안드로이드만 가능합니다.</b> 아이폰은 웹 알림 소리를 바꿀 수 없어 기본 알림음이 울립니다. 기종에 따라 메뉴 이름이 조금 다를 수 있습니다.
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

const SECTIONS_EN = [
  { id: "how", label: "How ANDON works" },
  { id: "screens", label: "Screens" },
  { id: "video", label: "Video" },
  { id: "quick", label: "Quick start" },
  { id: "more", label: "Manual · contact" },
];

/** English help (2026-11-01, visitors from the BG / R&D). Same anchors as the Korean page where they exist. */
function HelpEn() {
  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Help</h1>
        <nav className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 12 }} aria-label="Help sections">
          {SECTIONS_EN.map((s) => (
            <a key={s.id} className="btn" href={`#${s.id}`}>{s.label}</a>
          ))}
        </nav>

        <section id="how" className="card">
          <h2 style={{ marginTop: 0 }}>How ANDON works</h2>
          <p>Digital ANDON replaces the paper and the phone call when something goes wrong on a line — one flow, from the call to the record:</p>
          <ol style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li><b>Call</b> — the GAP leader (or supervisor) picks the line, the process and the situation, adds a short description and an optional photo.</li>
            <li><b>Red</b> — the line turns red on the dashboard; the responsible department (Quality, Maintenance, Logistics, Safety, Production …) gets a phone alert and a KakaoTalk message at once.</li>
            <li><b>Yellow</b> — a responder acknowledges (or starts the repair) and records the actions taken.</li>
            <li><b>Green</b> — the issue is closed with the corrective action; Production confirms for most calls.</li>
            <li><b>Escalation</b> — an ANDON not closed after 2 hours goes to the plant manager and the team leaders.</li>
            <li><b>History</b> — every step is kept with who, when and on which device: response and resolution times, repeated issues, CSV export.</li>
          </ol>
          <p className="muted" style={{ fontSize: 14 }}>Texts typed on the shop floor (descriptions, action notes, names) are shown as entered, usually in Korean. Lines, states, problem types and departments are shown in English.</p>
        </section>

        <section id="screens" className="card">
          <h2 style={{ marginTop: 0 }}>Screens</h2>
          <dl className="kv">
            <dt><Link href="/dashboard">Dashboard</Link></dt>
            <dd>Plant map for the office big screen: every line in its real position — red OPEN, amber IN ACTION, green closed within 24 h. The border colour shows the problem type; the side list shows active ANDON with the elapsed time.</dd>
            <dt><Link href="/dashboard/list">Dashboard (list)</Link></dt>
            <dd>The same information as cards, with counters.</dd>
            <dt><Link href="/respond">Respond</Link></dt>
            <dd>Active ANDON; open one for the details, the photo and the complete timeline.</dd>
            <dt><Link href="/history">History</Link></dt>
            <dd>Counts, average response / resolution time, by line and by type, repeated issues, the latest 200 calls.</dd>
            <dt><Link href="/me">My account</Link></dt>
            <dd>Your details and password change. Visitor accounts are view-only: no calls, no responses, no alerts.</dd>
          </dl>
          <p className="muted" style={{ fontSize: 14 }}>KR / EN switch: top right of every screen. The choice is kept in this browser.</p>
        </section>

        <section id="video" className="card">
          <h2 style={{ marginTop: 0 }}>Video <span className="muted" style={{ fontSize: 14 }}>1 min 50 s · Korean narration</span></h2>
          <video controls preload="none" playsInline poster="/andon-guide.jpg" style={{ width: "100%", borderRadius: 10, background: "#000", aspectRatio: "16 / 9" }}>
            <source src="/andon-guide.mp4" type="video/mp4" />
          </video>
        </section>

        <section id="quick" className="card">
          <h2 style={{ marginTop: 0 }}>Quick start <span className="muted" style={{ fontSize: 14 }}>for plant employees · pictures in Korean</span></h2>
          <ol style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li>Open <b>forvia-yeongcheon-andon.vercel.app</b> and log in with your employee number (or e-mail) and password.</li>
            <li>Phone: add ANDON to the home screen (Android: Chrome menu → Add to home screen; iPhone: Safari → Share → Add to Home Screen).</li>
            <li>Responders: <b>name ⚙ → My account → Turn on alerts on this device</b>, then send a test alert.</li>
            <li>Optional: link KakaoTalk in My account to get the call in your own KakaoTalk as well.</li>
          </ol>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {["/quickstart.png", "/quickstart-2.png", "/quickstart-3.png"].map((src, i) => (
              <a key={src} href={src} target="_blank" rel="noopener">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Quick start page ${i + 1} (Korean)`} loading="lazy" style={{ width: "100%", borderRadius: 10, border: "1px solid var(--line, #dde3ec)" }} />
              </a>
            ))}
          </div>
        </section>

        <section id="sound" className="card">
          <h2 style={{ marginTop: 0 }}>Big-screen dashboard</h2>
          <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li>On the display PC click <b>Turn on live updates</b> once and allow notifications: the board then changes within seconds of every call.</li>
            <li>Keep the dashboard window visible (not minimised). A green <b>● LIVE</b> means connected; a red warning means the network is down.</li>
          </ul>
        </section>

        <section id="more" className="card">
          <h2 style={{ marginTop: 0 }}>Manual · contact</h2>
          <p>
            <a className="btn" href="/manual-en.html" target="_blank" rel="noopener">User manual (English)</a>{" "}
            <a className="btn" href="/manual.html" target="_blank" rel="noopener">사용 매뉴얼 (Korean)</a>
          </p>
          <ul style={{ lineHeight: 1.8, paddingLeft: 20 }}>
            <li><b>Screen not up to date:</b> pull down to refresh, or reload the page.</li>
            <li><b>Contact:</b> Young-Hwan OH (QC), system owner, FORVIA Yeongcheon plant.</li>
          </ul>
        </section>
      </main>
    </>
  );
}
