# JRNL — Supabase Setup

Run this SQL on your existing Supabase project (same one as LEDGR + TASKR).

## SQL Editor → New Query → Run:

```sql
create table if not exists public.journal_entries (
  entry_id    text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null default '',
  content     text not null default '',
  entry_date  date not null,
  mood        text default '',
  images      jsonb default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists je_user_idx on public.journal_entries(user_id);
create index if not exists je_date_idx on public.journal_entries(entry_date);

alter table public.journal_entries enable row level security;

drop policy if exists "own rows" on public.journal_entries;
create policy "own rows" on public.journal_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

## Add your JRNL URL to Redirect URLs

Supabase → Authentication → URL Configuration → Redirect URLs → add:
```
https://YOUR-JRNL-URL.vercel.app
https://YOUR-JRNL-URL.vercel.app/**
```

Google login is already enabled from LEDGR setup — no extra steps needed.
