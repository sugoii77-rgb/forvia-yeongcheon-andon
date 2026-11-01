"use client";
import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { SetupTile } from "@/components/SetupTile";
import { useT } from "@/lib/i18n";

export default function Home() {
  const t = useT();
  return (
    <>
      <TopBar />
      <main className="page">
        <h1>{t("Digital ANDON · 영천공장", "Digital ANDON · Yeongcheon Plant")}</h1>
        <div className="tiles">
          <Link href="/operator" className="tile tile-andon">
            <strong>{t("ANDON 호출", "Call ANDON")}</strong>{t("GAP 리더 · Leader call", "GAP leader / supervisor")}
          </Link>
          <Link href="/dashboard" className="tile">
            <strong>{t("실시간 현황판", "Live dashboard")}</strong>{t("Live dashboard (대형 모니터)", "Plant map for the big screen")}
          </Link>
          <Link href="/respond" className="tile">
            <strong>{t("담당자 조치", "Respond")}</strong>{t("Responder · ACK / ACTION / CLOSE", "Acknowledge · act · close")}
          </Link>
          <Link href="/history" className="tile">
            <strong>{t("이력 / 통계", "History / analytics")}</strong>{t("History & analytics", "Past ANDON, response times")}
          </Link>
          <Link href="/help" className="tile">
            <strong>{t("도움말", "Help")}</strong>{t("동영상 · 빠른 시작 · 알림음 받기", "Video · quick start · how it works")}
          </Link>
          <a href={t("/manual.html", "/manual-en.html")} className="tile">
            <strong>{t("사용 매뉴얼", "User manual")}</strong>{t("Manual · 호출 · 조치 · 카카오 알림", "Call · respond · notifications")}
          </a>
          <SetupTile />
        </div>
      </main>
    </>
  );
}
