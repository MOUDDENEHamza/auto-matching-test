import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "./db";
import { runAutoMatching } from "./matcher";

// Runs the real migrations and the real job against Postgres, in a throwaway schema so the
// data in `public` is never touched. Skipped (with a warning) when the database is not reachable.

const SCHEMA = `test_matching_${process.pid}_${Date.now()}`;
const MIGRATIONS = path.join(process.cwd(), "migrations");

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const COMPANY = uuid(1);
const OTHER_COMPANY = uuid(2);
const ACCOUNT = uuid(10);

// invoices
const I_SINGLE = uuid(101);
const I_AMBIGUOUS_A = uuid(102);
const I_AMBIGUOUS_B = uuid(103);
const I_FOR_INCOMING = uuid(104);
const I_FOR_PENDING = uuid(105);
const I_FOR_DELETED = uuid(106);
const I_CANCELLED = uuid(107);
const I_CONTESTED = uuid(108);
const I_TAKEN = uuid(109);
const I_OTHER_COMPANY = uuid(110);

// transactions
const T_SINGLE = uuid(201);
const T_AMBIGUOUS = uuid(202);
const T_INCOMING = uuid(203);
const T_PENDING = uuid(204);
const T_DELETED = uuid(205);
const T_CANCELLED_ONLY = uuid(206);
const T_CONTESTED_1 = uuid(207);
const T_CONTESTED_2 = uuid(208);
const T_TAKEN_INVOICE = uuid(209);
const T_ALREADY_MATCHED = uuid(210);

let available = false;
let pool: Pool;

async function addInvoice(
  n: number,
  companyId: string,
  taxFree: number,
  vat: number,
  dueDate: string,
  status: string,
) {
  await pool.query(
    `insert into buying_invoice
       (id, company_id, supplier_name, invoice_number, tax_free_total, vat_amount, due_date, invoice_status)
     values ($1, $2, 'Supplier', $3, $4, $5, $6, $7)`,
    [uuid(n), companyId, `F-${n}`, taxFree, vat, dueDate, status],
  );
}

async function addTransaction(
  n: number,
  amount: number,
  options: {
    date?: string;
    status?: string;
    deleted?: boolean;
    matchedTo?: string;
  } = {},
) {
  await pool.query(
    `insert into transaction
       (id, account_id, remote_id, amount, label, reference, status, date, matched_invoice_id, deleted_at)
     values ($1, $2, $3, $4, 'label', '', $5, $6, $7, $8)`,
    [
      uuid(n),
      ACCOUNT,
      `BNK-${n}`,
      amount,
      options.status ?? "Booked",
      options.date ?? "2026-03-10",
      options.matchedTo ?? null,
      options.deleted ? new Date() : null,
    ],
  );
}

async function matchedByTransaction(): Promise<Record<string, string | null>> {
  const { rows } = await pool.query<{ id: string; matched_invoice_id: string | null }>(
    "select id, matched_invoice_id from transaction order by id",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.matched_invoice_id]));
}

beforeAll(async () => {
  try {
    await db.query("select 1");
    available = true;
  } catch {
    console.warn("Postgres is not reachable: skipping the database test");
    return;
  }

  await db.query(`create schema ${SCHEMA}`);
  // pg-pool keeps the password non-enumerable, so the spread alone would drop it.
  pool = new Pool({
    ...db.options,
    password: db.options.password,
    options: `-c search_path=${SCHEMA}`,
  });

  const files = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }

  await pool.query(
    `insert into company (id, siren, name) values ($1, '123456789', 'Test Co'), ($2, '987654321', 'Other Co')`,
    [COMPANY, OTHER_COMPANY],
  );
  await pool.query(`insert into account (id, company_id, iban) values ($1, $2, 'FR76TEST')`, [
    ACCOUNT,
    COMPANY,
  ]);

  // Invoices (amounts are tax free + vat). The transactions are all dated 2026-03-10.
  await addInvoice(101, COMPANY, 80, 20, "2026-03-15", "Pending"); // 100.00, only candidate
  await addInvoice(102, COMPANY, 160, 40, "2026-03-12", "ToPay"); // 200.00, two fit
  await addInvoice(103, COMPANY, 160, 40, "2026-03-20", "Pending"); // 200.00
  await addInvoice(104, COMPANY, 240, 60, "2026-03-12", "Pending"); // 300.00, incoming tx
  await addInvoice(105, COMPANY, 320, 80, "2026-03-12", "Pending"); // 400.00, pending tx
  await addInvoice(106, COMPANY, 400, 100, "2026-03-12", "Pending"); // 500.00, deleted tx
  await addInvoice(107, COMPANY, 480, 120, "2026-03-12", "Cancelled"); // 600.00, cancelled
  await addInvoice(108, COMPANY, 560, 140, "2026-03-15", "Pending"); // 700.00, two tx want it
  await addInvoice(109, COMPANY, 640, 160, "2026-03-15", "Pending"); // 800.00, already taken
  await addInvoice(110, OTHER_COMPANY, 80, 20, "2026-03-12", "Pending"); // 100.00, other tenant

  await addTransaction(201, -100); // exactly one candidate
  await addTransaction(202, -200); // two candidates
  await addTransaction(203, 300); // incoming money
  await addTransaction(204, -400, { status: "Pending" });
  await addTransaction(205, -500, { deleted: true });
  await addTransaction(206, -600); // only a cancelled invoice fits
  await addTransaction(207, -700);
  await addTransaction(208, -700, { date: "2026-03-11" }); // same invoice as 207
  await addTransaction(209, -800); // its only candidate is already matched
  await addTransaction(210, -800, { date: "2026-03-01", matchedTo: I_TAKEN });
});

afterAll(async () => {
  if (available) {
    await pool.end();
    await db.query(`drop schema ${SCHEMA} cascade`);
  }
  await db.end();
});

describe("runAutoMatching against Postgres", () => {
  it("matches only what is safe, leaves everything else untouched, and is stable on re-run", async (context) => {
    if (!available) {
      context.skip();
    }
    vi.spyOn(console, "log").mockImplementation(() => {});

    const first = await runAutoMatching("123456789", pool);

    // Eligible: 201, 202, 206, 207, 208, 209. Not eligible: incoming, pending, deleted, already matched.
    expect(first).toEqual({
      total: 6,
      matched: 1,
      skippedNoCandidate: 2, // cancelled-only invoice, invoice already taken
      skippedAmbiguous: 1,
      skippedConflict: 2,
      matches: [{ transactionId: T_SINGLE, invoiceId: I_SINGLE, reason: "single_candidate" }],
    });

    const afterFirst = await matchedByTransaction();
    expect(afterFirst).toEqual({
      [T_SINGLE]: I_SINGLE, // matched, and not confused with the other tenant's 100.00 invoice
      [T_AMBIGUOUS]: null, // I_AMBIGUOUS_A and I_AMBIGUOUS_B both fit: no guess
      [T_INCOMING]: null,
      [T_PENDING]: null,
      [T_DELETED]: null,
      [T_CANCELLED_ONLY]: null,
      [T_CONTESTED_1]: null, // both wanted I_CONTESTED: neither gets it
      [T_CONTESTED_2]: null,
      [T_TAKEN_INVOICE]: null,
      [T_ALREADY_MATCHED]: I_TAKEN, // an existing match is never overwritten
    });

    const second = await runAutoMatching("123456789", pool);
    expect(second.matched).toBe(0);
    expect(await matchedByTransaction()).toEqual(afterFirst);

    // keep the linter quiet about the documented-but-unused ids
    expect([I_AMBIGUOUS_A, I_AMBIGUOUS_B, I_FOR_INCOMING, I_FOR_PENDING, I_FOR_DELETED]).toHaveLength(5);
    expect([I_CANCELLED, I_CONTESTED, I_OTHER_COMPANY]).toHaveLength(3);
  });
});
