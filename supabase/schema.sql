-- Overflow Trade cloud schema. Run once in Supabase → SQL Editor → New query → Run.
-- Every row belongs to one user; Row Level Security makes sure users only ever see their own data.

-- Backtesting sessions (trades, drawings, journal, challenge state) as JSON documents.
create table if not exists public.sessions (
  user_id    uuid    not null default auth.uid() references auth.users (id) on delete cascade,
  id         text    not null,
  name       text    not null default '',
  data       jsonb   not null,
  updated_at bigint  not null,           -- client clock (ms), used for last-write-wins sync
  deleted    boolean not null default false,
  primary key (user_id, id)
);

-- Journal screenshots (JPEG data URLs), kept apart so session documents stay small.
create table if not exists public.shots (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id      text not null,
  data    text not null,
  primary key (user_id, id)
);

alter table public.sessions enable row level security;
alter table public.shots    enable row level security;

drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own shots" on public.shots;
create policy "own shots" on public.shots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Market data files (gzipped binary bars) in a private storage bucket, one folder per user.
insert into storage.buckets (id, name, public)
values ('datasets', 'datasets', false)
on conflict (id) do nothing;

drop policy if exists "own dataset files read"   on storage.objects;
drop policy if exists "own dataset files write"  on storage.objects;
drop policy if exists "own dataset files update" on storage.objects;
drop policy if exists "own dataset files delete" on storage.objects;

create policy "own dataset files read" on storage.objects for select
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own dataset files write" on storage.objects for insert
  with check (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own dataset files update" on storage.objects for update
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own dataset files delete" on storage.objects for delete
  using (bucket_id = 'datasets' and (storage.foldername(name))[1] = auth.uid()::text);
