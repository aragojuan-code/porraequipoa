-- PHASE 3A FIXED — manual results, scoring and ranking
-- Ejecutar completo en Supabase SQL Editor.

-- =========================
-- 0. Asegurar columnas necesarias
-- =========================

alter table public.scores
add column if not exists exact_count int not null default 0;

alter table public.scores
add column if not exists sign_count int not null default 0;

alter table public.scores
add column if not exists exact_results int not null default 0;

alter table public.scores
add column if not exists correct_signs int not null default 0;

alter table public.scores
add column if not exists updated_at timestamptz default now();

alter table public.players
add column if not exists updated_at timestamptz default now();

alter table public.matches
add column if not exists updated_at timestamptz default now();

-- =========================
-- 1. RLS scores
-- =========================

alter table public.scores enable row level security;

drop policy if exists "scores_select_pool_members" on public.scores;

create policy "scores_select_pool_members"
on public.scores
for select
to authenticated
using (
  exists (
    select 1
    from public.pool_members pm
    where pm.pool_id = scores.pool_id
      and pm.user_id = auth.uid()
  )
);

drop policy if exists "scores_upsert_pool_admin" on public.scores;

create policy "scores_upsert_pool_admin"
on public.scores
for all
to authenticated
using (public.is_pool_admin(scores.pool_id))
with check (public.is_pool_admin(scores.pool_id));

-- =========================
-- 2. Recalcular ranking de una porra
-- =========================

create or replace function public.recalculate_pool_scores(pool_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_rec record;
  match_pts numeric;
  exact_hits int;
  sign_hits int;
  top_pts numeric;
  total_pts numeric;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  if not public.is_pool_admin(pool_uuid) then
    raise exception 'Only pool admin can recalculate scores';
  end if;

  for member_rec in
    select pm.user_id
    from public.pool_members pm
    where pm.pool_id = pool_uuid
  loop

    select
      coalesce(sum(
        case
          when m.status <> 'finished' then 0
          when m.home_goals is null or m.away_goals is null then 0
          when p.home_goals = m.home_goals and p.away_goals = m.away_goals then 3
          when sign(p.home_goals - p.away_goals) = sign(m.home_goals - m.away_goals) then 1
          else 0
        end
      ), 0),

      coalesce(sum(
        case
          when m.status = 'finished'
           and m.home_goals is not null
           and m.away_goals is not null
           and p.home_goals = m.home_goals
           and p.away_goals = m.away_goals
          then 1
          else 0
        end
      ), 0),

      coalesce(sum(
        case
          when m.status = 'finished'
           and m.home_goals is not null
           and m.away_goals is not null
           and not (p.home_goals = m.home_goals and p.away_goals = m.away_goals)
           and sign(p.home_goals - p.away_goals) = sign(m.home_goals - m.away_goals)
          then 1
          else 0
        end
      ), 0)

    into match_pts, exact_hits, sign_hits
    from public.predictions p
    join public.matches m on m.id = p.match_id
    where p.pool_id = pool_uuid
      and p.user_id = member_rec.user_id;

    select
      coalesce(pl.goals, 0)
      +
      case
        when coalesce(pl.is_top_scorer, false) then 5
        else 0
      end
    into top_pts
    from public.top_scorer_picks tsp
    left join public.players pl on pl.id = tsp.player_id
    where tsp.pool_id = pool_uuid
      and tsp.user_id = member_rec.user_id;

    match_pts := coalesce(match_pts, 0);
    top_pts := coalesce(top_pts, 0);
    exact_hits := coalesce(exact_hits, 0);
    sign_hits := coalesce(sign_hits, 0);
    total_pts := match_pts + top_pts;

    insert into public.scores (
      pool_id,
      user_id,
      match_points,
      top_scorer_points,
      total_points,
      exact_results,
      correct_signs,
      exact_count,
      sign_count,
      updated_at
    )
    values (
      pool_uuid,
      member_rec.user_id,
      match_pts,
      top_pts,
      total_pts,
      exact_hits,
      sign_hits,
      exact_hits,
      sign_hits,
      now()
    )
    on conflict (pool_id, user_id)
    do update set
      match_points = excluded.match_points,
      top_scorer_points = excluded.top_scorer_points,
      total_points = excluded.total_points,
      exact_results = excluded.exact_results,
      correct_signs = excluded.correct_signs,
      exact_count = excluded.exact_count,
      sign_count = excluded.sign_count,
      updated_at = now();

  end loop;
end;
$$;

-- =========================
-- 3. Actualizar resultado real de un partido
-- =========================

create or replace function public.update_match_result(
  match_uuid uuid,
  home_score int,
  away_score int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  comp_ref uuid;
  can_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  if home_score < 0 or away_score < 0 then
    raise exception 'Los goles no pueden ser negativos';
  end if;

  select competition_id
  into comp_ref
  from public.matches
  where id = match_uuid
  limit 1;

  if comp_ref is null then
    raise exception 'Match not found';
  end if;

  select exists (
    select 1
    from public.pools p
    where p.competition_id = comp_ref
      and public.is_pool_admin(p.id)
  )
  into can_admin;

  if not can_admin then
    raise exception 'Only pool admin can update match result';
  end if;

  update public.matches
  set
    home_goals = home_score,
    away_goals = away_score,
    status = 'finished',
    updated_at = now()
  where id = match_uuid;
end;
$$;

-- =========================
-- 4. Actualizar goles de jugador
-- =========================

create or replace function public.update_player_goals(
  player_uuid uuid,
  goals_count int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  comp_ref uuid;
  can_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  if goals_count < 0 then
    raise exception 'Los goles no pueden ser negativos';
  end if;

  select competition_id
  into comp_ref
  from public.players
  where id = player_uuid
  limit 1;

  if comp_ref is null then
    raise exception 'Player not found';
  end if;

  select exists (
    select 1
    from public.pools p
    where p.competition_id = comp_ref
      and public.is_pool_admin(p.id)
  )
  into can_admin;

  if not can_admin then
    raise exception 'Only pool admin can update player goals';
  end if;

  update public.players
  set
    goals = goals_count,
    updated_at = now()
  where id = player_uuid;
end;
$$;

-- =========================
-- 5. Marcar jugador como pichichi final, opcional
-- =========================

create or replace function public.update_player_top_scorer(
  player_uuid uuid,
  is_top boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  comp_ref uuid;
  can_admin boolean;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión';
  end if;

  select competition_id
  into comp_ref
  from public.players
  where id = player_uuid
  limit 1;

  if comp_ref is null then
    raise exception 'Player not found';
  end if;

  select exists (
    select 1
    from public.pools p
    where p.competition_id = comp_ref
      and public.is_pool_admin(p.id)
  )
  into can_admin;

  if not can_admin then
    raise exception 'Only pool admin can update top scorer';
  end if;

  update public.players
  set
    is_top_scorer = is_top,
    updated_at = now()
  where id = player_uuid;
end;
$$;

-- =========================
-- 6. Permisos de ejecución
-- =========================

grant execute on function public.recalculate_pool_scores(uuid) to authenticated;
grant execute on function public.update_match_result(uuid, int, int) to authenticated;
grant execute on function public.update_player_goals(uuid, int) to authenticated;
grant execute on function public.update_player_top_scorer(uuid, boolean) to authenticated;
