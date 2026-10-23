# AfriRise website
Static responsive donor website. Open dist/index.html through a static HTTP server.

## Design foundation
Uses vendored daisyUI 5 CSS, an MIT-licensed GitHub design project: https://github.com/saadeghi/daisyui. Its license is retained in dist/assets/DAISYUI-LICENSE.txt. Custom layout and brand styling in dist/style.css.

## Content and launch configuration
Goal: USD 500,000. No raised amount, testimonials, named partners or participant counts invented. Independent registration is based on the owner's statement; exact registered identity and governance details remain to be supplied. Programme descriptions are directions, not confirmed delivery commitments. Images are illustrative, not evidence of programme activity.

## Interactions
Responsive navigation, programme information dialogs, amount/frequency selector, gift review, transparency accordions and sharing. No backend data collection or payment processing; selections are not pledges. Contact and participation dialogs explicitly explain availability.

## Required before public fundraising
Verified legal name and registration details, governance and official contact; approved programme scope, budget, location, timeline and selection; verified historical evidence; reviewed privacy, safeguarding and donation policies; organisational payment provider and server-verified checkout/webhooks; financial reconciliation and reporting workflow.


## Backend upgrade
USD-only Supabase database migration and TypeScript Edge Function are in `supabase/`. Staff console: `/admin.html`. Donor information: `/policies.html`. Full activation instructions, current integration limits and sandbox requirements: `SETUP.md`. Backend is not provisioned until a Supabase project and Bachs account are configured.
