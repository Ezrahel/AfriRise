# Activate Supabase + TypeScript + Bachs

The published Site is the static frontend. The backend is a TypeScript Supabase Edge Function. No Supabase project was connected or migrated in this session. No Bachs API call or charge was made. All monetary database columns use integer USD cents; Bachs receives decimal USD strings. Hosted checkout is restricted to the documented USD_CARD corridor to prevent local-currency checkout. This limits the available payment methods; confirm account access with Bachs.

## 1. Project and database
Create/select a Supabase project in your own account. With the official Supabase CLI authenticated:

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase functions deploy afririse-api
```

Review and apply `supabase/migrations/202610230001_afririse.sql`. It creates operational tables, default-deny RLS/grants and service-role-only RPCs. No private beneficiary case files are collected. Existing databases should be backed up before migrations. Configure database backups/PITR according to your plan and conduct a restore drill; backups are not provisioned by this repository.

## 2. Secrets
Use Supabase's secret manager or a local, ignored environment file. Do not paste secret keys into chat or `dist/config.js`. `.env.example` lists the expected configuration. Start with `BACHS_MODE=sandbox`, `PAYMENTS_ENABLED=false` and `BACHS_APPROVED=false`. SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are supplied by Supabase's runtime.

Bachs account approval must cover AfriRise's charitable fundraising activity. Its supported-business page does not explicitly list charitable fundraising. Confirm USD_CARD support and fees. Set BACHS_ORGANIZATION_ID to the account sending webhooks. The backend rejects a different account.

## 3. Frontend public settings
Set only the API base URL, project URL, and publishable/legacy anon key in `dist/config.js`. Example API base: `https://YOUR_PROJECT.supabase.co/functions/v1/afririse-api`. No secret keys belong here. Republish the Site after editing it. Set SITE_ORIGIN to the actual frontend origin; update it if a custom domain is connected.

## 4. Staff and MFA
Invite staff in Supabase Auth; disable public signups if unneeded. Enable TOTP MFA in Supabase. Add approved user IDs to staff_members through the SQL editor:

```sql
insert into public.staff_members(user_id,role) values('AUTH_USER_UUID','owner');
```

Visit `/admin.html`. Access tokens stay in memory. Every admin backend call validates the token with Supabase and requires `aal2` plus an assigned role. Expired sessions require sign-in again. Owners publish campaigns; editors draft campaign and programme content; finance staff handle accounting. Separate people approve expenses and participant content. Database mutations and audit entries are in the same transaction. Manual SQL/dashboard changes remain outside this app audit log and need separate operational controls.

## 5. Campaign disclosures
The founding campaign is seeded as a closed draft with a $500,000 USD goal. Use the staff console to fill the budget, location, eligibility, selection, delivery schedule, underfunding, overfunding, delivery-impossible, reporting, refund, cancellation, privacy, safeguarding, complaint and support-contact fields. Amount fields in admin JSON are cents. Version terms whenever campaign rules change. Do not publish unreviewed policy prose as approved legal terms.

Owner publication plus accepting_donations and all required fields are required. Also approve the legal identity and programme evidence on the public homepage. Set a support process, retention schedule and restricted record-access procedures. Publish the policy pages after organisational/legal review; current pages are review copy.

## 6. Bachs sandbox
One-time giving uses the official POST /v1/checkout-sessions with pricing.currency USD, a decimal pricing.amount, billing_currency USD and payment_method_types [USD_CARD]. Monthly giving uses a USD monthly recurring product ID and the documented ad-hoc fixed price override. Validate that the configured product is monthly, USD and has no trials, tax/add-ons or quantity changes. The code does not create a catalogue product automatically.

Set the webhook URL to the function URL plus `/webhook`. Disable platform JWT validation for this function (config.toml), because Bachs is not a Supabase user. The handler verifies Bachs HMAC signatures, timestamps and organization ID itself. Subscribe to collection.succeeded, collection.failed, collection.underpaid, customer.subscription.created/updated/deleted, invoice.paid and refund.paid. Raw bank/card details are discarded; normalized event fields only are saved.

Successful exact-amount USD collection events create one payment and one acknowledgement per charge atomically. Duplicate events and duplicate charge IDs cannot create extra receipts. Redirects never mark payment paid. Events with unmatched references, refunds and invoice-only renewals are placed in staff review. Refund execution and monthly cancellation are performed in the Bachs dashboard, then verified and recorded by staff. A support-form cancellation request does not itself cancel billing. No automatic email provider is configured: acknowledgements are available on the return page and printable; email delivery and newsletter sending require a separate implementation.

Before enabling monthly donations, test initial collection, subscription linkage, a renewal cycle, cancellation and event reordering. A renewal event must carry a mapped subscription/reference/checkout ID. Unmatched or invoice-only renewal events remain in review and are not automatically counted; extend and test provider-specific correlation against actual sandbox payloads before enabling monthly collection at scale.

## 7. Release checks
Run `npm test` and `npm run typecheck`. These use unit/HTTP tests and an embedded Postgres engine for migration, grants, duplicate-event and role workflow checks. They do not substitute for integration tests against your real Supabase project or Bachs sandbox. Verify RLS in the real project, admin MFA, a USD sandbox charge, duplicate/reordered webhooks, mismatched currency, reconciliation, acknowledgement retrieval, cancellation, refund handling, backups, and mobile access. Add platform rate limits/CAPTCHA where appropriate for your production traffic.

Once account eligibility, campaign details and sandbox checks pass, set BACHS_APPROVED=true and PAYMENTS_ENABLED=true. Move to live keys only after explicitly choosing production. Never use a real charge as a first test.

## Primary integration documentation
- https://docs.bachs.io/api-reference/payments/create-checkout-session
- https://docs.bachs.io/guides/checkout/adhoc-pricing
- https://docs.bachs.io/guides/webhooks/overview
- https://docs.bachs.io/guides/webhooks/events/collection-succeeded
- https://docs.bachs.io/for-you/supported-businesses
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/functions/auth
