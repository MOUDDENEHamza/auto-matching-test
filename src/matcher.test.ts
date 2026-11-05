import { describe, expect, it } from "vitest";
import {
  decide,
  findCandidates,
  isDueInWindow,
  planMatches,
  summarize,
  toDay,
  type Invoice,
  type Transaction,
} from "./matcher";

function transaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    amountCents: -50000,
    date: "2026-03-10",
    reference: "",
    ...overrides,
  };
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "i1",
    invoiceNumber: "F-1",
    totalCents: 50000,
    dueDate: "2026-03-15",
    ...overrides,
  };
}

function byTotal(invoices: Invoice[]): Map<number, Invoice[]> {
  const map = new Map<number, Invoice[]>();
  for (const item of invoices) {
    map.set(item.totalCents, [...(map.get(item.totalCents) ?? []), item]);
  }
  return map;
}

describe("toDay", () => {
  it("returns consecutive integers for consecutive days", () => {
    expect(toDay("2026-03-11")! - toDay("2026-03-10")!).toBe(1);
  });

  it("counts across month and year boundaries", () => {
    expect(toDay("2026-01-31")! - toDay("2026-01-01")!).toBe(30);
    expect(toDay("2027-01-01")! - toDay("2026-01-01")!).toBe(365);
  });

  it("accepts a leap day only in a leap year", () => {
    expect(toDay("2024-02-29")).not.toBeNull();
    expect(toDay("2026-02-29")).toBeNull();
  });

  it("rejects impossible calendar dates", () => {
    expect(toDay("2026-13-01")).toBeNull();
    expect(toDay("2026-02-30")).toBeNull();
    expect(toDay("2026-00-10")).toBeNull();
  });

  it("rejects malformed strings", () => {
    expect(toDay("")).toBeNull();
    expect(toDay("10/03/2026")).toBeNull();
    expect(toDay("2026-3-1")).toBeNull();
    expect(toDay("2026-03-10T00:00:00")).toBeNull();
  });
});

describe("isDueInWindow", () => {
  // Transaction on 2026-03-10: the window is due dates from 2026-03-07 to 2026-04-09.
  it("includes the boundaries: 3 days before and 30 days after", () => {
    expect(isDueInWindow("2026-03-10", "2026-03-07")).toBe(true);
    expect(isDueInWindow("2026-03-10", "2026-04-09")).toBe(true);
  });

  it("excludes one day outside each boundary", () => {
    expect(isDueInWindow("2026-03-10", "2026-03-06")).toBe(false);
    expect(isDueInWindow("2026-03-10", "2026-04-10")).toBe(false);
  });

  it("includes a due date equal to the transaction date", () => {
    expect(isDueInWindow("2026-03-10", "2026-03-10")).toBe(true);
  });

  it("is false when either date is invalid", () => {
    expect(isDueInWindow("2026-03-10", "not a date")).toBe(false);
    expect(isDueInWindow("2026-02-30", "2026-03-10")).toBe(false);
  });
});

describe("findCandidates", () => {
  it("matches an outgoing (negative) transaction to a positive invoice total", () => {
    const candidates = findCandidates(transaction(), byTotal([invoice()]));
    expect(candidates.map((item) => item.id)).toEqual(["i1"]);
  });

  it("excludes invoices of a different amount, even by one cent", () => {
    const candidates = findCandidates(
      transaction(),
      byTotal([invoice({ totalCents: 50001 })]),
    );
    expect(candidates).toEqual([]);
  });

  it("excludes invoices due outside the window", () => {
    const candidates = findCandidates(
      transaction(),
      byTotal([invoice({ dueDate: "2026-06-02" })]),
    );
    expect(candidates).toEqual([]);
  });

  it("does not match an incoming (positive) transaction", () => {
    const candidates = findCandidates(
      transaction({ amountCents: 50000 }),
      byTotal([invoice()]),
    );
    expect(candidates).toEqual([]);
  });
});

describe("decide", () => {
  it("skips when there is no candidate", () => {
    expect(decide(transaction(), [])).toEqual({
      kind: "skipped",
      reason: "no_candidate",
    });
  });

  it("matches when there is exactly one candidate", () => {
    expect(decide(transaction(), [invoice()])).toEqual({
      kind: "matched",
      invoiceId: "i1",
      reason: "single_candidate",
    });
  });

  it("skips instead of guessing when several invoices fit", () => {
    const decision = decide(transaction(), [
      invoice({ id: "a", dueDate: "2026-03-15" }),
      invoice({ id: "b", invoiceNumber: "F-2", dueDate: "2026-03-20" }),
    ]);
    expect(decision).toEqual({ kind: "skipped", reason: "ambiguous" });
  });

  it("resolves a tie when the reference names exactly one candidate", () => {
    const decision = decide(transaction({ reference: "F-2" }), [
      invoice({ id: "a", invoiceNumber: "F-1" }),
      invoice({ id: "b", invoiceNumber: "F-2" }),
    ]);
    expect(decision).toEqual({ kind: "matched", invoiceId: "b", reason: "reference" });
  });

  it("compares references ignoring case and surrounding spaces", () => {
    const decision = decide(transaction({ reference: "  f-2 " }), [
      invoice({ id: "a", invoiceNumber: "F-1" }),
      invoice({ id: "b", invoiceNumber: "F-2" }),
    ]);
    expect(decision).toMatchObject({ kind: "matched", invoiceId: "b" });
  });

  it("stays ambiguous when the reference names none of the candidates", () => {
    const decision = decide(transaction({ reference: "F-99" }), [
      invoice({ id: "a", invoiceNumber: "F-1" }),
      invoice({ id: "b", invoiceNumber: "F-2" }),
    ]);
    expect(decision).toEqual({ kind: "skipped", reason: "ambiguous" });
  });

  it("stays ambiguous when the reference names several candidates", () => {
    const decision = decide(transaction({ reference: "F-1" }), [
      invoice({ id: "a", invoiceNumber: "F-1" }),
      invoice({ id: "b", invoiceNumber: "F-1" }),
    ]);
    expect(decision).toEqual({ kind: "skipped", reason: "ambiguous" });
  });

  it("never uses an empty reference as evidence, even against an empty invoice number", () => {
    const decision = decide(transaction({ reference: "" }), [
      invoice({ id: "a", invoiceNumber: "" }),
      invoice({ id: "b", invoiceNumber: "F-2" }),
    ]);
    expect(decision).toEqual({ kind: "skipped", reason: "ambiguous" });
  });
});

describe("planMatches", () => {
  it("matches independent transactions to their own invoices", () => {
    const decisions = planMatches(
      [
        transaction({ id: "t1", amountCents: -1000 }),
        transaction({ id: "t2", amountCents: -2000 }),
      ],
      [
        invoice({ id: "i1", totalCents: 1000 }),
        invoice({ id: "i2", invoiceNumber: "F-2", totalCents: 2000 }),
      ],
    );
    expect(decisions.get("t1")).toMatchObject({ kind: "matched", invoiceId: "i1" });
    expect(decisions.get("t2")).toMatchObject({ kind: "matched", invoiceId: "i2" });
  });

  it("leaves a transaction unmatched when two invoices of the same amount fit", () => {
    const decisions = planMatches(
      [transaction()],
      [
        invoice({ id: "a", dueDate: "2026-03-15" }),
        invoice({ id: "b", invoiceNumber: "F-2", dueDate: "2026-03-20" }),
      ],
    );
    expect(decisions.get("t1")).toEqual({ kind: "skipped", reason: "ambiguous" });
  });

  it("gives an invoice to nobody when two transactions would claim it", () => {
    const decisions = planMatches(
      [
        transaction({ id: "t1", date: "2026-03-10" }),
        transaction({ id: "t2", date: "2026-03-11" }),
      ],
      [invoice({ id: "only" })],
    );
    expect(decisions.get("t1")).toEqual({ kind: "skipped", reason: "conflict" });
    expect(decisions.get("t2")).toEqual({ kind: "skipped", reason: "conflict" });
  });

  it("does not let a conflict affect unrelated matches", () => {
    const decisions = planMatches(
      [
        transaction({ id: "t1" }),
        transaction({ id: "t2" }),
        transaction({ id: "t3", amountCents: -700 }),
      ],
      [invoice({ id: "only" }), invoice({ id: "other", invoiceNumber: "F-3", totalCents: 700 })],
    );
    expect(decisions.get("t1")).toMatchObject({ reason: "conflict" });
    expect(decisions.get("t2")).toMatchObject({ reason: "conflict" });
    expect(decisions.get("t3")).toMatchObject({ kind: "matched", invoiceId: "other" });
  });

  it("returns one decision per transaction", () => {
    const decisions = planMatches(
      [transaction({ id: "t1" }), transaction({ id: "t2", amountCents: -1 })],
      [invoice()],
    );
    expect([...decisions.keys()].sort()).toEqual(["t1", "t2"]);
  });
});

describe("summarize", () => {
  it("counts each outcome and lists the matches with their reason", () => {
    const transactions = [
      transaction({ id: "t1", amountCents: -1000 }),
      transaction({ id: "t2", amountCents: -2000 }),
      transaction({ id: "t3", amountCents: -3000 }),
    ];
    const decisions = planMatches(transactions, [
      invoice({ id: "i1", totalCents: 1000 }),
      invoice({ id: "i2a", invoiceNumber: "F-2a", totalCents: 2000 }),
      invoice({ id: "i2b", invoiceNumber: "F-2b", totalCents: 2000 }),
    ]);

    expect(summarize(transactions, decisions)).toEqual({
      total: 3,
      matched: 1,
      skippedNoCandidate: 1,
      skippedAmbiguous: 1,
      skippedConflict: 0,
      matches: [{ transactionId: "t1", invoiceId: "i1", reason: "single_candidate" }],
    });
  });
});
