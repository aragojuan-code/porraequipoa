-- PORRA EQUIPO A — FASE 2
-- Ejecutar después de la fase 1.

create extension if not exists pgcrypto;

create table if not exists public.competitions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  season text,
  external_api_id text,
  first_match_kickoff timestamptz,
  predictions_close_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  name text not null,
  short_name text,
  country text,
  external_api_id text,
  logo_url text,
  created_at timestamptz default now(),
  unique(competition_id, name)
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  position text,
  goals int not null default 0,
  is_top_scorer boolean default false,
  external_api_id text,
  created_at timestamptz default now(),
  unique(competition_id, team_id, name)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references public.competitions(id) on delete cascade,
  external_api_id text,
  phase text not null default 'group',
  group_name text,
  home_team_id uuid not null references public.teams(id),
  away_team_id uuid not null references public.teams(id),
  kickoff timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled', 'finished', 'cancelled')),
  home_goals int,
  away_goals int,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(competition_id, home_team_id, away_team_id, kickoff)
);

alter table public.pools add column if not exists competition_id uuid references public.competitions(id);

create table if not exists public.pool_entries (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'locked')),
  submitted_at timestamptz,
  locked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(pool_id, user_id)
);

create table if not exists public.predictions (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  home_goals int not null check (home_goals >= 0 and home_goals <= 30),
  away_goals int not null check (away_goals >= 0 and away_goals <= 30),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(pool_id, user_id, match_id)
);

create table if not exists public.top_scorer_picks (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(pool_id, user_id)
);

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  pool_id uuid not null references public.pools(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_points numeric not null default 0,
  top_scorer_points numeric not null default 0,
  total_points numeric not null default 0,
  exact_results int not null default 0,
  correct_signs int not null default 0,
  updated_at timestamptz default now(),
  unique(pool_id, user_id)
);

alter table public.competitions enable row level security;
alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.matches enable row level security;
alter table public.pool_entries enable row level security;
alter table public.predictions enable row level security;
alter table public.top_scorer_picks enable row level security;
alter table public.scores enable row level security;

drop policy if exists "Authenticated can read competitions" on public.competitions;
create policy "Authenticated can read competitions" on public.competitions for select to authenticated using (true);
drop policy if exists "Authenticated can read teams" on public.teams;
create policy "Authenticated can read teams" on public.teams for select to authenticated using (true);
drop policy if exists "Authenticated can read players" on public.players;
create policy "Authenticated can read players" on public.players for select to authenticated using (true);
drop policy if exists "Authenticated can read matches" on public.matches;
create policy "Authenticated can read matches" on public.matches for select to authenticated using (true);

drop policy if exists "Members can read pool entries" on public.pool_entries;
create policy "Members can read pool entries" on public.pool_entries for select to authenticated using (public.is_pool_member(pool_id));
drop policy if exists "Users can insert own pool entry" on public.pool_entries;
create policy "Users can insert own pool entry" on public.pool_entries for insert to authenticated with check (user_id = auth.uid() and public.is_pool_member(pool_id));
drop policy if exists "Users can update own pool entry" on public.pool_entries;
create policy "Users can update own pool entry" on public.pool_entries for update to authenticated using (user_id = auth.uid() and public.is_pool_member(pool_id)) with check (user_id = auth.uid() and public.is_pool_member(pool_id));

drop policy if exists "Members can read predictions in their pools" on public.predictions;
create policy "Members can read predictions in their pools" on public.predictions for select to authenticated using (public.is_pool_member(pool_id));
drop policy if exists "Users can insert own predictions" on public.predictions;
create policy "Users can insert own predictions" on public.predictions for insert to authenticated with check (user_id = auth.uid() and public.is_pool_member(pool_id));
drop policy if exists "Users can update own predictions" on public.predictions;
create policy "Users can update own predictions" on public.predictions for update to authenticated using (user_id = auth.uid() and public.is_pool_member(pool_id)) with check (user_id = auth.uid() and public.is_pool_member(pool_id));

drop policy if exists "Members can read top scorer picks in their pools" on public.top_scorer_picks;
create policy "Members can read top scorer picks in their pools" on public.top_scorer_picks for select to authenticated using (public.is_pool_member(pool_id));
drop policy if exists "Users can insert own top scorer pick" on public.top_scorer_picks;
create policy "Users can insert own top scorer pick" on public.top_scorer_picks for insert to authenticated with check (user_id = auth.uid() and public.is_pool_member(pool_id));
drop policy if exists "Users can update own top scorer pick" on public.top_scorer_picks;
create policy "Users can update own top scorer pick" on public.top_scorer_picks for update to authenticated using (user_id = auth.uid() and public.is_pool_member(pool_id)) with check (user_id = auth.uid() and public.is_pool_member(pool_id));

drop policy if exists "Members can read scores in their pools" on public.scores;
create policy "Members can read scores in their pools" on public.scores for select to authenticated using (public.is_pool_member(pool_id));

create or replace function public.create_pool_with_owner(pool_name text, competition_uuid uuid default null)
returns public.pools
language plpgsql
security definer
set search_path = public
as $$
declare
  new_pool public.pools;
  generated_code text;
  comp_record public.competitions;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión'; end if;
  if length(trim(pool_name)) < 3 then raise exception 'El nombre de la porra es demasiado corto'; end if;

  if competition_uuid is null then
    select * into comp_record from public.competitions order by created_at asc limit 1;
  else
    select * into comp_record from public.competitions where id = competition_uuid limit 1;
  end if;
  if comp_record.id is null then raise exception 'No hay competición disponible'; end if;

  generated_code := 'ATEAM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.pools (owner_id, name, invite_code, competition_id, first_match_kickoff, predictions_close_at)
  values (auth.uid(), trim(pool_name), generated_code, comp_record.id, comp_record.first_match_kickoff, comp_record.predictions_close_at)
  returning * into new_pool;

  insert into public.pool_members (pool_id, user_id, role) values (new_pool.id, auth.uid(), 'owner') on conflict (pool_id, user_id) do nothing;
  insert into public.pool_entries (pool_id, user_id, status) values (new_pool.id, auth.uid(), 'draft') on conflict (pool_id, user_id) do nothing;
  return new_pool;
end;
$$;

create or replace function public.join_pool_by_code(code_input text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare target_pool_id uuid;
begin
  if auth.uid() is null then raise exception 'Debes iniciar sesión'; end if;
  select id into target_pool_id from public.pools where upper(invite_code) = upper(trim(code_input)) limit 1;
  if target_pool_id is null then raise exception 'Código de porra no encontrado'; end if;
  insert into public.pool_members (pool_id, user_id, role) values (target_pool_id, auth.uid(), 'member') on conflict (pool_id, user_id) do nothing;
  insert into public.pool_entries (pool_id, user_id, status) values (target_pool_id, auth.uid(), 'draft') on conflict (pool_id, user_id) do nothing;
  return target_pool_id;
end;
$$;

create or replace view public.my_pools as
select p.id, p.name, p.invite_code, p.owner_id, p.competition_id, c.name as competition_name,
       p.first_match_kickoff, p.predictions_close_at, p.created_at, pm.role,
       (select count(*) from public.pool_members pm2 where pm2.pool_id = p.id) as member_count
from public.pools p
join public.pool_members pm on pm.pool_id = p.id
left join public.competitions c on c.id = p.competition_id
where pm.user_id = auth.uid();
grant select on public.my_pools to authenticated;

do $$
declare
  comp_id uuid; spain_id uuid; italy_id uuid; france_id uuid; germany_id uuid; portugal_id uuid; england_id uuid;
begin
  insert into public.competitions (name, season, first_match_kickoff, predictions_close_at)
  values ('Eurocopa Demo', '2028', now() + interval '14 days', now() + interval '13 days')
  on conflict do nothing;
  select id into comp_id from public.competitions where name = 'Eurocopa Demo' limit 1;

  insert into public.teams (competition_id, name, short_name, country) values
    (comp_id, 'España', 'ESP', 'España'), (comp_id, 'Italia', 'ITA', 'Italia'),
    (comp_id, 'Francia', 'FRA', 'Francia'), (comp_id, 'Alemania', 'GER', 'Alemania'),
    (comp_id, 'Portugal', 'POR', 'Portugal'), (comp_id, 'Inglaterra', 'ENG', 'Inglaterra')
  on conflict (competition_id, name) do nothing;

  select id into spain_id from public.teams where competition_id = comp_id and name = 'España';
  select id into italy_id from public.teams where competition_id = comp_id and name = 'Italia';
  select id into france_id from public.teams where competition_id = comp_id and name = 'Francia';
  select id into germany_id from public.teams where competition_id = comp_id and name = 'Alemania';
  select id into portugal_id from public.teams where competition_id = comp_id and name = 'Portugal';
  select id into england_id from public.teams where competition_id = comp_id and name = 'Inglaterra';

  insert into public.players (competition_id, team_id, name, position, goals) values
    (comp_id, spain_id, 'Lamine Yamal', 'FW', 0), (comp_id, spain_id, 'Álvaro Morata', 'FW', 0),
    (comp_id, spain_id, 'Pedri', 'MF', 0), (comp_id, italy_id, 'Nicolò Barella', 'MF', 0),
    (comp_id, italy_id, 'Federico Chiesa', 'FW', 0), (comp_id, france_id, 'Kylian Mbappé', 'FW', 0),
    (comp_id, france_id, 'Antoine Griezmann', 'FW', 0), (comp_id, germany_id, 'Kai Havertz', 'FW', 0),
    (comp_id, germany_id, 'Jamal Musiala', 'MF', 0), (comp_id, portugal_id, 'Cristiano Ronaldo', 'FW', 0),
    (comp_id, portugal_id, 'Bruno Fernandes', 'MF', 0), (comp_id, england_id, 'Harry Kane', 'FW', 0),
    (comp_id, england_id, 'Jude Bellingham', 'MF', 0)
  on conflict (competition_id, team_id, name) do nothing;

  insert into public.matches (competition_id, phase, group_name, home_team_id, away_team_id, kickoff, status) values
    (comp_id, 'group', 'A', spain_id, italy_id, now() + interval '14 days', 'scheduled'),
    (comp_id, 'group', 'A', france_id, germany_id, now() + interval '14 days 3 hours', 'scheduled'),
    (comp_id, 'group', 'B', portugal_id, england_id, now() + interval '15 days', 'scheduled'),
    (comp_id, 'group', 'A', spain_id, france_id, now() + interval '17 days', 'scheduled'),
    (comp_id, 'group', 'A', germany_id, italy_id, now() + interval '17 days 3 hours', 'scheduled'),
    (comp_id, 'group', 'B', england_id, spain_id, now() + interval '20 days', 'scheduled')
  on conflict (competition_id, home_team_id, away_team_id, kickoff) do nothing;
end $$;
