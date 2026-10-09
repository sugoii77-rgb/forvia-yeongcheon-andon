// Setup status of every employee account (/admin/setup, 2026-10-09): logged in yet, KakaoTalk linked, phone
// push (sound) turned on. For the plant's launch follow-up. Names and states only — no contact fields.
import type { SetupStatusPerson } from "../domain.ts";
import { db } from "./db.ts";
import { departmentLabelMap } from "./routingService.ts";

export async function listSetupStatus(): Promise<SetupStatusPerson[]> {
  const labels = await departmentLabelMap();
  const rows = await db.all(
    `SELECT u.id, u.name, u.department_code, u.team_leader, r.name_ko AS role_name, r.sort_order,
            (SELECT MAX(i.last_login_at) FROM user_identity i WHERE i.user_id = u.id) AS last_login,
            (SELECT MAX(s.last_seen_at) FROM user_session s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS last_seen,
            (SELECT MIN(c.created_at) FROM user_notification_channel c
              WHERE c.user_id = u.id AND c.provider = 'KAKAO' AND c.verified = 1 AND c.active = 1) AS kakao_at,
            (SELECT COUNT(*) FROM push_subscription p WHERE p.user_id = u.id) AS push_n,
            (SELECT MIN(p.created_at) FROM push_subscription p WHERE p.user_id = u.id) AS push_at
       FROM app_user u JOIN role r ON r.code = u.role
      WHERE u.active = 1
        AND EXISTS (SELECT 1 FROM user_identity i WHERE i.user_id = u.id)   -- accounts people can log in with
        AND COALESCE(u.email, '') NOT LIKE '%.test'                           -- automated test accounts
      ORDER BY u.department_code, r.sort_order DESC, u.name`,
  );
  return rows.map((r) => ({
    id: r.id as number,
    name: r.name as string,
    departmentCode: r.department_code as string,
    departmentLabel: labels.get(r.department_code as string) ?? (r.department_code as string),
    roleName: r.role_name as string,
    teamLeader: r.team_leader === 1,
    lastLoginAt: (r.last_login as string | null) ?? null,
    lastSeenAt: (r.last_seen as string | null) ?? null,
    kakaoLinkedAt: (r.kakao_at as string | null) ?? null,
    pushDevices: Number(r.push_n ?? 0),
    pushSince: (r.push_at as string | null) ?? null,
  }));
}
