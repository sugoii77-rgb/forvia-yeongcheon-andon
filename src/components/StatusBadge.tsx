"use client";
import { STATUS_LABEL, signalColor, type AndonStatus } from "@/lib/domain";
import { useLang } from "@/lib/i18n";

export function StatusBadge({ status }: { status: AndonStatus }) {
  const lang = useLang();
  return (
    <span className={`badge badge-${signalColor(status)}`}>
      {lang === "en" ? STATUS_LABEL[status].en : `${STATUS_LABEL[status].ko} · ${STATUS_LABEL[status].en}`}
    </span>
  );
}
