// Compare a v3 backup with its migrated copy. Never operates on the live DB by default.
import {DatabaseSync} from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [beforePath,afterPath,reportPath]=process.argv.slice(2);
if(!beforePath||!afterPath||path.resolve(beforePath)===path.resolve(afterPath))throw new Error('Usage: node scripts/verify-google-migration.ts <v3-backup> <copy-to-migrate> [report.json]');
const before=new DatabaseSync(beforePath,{readOnly:true});
assert.equal(before.prepare('PRAGMA user_version').get()?.user_version,3);
const tables=before.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));
const projections=new Map(tables.map(t=>[t,before.prepare(`PRAGMA table_info("${t}")`).all().map(r=>`"${r.name}"`).join(',')]));
function snapshot(db:DatabaseSync){return Object.fromEntries(tables.map(t=>{const rows=db.prepare(`SELECT ${projections.get(t)} FROM "${t}" ORDER BY rowid`).all();return [t,{count:rows.length,sha256:crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')}];}));}
const baseline=snapshot(before);before.close();
process.env.DATABASE_PATH=path.resolve(afterPath);
process.env.UPLOAD_DIR=path.resolve('work/google/uploads');
const {getDb}=await import('../src/lib/server/db.ts');
const after=getDb();
assert.equal(after.prepare('PRAGMA user_version').get()?.user_version,4);
assert.deepEqual(snapshot(after),baseline,'All old columns/rows including history, events, notifications, routing and identities must match');
assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(),[]);
assert.equal(after.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
assert.throws(()=>after.exec("UPDATE andon_transition SET comment='tamper'"),/append-only/);
const report={from:3,to:4,verifiedAt:new Date().toISOString(),allExistingRowsAndColumnsUnchanged:true,tables:baseline,foreignKeys:'PASS',integrity:'ok',appendOnly:'PASS'};
if(reportPath)fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));after.close();
