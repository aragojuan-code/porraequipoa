-- Phase 3A - manual results, scoring and ranking

alter table public.scores enable row level security;

create policy if not exists "scores_select_pool_members"
on public.scores
for select
using (
  exists (
    select 1
    from public.pool_members pm
    where pm.pool_id = scores.pool_id
      and pm.user_id = auth.uid()
  )
);

create policy if not exists "scores_upsert_pool_admin"
on public.scores
for all
using (public.is_pool_admin(scores.pool_id))
with check (public.is_pool_admin(scores.pool_id));

create or replace function public.recalculate_pool_scores(pool_uuid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  member_rec record;
  match_pts int;
  exact_hits int;
  sign_hits int;
  top_pts int;
  total_pts int;
begin
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
          when m.home_goals is null or m.away_goals is null then 0
          when p.home_goals = m.home_goals and p.away_goals = m.away_goals then 3
          when sign(p.home_goals - p.away_goals) = sign(m.home_goals - m.away_goals) then 1
          else 0
        end
      ), 0),
      coalesce(sum(
        case when m.home_goals is not null and m.away_goals is not null and p.home_goals = m.home_goals and p.away_goals = m.away_goals then 1 else 0 end
      ), 0),
      coalesce(sum(
        case when m.home_goals is not null and m.away_goals is not null and not (p.home_goals = m.home_goals and p.away_goals = m.away_goals) and sign(p.home_goals - p.away_goals) = sign(m.home_goals - m.away_goals) then 1 else 0 end
      ), 0)
    into match_pts, exact_hits, sign_hits
    from public.predictions p
    join public.matches m on m.id = p.match_id
    where p.pool_id = pool_uuid
      and p.user_id = member_rec.user_id;

    select
      coalesce(pl.goals, 0) + case when coalesce(pl.is_top_scorer, false) then 5 else 0 end
    into top_pts
    from public.top_scorer_picks tsp
    left join public.players pl on pl.id = tsp.player_id
    where tsp.pool_id = pool_uuid
      and tsp.user_id = member_rec.user_id;

    top_pts := coalesce(top_pts, 0);
    match_pts := coalesce(match_pts, 0);
    exact_hits := coalesce(exact_hits, 0);
    sign_hits := coalesce(sign_hits, 0);
    total_pts := match_pts + top_pts;

    insert into public.scores (pool_id, user_id, match_points, top_scorer_points, exact_count, sign_count, total_points, updated_at)
    values (pool_uuid, member_rec.user_id, match_pts, top_pts, exact_hits, sign_hits, total_pts, now())
    on conflict (pool_id, user_id)
    do update
      set match_points = excluded.match_points,
          top_scorer_points = excluded.top_scorer_points,
          exact_count = excluded.exact_count,
          sign_count = excluded.sign_count,
          total_points = excluded.total_points,
          updated_at = now();
  end loop;
end;
$$;

create or replace function public.update_match_result(match_uuid uuid, home_score int, away_score int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pool_ref uuid;
begin
  select p.id into pool_ref
  from public.pools p
  join public.matches m on m.competition_id = p.competition_id
  where m.id = match_uuid
  limit 1;

  if pool_ref is null then
    raise exception 'Match not linked to a pool competition';
  end if;

  if not public.is_pool_admin(pool_ref) then
    raise exception 'Only pool admin can update match result';
  end if;

  update public.matches
  set home_goals = home_score,
      away_goals = away_score,
      status = 'finished',
      updated_at = now()
  where id = match_uuid;
end;
$$;

create or replace function public.update_player_goals(player_uuid uuid, goals_count int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pool_ref uuid;
begin
  select p.id into pool_ref
  from public.pools p
  join public.players pl on pl.competition_id = p.competition_id
  where pl.id = player_uuid
  limit 1;

  if pool_ref is null then
    raise exception 'Player not linked to a pool competition';
  end if;

  if not public.is_pool_admin(pool_ref) then
    raise exception 'Only pool admin can update player goals';
  end if;

  update public.players
  set goals = goals_count,
      updated_at = now()
  where id = player_uuid;
end;
$$;
