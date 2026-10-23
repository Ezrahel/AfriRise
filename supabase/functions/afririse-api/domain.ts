export class HttpError extends Error { status: number; constructor(status: number, message: string) {super(message);this.status=status;} }
export function cents(value: unknown): number {
 const text=String(value ?? '');
 if(!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw new HttpError(400,'Enter a valid USD amount with at most two decimal places.');
 const [whole,fraction='']=text.split('.'); const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(!Number.isSafeInteger(result)||result<100||result>100000000) throw new HttpError(400,'Donation must be between $1 and $1,000,000 USD.');
 return result;
}
export function decimal(value: number): string {if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid cents');return `${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;}
export function checkoutBody(d: {id:string;amount_cents:number;frequency:string;email:string;name?:string}, origin: string, monthlyProduct?:string) {
 const common={customer:{email:d.email,...(d.name?{name:d.name}:{})},billing_currency:'USD',payment_method_types:['USD_CARD'],reference:d.id,metadata:{donation_id:d.id},success_url:`${origin}/donation-status.html`,cancel_url:`${origin}/?donation=cancelled`};
 if(d.frequency==='monthly') {
  if(!monthlyProduct)throw new HttpError(503,'Monthly giving is not configured yet.');
  return {...common,product_cart:[{product_id:monthlyProduct,quantity:1,pricing:{price_type:'fixed',amount:decimal(d.amount_cents)}}]};
 }
 return {...common,pricing:{currency:'USD',amount:decimal(d.amount_cents)}};
}
export function safeCheckoutUrl(value:unknown):string {try{const url=new URL(String(value));if(url.protocol==='https:'&&url.hostname==='checkout.bachs.io'&&!url.username&&!url.password)return url.href;}catch{}throw new HttpError(502,'The payment provider returned an invalid checkout link.');}
export async function verifyWebhook(raw:string,headers:Headers,secret:string,now=Math.floor(Date.now()/1000)):Promise<boolean>{
 const v2=headers.get('x-bachs-signature-v2');let timestamp:string|null=null,signatures:string[]=[];
 if(v2){const parts=v2.split(',').map(s=>s.trim().split('='));const times=parts.filter(p=>p[0]==='t');if(times.length!==1)return false;timestamp=times[0][1];signatures=parts.filter(p=>p[0]==='v1').map(p=>p[1]);}
 else {timestamp=headers.get('x-bachs-timestamp');signatures=[headers.get('x-bachs-signature')||''];}
 if(!timestamp||!/^\d+$/.test(timestamp)||Math.abs(now-Number(timestamp))>300)return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 for(const signature of signatures){if(!/^[0-9a-f]{64}$/i.test(signature))continue;const bytes=Uint8Array.from(signature.match(/../g)!.map(h=>parseInt(h,16)));if(await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(`${timestamp}.${raw}`)))return true;}return false;
}
export const campaignRequired=['activities','beneficiaries','location','eligibility','selection_process','budget','timeline','underfunding','excess_funds','delivery_impossible','update_schedule','refunds','cancellation','privacy','safeguarding','complaints','support_email'];
export function campaignReady(c:Record<string,unknown>):boolean{return c.status==='published'&&c.accepting_donations===true&&campaignRequired.every(k=>typeof c[k]==='string'&&String(c[k]).trim().length>0);}
