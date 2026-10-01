"use client";
// Browser-side helpers shared by all screens.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

const DEVICE_KEY = "andon.device.id";
let memoryDeviceId: string | null = null;

/**
 * Persistent random id of this browser/device, created on first use and kept in localStorage.
 * Sent with every request (header x-andon-device) and recorded in the ANDON history.
 * Not an authentication mechanism: clearing browser data creates a new id.
 */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = `dev-${newRequestId()}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    memoryDeviceId ??= `dev-${newRequestId()}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    return memoryDeviceId;
  }
}

/** fetch + JSON with a timeout and Korean error messages. Network failures become status 0. */
export async function api<T>(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("x-andon-device", deviceId());
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, signal: ctrl.signal, cache: "no-store" });
  } catch (err) {
    const timeout = (err as Error)?.name === "AbortError";
    throw new ApiError(
      timeout ? "서버 응답 시간 초과 (timeout). 네트워크를 확인하세요." : "서버에 연결할 수 없습니다. 네트워크를 확인하세요.",
      0,
      timeout ? "TIMEOUT" : "NETWORK",
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(body?.error ?? `서버 오류 (HTTP ${res.status})`, res.status, body?.code);
  }
  return body as T;
}

/** crypto.randomUUID only exists on HTTPS/localhost; plant LAN may be plain HTTP. */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const kstTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const kstDateTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const fmtTime = (iso: string | null) => (iso ? kstTime.format(new Date(iso)) : "-");
export const fmtDateTime = (iso: string | null) => (iso ? kstDateTime.format(new Date(iso)) : "-");

/** 125 → "02:05", 3725 → "1:02:05" */
export function fmtDuration(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "-";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(r).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Human readable duration for stats: "4분 30초", "1시간 5분". */
export function fmtDurationKo(sec: number | null): string {
  if (sec == null) return "-";
  const s = Math.round(sec);
  if (s < 60) return `${s}초`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분 ${s % 60}초`;
}

/** Ticks every second; returns "server now" in ms, corrected by the last known server clock offset. */
export function useServerNow(offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now + offsetMs;
}

export interface PollState<T> {
  data: T | null;
  error: string | null;
  lastSuccess: number | null;
  /** serverTime - clientTime, if the response carries `serverTime`. */
  clockOffsetMs: number;
  refresh: () => void;
}

/** Polls `url` every `intervalMs`. Keeps the last good data when a poll fails. */
export function usePolling<T>(url: string | null, intervalMs: number): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccess, setLastSuccess] = useState<number | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (!url || inFlight.current) return;
    inFlight.current = true;
    try {
      const body = await api<T & { serverTime?: string }>(url, {}, 8000);
      setData(body);
      setError(null);
      setLastSuccess(Date.now());
      if (body && typeof body === "object" && body.serverTime) {
        setClockOffsetMs(new Date(body.serverTime).getTime() - Date.now());
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      inFlight.current = false;
    }
  }, [url]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, intervalMs]);

  return { data, error, lastSuccess, clockOffsetMs, refresh: load };
}

// ---- small localStorage-backed store (falls back to memory if storage is blocked)
const memoryStore: Record<string, string> = {};
const storeListeners = new Set<() => void>();

function readStored(key: string): string | null {
  try {
    const v = localStorage.getItem(key);
    if (v != null) return v;
  } catch {}
  return memoryStore[key] ?? null;
}

function subscribeStored(cb: () => void) {
  storeListeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    storeListeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

/** State persisted per device (for "who am I" and operator station defaults). */
export function useStoredState(key: string, initial: string): [string, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribeStored,
    () => readStored(key) ?? initial,
    () => initial,
  );
  const set = useCallback(
    (v: string) => {
      memoryStore[key] = v;
      try {
        localStorage.setItem(key, v);
      } catch {}
      storeListeners.forEach((l) => l());
    },
    [key],
  );
  return [value, set];
}
