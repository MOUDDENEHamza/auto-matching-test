# Auto-matching: bank transactions ↔ supplier invoices

## Context

Our customers' bank transactions and their supplier invoices come from different systems:
transactions from bank feeds, invoices from uploads and email ingestion. This job pairs them
automatically so the customer doesn't have to do it by hand. An incorrect pairing is worse
than no pairing at all. It writes an incorrect accounting record, and the customer is unlikely
to notice it.

## What's here

- `migrations/`: the database schema.
- `seeds/`: a deterministic dataset for two companies.
- `src/matcher.ts`: the matching job. A colleague shipped this first implementation under
  time pressure. It works and produces matches.
- `main.ts`: the entry point. It runs the job for one company and prints a summary.

Here's how the job is meant to work. It goes through every unmatched outgoing transaction of a
company and looks for the supplier invoice that transaction pays. That's the invoice whose
total equals the transaction amount, with a due date between 3 days before and 30 days after
the transaction date. When it finds one, it records the match. When there's no convincing
candidate, it leaves the transaction unmatched.

## Setup

You need Node.js (20 or later) and Docker.

```sh
docker compose up -d
npm install
npm run db:reset
npm start
```

`npm run db:reset` drops the schema, re-creates it and reseeds it. You can run it as often as
you like.

## What we'd like from you

Please do these in this order:

1. **`FINDINGS.md`**: your critique of this implementation, **ranked by how much each point
   would hurt us in production**. For each point, state the consequence concretely. We care more
   about the ranking and the reasoning than about how long the list is.
2. **A reworked implementation, with tests.** Keep the overall shape: a `tsx` entry point,
   raw SQL through `pg`, no ORM. Beyond that, use whatever you need, including **any libraries and any test
   runner you like**. If you think the schema needs to change, change it; a migration is fine. You
   don't have to keep the existing function signature.
3. **A short note.** A few paragraphs at the end of `FINDINGS.md` is fine. Tell us what you
   deliberately left undone, what you'd need from the product side to decide properly, and
   what you'd build next.

## Time

We think this takes about 3–4 hours. Please don't spend a full day on it. If you run out of
time, tell us what you'd have done next; that answer counts.

## Ground rules

You can use any tooling, any libraries and AI assistants. In the follow-up conversation,
though, you'll need to be able to explain and defend every line.
