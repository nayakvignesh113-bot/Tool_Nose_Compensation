-- =====================================================================
-- CNC video lesson: Tool Nose Radius Compensation — Supabase setup
-- Run ONCE in: Supabase Dashboard → (Nikasha project) → SQL Editor → New query → paste → Run
-- Safe to re-run. Creates only cnc_* objects; touches nothing else.
-- =====================================================================
begin;
-- TNRC video lesson: tracking + grading backend (all objects prefixed cnc_)
-- Students never touch tables directly: they call SECURITY DEFINER RPCs with an attempt token.
-- Instructors (emails in cnc_instructors) read everything through RLS after Supabase Auth login.

create extension if not exists pgcrypto;

create table if not exists public.cnc_modules (
  id text primary key,
  title text not null,
  duration_s numeric not null,
  is_open boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.cnc_questions (
  module_id text not null references public.cnc_modules(id) on delete cascade,
  qid text not null,
  ord int not null,
  scene text,
  prompt text not null,
  options jsonb not null,          -- [{id,text}]  (public)
  answer text not null,            -- correct option id (never sent before answering)
  feedback jsonb not null,         -- {option_id: why-wrong text}
  why text not null,               -- explanation of the correct answer
  primary key (module_id, qid)
);

create table if not exists public.cnc_attempts (
  id uuid primary key default gen_random_uuid(),
  module_id text not null references public.cnc_modules(id) on delete cascade,
  usn text not null,
  name text not null,
  token uuid not null default gen_random_uuid(),
  attempt_no int not null default 1,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  completed_at timestamptz,
  watched_s numeric not null default 0,
  max_pos_s numeric not null default 0,
  segments jsonb not null default '[]'::jsonb,   -- merged [[a,b],...] seconds actually watched
  active_s numeric not null default 0,           -- wall-clock seconds with the page visible
  score int not null default 0,
  answered int not null default 0,
  total int not null default 0,
  seek_blocked int not null default 0,
  tab_hidden int not null default 0,
  rewinds int not null default 0,
  user_agent text
);
create index if not exists cnc_attempts_mod_usn on public.cnc_attempts(module_id, usn);

create table if not exists public.cnc_responses (
  attempt_id uuid not null references public.cnc_attempts(id) on delete cascade,
  qid text not null,
  chosen text not null,
  correct boolean not null,
  time_ms int,
  video_pos numeric,
  answered_at timestamptz not null default now(),
  primary key (attempt_id, qid)
);

create table if not exists public.cnc_events (
  id bigserial primary key,
  attempt_id uuid not null references public.cnc_attempts(id) on delete cascade,
  kind text not null,
  pos numeric,
  data jsonb,
  at timestamptz not null default now()
);
create index if not exists cnc_events_attempt on public.cnc_events(attempt_id);

create table if not exists public.cnc_instructors (
  email text primary key
);

-- ---------- RLS ----------
alter table public.cnc_modules     enable row level security;
alter table public.cnc_questions   enable row level security;
alter table public.cnc_attempts    enable row level security;
alter table public.cnc_responses   enable row level security;
alter table public.cnc_events      enable row level security;
alter table public.cnc_instructors enable row level security;

-- instructor = signed-in user whose CONFIRMED email is on the allowlist
create or replace function public.cnc_is_instructor() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u join public.cnc_instructors i on lower(i.email) = lower(u.email)
                 where u.id = auth.uid() and u.email_confirmed_at is not null);
$$;
revoke all on function public.cnc_is_instructor() from public, anon;
grant execute on function public.cnc_is_instructor() to authenticated;

do $$ declare t text; begin
  foreach t in array array['cnc_modules','cnc_questions','cnc_attempts','cnc_responses','cnc_events','cnc_instructors'] loop
    execute format('drop policy if exists instructor_read on public.%I', t);
    execute format('create policy instructor_read on public.%I for select to authenticated using ((select public.cnc_is_instructor()))', t);
  end loop;
end $$;
-- instructors may delete test attempts and open/close a module
drop policy if exists instructor_delete on public.cnc_attempts;
create policy instructor_delete on public.cnc_attempts for delete to authenticated using ((select public.cnc_is_instructor()));
drop policy if exists instructor_update on public.cnc_modules;
create policy instructor_update on public.cnc_modules for update to authenticated using ((select public.cnc_is_instructor())) with check ((select public.cnc_is_instructor()));

revoke all on public.cnc_modules, public.cnc_questions, public.cnc_attempts, public.cnc_responses, public.cnc_events, public.cnc_instructors from anon;
revoke all on public.cnc_modules, public.cnc_questions, public.cnc_attempts, public.cnc_responses, public.cnc_events, public.cnc_instructors from authenticated;
grant select on public.cnc_modules, public.cnc_questions, public.cnc_attempts, public.cnc_responses, public.cnc_events, public.cnc_instructors to authenticated;
grant delete on public.cnc_attempts to authenticated;
grant update (is_open) on public.cnc_modules to authenticated;

-- ---------- helpers ----------
create or replace function public.cnc_auth(p_attempt uuid, p_token uuid)
returns public.cnc_attempts language plpgsql stable security definer set search_path = public as $$
declare a public.cnc_attempts;
begin
  select * into a from public.cnc_attempts where id = p_attempt and token = p_token;
  if not found then raise exception 'invalid attempt' using errcode = '28000'; end if;
  return a;
end $$;
revoke all on function public.cnc_auth(uuid, uuid) from public, anon, authenticated;

-- merge [[a,b],...] intervals
create or replace function public.cnc_merge(p jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare r jsonb := '[]'::jsonb; cur_a numeric; cur_b numeric; x record;
begin
  for x in select (e->>0)::numeric a, (e->>1)::numeric b from jsonb_array_elements(coalesce(p,'[]'::jsonb)) e
           where jsonb_typeof(e) = 'array' and (e->>1)::numeric > (e->>0)::numeric order by 1 loop
    if cur_a is null then cur_a := x.a; cur_b := x.b;
    elsif x.a <= cur_b + 0.75 then cur_b := greatest(cur_b, x.b);
    else r := r || jsonb_build_array(jsonb_build_array(round(cur_a,2), round(cur_b,2))); cur_a := x.a; cur_b := x.b; end if;
  end loop;
  if cur_a is not null then r := r || jsonb_build_array(jsonb_build_array(round(cur_a,2), round(cur_b,2))); end if;
  return r;
end $$;

-- ---------- student RPCs (anon) ----------
create or replace function public.cnc_start(p_module text, p_usn text, p_name text, p_ua text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.cnc_modules; a public.cnc_attempts; n int; today int; v_usn text := upper(regexp_replace(coalesce(p_usn,''), '\s', '', 'g'));
        nm text := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g')); best int;
begin
  select * into m from public.cnc_modules where id = p_module;
  if not found then raise exception 'unknown module'; end if;
  if not m.is_open then raise exception 'This lesson is closed by the instructor.'; end if;
  if v_usn !~ '^[0-9][A-Z]{2}[0-9]{2}[A-Z]{2,3}[0-9]{3}$' then raise exception 'Enter a valid USN (e.g. 4MT22ME001).'; end if;
  if length(nm) < 2 or length(nm) > 80 then raise exception 'Enter your full name.'; end if;
  select count(*) into today from public.cnc_attempts where module_id = p_module and usn = v_usn and started_at > now() - interval '1 day';
  if today >= 10 then raise exception 'Too many attempts today. Try again tomorrow.'; end if;
  select count(*), max(score) into n, best from public.cnc_attempts where module_id = p_module and usn = v_usn;
  insert into public.cnc_attempts(module_id, usn, name, attempt_no, total, user_agent)
  values (p_module, v_usn, nm, n + 1, (select count(*) from public.cnc_questions where module_id = p_module), left(p_ua, 300))
  returning * into a;
  return jsonb_build_object('attempt_id', a.id, 'token', a.token, 'attempt_no', a.attempt_no, 'usn', a.usn, 'name', a.name,
    'previous_best', best, 'duration', m.duration_s, 'title', m.title,
    'questions', (select jsonb_agg(jsonb_build_object('qid', qid, 'scene', scene, 'prompt', prompt, 'options', options) order by ord)
                  from public.cnc_questions where module_id = p_module));
end $$;

create or replace function public.cnc_resume(p_attempt uuid, p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.cnc_attempts := public.cnc_auth(p_attempt, p_token);
begin
  return jsonb_build_object('attempt_id', a.id, 'attempt_no', a.attempt_no, 'usn', a.usn, 'name', a.name,
    'max_pos', a.max_pos_s, 'segments', a.segments, 'completed', a.completed_at is not null, 'score', a.score,
    'duration', (select duration_s from public.cnc_modules where id = a.module_id),
    'questions', (select jsonb_agg(jsonb_build_object('qid', qid, 'scene', scene, 'prompt', prompt, 'options', options) order by ord)
                  from public.cnc_questions where module_id = a.module_id),
    'answered', coalesce((select jsonb_agg(jsonb_build_object('qid', r.qid, 'chosen', r.chosen, 'correct', r.correct,
                    'answer', q.answer, 'why', q.why, 'feedback', q.feedback -> r.chosen))
                  from public.cnc_responses r join public.cnc_questions q on q.module_id = a.module_id and q.qid = r.qid
                  where r.attempt_id = a.id), '[]'::jsonb));
end $$;

create or replace function public.cnc_answer(p_attempt uuid, p_token uuid, p_qid text, p_chosen text, p_time_ms int default null, p_pos numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.cnc_attempts := public.cnc_auth(p_attempt, p_token); q public.cnc_questions; r public.cnc_responses; ok boolean; first boolean := false;
begin
  if a.completed_at is not null then raise exception 'attempt already completed'; end if;
  select * into q from public.cnc_questions where module_id = a.module_id and qid = p_qid;
  if not found then raise exception 'unknown question'; end if;
  if not exists (select 1 from jsonb_array_elements(q.options) o where o->>'id' = p_chosen) then raise exception 'invalid option'; end if;
  ok := (p_chosen = q.answer);
  insert into public.cnc_responses(attempt_id, qid, chosen, correct, time_ms, video_pos)
  values (a.id, p_qid, p_chosen, ok, least(greatest(coalesce(p_time_ms,0),0), 3600000), p_pos)
  on conflict (attempt_id, qid) do nothing
  returning * into r;
  if r.attempt_id is not null then
    first := true;
    update public.cnc_attempts set answered = answered + 1, score = score + (case when ok then 1 else 0 end), last_seen = now() where id = a.id;
  else
    select * into r from public.cnc_responses where attempt_id = a.id and qid = p_qid;
  end if;
  return jsonb_build_object('first', first, 'chosen', r.chosen, 'correct', r.correct, 'answer', q.answer, 'why', q.why,
                            'feedback', q.feedback -> r.chosen);
end $$;

create or replace function public.cnc_progress(p_attempt uuid, p_token uuid, p_max_pos numeric, p_segments jsonb,
                                               p_active_s numeric default 0, p_events jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.cnc_attempts := public.cnc_auth(p_attempt, p_token); dur numeric; seg jsonb; w numeric; e jsonb; k int := 0;
begin
  select duration_s into dur from public.cnc_modules where id = a.module_id;
  seg := public.cnc_merge(coalesce(a.segments,'[]'::jsonb) || coalesce(p_segments,'[]'::jsonb));
  -- clamp to the video length
  select coalesce(jsonb_agg(jsonb_build_array(greatest(0,(x->>0)::numeric), least(dur,(x->>1)::numeric))), '[]'::jsonb) into seg
    from jsonb_array_elements(seg) x where (x->>0)::numeric < dur;
  select coalesce(sum((x->>1)::numeric - (x->>0)::numeric), 0) into w from jsonb_array_elements(seg) x;
  for e in select * from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) loop
    k := k + 1; exit when k > 50;
    if (select count(*) from public.cnc_events where attempt_id = a.id) < 2000 then
      insert into public.cnc_events(attempt_id, kind, pos, data) values (a.id, left(e->>'kind', 32), (e->>'pos')::numeric, e->'data');
    end if;
  end loop;
  update public.cnc_attempts set
    segments = seg, watched_s = round(w, 1),
    max_pos_s = least(dur, greatest(max_pos_s, coalesce(p_max_pos, 0))),
    active_s = active_s + least(greatest(coalesce(p_active_s, 0), 0), 120),
    seek_blocked = seek_blocked + (select count(*) from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) x where x->>'kind' = 'seek_blocked'),
    tab_hidden   = tab_hidden   + (select count(*) from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) x where x->>'kind' = 'tab_hidden'),
    rewinds      = rewinds      + (select count(*) from jsonb_array_elements(coalesce(p_events,'[]'::jsonb)) x where x->>'kind' in ('rewatch','rewind')),
    last_seen = now()
  where id = a.id;
  return jsonb_build_object('watched_s', round(w,1), 'duration', dur);
end $$;

create or replace function public.cnc_complete(p_attempt uuid, p_token uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.cnc_attempts := public.cnc_auth(p_attempt, p_token); dur numeric;
begin
  select duration_s into dur from public.cnc_modules where id = a.module_id;
  if a.answered < a.total then raise exception 'answer all questions first'; end if;
  update public.cnc_attempts set completed_at = coalesce(completed_at, now()), last_seen = now() where id = a.id returning * into a;
  return jsonb_build_object('score', a.score, 'total', a.total, 'watched_pct', round(100 * a.watched_s / nullif(dur,0)),
    'attempt_no', a.attempt_no, 'completed_at', a.completed_at,
    'best', (select max(score) from public.cnc_attempts where module_id = a.module_id and usn = a.usn));
end $$;

revoke all on function public.cnc_start(text,text,text,text), public.cnc_resume(uuid,uuid), public.cnc_answer(uuid,uuid,text,text,int,numeric),
  public.cnc_progress(uuid,uuid,numeric,jsonb,numeric,jsonb), public.cnc_complete(uuid,uuid), public.cnc_merge(jsonb) from public;
revoke all on function public.cnc_merge(jsonb) from anon, authenticated;
grant execute on function public.cnc_start(text,text,text,text), public.cnc_resume(uuid,uuid), public.cnc_answer(uuid,uuid,text,text,int,numeric),
  public.cnc_progress(uuid,uuid,numeric,jsonb,numeric,jsonb), public.cnc_complete(uuid,uuid) to anon, authenticated;

-- ---------- lesson + questions ----------
insert into public.cnc_modules(id,title,duration_s) values ('tnrc-v1','Tool Nose Radius Compensation (G41/G42/G40)',346.625)
 on conflict (id) do update set title=excluded.title, duration_s=excluded.duration_s;
insert into public.cnc_questions(module_id,qid,ord,scene,prompt,options,answer,feedback,why) values
('tnrc-v1','q1',1,'nose','With tool nose radius compensation OFF, which point does the control move exactly along the programmed path?','[{"id": "a", "text": "The centre of the nose radius"}, {"id": "b", "text": "The imaginary tool tip, where the X and Z tangents to the nose meet"}, {"id": "c", "text": "The actual point of the nose arc that is in contact with the work"}, {"id": "d", "text": "The turret reference point"}]'::jsonb,'b','{"a": "The nose centre is only the programmed point when tip code 0 or 9 is used. Normally, offsets are touched off on X and Z, which locate the imaginary tip.", "b": "", "c": "The contact point moves around the arc as the direction changes. The control doesn''t track it — that is exactly why errors appear.", "d": "The tool geometry offsets shift the turret reference to the touched-off point — the imaginary tip — so that is what follows the path."}'::jsonb,'Touch-off sets X on the diameter and Z on the face; both lie on tangents whose intersection is the imaginary tip, so that is the point the control drives along the path.'),('tnrc-v1','q2',2,'error','On which features does an uncompensated nose radius produce NO dimensional error?','[{"id": "a", "text": "45° chamfers"}, {"id": "b", "text": "Convex corner radii"}, {"id": "c", "text": "Straight turning along Z and facing along X"}, {"id": "d", "text": "Tapers of any angle"}]'::jsonb,'c','{"a": "45° is where the error is largest (0.414 R).", "b": "Arcs are cut oversize; the error peaks halfway around the arc.", "c": "", "d": "Any taper between 0° and 90° has a non-zero error R(sin θ + cos θ − 1)."}'::jsonb,'Moving parallel to Z or X, the nose''s tangent point lies on the same line as the imaginary tip, so the cut surface lands exactly on the programmed line.'),('tnrc-v1','q3',3,'calc','A 45° chamfer is finished with a 0.8 mm nose radius and compensation OFF. The error normal to the chamfer is about:','[{"id": "a", "text": "0.80 mm"}, {"id": "b", "text": "0.23 mm"}, {"id": "c", "text": "1.13 mm"}, {"id": "d", "text": "0.33 mm"}]'::jsonb,'d','{"a": "That is R itself. The error is R(sin 45° + cos 45° − 1) = 0.414 R.", "b": "0.23 mm is R(1 − cos 45°) — not the right relation. Use e = R(sin θ + cos θ − 1).", "c": "1.13 mm is R√2 — the distance from nose centre to imaginary tip, not the surface error.", "d": ""}'::jsonb,'e = R(sin 45° + cos 45° − 1) = 0.414 × 0.8 ≈ 0.33 mm, normal to the chamfer (≈ 0.94 mm on diameter).'),('tnrc-v1','q4',4,'g4142','Standard lathe view (+X up, tool above the centre line). Outside-diameter turning toward the chuck uses:','[{"id": "a", "text": "G41"}, {"id": "b", "text": "G42"}, {"id": "c", "text": "G40"}, {"id": "d", "text": "G43"}]'::jsonb,'b','{"a": "Facing along the motion (−Z), the tool is on the RIGHT of the profile, so it is G42. G41 is for boring toward the chuck.", "b": "", "c": "G40 cancels compensation.", "d": "G43 is tool length compensation on machining centres, not nose radius compensation."}'::jsonb,'Facing along the motion (toward the chuck, −Z) with the tool above the profile, the tool is on the right → G42.'),('tnrc-v1','q5',5,'g4142','Same view. Boring an inside diameter toward the chuck uses:','[{"id": "a", "text": "G42"}, {"id": "b", "text": "G40"}, {"id": "c", "text": "G41"}, {"id": "d", "text": "Either — the control decides from the tip code"}]'::jsonb,'c','{"a": "Inside the bore the tool is on the other side of the profile — LEFT of the motion — so G41.", "b": "G40 cancels compensation.", "c": "", "d": "The tip code sets where the imaginary tip lies on the nose; the side of the profile is still chosen by G41/G42."}'::jsonb,'Inside the bore the tool is below the wall it cuts — on the left of the motion toward the chuck → G41.'),('tnrc-v1','q6',6,'offsets','Which two values must be in the tool offset page for compensation to work correctly?','[{"id": "a", "text": "Nose radius R and tip orientation code T"}, {"id": "b", "text": "X and Z geometry offsets only"}, {"id": "c", "text": "Nose radius R and the wear X value"}, {"id": "d", "text": "Cutting speed and feed"}]'::jsonb,'a','{"a": "", "b": "X and Z locate the imaginary tip, but without R and T the control can''t compute the nose-centre offset.", "c": "Wear X adjusts size; the control still needs T to know where the imaginary tip lies.", "d": "Speed and feed are programmed with S and F; they do not affect the compensation geometry."}'::jsonb,'R gives the offset distance and T tells the control where the imaginary tip lies relative to the nose centre; both are needed.'),('tnrc-v1','q7',7,'offsets','What does the tip orientation code (T) tell the control?','[{"id": "a", "text": "The insert shape (C, D, V…)"}, {"id": "b", "text": "The direction of the imaginary tip from the nose centre"}, {"id": "c", "text": "Which side of the profile the tool is on"}, {"id": "d", "text": "How much nose wear to add"}]'::jsonb,'b','{"a": "Insert shape is not entered for compensation. T describes direction only.", "b": "", "c": "That is chosen in the program with G41/G42, not by T.", "d": "Wear is entered in the wear R column; T is a direction code."}'::jsonb,'T is a direction code: which way the imaginary tip lies from the nose centre (0/9 = the centre itself).'),('tnrc-v1','q8',8,'program','Which is the correct way to switch ON nose radius compensation?','[{"id": "a", "text": "On the first G02/G03 arc of the profile"}, {"id": "b", "text": "On a straight G00/G01 move, clear of the part, longer than the nose radius"}, {"id": "c", "text": "In a block with no X or Z motion, just before the profile"}, {"id": "d", "text": "On the first cutting move, with the tool already touching the part"}]'::jsonb,'b','{"a": "Starting compensation on an arc raises an alarm on most controls.", "b": "", "c": "The offset is built up during motion; a block with no X/Z motion gives it nothing to work with.", "d": "The tool would gouge or leave a mark as the offset builds up. Start in clear air."}'::jsonb,'The offset is built up during a straight move; it must happen in clear air and be longer than the nose radius.')
on conflict (module_id,qid) do update set ord=excluded.ord,scene=excluded.scene,prompt=excluded.prompt,options=excluded.options,answer=excluded.answer,feedback=excluded.feedback,why=excluded.why;

-- Who may open the instructor dashboard (must be a CONFIRMED Supabase Auth user in this project)
insert into public.cnc_instructors(email) values ('nayak.vignesh113@gmail.com') on conflict do nothing;
commit;
