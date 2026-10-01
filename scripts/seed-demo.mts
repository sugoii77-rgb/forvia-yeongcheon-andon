// Loads realistic demo data.  Usage:
//   npm run seed          -> adds demo events to the existing DB
//   npm run seed -- --reset -> backs up and deletes the DB first, then seeds
// Stop the app server before using --reset.
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const { DATABASE_PATH, REMOTE_DATABASE_URL } = await import("../src/lib/server/db.ts");

if (process.argv.includes("--reset") && REMOTE_DATABASE_URL) {
  console.error("--reset is only for the local SQLite file. A remote (Turso) database is never deleted by this script.");
  process.exit(1);
}
if (process.argv.includes("--reset") && fs.existsSync(DATABASE_PATH)) {
  const backupDir = path.join(path.dirname(DATABASE_PATH), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `andon-before-reset-${stamp}.db`);
  fs.copyFileSync(DATABASE_PATH, target);
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(DATABASE_PATH + suffix, { force: true });
  console.log(`Previous DB backed up to ${target} and removed.`);
}

const { db } = await import("../src/lib/server/db.ts");
const { createEvent, transitionEvent } = await import("../src/lib/server/andonService.ts");

const proc = async (line: string, name: string) =>
  ((await db.get("SELECT id FROM process WHERE line_code = ? AND name = ?", line, name)) as { id: number }).id;

interface Demo {
  line: string;
  process: string;
  category: string;
  desc: string;
  by: string;
  daysAgo: number;
  hour: number; // KST hour of occurrence
  ackMin?: number; // minutes until ACKNOWLEDGE
  actionMin?: number; // minutes until first ACTION
  closeMin?: number; // minutes until CLOSE
  responder?: string;
  actionNote?: string;
  closeNote?: string;
}

const Q = "품질 담당 A";
const Q2 = "품질 담당 B";
const M = "보전 담당";
const P = "생산 반장";
const L = "물류 담당";
const S = "안전 담당";

const demo: Demo[] = [
  { line: "TGDI1", process: "WCC Final Inspection", category: "QUALITY", desc: "Stay Bracket 체결 이상 발견", by: "김작업", daysAgo: 6, hour: 9, ackMin: 3, actionMin: 6, closeMin: 25, responder: Q, actionNote: "체결 토크 확인 중", closeNote: "체결 볼트 재체결, 동일 LOT 20EA 전수검사 OK" },
  { line: "TGDI1", process: "WCC Welding", category: "MAINTENANCE", desc: "용접 로봇 #2 알람 정지 (Wire feed error)", by: "박작업", daysAgo: 6, hour: 14, ackMin: 2, actionMin: 4, closeMin: 38, responder: M, actionNote: "와이어 피더 롤러 점검", closeNote: "피더 롤러 교체, 시험 용접 OK" },
  { line: "TGDI2", process: "Leak Test", category: "QUALITY", desc: "Leak Test NG 연속 3회 발생", by: "이작업", daysAgo: 5, hour: 10, ackMin: 4, actionMin: 7, closeMin: 52, responder: Q2, actionNote: "지그 실링 상태 확인", closeNote: "지그 O-ring 손상 → 교체, 마스터 샘플 검증 OK" },
  { line: "TGDI1", process: "WCC Canning", category: "MATERIAL", desc: "Mat 자재 결품 임박 (잔량 30EA)", by: "최작업", daysAgo: 5, hour: 15, ackMin: 6, closeMin: 20, responder: L, closeNote: "창고에서 2 Box 긴급 공급" },
  { line: "MUF1", process: "Pipe Bending", category: "PRODUCTION", desc: "벤딩 각도 셋업 변경 필요 (모델 교체)", by: "정작업", daysAgo: 5, hour: 16, ackMin: 5, closeMin: 18, responder: P, closeNote: "모델 교체 셋업 완료, 초품 확인 OK" },
  { line: "TGDI1", process: "WCC Final Inspection", category: "QUALITY", desc: "Stay Bracket 체결 이상 발견", by: "김작업", daysAgo: 4, hour: 11, ackMin: 2, actionMin: 5, closeMin: 31, responder: Q, actionNote: "체결 공구 토크값 확인", closeNote: "너트런너 토크 편차 → 보정, 재검사 OK" },
  { line: "TGDI2", process: "WCC Welding", category: "QUALITY", desc: "용접 비드 기공(Porosity) 발견", by: "한작업", daysAgo: 4, hour: 13, ackMin: 3, actionMin: 8, closeMin: 44, responder: Q2, actionNote: "가스 유량 점검", closeNote: "보호가스 유량 저하 → 레귤레이터 조정, 후속 10EA OK" },
  { line: "MUF1", process: "Muffler Welding", category: "SAFETY", desc: "용접 부스 차광막 파손", by: "오작업", daysAgo: 4, hour: 15, ackMin: 4, closeMin: 35, responder: S, closeNote: "차광막 교체 완료" },
  { line: "TGDI1", process: "Leak Test", category: "MAINTENANCE", desc: "Leak Tester 압력 센서 이상값", by: "박작업", daysAgo: 3, hour: 8, ackMin: 7, actionMin: 10, closeMin: 64, responder: M, actionNote: "센서 교정값 확인", closeNote: "압력 센서 교체 및 교정" },
  { line: "TGDI1", process: "WCC Final Inspection", category: "QUALITY", desc: "Stay Bracket 체결 이상 발견", by: "윤작업", daysAgo: 3, hour: 14, ackMin: 3, actionMin: 5, closeMin: 22, responder: Q, actionNote: "체결 볼트 LOT 확인", closeNote: "볼트 LOT 불량 의심 → 격리, 협력사 통보" },
  { line: "TGDI2", process: "WCC Canning", category: "PRODUCTION", desc: "작업자 결원으로 사이클 지연", by: "이작업", daysAgo: 3, hour: 16, ackMin: 2, closeMin: 15, responder: P, closeNote: "지원 인원 배치" },
  { line: "TGDI2", process: "WCC Final Inspection", category: "QUALITY", desc: "외관 스크래치 발견", by: "한작업", daysAgo: 2, hour: 9, ackMin: 5, actionMin: 8, closeMin: 27, responder: Q2, actionNote: "취급 공정 확인", closeNote: "이송 지그 보호패드 교체" },
  { line: "MUF1", process: "Final Inspection", category: "MATERIAL", desc: "포장 박스 결품", by: "정작업", daysAgo: 2, hour: 11, ackMin: 8, closeMin: 26, responder: L, closeNote: "포장재 긴급 입고" },
  { line: "TGDI1", process: "WCC Welding", category: "MAINTENANCE", desc: "용접 로봇 #2 알람 정지 (Wire feed error)", by: "박작업", daysAgo: 2, hour: 13, ackMin: 3, actionMin: 5, closeMin: 41, responder: M, actionNote: "피더 점검", closeNote: "와이어 라이너 교체" },
  { line: "TGDI2", process: "Leak Test", category: "QUALITY", desc: "Leak Test NG 연속 3회 발생", by: "이작업", daysAgo: 1, hour: 10, ackMin: 3, actionMin: 6, closeMin: 33, responder: Q2, actionNote: "지그 점검", closeNote: "실링 지그 청소 후 정상" },
  { line: "TGDI1", process: "Packing", category: "OTHER", desc: "라벨 프린터 용지 걸림", by: "최작업", daysAgo: 1, hour: 15, ackMin: 4, closeMin: 12, responder: L, closeNote: "용지 재장착" },
  { line: "MUF1", process: "Pipe Bending", category: "MAINTENANCE", desc: "벤딩기 유압 누유", by: "오작업", daysAgo: 1, hour: 17, ackMin: 6, actionMin: 9, closeMin: 70, responder: M, actionNote: "누유 부위 확인", closeNote: "유압 호스 교체" },
  // Today: some closed, one in progress, one open (so the board is not empty at demo start)
  { line: "TGDI2", process: "WCC Welding", category: "QUALITY", desc: "용접 비드 기공(Porosity) 발견", by: "한작업", daysAgo: 0, hour: -3, ackMin: 2, actionMin: 4, closeMin: 29, responder: Q2, actionNote: "가스 노즐 점검", closeNote: "노즐 스패터 제거" },
  { line: "MUF1", process: "Muffler Welding", category: "MATERIAL", desc: "End Cap 자재 결품 임박", by: "정작업", daysAgo: 0, hour: -1, ackMin: 3, actionMin: 5, responder: L, actionNote: "창고 재고 확인 중, 10분 내 공급 예정" },
  { line: "TGDI1", process: "WCC Final Inspection", category: "QUALITY", desc: "Stay Bracket 체결 이상 발견", by: "김작업", daysAgo: 0, hour: -0.1 },
];

let n = 0;
for (const d of demo) {
  // hour >= 0: KST clock hour on that day; hour < 0: hours before now (for "today" events)
  let t0: number;
  if (d.hour < 0) {
    t0 = Date.now() + d.hour * 3600_000;
  } else {
    const kst = new Date(Date.now() + 9 * 3600_000 - d.daysAgo * 86400_000);
    kst.setUTCHours(d.hour, Math.floor(Math.random() * 50), 0, 0);
    t0 = kst.getTime() - 9 * 3600_000;
  }
  const at = (min: number) => new Date(t0 + min * 60_000 + Math.floor(Math.random() * 50) * 1000).toISOString();

  const { event } = await createEvent({
    lineCode: d.line,
    processId: await proc(d.line, d.process),
    categoryCode: d.category,
    description: d.desc,
    createdBy: d.by,
    createdAt: new Date(t0).toISOString(),
  });
  if (d.ackMin != null) await transitionEvent(event.id, { action: "ACKNOWLEDGE", userName: d.responder!, at: at(d.ackMin) });
  if (d.actionMin != null) await transitionEvent(event.id, { action: "ACTION", userName: d.responder!, comment: d.actionNote, at: at(d.actionMin) });
  if (d.closeMin != null) await transitionEvent(event.id, { action: "CLOSE", userName: d.responder!, comment: d.closeNote, at: at(d.closeMin) });
  n++;
}
console.log(`Seeded ${n} demo ANDON events into ${(await db.info()).label}`);
