import {HttpError,cents,decimal,checkoutBody,safeCheckoutUrl,verifyWebhook,campaignReady} from './domain.ts';
declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):void};
const env=(key:string)=>Deno.env.get(key)||'';
const base=()=>env('SUPABASE_URL').replace(/\/$/,'');
const origin=()=>env('SITE_ORIGIN').replace(/\/$/,'');
// LOCAL_SITE_ORIGIN may list several comma-separated origins (e.g. both localhost and 127.0.0.1).
const allowedOrigins=()=>[origin(),...env('LOCAL_SITE_ORIGIN').split(',').map(o=>o.trim().replace(/\/$/,''))].filter(Boolean);
const headers=()=>({'apikey':env('SUPABASE_SERVICE_ROLE_KEY'),'Authorization':`Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,'Content-Type':'application/json'});
async function db(path:string,method='GET',body?:unknown){
 const r=await fetch(`${base()}/rest/v1/${path}`,{method,headers:{...headers(),Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 if(!r.ok)throw new HttpError(503,'The database request could not be completed.');return r.status===204?null:r.json();
}
async function rpc(name:string,body:unknown){return db(`rpc/${name}`,'POST',body)}
async function bachs(path:string,method='GET',body?:unknown,idempotency?:string){
 const api=env('BACHS_MODE')==='live'?'https://api.bachs.io/v1':'https://api.bachs.io/v1';
 const r=await fetch(api+path,{method,headers:{Authorization:`Bearer ${env('BACHS_API_KEY')}`,'Content-Type':'application/json',...(idempotency?{'Idempotency-Key':idempotency}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw new HttpError(502,'Bachs could not complete the request. Please retry the same selection.');const value=await r.json();return value.data??value;
}
function json(value:unknown,status=200,request?:Request){const requestOrigin=request?.headers.get('origin')||'';return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...(allowedOrigins().includes(requestOrigin)?{'Access-Control-Allow-Origin':requestOrigin,'Vary':'Origin'}:{})}})}
function configured(){return !!(base()&&env('SUPABASE_SERVICE_ROLE_KEY')&&origin())}
async function body(request:Request){const text=await request.text();if(text.length>20000)throw new HttpError(413,'Request too large.');try{return JSON.parse(text)}catch{throw new HttpError(400,'Invalid JSON.')}}
async function admin(request:Request){
 const token=request.headers.get('authorization')?.replace(/^Bearer /,'');if(!token)throw new HttpError(401,'Sign in required.');
 const response=await fetch(`${base()}/auth/v1/user`,{headers:{apikey:env('SUPABASE_ANON_KEY'),Authorization:`Bearer ${token}`}});if(!response.ok)throw new HttpError(401,'Session expired.');
 const user=await response.json();let claims;try{claims=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')))}catch{throw new HttpError(401,'Invalid session.')}
 if(claims.aal!=='aal2')throw new HttpError(403,'Verify your administrator MFA code first.');
 const members=await db(`staff_members?user_id=eq.${encodeURIComponent(user.id)}&select=role`);if(!members.length)throw new HttpError(403,'Staff access required.');return {id:user.id,role:members[0].role};
}
type DataRow=Record<string,unknown>;
const number=(value:unknown)=>Number(value||0);
function dashboard(rows:Record<string,DataRow[]>){
 const payments=rows.payments||[], intents=rows.donation_intents||[], expenses=rows.expenses||[];
 const sum=(items:DataRow[],field:string)=>items.reduce((total,item)=>total+number(item[field]),0);
 const paid=payments.length, gross=sum(payments,'amount_cents'), fees=sum(payments,'fee_cents'), refunded=sum(payments,'refunded_cents');
 const byDay=new Map<string,number>();
 for(let i=6;i>=0;i--){const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-i);byDay.set(d.toISOString().slice(0,10),0)}
 for(const payment of payments){const key=String(payment.created_at||'').slice(0,10);if(byDay.has(key))byDay.set(key,(byDay.get(key)||0)+number(payment.amount_cents)-number(payment.refunded_cents))}
 const activity=[
  ...(rows.audit_log||[]).map(x=>({kind:'staff',title:String(x.action).replaceAll('_',' '),at:x.created_at,detail:'Administrative action recorded'})),
  ...(rows.webhook_events||[]).map(x=>({kind:'webhook',title:String(x.event_type).replaceAll('_',' '),at:x.created_at,detail:`Provider event: ${x.status}`})),
  ...(rows.support_requests||[]).map(x=>({kind:'support',title:`${x.kind} request`,at:x.created_at,detail:`Request is ${x.status}`}))
 ].sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,12);
 return {metrics:{campaigns:(rows.campaigns||[]).length,liveCampaigns:(rows.campaigns||[]).filter(x=>x.status==='published'&&x.accepting_donations===true).length,paidPayments:paid,grossCents:gross,feesCents:fees,refundedCents:refunded,netCents:gross-fees-refunded,pendingIntents:intents.filter(x=>x.status==='pending').length,reviewIntents:intents.filter(x=>x.status==='review').length,openExpenses:expenses.filter(x=>x.status==='submitted').length,openSupport:(rows.support_requests||[]).filter(x=>x.status==='open').length,webhookReview:(rows.webhook_events||[]).filter(x=>x.status==='review'||x.status==='unmatched').length},revenue:[...byDay].map(([date,cents])=>({date,cents})),activity};
}
async function webhook(request:Request){
 const raw=await request.text();if(raw.length>1000000)throw new HttpError(413,'Request too large.');
 if(!env('BACHS_WEBHOOK_SECRET'))throw new HttpError(503,'Webhook is not configured.');
 if(!await verifyWebhook(raw,request.headers,env('BACHS_WEBHOOK_SECRET')))throw new HttpError(400,'Invalid webhook signature.');
 let e;try{e=JSON.parse(raw)}catch{throw new HttpError(400,'Invalid webhook JSON.')}
 if(!e.id||!e.type||!e.created_at||e.organization_id!==env('BACHS_ORGANIZATION_ID'))throw new HttpError(400,'Unexpected webhook account or envelope.');
 // Only normalize necessary financial fields; never persist raw bank/card information.
 const d=e.data||{};const normalized:Record<string,unknown>={event_id:e.id,event_type:e.type,occurred_at:e.created_at,reference:d.metadata?.donation_id||d.reference||null,checkout_id:d.checkout_id||null,subscription_id:d.subscription_id||d.subscription?.subscription_id||null,charge_id:d.charge_id||null,currency:d.currency||null};
 if(e.type==='collection.succeeded'){
  if(d.currency!=='USD')throw new HttpError(400,'Non-USD payment requires manual review.');
  normalized.amount_cents=cents(d.amount);normalized.fee_cents=d.processing_fee_currency==='USD'?Math.round(Number(d.processing_fee||0)*100):null;
  if(!normalized.charge_id)throw new HttpError(400,'Missing payment identifier.');
 }
 if(e.type==='refund.paid'){
  // Refund shape is recorded for review until reconciled against provider records.
  normalized.refund_id=d.refund_id||null;
 }
 const result=await rpc('process_bachs_event',{p_event:normalized});return json({received:true,result});
}
export async function handler(request:Request):Promise<Response>{
 try{
  const url=new URL(request.url),path=url.pathname.split('/afririse-api')[1]||'/';
  if(request.method==='OPTIONS'){const requestOrigin=request.headers.get('origin')||'';if(!allowedOrigins().includes(requestOrigin))throw new HttpError(403,'Origin is not allowed.');return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':requestOrigin,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'authorization,content-type,idempotency-key','Vary':'Origin'}})}
  if(!configured())throw new HttpError(503,'AfriRise services are not configured yet.');
  if(path==='/webhook'&&request.method==='POST')return await webhook(request);
  if(request.headers.get('origin')&&!allowedOrigins().includes(request.headers.get('origin')||''))throw new HttpError(403,'Origin is not allowed.');
  if(path==='/config')return json({currency:'USD',provider:'Bachs',mode:env('BACHS_MODE')||'live',paymentsEnabled:env('PAYMENTS_ENABLED')==='true'&&!!env('BACHS_API_KEY')&&env('BACHS_APPROVED')==='true',monthlyEnabled:!!env('BACHS_MONTHLY_PRODUCT_ID')},200,request);
  if(path==='/campaigns'&&request.method==='GET')return json(await db('campaigns?status=eq.published&select=id,slug,title,goal_cents,currency,activities,beneficiaries,location,eligibility,selection_process,budget,timeline,underfunding,excess_funds,delivery_impossible,update_schedule,refunds,cancellation,privacy,safeguarding,complaints,support_email,terms_version,accepting_donations&order=created_at'),200,request);
  if(path==='/checkout'&&request.method==='POST'){
   if(env('PAYMENTS_ENABLED')!=='true'||env('BACHS_APPROVED')!=='true'||!env('BACHS_API_KEY'))throw new HttpError(503,'Donation checkout is not open yet.');
   const b=await body(request);if(b.currency!=='USD')throw new HttpError(400,'AfriRise accepts USD only.');
   const value=cents(b.amount);if(!['once','monthly'].includes(b.frequency))throw new HttpError(400,'Choose one-time or monthly giving.');
   if(typeof b.email!=='string'||b.email.length>254||!/^\S+@\S+\.\S+$/.test(b.email))throw new HttpError(400,'Enter a valid email address.');
   if(b.name&&String(b.name).length>150)throw new HttpError(400,'Name is too long.');
   if(b.termsAccepted!==true||b.privacyAccepted!==true||(b.frequency==='monthly'&&b.recurringAccepted!==true))throw new HttpError(400,'Review and accept the donation information first.');
   if(typeof b.campaignId!=='string'||!/^[a-f0-9-]{36}$/i.test(b.campaignId))throw new HttpError(400,'Select a published campaign.');
   const [campaign]=await db(`campaigns?id=eq.${b.campaignId}`);if(!campaign||!campaignReady(campaign))throw new HttpError(409,'This campaign is not ready to receive donations.');
   if(b.termsVersion!==campaign.terms_version)throw new HttpError(409,'Campaign terms changed. Please review them again.');
   const key=request.headers.get('idempotency-key');if(!key||!/^[a-f0-9-]{36}$/i.test(key))throw new HttpError(400,'A checkout request identifier is required.');
   // Atomic reservation prevents duplicate intents and mismatched reuse of a key.
   const intent=await rpc('reserve_donation',{p_key:key,p_campaign:b.campaignId,p_amount:value,p_frequency:b.frequency,p_email:b.email.trim().toLowerCase(),p_name:String(b.name||'').trim(),p_anonymous:b.anonymous===true,p_newsletter:b.newsletter===true,p_terms:campaign.terms_version});
   const session=await bachs('/checkout-sessions','POST',checkoutBody({id:intent.id,amount_cents:value,frequency:b.frequency,email:b.email,name:b.name},origin(),env('BACHS_MONTHLY_PRODUCT_ID')),intent.id);
   const checkoutUrl=safeCheckoutUrl(session.checkout_url);
   await db(`donation_intents?id=eq.${intent.id}`,'PATCH',{checkout_id:session.checkout_id,checkout_url:checkoutUrl});
   return json({checkoutUrl,intentId:intent.id,statusToken:intent.status_token},200,request);
  }
  if(path==='/status'&&request.method==='POST'){
   const b=await body(request);if(typeof b.token!=='string'||!/^[a-f0-9-]{36}$/i.test(b.token))throw new HttpError(400,'Invalid confirmation token.');
   const [intent]=await db(`donation_intents?status_token=eq.${b.token}&select=id,status,amount_cents,currency,frequency,campaign_id`);if(!intent)throw new HttpError(404,'Donation not found.');
   const receipts=await db(`receipts?intent_id=eq.${intent.id}&select=receipt_number,amount_cents,currency,issued_at&order=issued_at.desc&limit=1`);
   return json({...intent,receipt:receipts[0]||null},200,request);
  }
  if(path==='/request'&&request.method==='POST'){
   const b=await body(request);if(!['privacy','complaint','cancel_recurring'].includes(b.kind)||typeof b.email!=='string'||!/^\S+@\S+\.\S+$/.test(b.email)||b.email.length>254||typeof b.message!=='string'||b.message.length<10||b.message.length>4000||b.website)throw new HttpError(400,'Check your request details.');
   await db('support_requests','POST',{kind:b.kind,email:b.email,message:b.message});return json({received:true,message:'Request received for staff review. A cancellation request is not confirmation of cancellation.'},201,request);
  }
  if(path.startsWith('/admin')){
   const staff=await admin(request);
   if(path==='/admin/session')return json(staff,200,request);
   const resource=url.searchParams.get('resource')||'campaigns';
   const resources:Record<string,string[]>={owner:['campaigns','donation_intents','payments','receipts','expenses','reconciliations','milestones','content_submissions','audit_log','support_requests','webhook_events'],finance:['campaigns','donation_intents','payments','receipts','expenses','reconciliations','audit_log','support_requests','webhook_events'],editor:['campaigns','milestones','content_submissions']};
   if(path==='/admin/dashboard'&&request.method==='GET'){
    const fields:Record<string,string>={
     campaigns:'id,title,status,accepting_donations,created_at',donation_intents:'status,amount_cents,frequency,created_at',payments:'amount_cents,fee_cents,refunded_cents,created_at',
     expenses:'status,amount_cents,created_at',support_requests:'kind,status,created_at',webhook_events:'event_type,status,created_at',audit_log:'action,created_at'
    };
    const permitted=resources[staff.role]||[];
    const names=Object.keys(fields).filter(name=>permitted.includes(name));
    const results=await Promise.all(names.map(async name=>[name,await db(`${name}?select=${fields[name]}&order=created_at.desc&limit=500`)] as const));
    return json(dashboard(Object.fromEntries(results) as Record<string,DataRow[]>),200,request);
   }
   if(path==='/admin/records'&&request.method==='GET'){
    if(!resources[staff.role]?.includes(resource))throw new HttpError(403,'Your role cannot access this area.');
    const offset=Math.max(0,Math.min(100000,Number(url.searchParams.get('offset')||0)));if(!Number.isSafeInteger(offset))throw new HttpError(400,'Invalid offset.');
    return json(await db(`${resource}?select=*&order=created_at.desc&limit=100&offset=${offset}`),200,request);
   }
   if(path==='/admin/action'&&request.method==='POST'){
    const b=await body(request);return json(await rpc('admin_action',{p_actor:staff.id,p_action:b.action,p_data:b.data||{}}),200,request);
   }
  }
  throw new HttpError(404,'Route not found.');
 }catch(e){return json({error:e instanceof HttpError?e.message:'The request could not be completed. Please try again.'},e instanceof HttpError?e.status:500,request)}
}
Deno.serve(handler);
