// npm run import:uap -- <workbook.xlsx> [--dry-run] [--allow-remote]
//
// Imports the UAP line ownership (Supervisor, GAP leader of shift A / B per line) from the plant
// workbook into line_assignment. The workbook stays OUTSIDE the repository (it contains personal data).
// Only names, positions, areas and lines are read — never phone numbers, Google / Kakao IDs, employee
// IDs or e-mail addresses. Lines must already exist in the line master (src/lib/server/masterData.ts).
//
// Repeatable: an unchanged workbook changes nothing; a changed person ends the old assignment and
// starts a new one (history kept). --dry-run shows what would happen and rolls everything back.
// The target database is the one the app uses (DATABASE_PATH / .env). A Turso database is refused
// unless --allow-remote is given.
import fs from "node:fs";
import path from "node:path";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
if (!file || !fs.existsSync(file)) {
  console.error("usage: npm run import:uap -- <workbook.xlsx> [--dry-run] [--allow-remote]");
  process.exit(2);
}

const { readOrgWorkbook } = await import("./lib/uap-workbook.ts");
const { db, REMOTE_DATABASE_URL } = await import("../src/lib/server/db.ts");
const { applyOrgImport } = await import("../src/lib/server/lineAssignments.ts");

if (REMOTE_DATABASE_URL && !args.includes("--allow-remote")) {
  console.error("Refusing to import into a remote (Turso) database without --allow-remote.");
  process.exit(2);
}

class DryRun extends Error {}
try {
  const parsed = await readOrgWorkbook(file);
  const info = await db.info();
  console.log(`database : ${info.label} (${info.kind})${dryRun ? "  — DRY RUN, nothing is saved" : ""}`);
  console.log(`workbook : ${path.basename(file)} → ${parsed.lines.length} lines`);
  let report: Awaited<ReturnType<typeof applyOrgImport>> | undefined;
  await db
    .transaction(async () => {
      report = await applyOrgImport(parsed.lines, path.basename(file));
      if (dryRun) throw new DryRun();
    })
    .catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });
  const r = report!;
  console.log(`employees   : ${r.employeesCreated} created, ${r.employeesReused} already present`);
  console.log(`assignments : ${r.assignmentsCreated} created, ${r.assignmentsUnchanged} unchanged, ${r.assignmentsEnded} ended`);
  const warnings = [...parsed.warnings, ...r.warnings];
  if (warnings.length) console.log(`warnings (${warnings.length}) — check with the plant:\n  - ${warnings.join("\n  - ")}`);
  console.log(dryRun ? "Dry run: rolled back." : "Saved. Show with: npm run masterdata -- lines");
  process.exit(0);
} catch (err) {
  console.error(`IMPORT FAILED (nothing saved): ${(err as Error).message}`);
  process.exit(1);
}
