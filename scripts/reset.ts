import fs from 'fs';
import path from 'path';
import { db } from '../src/db';

async function runSqlFiles(directory: string) {
  for (const file of fs.readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    await db.query(fs.readFileSync(path.join(directory, file), 'utf8'));
  }
}

async function reset() {
  await db.query('drop schema public cascade');
  await db.query('create schema public');
  await runSqlFiles(path.join(__dirname, '..', 'migrations'));
  await runSqlFiles(path.join(__dirname, '..', 'seeds'));
  await db.end();
}

reset().catch(async (e) => {
  console.error(e);
  await db.end();
  process.exit(1);
});
