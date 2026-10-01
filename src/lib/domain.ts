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
  comment: string | null;
  createdAt: string;
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
  lines: { code: string; name: string }[];
  processes: { id: number; lineCode: string; name: string }[];
  categories: { code: string; nameKo: string; nameEn: string; defaultDepartment: string }[];
  departments: { code: string; nameKo: string; nameEn: string }[];
  users: { id: number; name: string; departmentCode: string; role: string }[];
}
