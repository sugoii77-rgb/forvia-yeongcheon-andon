"use client";
// KR / EN screen language (2026-11-01: visitors from the BG / R&D who read no Korean). Per browser, in the
// cookie andon_lang (also readable by the server later); default Korean. Texts are
// written in place as pairs — t("현황판", "Dashboard") — so each screen keeps both languages side by side.
// Data typed by people (descriptions, action comments, names) is shown as entered.
import { useCallback, useEffect, useSyncExternalStore } from "react";

export type Lang = "ko" | "en";
const COOKIE = "andon_lang";
const listeners = new Set<() => void>();

export function currentLang(): Lang {
  return typeof document === "undefined" ? "ko" : readLang();
}

function readLang(): Lang {
  const m = document.cookie.match(/(?:^|;\s*)andon_lang=(ko|en)/);
  // Korean unless the person chose EN (plant 2026-11-01: GAP leaders must never find an English screen)
  return m ? (m[1] as Lang) : "ko";
}

export function setLang(lang: Lang) {
  document.cookie = `${COOKIE}=${lang}; path=/; max-age=${400 * 86400}; samesite=lax`;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** Current language; "ko" while rendering on the server and during hydration. */
export function useLang(): Lang {
  const lang = useSyncExternalStore(subscribe, readLang, () => "ko" as Lang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return lang;
}

export type T = (ko: string, en: string) => string;

/** t("한국어", "English") → the text in the current language. */
export function useT(): T {
  const lang = useLang();
  return useCallback((ko: string, en: string) => (lang === "en" ? en : ko), [lang]);
}

// ---- master data in English (codes are stable; names come from the server in Korean)

const CATEGORY_EN: Record<string, string> = {
  QUALITY: "Quality",
  MAINTENANCE: "Maintenance",
  PRODUCTION: "Production",
  MATERIAL: "Material / Logistics",
  SAFETY: "Safety",
  OTHER: "Other",
};
export const categoryName = (lang: Lang, code: string, ko: string) => (lang === "en" ? (CATEGORY_EN[code] ?? ko) : ko);
const CATEGORY_BY_KO: Record<string, string> = { 품질: "Quality", 설비: "Maintenance", 생산: "Production", "자재/물류": "Material / Logistics", 안전: "Safety", 기타: "Other" };
/** For data that carries only the (Korean) category name, e.g. the statistics. */
export const categoryNameByKo = (lang: Lang, ko: string) => (lang === "en" ? (CATEGORY_BY_KO[ko] ?? ko) : ko);

const DEPT_EN: Record<string, string> = {
  ME: "Manufacturing Eng.",
  MT: "Maintenance",
  UAP: "Production",
  QC: "Quality",
  PCL: "Logistics",
  "PC&L": "Logistics",
  HSE: "Safety",
  FES: "FES",
};
/** "QC · 품질, MT · 보전" → "QC · Quality, MT · Maintenance" (unknown Korean parts are dropped, the code stays). */
export function departmentLabel(lang: Lang, label: string): string {
  if (lang !== "en" || !label) return label;
  return label
    .split(/,\s*/)
    .map((part) => {
      const code = part.split(" · ")[0].trim();
      return DEPT_EN[code] ? `${code} · ${DEPT_EN[code]}` : code.replace(/[가-힣]+/g, "").trim() || part;
    })
    .join(", ");
}

const ROLE_EN: Record<string, string> = {
  OPERATOR: "Viewer / Operator",
  RESPONDER: "Responder",
  GAP_LEADER: "GAP Leader",
  SUPERVISOR: "Supervisor",
  ENGINEER: "Engineer",
  PLANT_MANAGER: "Plant Manager",
};
export const roleName = (lang: Lang, code: string, ko: string) => (lang === "en" ? (ROLE_EN[code] ?? code) : ko);

/** Server error messages are Korean; the common ones by code in English. */
const ERROR_EN: Record<string, string> = {
  INVALID_CREDENTIALS: "Wrong login ID (employee no. / e-mail) or password.",
  ACCOUNT_INACTIVE: "This account is deactivated. Please contact the administrator.",
  AUTH_REQUIRED: "Please log in.",
  TOO_MANY_ATTEMPTS: "Too many failed attempts. Please wait a few minutes and try again.",
  TIMEOUT: "The server did not answer in time. Please check the network.",
  NETWORK: "Cannot reach the server. Please check the network.",
  INVALID_PASSWORD: "Password: 8–128 characters with letters and numbers.",
  WRONG_CURRENT_PASSWORD: "The current password is not correct.",
  PASSWORD_MISMATCH: "The two new passwords do not match.",
  SAME_PASSWORD: "The new password must differ from the current one.",
  NO_LOCAL_LOGIN: "This account has no password login.",
  ROLE_NOT_ALLOWED: "Your account cannot do this (view-only or other role).",
  CONFLICT: "This ANDON has already moved on — the screen will refresh.",
  INVALID_ACTION: "This step is not possible in the current state.",
  COMMENT_REQUIRED: "Please describe the action taken.",
  COMMENT_TOO_LONG: "The comment is too long.",
  DESCRIPTION_REQUIRED: "Please describe the problem.",
  BAD_ORIGIN: "Request blocked (wrong origin). Reload the page.",
  NOT_FOUND: "Not found.",
};
export const errorText = (lang: Lang, code: string | undefined, ko: string) => (lang === "en" && code && ERROR_EN[code]) || ko;

/** "KR | EN" switch. */
export function LangToggle({ className }: { className?: string }) {
  const lang = useLang();
  return (
    <span className={`lang-toggle${className ? ` ${className}` : ""}`} role="group" aria-label="Language">
      <button type="button" className={lang === "ko" ? "on" : ""} aria-pressed={lang === "ko"} onClick={() => setLang("ko")}>
        KR
      </button>
      <button type="button" className={lang === "en" ? "on" : ""} aria-pressed={lang === "en"} onClick={() => setLang("en")}>
        EN
      </button>
    </span>
  );
}
