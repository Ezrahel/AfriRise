-- A campaign may only accept donations when it is published and every donor
-- disclosure is filled in. Previously this was checked only inside the
-- admin_action RPC, so a direct SQL/dashboard edit (or the column default)
-- could open a campaign whose checkout the API then rejects with 409.

alter table public.campaigns alter column accepting_donations set default false;

create or replace function public.campaign_disclosures_complete(c public.campaigns) returns boolean
language sql immutable set search_path = public as $$
 select c.status = 'published' and not exists(
  select 1 from jsonb_each_text(to_jsonb(c)) f
  where f.key in ('activities','beneficiaries','location','eligibility','selection_process','budget','timeline','underfunding','excess_funds','delivery_impossible','update_schedule','refunds','cancellation','privacy','safeguarding','complaints','support_email')
    and length(trim(coalesce(f.value,''))) = 0)
$$;

-- Close any campaign that is currently open without complete disclosures.
update public.campaigns c set accepting_donations = false
 where c.accepting_donations and not public.campaign_disclosures_complete(c);

create or replace function public.enforce_campaign_readiness() returns trigger
language plpgsql set search_path = public as $$
begin
 if new.accepting_donations and not public.campaign_disclosures_complete(new) then
  raise exception 'Complete fundraising information and publish the campaign before opening donations';
 end if;
 return new;
end $$;

drop trigger if exists campaigns_readiness_guard on public.campaigns;
create trigger campaigns_readiness_guard before insert or update on public.campaigns
 for each row execute function public.enforce_campaign_readiness();

revoke all on function public.campaign_disclosures_complete(public.campaigns) from public, anon, authenticated;
revoke all on function public.enforce_campaign_readiness() from public, anon, authenticated;
