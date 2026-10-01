// Stops the supervisor and the ANDON server (npm run stop). Safe to run when nothing is running.
// Only processes that are provably this project's are stopped — never other programs on the port.
import {
  PORT,
  SERVER_PID_FILE,
  SUPERVISOR_PID_FILE,
  commandLine,
  fetchHealth,
  isAlive,
  isOurServer,
  isPortOpen,
  killTree,
  portOwner,
  readPid,
  removePid,
  waitUntil,
} from "./lib/runtime.ts";

let stopped = 0;

// Supervisor first, so it cannot restart the server. /T also ends its child server.
const sup = readPid(SUPERVISOR_PID_FILE);
if (sup && isAlive(sup) && commandLine(sup).includes("supervisor")) {
  console.log(`stopping supervisor (PID ${sup})`);
  killTree(sup);
  await waitUntil(() => !isAlive(sup), 10_000);
  stopped++;
}
removePid(SUPERVISOR_PID_FILE);

const srv = readPid(SERVER_PID_FILE);
if (srv && isAlive(srv) && isOurServer(commandLine(srv))) {
  console.log(`stopping server (PID ${srv})`);
  killTree(srv);
  await waitUntil(() => !isAlive(srv), 10_000);
  stopped++;
}
removePid(SERVER_PID_FILE);

// Unmanaged server of this project still holding the port (e.g. started by hand)?
if (await isPortOpen(PORT)) {
  const owner = portOwner(PORT);
  const cmd = owner ? commandLine(owner) : "";
  if (owner && isOurServer(cmd, (await fetchHealth(3000)).body)) {
    console.log(`stopping unmanaged ANDON server on port ${PORT} (PID ${owner})`);
    killTree(owner);
    stopped++;
  } else if (owner) {
    console.log(`port ${PORT} is used by another program (PID ${owner}) — not touched: ${cmd}`);
  }
}

const free = await waitUntil(async () => !(await isPortOpen(PORT)), 10_000);
console.log(stopped ? `stopped ${stopped} process(es).` : "nothing was running.");
console.log(free ? `port ${PORT} is free.` : `WARNING: port ${PORT} is still in use.`);
process.exit(free ? 0 : 1);
