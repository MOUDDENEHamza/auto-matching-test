import { Pool } from 'pg';

export const db = new Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5433),
  user: process.env.PGUSER ?? 'admin',
  password: process.env.PGPASSWORD ?? 'admin',
  database: process.env.PGDATABASE ?? 'matching',
});
