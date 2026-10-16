-- Vitals 2.2: cycle tracking. One row per logged day, private to the person who logs it.
-- Safe to run more than once.

create table if not exists public.ct_cycle (
  user_id    uuid not null default auth.uid(),
  day        date not null,
  flow       text check (flow in ('spotting', 'light', 'medium', 'heavy')),
  symptoms   text[] not null default '{}' check (cardinality(symptoms) <= 12),
  note       text check (char_length(note) <= 300),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.ct_cycle enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ct_cycle' and policyname = 'own rows') then
    create policy "own rows" on public.ct_cycle for all
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  end if;
end $$;

-- Each person switches cycle tracking on for themselves in Settings.
alter table public.ct_settings add column if not exists cycle_on boolean not null default false;

notify pgrst, 'reload schema';
