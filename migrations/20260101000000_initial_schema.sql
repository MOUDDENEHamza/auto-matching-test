create table company (
  id uuid primary key,
  siren varchar(9),
  name varchar(255)
);

create table account (
  id uuid primary key,
  company_id uuid,
  iban varchar(255)
);

create table transaction (
  id uuid primary key,
  account_id uuid,
  remote_id varchar(255),
  amount real,
  label varchar(255),
  reference varchar(255),
  status varchar(255),
  date date,
  matched_invoice_id uuid,
  deleted_at timestamp
);

create table buying_invoice (
  id uuid primary key,
  company_id uuid,
  supplier_name varchar(255),
  invoice_number varchar(255),
  tax_free_total real,
  vat_amount real,
  due_date varchar(255),
  invoice_status varchar(255),
  deleted_at timestamp
);
