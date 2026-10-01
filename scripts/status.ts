// Shows whether the ANDON server is running and healthy (npm run status).
import fs from "node:fs";
import {
  HEALTH_URL,
  SERVER_PID_FILE,
  SUPERVISOR_PID_FILE,
  fetchHealth,
  isAlive,
  logFile,
  readPid,
} from "./lib/runtime.ts";

const sup = readPid(SUPERVISOR_PID_FILE);
const srv = readPid(SERVER_PID_FILE);
const health = await fetchHealth(5000);

console.log(`supervisor : ${sup && isAlive(sup) ? `running (PID ${sup})` : "NOT running"}`);
console.log(`server     : ${srv && isAlive(srv) ? `running (PID ${srv})` : "NOT running"}`);
console.log(`health     : ${health.ok ? "OK" : "FAIL"}  ${HEALTH_URL}`);
console.log(`             ${JSON.stringify(health.body)}`);

const file = logFile();
if (fs.existsSync(file)) {
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
  console.log(`\nlast log lines (${file}):`);
  for (const l of lines.slice(-10)) console.log("  " + l);
}
process.exit(health.ok ? 0 : 1);
