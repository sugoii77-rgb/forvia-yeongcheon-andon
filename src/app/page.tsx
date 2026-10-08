import Link from "next/link";
import { TopBar } from "@/components/TopBar";

export default function Home() {
  return (
    <>
      <TopBar />
      <main className="page">
        <h1>Digital ANDON · 영천공장</h1>
        <div className="tiles">
          <Link href="/operator" className="tile tile-andon">
            <strong>ANDON 호출</strong>GAP 리더 · Leader call
          </Link>
          <Link href="/dashboard" className="tile">
            <strong>실시간 현황판</strong>Live dashboard (대형 모니터)
          </Link>
          <Link href="/respond" className="tile">
            <strong>담당자 조치</strong>Responder · ACK / ACTION / CLOSE
          </Link>
          <Link href="/history" className="tile">
            <strong>이력 / 통계</strong>History &amp; analytics
          </Link>
          <a href="/manual.html" className="tile">
            <strong>사용 매뉴얼</strong>Manual · 호출 · 조치 · 카카오 알림
          </a>
        </div>
      </main>
    </>
  );
}
