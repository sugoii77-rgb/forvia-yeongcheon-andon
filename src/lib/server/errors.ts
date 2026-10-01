/** Error with an HTTP status and a user-facing (Korean) message. */
export class AndonError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Who/what performed a change, captured from the HTTP request (see http.ts requestAudit). */
export interface AuditInfo {
  deviceId: string | null;
  clientIp: string | null;
  userAgent: string | null;
}
