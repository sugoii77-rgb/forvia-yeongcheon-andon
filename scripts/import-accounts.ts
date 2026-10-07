// npm run import:accounts -- <accounts.xlsx|.csv> [--dry-run] [--allow-remote]
//
// Login accounts from the plant's list (GAP leaders, SV, MT, PC&L, …): name, department, position, login
// e-mail. SV / GL get their login on the employee record of the line-ownership import (so "my lines"
// works); others are matched by name + department or created. See scripts/lib/account-import.ts.
// Temporary passwords are written to work/accounts/temp-passwords-<time>.csv — never printed. Hand them
// over individually and delete the file afterwards. The file itself stays outside the repository.
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!file || !fs.existsSync(file)) {
  console.error("usage: npm run import:accounts -- <accounts.xlsx|.csv> [--dry-run] [--allow-remote]");
  process.exit(2);
}
const { readAccountFile, importAccounts, writeCredentials } = await import("./lib/account-import.ts");
const { db, REMOTE_DATABASE_URL } = await import("../src/lib/server/db.ts");
if (REMOTE_DATABASE_URL && !args.includes("--allow-remote")) {
  console.error("Refusing to import into a remote (Turso) database without --allow-remote.");
  process.exit(2);
}

class DryRun extends Error {}
try {
  const rows = await readAccountFile(file);
  const info = await db.info();
  console.log(`database : ${info.label} (${info.kind})${dryRun ? "  — DRY RUN, nothing is saved" : ""}`);
  console.log(`file     : ${path.basename(file)} → ${rows.length} rows with a login e-mail`);
  let result: Awaited<ReturnType<typeof importAccounts>> | undefined;
  await db
    .transaction(async () => {
      result = await importAccounts(rows);
      if (dryRun) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });
  const r = result!;
  console.log(`accounts : ${r.created} created, ${r.loginAdded} login added to an existing employee, ${r.unchanged} already had a login`);
  if (r.problems.length) console.log(`check (${r.problems.length}):\n  - ${r.problems.join("\n  - ")}`);
  if (!dryRun && r.credentials.length) {
    const out = writeCredentials(path.resolve("work/accounts"), r.credentials);
    console.log(`temporary passwords: ${path.relative(process.cwd(), out)} (${r.credentials.length}) — hand over individually, then delete the file`);
  }
  console.log(dryRun ? "Dry run: rolled back." : "Saved.");
  process.exit(0);
} catch (err) {
  console.error(`IMPORT FAILED (nothing saved): ${(err as Error).message}`);
  process.exit(1);
}
