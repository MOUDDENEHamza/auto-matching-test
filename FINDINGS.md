# Findings

I ranked these by how much they would hurt in production. The README says a wrong pairing is worse
than no pairing, so the things that write wrong records silently come first, then the things that
hide failures, then missed matches, then cost and hygiene.

"Observed" means I ran the original job on the seed and saw it. The rest comes from reading the
code and the schema.

## 1. When several invoices fit, it just picks one

`findMatch` filters by amount and date, scores what is left and returns `scored[0]`. It never
checks whether more than one invoice was plausible. The score is only the number of days from the
due date, which says nothing about which invoice the payment settled, and on a tie the winner is
whatever row the database returned first.

Consequence: the payment ends up on the wrong supplier's invoice. The invoice that was really paid
still looks open, so the customer might pay it twice, and nothing flags the mistake because it was
an "automatic match". The seed has this shape, for example two `-44.99` Bouygues Telecom payments
in different months.

## 2. One invoice can be matched to several transactions

Nothing marks an invoice as taken after the update, and the schema has no constraint on
`matched_invoice_id`. Two transactions with the same amount can pick the same invoice.

Observed: after I added a unique index on `matched_invoice_id`, a single run hit it 12 times
(`duplicate key value violates unique constraint "transaction_matched_invoice_key"`). That is 12
invoices the job tried to claim twice, one of them already matched in the seed. Without the index
all 12 updates succeed, those invoices count as paid twice and the real ones stay open.

The fix needs the code (skip invoices already matched) and the schema (the unique index).

## 3. It processes every transaction, not only unmatched outgoing ones

```ts
`select transaction.*
 from transaction
 join account on account.id = transaction.account_id
 where account.company_id = '${company.id}'`
```

There is no `matched_invoice_id is null`, no `amount < 0`, no `deleted_at is null` and no status
check, and the matcher compares with `Math.abs(amount)`.

Consequence: a re-run re-evaluates existing matches and can overwrite one a customer fixed by
hand. An incoming receipt can be matched to a supplier invoice of the same amount. Pending
transactions (which can still change) and soft-deleted ones (payments that officially don't exist)
get matched too. The seed has both.

## 4. Cancelled and paid invoices are candidates

`select * from buying_invoice where company_id = ...` ignores `invoice_status` and `deleted_at`.
The seed has `Cancelled` and `Paid` invoices. A payment can end up on an invoice the customer
cancelled or already settled, while the right open invoice is skipped.

## 5. The label bonus is too strong and too loose

If the label contains the supplier name or invoice number, the score drops by 100, which beats any
date difference (the whole window is 33 days). But `includes` has no word boundaries, so a short
supplier name matches inside unrelated labels, and an empty `invoice_number` makes `includes("")`
always true (the seed has one). It also never rejects anything: a label naming supplier X still
matches an invoice from supplier Y if the amount fits. The bank `reference` column, which often
holds the invoice number, is not used.

Consequence: a coincidence beats the date evidence and the choice looks confident.

## 6. Every error is swallowed

```ts
} catch (e) {
  console.log("skip", e);
}
```

Observed: the 12 violations above and a `TypeError` on a transaction with a `null` label were all
printed as `skip`. The run still ended with `Matched 496 of 1200 transactions` and exit code 0.
A database outage or a bug would look exactly like a normal run, and nobody would know some
transactions were never processed.

## 7. No database transaction, no protection against concurrent runs

Each `update` commits on its own. A crash halfway leaves a half-applied batch, and two overlapping
runs (a cron retry, a manual run) can interleave and claim the same invoice, which is how point 2
happens for real.

## 8. Money is `real`, compared with `===`

`tax_free_total + vat_amount === Math.abs(amount)` on float columns. In JavaScript
`9.69 + 1.94` is `11.629999999999999`, not `11.63`, so some correct matches are silently missed.
If someone later "fixes" it with a tolerance, wrong matches appear instead. Money should be
integer cents or `numeric`.

## 9. Date handling is fragile

`due_date` is a `varchar`, and `dayDiff` mixes a local-midnight `Date` with a UTC-parsed string and
then uses `Math.floor`. Matches at exactly -30 or +3 days can flip depending on the server's time
zone, and bad date strings are never rejected. The seed has 1,051 invoices with no due date.

## 10. The invoice list is reloaded for every transaction

`getCandidates(company.id)` runs inside the loop, and there is no index on
`buying_invoice.company_id`, so each call scans the table. With about 1,200 transactions and about
35,000 invoices that is tens of millions of row reads per run (a rough estimate, I didn't measure
it). The list is re-fetched, so it does see earlier updates, but nothing uses that: there is no
"already matched" filter, so the cost buys no protection against point 2.

## 11. The company lookup is unchecked, and `siren` isn't unique

```ts
const { rows: [company] } = await db.query(`select * from company where siren = '${companySiren}'`);
```

If no row matches, `company` is `undefined` and the next line crashes with an unhelpful error. If
several match, it takes the first, and without an `order by` that can change between runs, so the
job may silently process the wrong customer. The fix is
`alter table company add constraint company_siren_key unique (siren);` (the unique constraint
already creates the index, so a separate `create index` is redundant) and failing loudly unless
exactly one row comes back.

## 12. SQL built by string concatenation

`x' or '1'='1` as the SIREN gives `select * from company where siren = 'x' or '1'='1'`, which
returns every company, and the job runs on the first one. I ranked it low because it is latent:
the SIREN is hardcoded in `main.ts`, so nothing external reaches it today. It becomes a real hole
the first time a caller passes a request or CLI value. Same pattern with ids elsewhere. The fix is
parameterized queries: `db.query('select * from company where siren = $1', [siren])`.

## 13. Smaller things

- The summary only says "Matched X of N". It doesn't separate "no candidate" from "several
  candidates, skipped", and nothing records why a match was made, so a bad batch can't be audited
  or undone.
- `main.ts` hardcodes the SIREN, so the job only runs for one company.
- `db.ts` falls back to a default password instead of failing when the variables are missing.
- `scripts/reset.ts` runs `drop schema public cascade` on whatever the `PG*` variables point to.
- The schema has no foreign keys and no `not null`, and statuses are free text.
- The original tests only covered `normalizeLabel` and `dayDiff`. `findMatch`, where points 1 to 5
  live, wasn't exported and wasn't tested.

## What I changed

I rewrote `src/matcher.ts` in place, so the code quoted above is the original and no longer in the
repo. The new one only looks at outgoing, booked, live, unmatched transactions and open
(`Pending`, `ToPay`), live, unmatched invoices. Amounts are compared as integer cents and dates as
UTC days. If more than one invoice fits, the transaction stays unmatched, unless its bank
`reference` equals exactly one candidate's invoice number. If two transactions would claim the
same invoice, neither gets it. A run is one database transaction, locked per company, errors roll
back and are rethrown, queries are parameterized and data is loaded once.

The migration adds a unique `siren`, `not null` and status checks, the foreign keys the seed
allows, a unique index so an invoice is matched to at most one live transaction, and indexes for
the matcher's queries.

## Note

**What I left undone**

- Money is still `real` and `due_date` still `varchar`. Moving to `numeric` and `date` is the
  right fix but touches every query, so I compare in integer cents instead.
- No foreign key on `transaction.account_id` and no unique `remote_id`: the seed has a transaction
  pointing at a missing account and a `remote_id` used on three rows.
- The reason for a match is returned in the run summary but not stored.
- The label and supplier name aren't used as evidence, only the `reference`.
- `main.ts` still has a hardcoded SIREN.
- Tests: `src/matcher.test.ts` has unit tests for the decision logic of `matcher.ts` (dates,
  window boundaries, candidates, ambiguity, reference tie-break, conflicts, summary).
  `src/matcher.db.test.ts` is one test against a real Postgres, in a throwaway schema: it
  checks the transaction and invoice filters, one invoice per transaction, the conflict case, that
  an existing match is never overwritten, and that a second run changes nothing. It is skipped if
  the database is not reachable. What is still not tested: rollback when an error happens
  mid-run, two runs at the same time (the advisory lock), and the case where a second run matches
  more because an invoice was taken by the first.

**What I'd need from product**

- Whether one SIREN must mean one company.
- What should happen to a match when its transaction is later deleted.
- Whether a `Pending` bank line should ever be matched.

**What I'd build next**

- Tests against a real database for the whole run (re-runs, concurrency, rollback).
- Check why transactions end up with no candidate (amount, date window or status) to see whether
  the rules are too strict.
- A review queue for ambiguous cases, so the customer confirms instead of searching.
- Store the reason and a run id with each match, and a way to undo a batch.
- Move money and dates to proper types.
