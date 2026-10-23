-- All campaign and accounting money is integer USD cents. No donor card/bank data.
create extension if not exists pgcrypto;
create table public.staff_members(user_id uuid primary key references auth.users(id),role text not null check(role in ('owner','finance','editor')),created_at timestamptz not null default now());
create table public.campaigns(
 id uuid primary key default gen_random_uuid(),slug text unique not null,title text not null,goal_cents bigint not null check(goal_cents>0),currency text not null default 'USD' check(currency='USD'),
 status text not null default 'draft' check(status in ('draft','published','closed')),accepting_donations boolean not null default false,
 activities text not null default '',beneficiaries text not null default '',location text not null default '',eligibility text not null default '',selection_process text not null default '',budget text not null default '',timeline text not null default '',underfunding text not null default '',excess_funds text not null default '',delivery_impossible text not null default '',update_schedule text not null default '',refunds text not null default '',cancellation text not null default '',privacy text not null default '',safeguarding text not null default '',complaints text not null default '',support_email text not null default '',terms_version text not null default 'draft-1',created_at timestamptz not null default now()
);
insert into public.campaigns(slug,title,goal_cents) values('founding-fund','AfriRise founding fund',50000000);
create table public.donation_intents(
 id uuid primary key default gen_random_uuid(),idempotency_key uuid unique not null,status_token uuid unique not null default gen_random_uuid(),campaign_id uuid not null references public.campaigns(id),
 amount_cents bigint not null check(amount_cents between 100 and 100000000),currency text not null default 'USD' check(currency='USD'),frequency text not null check(frequency in ('once','monthly')),email text not null,name text not null default '',public_anonymous boolean not null default false,newsletter_consent boolean not null default false,terms_version text not null,consented_at timestamptz not null default now(),
 status text not null default 'pending' check(status in ('pending','paid','review')),checkout_id text unique,checkout_url text,subscription_id text,last_event_at timestamptz,created_at timestamptz not null default now()
);
create table public.webhook_events(event_id text primary key,event_type text not null,payload jsonb not null,status text not null default 'received',created_at timestamptz not null default now());
create table public.payments(id uuid primary key default gen_random_uuid(),intent_id uuid not null references public.donation_intents(id),provider_charge_id text unique not null,amount_cents bigint not null check(amount_cents>0),fee_cents bigint check(fee_cents>=0),refunded_cents bigint not null default 0 check(refunded_cents>=0 and refunded_cents<=amount_cents),currency text not null default 'USD' check(currency='USD'),created_at timestamptz not null default now());
create table public.receipts(id uuid primary key default gen_random_uuid(),intent_id uuid not null references public.donation_intents(id),payment_id uuid unique not null references public.payments(id),receipt_number text unique not null,amount_cents bigint not null,currency text not null default 'USD' check(currency='USD'),issued_at timestamptz not null default now(),created_at timestamptz not null default now());
create table public.expenses(id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.campaigns(id),description text not null,amount_cents bigint not null check(amount_cents>0),currency text not null default 'USD' check(currency='USD'),submitted_by uuid not null references auth.users(id),approved_by uuid references auth.users(id),status text not null default 'submitted' check(status in ('submitted','approved','rejected')),created_at timestamptz not null default now());
create table public.reconciliations(id uuid primary key default gen_random_uuid(),payment_id uuid not null references public.payments(id),bank_reference text not null,bank_received_cents bigint not null check(bank_received_cents>=0),currency text not null default 'USD' check(currency='USD'),note text not null default '',recorded_by uuid not null references auth.users(id),created_at timestamptz not null default now());
create table public.milestones(id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.campaigns(id),title text not null,description text not null,due_date date,outcome text not null default '',created_at timestamptz not null default now());
create table public.content_submissions(id uuid primary key default gen_random_uuid(),campaign_id uuid references public.campaigns(id),title text not null,body text not null,consent_reference text not null default '',submitted_by uuid not null references auth.users(id),approved_by uuid references auth.users(id),status text not null default 'draft' check(status in ('draft','approved','rejected')),created_at timestamptz not null default now());
create table public.support_requests(id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('privacy','complaint','cancel_recurring')),email text not null,message text not null,status text not null default 'open',created_at timestamptz not null default now());
create table public.audit_log(id uuid primary key default gen_random_uuid(),actor_id uuid references auth.users(id),action text not null,record_id text,created_at timestamptz not null default now());
-- No browser-facing access to operational tables, even for signed-in users.
do $$ declare t text;begin foreach t in array array['staff_members','campaigns','donation_intents','webhook_events','payments','receipts','expenses','reconciliations','milestones','content_submissions','support_requests','audit_log'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on table public.%I from anon, authenticated',t);execute format('grant all on table public.%I to service_role',t);end loop;end $$;
create index on public.donation_intents(campaign_id);
create index on public.donation_intents(subscription_id);
create index on public.payments(intent_id);
create function public.reserve_donation(p_key uuid,p_campaign uuid,p_amount bigint,p_frequency text,p_email text,p_name text,p_anonymous boolean,p_newsletter boolean,p_terms text) returns jsonb language plpgsql security definer set search_path=public as $$
declare d donation_intents;c campaigns;begin
 select * into c from campaigns where id=p_campaign for share;
 if c.id is null or c.status<>'published' or not c.accepting_donations or c.terms_version<>p_terms then raise exception 'Campaign unavailable';end if;
 insert into donation_intents(idempotency_key,campaign_id,amount_cents,frequency,email,name,public_anonymous,newsletter_consent,terms_version) values(p_key,p_campaign,p_amount,p_frequency,p_email,p_name,p_anonymous,p_newsletter,p_terms) on conflict(idempotency_key) do nothing;
 select * into d from donation_intents where idempotency_key=p_key for update;
 if d.campaign_id<>p_campaign or d.amount_cents<>p_amount or d.frequency<>p_frequency or d.email<>p_email or d.name<>p_name or d.public_anonymous<>p_anonymous or d.newsletter_consent<>p_newsletter or d.terms_version<>p_terms then raise exception 'Idempotency conflict';end if;
 return jsonb_build_object('id',d.id,'status_token',d.status_token);
end $$;
create function public.process_bachs_event(p_event jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare d donation_intents;p payments;seen integer;stamp timestamptz;begin
 insert into webhook_events(event_id,event_type,payload) values(p_event->>'event_id',p_event->>'event_type',p_event) on conflict do nothing;
 get diagnostics seen=row_count;if seen=0 then return '{"duplicate":true}'::jsonb;end if;
 select * into d from donation_intents where (id::text=p_event->>'reference') or (checkout_id=p_event->>'checkout_id') or (subscription_id=p_event->>'subscription_id') limit 1 for update;
 if d.id is null then update webhook_events set status='unmatched' where event_id=p_event->>'event_id';return '{"review":true}'::jsonb;end if;
 stamp=(p_event->>'occurred_at')::timestamptz;
 if p_event->>'event_type'='collection.succeeded' then
  if p_event->>'currency'<>'USD' or (p_event->>'amount_cents')::bigint<>d.amount_cents or (d.frequency='once' and exists(select 1 from payments where intent_id=d.id and provider_charge_id<>p_event->>'charge_id')) then
   update webhook_events set status='review' where event_id=p_event->>'event_id';update donation_intents set status='review' where id=d.id;return '{"review":true}'::jsonb;
  end if;
  insert into payments(intent_id,provider_charge_id,amount_cents,fee_cents) values(d.id,p_event->>'charge_id',(p_event->>'amount_cents')::bigint,(p_event->>'fee_cents')::bigint) on conflict(provider_charge_id) do nothing returning * into p;
  if p.id is not null then insert into receipts(intent_id,payment_id,receipt_number,amount_cents) values(d.id,p.id,'AR-'||upper(replace(p.id::text,'-','')),p.amount_cents);end if;
  update donation_intents set status='paid',last_event_at=greatest(coalesce(last_event_at,stamp),stamp) where id=d.id;
 elsif p_event->>'event_type' like 'customer.subscription.%' then
  if d.frequency='monthly' and (d.last_event_at is null or stamp>=d.last_event_at) then update donation_intents set subscription_id=p_event->>'subscription_id',last_event_at=stamp where id=d.id;end if;
 elsif p_event->>'event_type' in ('refund.paid','invoice.paid','collection.underpaid') then
  update webhook_events set status='review' where event_id=p_event->>'event_id';return '{"review":true}'::jsonb;
 end if;
 update webhook_events set status='processed' where event_id=p_event->>'event_id';return '{"processed":true}'::jsonb;
end $$;
create function public.admin_action(p_actor uuid,p_action text,p_data jsonb) returns jsonb language plpgsql security definer set search_path=public as $$
declare r text;rid uuid;c campaigns;e expenses;begin
 select role into r from staff_members where user_id=p_actor;if r is null then raise exception 'Forbidden';end if;
 if p_action='save_campaign' and r in ('owner','editor') then
  if coalesce(p_data->>'currency','USD')<>'USD' then raise exception 'USD only';end if;
  rid=coalesce(nullif(p_data->>'id','')::uuid,gen_random_uuid());
  if r='editor' and (p_data->>'status'='published' or coalesce((p_data->>'accepting_donations')::boolean,false) or exists(select 1 from campaigns where id=rid and status='published')) then raise exception 'Owner approval required for published campaigns';end if;
  insert into campaigns(id,slug,title,goal_cents) values(rid,p_data->>'slug',p_data->>'title',(p_data->>'goal_cents')::bigint) on conflict(id) do update set slug=excluded.slug,title=excluded.title,goal_cents=excluded.goal_cents;
  update campaigns set activities=coalesce(p_data->>'activities',''),beneficiaries=coalesce(p_data->>'beneficiaries',''),location=coalesce(p_data->>'location',''),eligibility=coalesce(p_data->>'eligibility',''),selection_process=coalesce(p_data->>'selection_process',''),budget=coalesce(p_data->>'budget',''),timeline=coalesce(p_data->>'timeline',''),underfunding=coalesce(p_data->>'underfunding',''),excess_funds=coalesce(p_data->>'excess_funds',''),delivery_impossible=coalesce(p_data->>'delivery_impossible',''),update_schedule=coalesce(p_data->>'update_schedule',''),refunds=coalesce(p_data->>'refunds',''),cancellation=coalesce(p_data->>'cancellation',''),privacy=coalesce(p_data->>'privacy',''),safeguarding=coalesce(p_data->>'safeguarding',''),complaints=coalesce(p_data->>'complaints',''),support_email=coalesce(p_data->>'support_email',''),terms_version=coalesce(p_data->>'terms_version','draft-1'),status=coalesce(p_data->>'status','draft'),accepting_donations=coalesce((p_data->>'accepting_donations')::boolean,false) where id=rid;
  select * into c from campaigns where id=rid;
  if c.accepting_donations and (c.status<>'published' or exists(select 1 from jsonb_each_text(to_jsonb(c)) f where f.key in ('activities','beneficiaries','location','eligibility','selection_process','budget','timeline','underfunding','excess_funds','delivery_impossible','update_schedule','refunds','cancellation','privacy','safeguarding','complaints','support_email') and length(trim(f.value))=0)) then raise exception 'Complete fundraising information before opening donations';end if;
 elsif p_action='submit_expense' and r in ('owner','finance') then
  insert into expenses(campaign_id,description,amount_cents,submitted_by) values((p_data->>'campaign_id')::uuid,p_data->>'description',(p_data->>'amount_cents')::bigint,p_actor) returning id into rid;
 elsif p_action='approve_expense' and r in ('owner','finance') then
  select * into e from expenses where id=(p_data->>'id')::uuid for update;
  if e.id is null or e.submitted_by=p_actor or e.status<>'submitted' then raise exception 'Separate financial approver required';end if;
  update expenses set status='approved',approved_by=p_actor where id=e.id;rid=e.id;
 elsif p_action='record_reconciliation' and r in ('owner','finance') then
  insert into reconciliations(payment_id,bank_reference,bank_received_cents,note,recorded_by) values((p_data->>'payment_id')::uuid,p_data->>'bank_reference',(p_data->>'bank_received_cents')::bigint,coalesce(p_data->>'note',''),p_actor) returning id into rid;
 elsif p_action='record_refund' and r in ('owner','finance') then
  update payments set refunded_cents=(p_data->>'refunded_cents')::bigint where id=(p_data->>'payment_id')::uuid returning id into rid;
  if rid is null or length(coalesce(p_data->>'provider_refund_reference',''))<3 then raise exception 'Verified provider refund reference required';end if;
 elsif p_action='save_milestone' and r in ('owner','editor') then
  insert into milestones(campaign_id,title,description,due_date,outcome) values((p_data->>'campaign_id')::uuid,p_data->>'title',p_data->>'description',nullif(p_data->>'due_date','')::date,coalesce(p_data->>'outcome','')) returning id into rid;
 elsif p_action='submit_content' and r in ('owner','editor') then
  insert into content_submissions(campaign_id,title,body,consent_reference,submitted_by) values(nullif(p_data->>'campaign_id','')::uuid,p_data->>'title',p_data->>'body',coalesce(p_data->>'consent_reference',''),p_actor) returning id into rid;
 elsif p_action='approve_content' and r='owner' then
  update content_submissions set status='approved',approved_by=p_actor where id=(p_data->>'id')::uuid and submitted_by<>p_actor and consent_reference<>'' returning id into rid;
  if rid is null then raise exception 'Separate review and consent reference required';end if;
 else raise exception 'Action not permitted for this role';end if;
 insert into audit_log(actor_id,action,record_id) values(p_actor,p_action,rid::text);return jsonb_build_object('id',rid,'saved',true);
end $$;
revoke all on function public.reserve_donation(uuid,uuid,bigint,text,text,text,boolean,boolean,text) from public,anon,authenticated;
revoke all on function public.process_bachs_event(jsonb) from public,anon,authenticated;
revoke all on function public.admin_action(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_donation(uuid,uuid,bigint,text,text,text,boolean,boolean,text),public.process_bachs_event(jsonb),public.admin_action(uuid,text,jsonb) to service_role;
