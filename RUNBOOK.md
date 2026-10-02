# Digital ANDON — 운영 런북 (Operations Runbook)

서버 PC에서 **`C:\andon`** 폴더 기준. 명령은 PowerShell에서 실행합니다.
All commands are run in PowerShell inside `C:\andon`.

## 1. 상태 확인 · Check status

```powershell
cd C:\andon
npm run status
```

정상 (OK): `supervisor : running`, `server : running`, `health : OK`, 그리고 `"db":"C:\\andon\\data\\andon.db"`.

브라우저 확인: `http://<서버IP>:<PORT>/api/health` → `"ok":true`

## 2. 시작 · 중지 · 재시작 · Start / stop / restart

| 작업 | 자동 시작 등록된 경우 (scheduled task) | 수동 운영 (manual) |
|---|---|---|
| 시작 Start | `Start-ScheduledTask -TaskName "Digital ANDON"` | `npm run serve` (창을 닫지 마세요 / keep window open) |
| 중지 Stop | `Stop-ScheduledTask -TaskName "Digital ANDON"; npm run stop` | `npm run stop` |
| 재시작 Restart | 중지 후 시작 (stop, then start) | `npm run stop` → `npm run serve` |

- **항상 `npm run stop` 으로 중지하세요.** 작업 관리자에서 node.exe 를 임의로 종료하지 마세요.
  Always stop with `npm run stop` — it also removes leftover server processes.
- 서버가 죽으면 supervisor 가 **자동으로 재시작**합니다 (1–30초). 응답이 없으면 약 1분 내 자동 재시작.
  The supervisor restarts a crashed server within seconds and a hung server within about a minute.
- 빌드 파일(.next)이 없으면 시작 시 **자동으로 다시 빌드**합니다 (약 1분).

## 3. 장애 대응 순서 · When the dashboard shows "서버 연결 끊김"

1. `npm run status` 실행 → 결과 확인.
2. `supervisor : NOT running` → **2절의 "시작"** 실행.
3. `health : FAIL` 이 1분 이상 지속 → `npm run stop` 후 `npm run serve`.
4. 로그 확인: `data\logs\andon-YYYY-MM-DD.log` (마지막 50줄: `Get-Content data\logs\andon-*.log -Tail 50`).
5. `port … is used by another program` 로그 → 다른 프로그램이 포트 사용 중. `.env` 의 `PORT` 를 바꾸고 재시작
   (태블릿/모니터 주소도 함께 변경).
6. 그래도 안 되면: PC 재부팅. 자동 시작이 등록되어 있으면 서버는 스스로 올라옵니다.

데이터는 `data\` 폴더(andon.db, uploads)에 있으며 재시작/재부팅으로 사라지지 않습니다.
All data lives in `data\` and survives restarts and reboots.

## 4. 자동 시작 등록 (최초 1회) · Auto-start (one time)

관리자 PowerShell (Run as Administrator):

```powershell
cd C:\andon
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -AtStartup
Start-ScheduledTask -TaskName "Digital ANDON"
npm run status
```

- `-AtStartup`: PC 부팅 시 로그인 없이 시작 (권장 / recommended for the plant server).
- `-AtStartup` 없이 실행하면: 현재 사용자 로그인 시 시작 (관리자 권한 불필요).
- 미리보기 (no changes): `... install-autostart.ps1 -DryRun`
- 해제 (remove): `powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-autostart.ps1`

## 5. 백업 · Backup

```powershell
npm run backup        # → data\backups\andon-<시각>.db  (운영 중 실행 가능 / safe while running)
```

사진(`data\uploads`)은 아직 자동 백업되지 않습니다 — 필요 시 폴더째 복사. (Photos are not yet included.)

## 6. 회원가입 · 로그인 · Responder accounts

- **작업자(ANDON 호출)는 로그인 없이** 사용합니다. Operators never need to log in.
- **담당자는 본인이 회원가입** 합니다: `http://<서버IP>:<PORT>/register` → 이름, 이메일, 부서
  (ME · 생산기술 / MT · 보전 / UAP · 생산 / QC · 품질 / PC&L · 물류), 비밀번호(8자 이상, 영문+숫자).
  가입 즉시 해당 부서의 **담당자(RESPONDER)** 로 등록되어 그 부서 ANDON을 접수·조치·완료할 수 있습니다.
- GAP 리더 · 감독자 · 엔지니어 · 공장장 · 작업자 역할은 **관리자만** 지정합니다 (7절 `user role`).
- 알림 링크로 ANDON을 열면 로그인 후 바로 그 ANDON으로 돌아갑니다. 로그인은 7일간 유지됩니다.
- 비밀번호 분실: 관리자가 `user reset-password <이메일>` → 임시 비밀번호 전달.
- 퇴직/이동: `user deactivate <이메일>` (즉시 조치 불가). 부서 이동: `user dept <이메일> <부서>`.
- ⚠ 현재 공장 LAN은 HTTP 입니다. 공용 Wi-Fi에서 비밀번호가 노출될 수 있으니 다른 시스템과 같은 비밀번호를 쓰지 마세요.

**오류 메시지 · Error messages**

| 메시지 (code) | 의미 · Meaning | 조치 · Fix |
|---|---|---|
| 로그인이 필요합니다 (`AUTH_REQUIRED`) | 로그인하지 않음 / 세션 만료 | 로그인 |
| 이메일 또는 비밀번호가 올바르지 않습니다 (`INVALID_CREDENTIALS`) | 로그인 실패 | 다시 입력, 또는 비밀번호 재설정 |
| 로그인 실패가 많습니다 (`TOO_MANY_ATTEMPTS`) | 15분 내 5회 실패 | 15분 후 재시도 (서버 재시작 시 해제) |
| 비활성(사용 중지)된 계정 (`ACCOUNT_INACTIVE` / `INACTIVE_RESPONDER`) | 관리자가 비활성화 | 필요 시 `user activate <이메일>` |
| 이미 가입된 이메일 (`EMAIL_TAKEN`) | 같은 이메일 계정 있음 | 로그인 또는 비밀번호 재설정 |
| 조치 권한이 없는 역할 (`ROLE_NOT_ALLOWED`) | 작업자(OPERATOR) 역할 | `user role <이메일> RESPONDER` |
| 담당 부서 소속이 아닙니다 (`WRONG_DEPARTMENT`) | 이 ANDON의 담당 부서가 아님 | 해당 부서 담당자가 조치 / 라우팅 확인 |
| 담당자 정보가 로그인 사용자와 다릅니다 (`RESPONDER_MISMATCH`) | 요청에 다른 사용자 정보 | 화면 새로고침 후 다시 |

## 7. 기준정보 관리 · Master data (users, routing)

서버 실행 중에도 가능 (관리자 전용). `<user>` = 사용자 ID, 로컬 로그인 이메일, 또는 `emp:<사번>`. 사용자는 **삭제하지 말고 비활성화**하세요 (이력 보존).
Works while the server runs. Never delete users — deactivate them (history must stay intact).

```powershell
npm run masterdata -- list                                   # 전체 조회 (users, roles, routing rules …)
npm run masterdata -- user role hong@example.com GAP_LEADER   # 역할 지정 (관리자만)
npm run masterdata -- user dept hong@example.com MT           # 부서 변경 (ME, MT, UAP, QC, PCL)
npm run masterdata -- user deactivate hong@example.com        # 비활성화 (퇴직/이동) — 즉시 적용
npm run masterdata -- user activate 12
npm run masterdata -- user reset-password hong@example.com    # 임시 비밀번호 1회 표시, 기존 로그인 종료
npm run masterdata -- user add "T-GDI 2 작업자" UAP OPERATOR  # 로그인 없는 계정 (데모/작업자)
npm run masterdata -- user deactivate-test-accounts        # 테스트 계정(*@andon.test) 정리
npm run masterdata -- user employee-id hong@example.com A1234   # 사번 지정 (한 번 지정하면 변경 불가)
npm run masterdata -- user unlink-google emp:A1234         # Google 로그인 연결 해제 (분실 등), 로그인 종료
npm run masterdata -- route add OTHER TGDI1 5 PCL "포장 라벨은 물류"   # 공정별 라우팅 규칙
npm run masterdata -- route add MATERIAL MUF1 UAP            # 라인별 라우팅 규칙
npm run masterdata -- route deactivate 3
npm run masterdata -- category default SAFETY UAP            # 유형 기본 담당 부서
npm run masterdata -- lines                                  # 라인별 감독자 · A/B조 GAP 리더 (이름만)
npm run masterdata -- assign add AP1-MAIN1 SUPERVISOR 12     # 감독자 변경 (이전 배정은 종료, 이력 보존)
npm run masterdata -- assign add AP1-MAIN1 GAP_LEADER A 15   # A조 GAP 리더 변경
npm run masterdata -- assign end 40                          # 배정 종료
npm run masterdata -- user set-login 12 hong@example.com     # 워크북으로 등록된 사람에게 로그인 부여 (재가입 금지: 중복 생성됨)
```

**라인 · 담당자 일괄 반영 (워크북)** — 워크북은 개인정보가 있으므로 저장소에 넣지 마세요.

```powershell
npm run import:uap -- "C:\Users\<사용자>\Downloads\모바일 안돈시스템(261001) QC.xlsx" --dry-run   # 미리보기 (저장 안 함)
npm run import:uap -- "C:\Users\<사용자>\Downloads\모바일 안돈시스템(261001) QC.xlsx"             # 반영
```

- 두 시트(개인정보, UAP(Line 구분))를 교차 확인합니다. 감독자 · 라인 · 구역이 다르면 **반영하지 않습니다**.
  GAP 리더가 개인정보 시트에 더 넓게 적힌 경우는 경고로 표시하고 UAP 시트(라인별)를 따릅니다.
- 연락처 · 사번 · Google/카카오 ID · 이메일은 읽지 않습니다. 같은 사람은 한 번만 등록됩니다. 다시 실행해도 안전합니다.
- 라인 이름은 워크북 표기와 정확히 같아야 합니다(`npm run masterdata -- list` 의 line 표).
- A/B 조 근무 시간이 정해지지 않아 "현재 근무조" GAP 리더는 아직 자동으로 정하지 않습니다.
- 라인 담당(감독자/GAP 리더)은 **책임 부서와 별개**입니다. 책임 부서는 이상 유형 · 라우팅 규칙으로 정해집니다.

- 부서 Departments: `ME` 생산기술, `MT` 보전, `UAP` 생산, `QC` 품질, `PCL` (표시 PC&L) 물류.
  이전 코드(QUALITY 등)는 비활성 상태로 이력에만 남아 있습니다.
- **유형(Category) ≠ 부서(Department)**: 유형 = 무슨 문제, 부서 = 누가 담당. 라우팅이 유형 → 부서를 정합니다.
- 역할 Roles: `OPERATOR` (호출만), `RESPONDER` (가입 시 기본), `GAP_LEADER`, `SUPERVISOR`, `ENGINEER`, `PLANT_MANAGER`.
- 라우팅: **공정별 규칙 > 라인별 규칙 > 유형 기본값**. 변경은 **새 ANDON부터** 적용됩니다.
- 공정 ID 는 `list` 의 `process` 표에서 확인.
- 에스컬레이션 표(`escalation_step`)는 준비만 되어 있고 **아직 동작하지 않습니다**.

## 8. 최초 설치 체크리스트 · First-time setup on a new PC

- [ ] Node.js 24 설치 (`node --version` → v24.x)
- [ ] `C:\andon` 에 프로젝트 복사 후 `npm install`
- [ ] `.env` 생성 (`copy .env.example .env`) → `PORT`, `APP_BASE_URL=http://<서버IP>:<PORT>` 설정
- [ ] 서버 IP 고정 (static IP or DHCP reservation)
- [ ] Windows 방화벽에서 node.exe / `PORT` 인바운드 허용 (inbound firewall rule)
- [ ] `npm run build` → `npm run serve` → 휴대폰에서 `http://<서버IP>:<PORT>/operator` 접속 확인
- [ ] 자동 시작 등록 (4절)
- [ ] 현황판 모니터: 브라우저 전체화면(F11), 화면 보호기/절전 해제

## 9. Google 로그인 설정 · Google sign-in setup (선택 / optional)

Google 로그인은 **추가** 로그인 방식입니다. 설정하지 않으면 버튼이 보이지 않고 로컬 로그인만 사용됩니다.

1. Google Cloud Console → *APIs & Services* → *OAuth consent screen* 설정 → *Credentials* →
   **Create OAuth client ID** → 유형 **Web application**.
2. **Authorized redirect URI** 에 정확히 입력:
   - 이 PC에서 시험: `http://localhost:3100/api/auth/google/callback`
   - 공장 휴대폰용: `https://<서버 HTTPS 주소>/api/auth/google/callback`
     (Google은 localhost 외에는 **HTTPS만** 허용합니다.)
3. 서버의 `C:andon.env` 에만 입력 (git에 올라가지 않음, 채팅/메일로 보내지 마세요):
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_REDIRECT_URI=http://localhost:3100/api/auth/google/callback
   ```
   HTTPS 운영 시 `COOKIE_SECURE=true` 도 설정.
4. `npm run stop` → `npm run serve` (재시작) → `/login` 에 "Google로 로그인" 버튼이 보이면 설정 완료.

- 사용자는 **같은 주소**(redirect URI의 주소)로 접속해야 합니다 (예: localhost 설정이면 localhost로 접속).
- 처음 Google로 로그인한 사람은 **직원 정보 등록**(사번, 이름, 부서, 휴대전화, 카카오톡 ID)을 합니다 → 담당자(RESPONDER).
- 기존 로컬 계정 사용자는 로그인 후 **내 정보 → 비밀번호 확인 → Google 계정 연결**.
  Google 이메일이 같아도 자동 연결되지 않습니다.
- 카카오톡 ID는 연락 참고용이며 알림 발송 주소로 사용되지 않습니다.

## 10. Vercel 클라우드 데모 · Cloud demo on Vercel

주소: https://forvia-yeongcheon-andon.vercel.app  (공장 서버와 **별개**의 DB · 사진 저장소를 사용합니다)

- **배포:** GitHub `main` 에 push 하면 자동 배포. 상태 확인: `vercel ls`, `https://forvia-yeongcheon-andon.vercel.app/api/health` → `"backend":"remote"`.
- **DB 스키마 변경이 있는 커밋은 push 전에 먼저:**
  ```powershell
  vercel env run -e production -- npm run db:migrate
  ```
- **데모 데이터 추가:** `vercel env run -e production -- npm run seed` (`--reset` 은 Turso에서 거부됨).
- **절대 금지:** `C:\andon` 에서 `vercel env pull` 실행 — `.env.local` 에 Turso 접속정보가 생기면 공장 서버가 클라우드 DB를 쓰게 됩니다.
  실수로 생겼다면 `.env.local` 삭제 후 `npm run stop` → `npm run serve`.
- 제약: Hobby 요금제(비상업용), 공개 주소 · 누구나 회원가입 가능, 현황판 2초 폴링 비용, 미국 동부 서버(응답 ~0.6초). 자세한 내용 PROJECT.md §12.

## 11. 근무조 (A/B) · Shift schedule

영천 UAP 확정 규칙 (2026-10-02):

- 12시간 2교대: **주간 08:00–20:00, 야간 20:00–08:00** (시간대 **Asia/Seoul**)
- A조 / B조가 **매주** 주간·야간을 바꿉니다. 바뀌는 시점은 **월요일 08:00** 주간 근무 시작입니다.
  월요일 00:00–07:59 는 아직 **전주 일요일 야간** 근무입니다 (근무는 시작 시각 기준으로 날짜/주를 정함).
- 어느 조가 주간인지 계산하려면 **기준(anchor) 한 가지**가 필요합니다: "어떤 주(월요일)에 어느 조가 주간이었는지".
  **기준이 설정되기 전에는 자동 A/B 판정이 유효하지 않으며**, 시스템은 A/B를 임의로 고르지 않습니다
  (`SHIFT_SCHEDULE_NOT_ANCHORED`). ANDON 호출은 그대로 동작하고 근무조만 '미확정'으로 기록됩니다.

```powershell
npm run masterdata -- shift show                      # 규칙, 기준, 현재 근무조, 변경 이력
npm run masterdata -- shift anchor <월요일 YYYY-MM-DD> <A|B>   # UAP가 확인한 값만 입력 (그 주의 월요일 + 그 주 주간 조)
```

- 화면: `/admin/shifts` — 보기: GAP 리더 · 감독자 · 엔지니어 · 공장장 / 변경: 감독자 · 공장장.
- 모든 변경은 이력(누가, 언제, 이전 값, 새 값)에 남고 지울 수 없습니다. 기존 ANDON 기록은 바뀌지 않습니다.
- 로컬 공장 서버와 클라우드(Vercel/Turso)는 DB가 따로이므로 **양쪽에 각각** 입력합니다.
- 근무조(담당자: GAP 리더 · 감독자)는 **책임 부서와 별개**입니다. 알림 발송은 아직 없습니다.
