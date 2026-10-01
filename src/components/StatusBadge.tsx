import { STATUS_LABEL, signalColor, type AndonStatus } from "@/lib/domain";

export function StatusBadge({ status }: { status: AndonStatus }) {
  return (
    <span className={`badge badge-${signalColor(status)}`}>
      {STATUS_LABEL[status].ko} · {STATUS_LABEL[status].en}
    </span>
  );
}
