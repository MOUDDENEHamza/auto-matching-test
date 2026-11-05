-- Integrity constraints and indexes on top of the initial schema.
-- Column types are unchanged on purpose (real money, varchar due_date) so the existing matcher
-- keeps working; moving to numeric / date is a separate migration.

-- company ---------------------------------------------------------------------------------
alter table company
  alter column siren set not null,
  alter column name set not null,
  add constraint company_siren_format check (siren ~ '^[0-9]{9}$'),
  add constraint company_siren_key unique (siren);

-- account ---------------------------------------------------------------------------------
-- The seed inserts accounts before companies, so these foreign keys are deferred to the end of
-- the loading transaction.
alter table account
  alter column company_id set not null,
  add constraint account_company_fk
    foreign key (company_id) references company (id) deferrable initially deferred;

create index account_company_idx on account (company_id);

-- buying_invoice --------------------------------------------------------------------------
-- due_date stays nullable: the seed has invoices without a due date.
alter table buying_invoice
  alter column company_id set not null,
  alter column invoice_number set not null,
  alter column tax_free_total set not null,
  alter column vat_amount set not null,
  alter column invoice_status set not null,
  add constraint buying_invoice_company_fk
    foreign key (company_id) references company (id) deferrable initially deferred,
  add constraint buying_invoice_amounts_check check (tax_free_total >= 0 and vat_amount >= 0),
  add constraint buying_invoice_status_check
    check (invoice_status in ('Pending', 'ToPay', 'Paid', 'Cancelled')),
  add constraint buying_invoice_due_date_format
    check (due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

-- candidate lookup: open, non-deleted invoices of one company
create index buying_invoice_open_idx
  on buying_invoice (company_id, invoice_status)
  where deleted_at is null;

-- transaction -----------------------------------------------------------------------------
-- No foreign key on account_id: the seed contains a transaction pointing to an account that
-- does not exist, which such a key would reject. No unique key on remote_id either: the seed
-- reuses BNK-2026-000777 on three rows.
alter table transaction
  alter column account_id set not null,
  alter column amount set not null,
  alter column date set not null,
  alter column status set not null,
  add constraint transaction_status_check check (status in ('Booked', 'Pending')),
  add constraint transaction_matched_invoice_fk
    foreign key (matched_invoice_id) references buying_invoice (id);

-- an invoice can be matched to at most one live transaction
create unique index transaction_matched_invoice_key
  on transaction (matched_invoice_id)
  where matched_invoice_id is not null and deleted_at is null;

-- work queue of the matcher: unmatched, live transactions of an account
create index transaction_unmatched_idx
  on transaction (account_id, date)
  where matched_invoice_id is null and deleted_at is null;
