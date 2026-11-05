import type { Pool, PoolClient } from "pg";
import { db } from "./db";

// Guiding rule: a wrong match is worse than no match. Whenever the evidence does not point to
// exactly one invoice, the transaction is left unmatched.

const OPEN_INVOICE_STATUSES = ["Pending", "ToPay"];

// An invoice is a candidate when its due date is between 3 days before and 30 days after the
// transaction date, i.e. dueDay - transactionDay is within [-3, 30].
const MIN_DUE_OFFSET_DAYS = -3;
const MAX_DUE_OFFSET_DAYS = 30;

export type Transaction = {
  id: string;
  /** Negative for outgoing payments. Integer cents. */
  amountCents: number;
  /** ISO date, YYYY-MM-DD. */
  date: string;
  reference: string;
};

export type Invoice = {
  id: string;
  invoiceNumber: string;
  /** tax_free_total + vat_amount, integer cents. */
  totalCents: number;
  /** ISO date, YYYY-MM-DD. */
  dueDate: string;
};

export type SkipReason = "no_candidate" | "ambiguous" | "conflict";
export type MatchReason = "single_candidate" | "reference";

export type Decision =
  | { kind: "matched"; invoiceId: string; reason: MatchReason }
  | { kind: "skipped"; reason: SkipReason };

export type Summary = {
  total: number;
  matched: number;
  skippedNoCandidate: number;
  skippedAmbiguous: number;
  skippedConflict: number;
  matches: { transactionId: string; invoiceId: string; reason: MatchReason }[];
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days since epoch for a YYYY-MM-DD string, or null if it is not a real calendar date. */
export function toDay(iso: string): number | null {
  const parts = ISO_DATE.exec(iso);
  if (!parts) {
    return null;
  }
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return utc.getTime() / 86_400_000;
}

export function isDueInWindow(transactionDate: string, dueDate: string): boolean {
  const transactionDay = toDay(transactionDate);
  const dueDay = toDay(dueDate);
  if (transactionDay === null || dueDay === null) {
    return false;
  }
  const offset = dueDay - transactionDay;
  return offset >= MIN_DUE_OFFSET_DAYS && offset <= MAX_DUE_OFFSET_DAYS;
}

function normalizeReference(value: string): string {
  return value.trim().toLowerCase();
}

/** Invoices that could have been paid by this transaction: same amount, due date in the window. */
export function findCandidates(
  transaction: Transaction,
  invoicesByTotal: Map<number, Invoice[]>,
): Invoice[] {
  const sameAmount = invoicesByTotal.get(-transaction.amountCents) ?? [];
  return sameAmount.filter((invoice) =>
    isDueInWindow(transaction.date, invoice.dueDate),
  );
}

/**
 * Decides for one transaction in isolation. Never guesses: more than one candidate is only
 * resolved when the bank reference names exactly one of them.
 */
export function decide(transaction: Transaction, candidates: Invoice[]): Decision {
  if (candidates.length === 0) {
    return { kind: "skipped", reason: "no_candidate" };
  }
  if (candidates.length === 1) {
    return { kind: "matched", invoiceId: candidates[0].id, reason: "single_candidate" };
  }

  const reference = normalizeReference(transaction.reference);
  if (reference !== "") {
    const named = candidates.filter(
      (invoice) => normalizeReference(invoice.invoiceNumber) === reference,
    );
    if (named.length === 1) {
      return { kind: "matched", invoiceId: named[0].id, reason: "reference" };
    }
  }
  return { kind: "skipped", reason: "ambiguous" };
}

function indexByTotal(invoices: Invoice[]): Map<number, Invoice[]> {
  const byTotal = new Map<number, Invoice[]>();
  for (const invoice of invoices) {
    const bucket = byTotal.get(invoice.totalCents);
    if (bucket) {
      bucket.push(invoice);
    } else {
      byTotal.set(invoice.totalCents, [invoice]);
    }
  }
  return byTotal;
}

/**
 * Pure planning step: decides every transaction, then enforces one transaction per invoice.
 * If two transactions would claim the same invoice, neither gets it, because we cannot tell
 * which payment really settled it.
 */
export function planMatches(
  transactions: Transaction[],
  invoices: Invoice[],
): Map<string, Decision> {
  const invoicesByTotal = indexByTotal(invoices);
  const decisions = new Map<string, Decision>();
  const claims = new Map<string, number>();

  for (const transaction of transactions) {
    const decision = decide(transaction, findCandidates(transaction, invoicesByTotal));
    decisions.set(transaction.id, decision);
    if (decision.kind === "matched") {
      claims.set(decision.invoiceId, (claims.get(decision.invoiceId) ?? 0) + 1);
    }
  }

  for (const [transactionId, decision] of decisions) {
    if (decision.kind === "matched" && (claims.get(decision.invoiceId) ?? 0) > 1) {
      decisions.set(transactionId, { kind: "skipped", reason: "conflict" });
    }
  }
  return decisions;
}

export function summarize(
  transactions: Transaction[],
  decisions: Map<string, Decision>,
): Summary {
  const summary: Summary = {
    total: transactions.length,
    matched: 0,
    skippedNoCandidate: 0,
    skippedAmbiguous: 0,
    skippedConflict: 0,
    matches: [],
  };
  for (const [transactionId, decision] of decisions) {
    if (decision.kind === "matched") {
      summary.matched++;
      summary.matches.push({
        transactionId,
        invoiceId: decision.invoiceId,
        reason: decision.reason,
      });
    } else if (decision.reason === "no_candidate") {
      summary.skippedNoCandidate++;
    } else if (decision.reason === "ambiguous") {
      summary.skippedAmbiguous++;
    } else {
      summary.skippedConflict++;
    }
  }
  return summary;
}

async function resolveCompanyId(client: PoolClient, siren: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "select id from company where siren = $1",
    [siren],
  );
  if (rows.length !== 1) {
    throw new Error(`Expected exactly 1 company for SIREN ${siren}, found ${rows.length}`);
  }
  return rows[0].id;
}

/** Unmatched, booked, outgoing, non-deleted transactions. Amounts and dates are normalized in SQL. */
async function loadTransactions(
  client: PoolClient,
  companyId: string,
): Promise<Transaction[]> {
  const { rows } = await client.query<{
    id: string;
    amount_cents: number;
    date: string;
    reference: string;
  }>(
    `select t.id,
            round(t.amount::numeric * 100)::int as amount_cents,
            to_char(t.date, 'YYYY-MM-DD') as date,
            coalesce(t.reference, '') as reference
     from transaction t
     join account a on a.id = t.account_id
     where a.company_id = $1
       and t.matched_invoice_id is null
       and t.deleted_at is null
       and t.status = 'Booked'
       and t.amount < 0
       and t.date is not null
     order by t.date, t.id`,
    [companyId],
  );
  return rows.map((row) => ({
    id: row.id,
    amountCents: row.amount_cents,
    date: row.date,
    reference: row.reference,
  }));
}

/** Open, non-deleted invoices that are not already matched to a live transaction. */
async function loadInvoices(client: PoolClient, companyId: string): Promise<Invoice[]> {
  const { rows } = await client.query<{
    id: string;
    invoice_number: string;
    total_cents: number;
    due_date: string;
  }>(
    `select i.id,
            invoice_number,
            round(i.tax_free_total::numeric * 100)::int
              + round(i.vat_amount::numeric * 100)::int as total_cents,
            i.due_date
     from buying_invoice i
     where i.company_id = $1
       and i.deleted_at is null
       and i.invoice_status = any($2)
       and i.tax_free_total is not null
       and i.vat_amount is not null
       and i.due_date is not null
       and not exists (
         select 1 from transaction t
         where t.matched_invoice_id = i.id and t.deleted_at is null
       )`,
    [companyId, OPEN_INVOICE_STATUSES],
  );
  return rows.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    totalCents: row.total_cents,
    dueDate: row.due_date,
  }));
}

/**
 * Runs the matching for one company inside a single database transaction. Concurrent runs for
 * the same company are serialized by an advisory lock. Any error rolls everything back and is
 * rethrown, so a failed run is never reported as a success.
 */
export async function runAutoMatching(
  companySiren: string,
  pool: Pool = db,
): Promise<Summary> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const companyId = await resolveCompanyId(client, companySiren);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      `auto-matching:${companyId}`,
    ]);

    const transactions = await loadTransactions(client, companyId);
    const invoices = await loadInvoices(client, companyId);
    const decisions = planMatches(transactions, invoices);
    const summary = summarize(transactions, decisions);

    for (const match of summary.matches) {
      const { rowCount } = await client.query(
        `update transaction set matched_invoice_id = $1
         where id = $2 and matched_invoice_id is null`,
        [match.invoiceId, match.transactionId],
      );
      if (rowCount !== 1) {
        throw new Error(`Transaction ${match.transactionId} changed during the run`);
      }
    }

    await client.query("commit");
    console.log(
      `Matched ${summary.matched} of ${summary.total} transactions ` +
        `(no candidate: ${summary.skippedNoCandidate}, ambiguous: ${summary.skippedAmbiguous}, ` +
        `conflict: ${summary.skippedConflict})`,
    );
    return summary;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
