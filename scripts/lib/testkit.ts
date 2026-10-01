// Shared helpers for the API test scripts (test-golden-path, test-reliability, test-routing, test-auth).
//
// Since Milestone 2B every responder action requires a logged-in session. Tests therefore register
// their own throw-away accounts: e-mail *@andon.test, random password that is never stored or printed.
// Administrator steps (role change, deactivation) use the masterdata CLI against the local database,
// so these tests must run on the server PC. At the end, finish() deactivates all *@andon.test accounts.
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUN = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;

let failures = 0;
export function check(cond: unknown, label: string) {
  if (cond) console.log(`  ✔ ${label}`);
  else {
    failures++;
    console.log(`  ✖ ${label}`);
  }
}

/** A browser-like client: keeps its own session cookie and device id. */
export class Client {
  cookie: string | null = null;
  readonly device: string;
  readonly label: string;
  constructor(label = "client") {
    this.label = label;
    this.device = `dev-test-${RUN}-${label}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  }
  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "x-andon-device": this.device,
      "user-agent": `andon-test/${this.label}`,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    };
  }
  async request(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: this.headers(isForm || body === undefined ? extraHeaders : { "Content-Type": "application/json", ...extraHeaders }),
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) {
      const pair = c.split(";")[0];
      if (pair.startsWith("andon_session=")) this.cookie = /Max-Age=0/i.test(c) || pair === "andon_session=" ? null : pair;
    }
    const text = await res.text();
    let json: Record<string, unknown> & { [k: string]: any } = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, raw: text, setCookie };
  }
}

let seq = 0;
export interface TestAccount {
  client: Client;
  email: string;
  password: string;
  name: string;
  id: number;
  department: string;
}

/** Registers a new RESPONDER of `department` and returns a logged-in client. */
export async function registerAccount(department: string, label = department): Promise<TestAccount> {
  seq++;
  const email = `t-${RUN}-${label.toLowerCase().replace(/[^a-z0-9]/g, "")}-${seq}@andon.test`;
  const password = `T${crypto.randomBytes(9).toString("base64url")}9a`;
  const name = `[TEST] ${label} ${seq}`;
  const client = new Client(`${label}${seq}`);
  const r = await client.request("POST", "/api/auth/register", { name, email, department, password, passwordConfirm: password });
  if (r.status !== 201) throw new Error(`registration failed (${r.status}): ${r.raw}`);
  return { client, email, password, name, id: r.body.user.id, department };
}

/** Administrator action via the masterdata CLI (local database). */
export function admin(...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(process.execPath, ["scripts/masterdata.ts", ...args], { cwd: ROOT, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}` };
}

const meta = { processes: null as null | { id: number; lineCode: string; name: string }[] };
export async function processId(line: string, name: string): Promise<number> {
  meta.processes ??= (await fetch(`${BASE}/api/meta`).then((r) => r.json())).processes;
  const p = meta.processes!.find((x) => x.lineCode === line && x.name === name);
  if (!p) throw new Error(`process ${line}/${name} not found`);
  return p.id;
}

/** Operator ANDON call (no login needed). */
export async function createAndon(
  line: string,
  process: string,
  category: string,
  description: string,
  client = new Client("operator"),
  photo?: Blob,
) {
  const f = new FormData();
  f.set("lineCode", line);
  f.set("processId", String(await processId(line, process)));
  f.set("categoryCode", category);
  f.set("description", description);
  f.set("createdBy", "test-operator");
  f.set("clientRequestId", `t-${RUN}-${Date.now()}-${Math.random()}`);
  if (photo) f.set("photo", photo, "photo");
  return client.request("POST", "/api/andons", f);
}

export const detail = (id: string, client = new Client("viewer")) => client.request("GET", `/api/andons/${id}`);

export function transition(client: Client, id: string, action: string, comment?: string, extra: Record<string, unknown> = {}) {
  return client.request("POST", `/api/andons/${id}/transition`, { action, comment, ...extra });
}

/** Deactivate this machine's *@andon.test accounts, print the summary, exit with the result. */
export function finish(): never {
  const r = admin("user", "deactivate-test-accounts");
  if (!r.ok) console.log(`  (could not deactivate test accounts: ${r.out.trim()})`);
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
