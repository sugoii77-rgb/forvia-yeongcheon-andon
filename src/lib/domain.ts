// ANDON domain model: statuses, actions and the state machine.
// This file has no dependencies so it can be used by both server and client code.

export const STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "CLOSED"] as const;
export type AndonStatus = (typeof STATUSES)[number];

export const ACTIVE_STATUSES: AndonStatus[] = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS"];

/** Signal colour shown on boards. ACKNOWLEDGED and IN_PROGRESS are both YELLOW. */
export type SignalColor = "RED" | "YELLOW" | "GREEN";

export function signalColor(status: AndonStatus): SignalColor {
  if (status === "OPEN") return "RED";
  if (status === "CLOSED") return "GREEN";
  return "YELLOW";
}

export const STATUS_LABEL: Record<AndonStatus, { ko: string; en: string }> = {
  OPEN: { ko: "발생", en: "OPEN" },
  ACKNOWLEDGED: { ko: "접수", en: "ACKNOWLEDGED" },
  IN_PROGRESS: { ko: "조치중", en: "IN PROGRESS" },
  CLOSED: { ko: "완료", en: "CLOSED" },
};

/**
 * User-triggered actions. CREATE is recorded as the first transition of every event.
 * ACTION records a corrective-action note and moves the event to IN_PROGRESS
 * (it may be repeated while IN_PROGRESS; each note is a separate history row).
 */
export const TRANSITION_ACTIONS = ["ACKNOWLEDGE", "ACTION", "CLOSE"] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];
export type HistoryAction = "CREATE" | TransitionAction;

interface TransitionRule {
  from: AndonStatus[];
  to: AndonStatus;
  commentRequired: boolean;
}

export const TRANSITION_RULES: Record<TransitionAction, TransitionRule> = {
  ACKNOWLEDGE: { from: ["OPEN"], to: "ACKNOWLEDGED", commentRequired: false },
  ACTION: { from: ["ACKNOWLEDGED", "IN_PROGRESS"], to: "IN_PROGRESS", commentRequired: true },
  CLOSE: { from: ["ACKNOWLEDGED", "IN_PROGRESS"], to: "CLOSED", commentRequired: true },
};

export function allowedActions(status: AndonStatus): TransitionAction[] {
  return TRANSITION_ACTIONS.filter((a) => TRANSITION_RULES[a].from.includes(status));
}

// ---- Organisation ----

/**
 * Role codes. Stored in the `role` table (configurable names / flags); the codes are referenced by
 * the future escalation model, so they are fixed here.
 *   OPERATOR       creates ANDONs, cannot ACK/ACTION/CLOSE
 *   RESPONDER      first responder of a department (receives the initial notification)
 *   GAP_LEADER     escalation level 1 (prepared, not active)
 *   SUPERVISOR     escalation level 2 (prepared, not active)
 *   ENGINEER       escalation level 2 (prepared, not active)
 *   PLANT_MANAGER  escalation level 3 (prepared, not active)
 */
export const ROLE_CODES = ["OPERATOR", "RESPONDER", "GAP_LEADER", "SUPERVISOR", "ENGINEER", "PLANT_MANAGER"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

/**
 * Operational departments (WHO is responsible). Not the same as issue categories (WHAT happened):
 * routing maps Line + Process + Category → Department (see src/lib/routing.ts).
 * Codes are stable identifiers; `displayCode` is what users see ("PC&L" for code PCL).
 */
export const DEPARTMENT_CODES = ["ME", "MT", "UAP", "QC", "PCL"] as const;

/** Roles a person may self-register with. Everything else is assigned by an administrator. */
export const SELF_REGISTRATION_ROLE: RoleCode = "RESPONDER";

/** Public view of a user — never contains password hashes or session data. */
export interface PublicUser {
  id: number;
  employeeId: string | null;
  googleLinked: boolean;
  name: string;
  email: string | null;
  departmentCode: string;
  /** e.g. "PC&L · 물류" */
  departmentLabel: string;
  role: RoleCode;
  roleName: string;
  active: boolean;
  canRespond: boolean;
}

/** How the responsible department of an event was determined (see src/lib/routing.ts). */
export type RoutingMatch = "LINE_PROCESS_CATEGORY" | "LINE_CATEGORY" | "CATEGORY_DEFAULT";

// ---- Shapes returned by the API ----

export interface AndonEvent {
  id: string;
  plant: string;
  lineCode: string;
  lineName: string;
  processId: number;
  processName: string;
  categoryCode: string;
  categoryName: string;
  departmentCode: string;
  departmentName: string;
  /** "QC · 품질"; for events routed before the department change: the old code, e.g. "QUALITY · 품질" */
  departmentLabel: string;
  description: string;
  photoFile: string | null;
  status: AndonStatus;
  createdBy: string;
  createdAt: string; // ISO-8601 UTC
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  closedAt: string | null;
  closedBy: string | null;
  correctiveAction: string | null;
  updatedAt: string;
}

export interface AndonTransition {
  id: number;
  eventId: string;
  action: HistoryAction;
  fromStatus: AndonStatus | null;
  toStatus: AndonStatus;
  userName: string;
  /** Master-data user (null for CREATE by an operator without an account, and for pre-v2 history). */
  userId: number | null;
  /** Department / role of the user at the time of the action (null before schema v3). */
  userDepartment: string | null;
  /** e.g. "PC&L · 물류" (display only) */
  userDepartmentLabel: string | null;
  userRole: string | null;
  comment: string | null;
  createdAt: string;
  /** Per-device id generated by the browser (localStorage), null if not sent. */
  deviceId: string | null;
  /** Client IP as reported to the server (not authenticated). */
  clientIp: string | null;
  userAgent: string | null;
}

export interface Responsibility {
  /** Department stored on the event (may be a pre-v3 code). */
  departmentCode: string;
  /** Current operational department that handles it (follows department.successor_code). */
  effectiveDepartmentCode: string;
  departmentName: string;
  departmentLabel: string;
  matchedBy: RoutingMatch;
  routingRuleId: number | null;
}

export interface ResponderSummary {
  id: number;
  name: string;
  role: RoleCode;
  departmentCode: string;
}

export interface NotificationLogEntry {
  id: number;
  eventId: string;
  provider: string;
  recipient: string;
  status: "SENT" | "FAILED";
  message: string;
  error: string | null;
  createdAt: string;
}

export interface MasterData {
  plant: string;
  plants: { code: string; name: string; nameKo: string }[];
  lines: { code: string; name: string; plantCode: string }[];
  processes: { id: number; lineCode: string; name: string }[];
  categories: { code: string; nameKo: string; nameEn: string; defaultDepartment: string }[];
  /** Active operational departments, in display order. */
  departments: { code: string; displayCode: string; label: string; nameKo: string; nameEn: string }[];
  roles: { code: RoleCode; nameKo: string; nameEn: string; canRespond: boolean; escalationLevel: number | null }[];
}
