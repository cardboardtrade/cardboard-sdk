import {validateMemo} from './memo.js';
import {validateTrade,validateSignedTrade,type TradeIntent} from './trade.js';

/** Cardboard API client. Amounts remain exact decimal strings throughout. */
export type MarketSymbol = 'SOL' | 'BTC' | 'ETH';
export type Side = 'long' | 'short';
export interface Signer {
  address: string;
  signOffchainMessage?: (message: string) => Promise<Uint8Array>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction: (wire: Uint8Array) => Promise<Uint8Array>;
}
export interface Builder { wallet: string; notionalMarkupPercent?: string | number; profitMarkupPercent?: string | number }
export interface BuilderFees { wallet: string; notional_markup_bps: number; profit_markup_bps: number }
export interface Admission { expires_at: number; signature?: string; offchain_signature?: string; transaction?: string }
interface TradingTerms { program: string; max_builder_notional_markup_bps: number; max_builder_profit_markup_bps: number; deadband_ppm: number; round_trip_fee_ppm: number; max_leverage: number }
export interface Market { id: number; symbol: MarketSymbol; fee_bps: number; liquidation_buffer_bps: number; retired: boolean }
export interface Oracle { market_id: number; mid: string | null }
export interface Account<T> { address: string; kind: string; state: T; slot: string; version: string }
export interface Position { id: string; owner: string; market_id: number; open: boolean; margin: string; leverage: number; entry_price: string; builder_wallet?: string | null; builder_pending?: string; builder_paid?: string; builder_reused?: string }
export interface TradingAccount { owner:string; available:string; queued:string; staked:string; pending_reward:string; reward_balance:string; activated:boolean; frozen:boolean }
export interface UserPosition extends Position { address:string; is_long:boolean; exit_price:string; closed_at:string; liquidated:boolean; returned_margin:string; settled_claim:string; fees_charged:string; mark_price?:string; close_pnl?:string; close_equity?:string; settlement_signature:string|null }
export interface PositionPage { items:UserPosition[]; next_cursor:string|null }
export interface Earnings { earned: string; credited: string; queued: string; reused_as_margin: string; notional_fees: string; profit_fees: string; earned_24h: string; positions_opened: string; positions_closed: string; traders: string }
export interface BuilderStats { builder_wallet: string; totals: Earnings; markets: (Earnings & {market_id: number})[] }
export interface Prepared { id: string; transaction: string; builder?: BuilderFees }
export interface Status { id: string; status: string; signature?: string | null; error?: string | null }
export type Event = 'positions' | 'balances' | 'transactions' | 'builder_fees' | 'markets';
export interface Balance {owner:string;available:string;queued:string}
export interface Claim {owner:string;id:string;amount:string}
export type StreamAccount = (Account<Position>&{kind:'position'})|(Account<Balance>&{kind:'trader'})|(Account<Claim>&{kind:'claim'})|(Account<Market>&{kind:'market'})|(Account<Oracle>&{kind:'oracle'});
export type StreamFrame = {type:'snapshot';rows:StreamAccount[];builder_fees:FeeFrame[];next_cursor:string|null}
  | {type:'delta';upsert:StreamAccount[];remove:string[]}
  | {type:'settlement';owner:string;address:string;signature:string}
  | {type:'transaction';item:Status|null} | {type:'valuations';upsert:(Position&{address:string;value_version:string;mark_price?:string;close_pnl?:string;close_equity?:string})[]}
  | FeeFrame | {type:'wallet';owner:string;amount?:string;error:boolean} | {type:'heartbeat'};
export interface FeeFrame {type:'builder_fees';position:string;version:string;state:Position}
export interface OpenPosition { market: MarketSymbol; side: Side; marginUSDC: string; leverage: number; slippageBps?: number; minWinningExposureUSDC?: string; builder?: Builder }
export class ApiError extends Error {
  constructor(message:string, readonly status:number, readonly retryAfter:number|null) {super(message);this.name='ApiError';}
}
const bytes = (s:string) => Uint8Array.from(atob(s),c=>c.charCodeAt(0));
const base64 = (b:Uint8Array) => btoa(Array.from(b,c=>String.fromCharCode(c)).join(''));
export function toUnits(value:string, decimals=6): string {
  if(typeof value!=='string'||value.length>64||!Number.isInteger(decimals)||decimals<0||decimals>18)throw new Error('Use a decimal string for exact amounts');
  const s=value; const match=/^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(s);
  if (!match || (match[2]?.length??0)>decimals) throw new Error(`Use a nonnegative decimal with at most ${decimals} fractional digits`);
  const n=BigInt(match[1])*10n**BigInt(decimals)+BigInt((match[2]??'').padEnd(decimals,'0')||'0');
  if(n>18446744073709551615n)throw new Error('Amount exceeds the supported range');
  return n.toString();
}
export function fromUnits(value:string,decimals=6):string {
  const n=BigInt(value);const sign=n<0n?'-':'';const s=(n<0n?-n:n).toString().padStart(decimals+1,'0');
  return decimals ? `${sign}${s.slice(0,-decimals)}.${s.slice(-decimals)}` : `${sign}${s}`;
}
export class CardboardClient {
  readonly base:string;
  private proof?:Admission;
  private clock?:{seconds:number;at:number};
  private readonly orders=new WeakMap<Prepared,{id:string;transaction:string;wire:Uint8Array;intent:TradeIntent;builder:string}>();
  constructor(readonly options:{apiBase?:string;program?:string;owner?:string;signer?:Signer;builder?:Builder;builderKey?:string}={}) {
    this.base=(options.apiBase??'https://cardboardtrade.xyz/v1').replace(/\/$/,'');
  }
  private owner():string {const owner=this.options.owner??this.options.signer?.address;if(!owner)throw new Error('A connected wallet is required');return owner;}
  private signer():Signer {if(!this.options.signer)throw new Error('A connected wallet is required');return this.options.signer;}
  private key():string|undefined {
    const key=this.options.builderKey;
    if(key&&typeof window!=='undefined')throw new Error('Builder server keys must never be used in a browser');
    return key;
  }
  async request<T>(path:string,body?:object,authorization?:string):Promise<T> {
    const key=this.key();
    const response=await fetch(`${this.base}${path}`,{method:body===undefined?'GET':'POST',credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000),
      headers:{...(key?{'X-Builder-Key':key}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...(authorization?{Authorization:authorization}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const seconds=Date.parse(response.headers.get('Date')??'')/1000;
    if(Number.isFinite(seconds))this.clock={seconds,at:performance.now()};
    const value=await response.json().catch(()=>undefined);
    if(!response.ok)throw new ApiError(typeof value?.error==='string'?value.error:`API ${response.status}`,response.status,Number(response.headers.get('Retry-After'))||null);
    if(value===undefined)throw new Error('Invalid API response');
    return value as T;
  }
  private tradingTerms():Promise<TradingTerms>{return this.request('/config');}
  getMarkets():Promise<Account<Market>[]>{return this.request('/accounts?kind=market');}
  getBuilderEarnings(wallet=this.options.builder?.wallet):Promise<BuilderStats>{if(!wallet)throw new Error('Set a builder wallet');return this.request(`/builders/${encodeURIComponent(wallet)}/stats`);}
  getBuilderPositions(wallet=this.options.builder?.wallet,owner?:string,cursor?:string):Promise<{items:Account<Position>[];next_cursor:string|null}>{
    if(!wallet)throw new Error('Set a builder wallet');const q=new URLSearchParams();if(owner)q.set('owner',owner);if(cursor)q.set('cursor',cursor);
    return this.request(`/builders/${encodeURIComponent(wallet)}/positions${q.size?'?'+q:''}`);
  }
  getAccount(owner=this.owner()):Promise<TradingAccount>{return this.request(`/traders/${encodeURIComponent(owner)}`);}
  private async positions(owner:string,cursor:string|undefined,open:boolean):Promise<PositionPage>{
    const q=new URLSearchParams();if(cursor!==undefined)q.set('cursor',cursor);
    const rows=await this.request<UserPosition[]>(`/positions/${encodeURIComponent(owner)}${q.size?'?'+q:''}`);
    return {items:rows.filter(row=>row.open===open),next_cursor:rows.length>=500?rows.at(-1)!.address:null};
  }
  getPositions(owner=this.owner(),cursor?:string):Promise<PositionPage>{return this.positions(owner,cursor,true);}
  getHistory(owner=this.owner(),cursor?:string):Promise<PositionPage>{return this.positions(owner,cursor,false);}
  private now():number {if(!this.clock)throw new Error('API Date header missing');return this.clock.seconds+(performance.now()-this.clock.at)/1000;}
  async authorization():Promise<Admission>{
    const signer=this.signer();const owner=this.owner();
    if(!this.options.program)throw new Error('Set the expected exchange program before signing');
    if(this.proof){this.clock=undefined;await this.tradingTerms();if(this.proof.expires_at>this.now()+15)return this.proof;}
    this.clock=undefined;
    const q=new URLSearchParams({owner,authority:signer.address,lifetime_seconds:'900'});
    const c=await this.request<{program:string;message:string;expires_at:number;transaction:string}>(`/prepare-auth?${q}`);
    const expected=`Cardboard API access\nprogram=${this.options.program}\nowner=${owner}\nauthority=${signer.address}\nexpires_at=${c.expires_at}`;
    if(c.program!==this.options.program||c.message!==expected||!Number.isSafeInteger(c.expires_at)||c.expires_at<=this.now()||c.expires_at>this.now()+905)throw new Error('Invalid authorization challenge');
    const signed=signer.signOffchainMessage?{offchain_signature:base64(await signer.signOffchainMessage(expected))}:signer.signMessage?{signature:base64(await signer.signMessage(new TextEncoder().encode(expected)))}:{transaction:base64(await this.signMemo(c.transaction,expected))};
    return this.proof={expires_at:c.expires_at,...signed}; // Authentication memo is never broadcast.
  }
  private async signMemo(transaction:string,message:string):Promise<Uint8Array>{
    const wire=bytes(transaction);validateMemo(wire,this.signer().address,message);
    const signed=await this.signer().signTransaction(wire);validateMemo(signed,this.signer().address,message,true);
    if(!signed.slice(65).every((b,i)=>b===wire[i+65]))throw new Error('Wallet changed the authorization transaction');
    return signed;
  }
  private async credential():Promise<string>{return 'Bearer '+base64(new TextEncoder().encode(JSON.stringify({owner:this.owner(),authority:this.signer().address,admission:await this.authorization()})));}
  async prepare(action:Record<string,string|number|boolean|undefined>):Promise<Prepared>{
    return this.request('/prepare',{...action,owner:this.owner(),authority:this.signer().address,admission:await this.authorization()});
  }
  private async checked(prepared:Prepared,action:TradeIntent['action'],builder?:BuilderFees):Promise<Prepared>{
    const {id,transaction}=prepared;
    if(typeof id!=='string'||!id||id.length>64||typeof transaction!=='string'||transaction.length>1644)throw new Error('Invalid prepared transaction');
    const intent:TradeIntent={program:this.options.program??'',owner:this.owner(),authority:this.signer().address,action:{...action},builder:builder?{...builder}:undefined};
    const wire=bytes(transaction);
    await validateTrade(wire,intent);
    if(builder?prepared.builder?.wallet!==builder.wallet||prepared.builder.notional_markup_bps!==builder.notional_markup_bps||prepared.builder.profit_markup_bps!==builder.profit_markup_bps:prepared.builder!=null)throw new Error('Prepared builder fees changed; refresh the quote');
    this.orders.set(prepared,{id,transaction,wire,intent,builder:JSON.stringify(prepared.builder??null)});
    return prepared;
  }
  async openPosition(order:OpenPosition):Promise<Prepared>{
    if(order.side!=='long'&&order.side!=='short')throw new Error('Side must be long or short');
    const marketId={BTC:0,ETH:1,SOL:2}[order.market];
    if(marketId===undefined)throw new Error('Market is unavailable');
    const [config,markets,oracles]=await Promise.all([this.tradingTerms(),this.getMarkets(),this.request<Account<Oracle>[]>('/accounts?kind=oracle')]);
    if(config.program!==this.options.program)throw new Error('Exchange program changed');
    const market=markets.find(m=>m.state.symbol===order.market)?.state;
    if(!market||market.retired||market.id!==marketId)throw new Error('Market is unavailable or its identity changed');
    if(!Number.isInteger(order.leverage)||order.leverage<1||order.leverage>config.max_leverage)throw new Error('Invalid leverage');
    const slippage=order.slippageBps??5;
    if(!Number.isInteger(slippage)||slippage<0||slippage>1000)throw new Error('Slippage must be 0..1000 basis points');
    const mid=oracles.find(o=>o.state.market_id===market.id)?.state.mid;
    if(!mid||BigInt(mid)<=0n)throw new Error('A current market price is required');
    const price=BigInt(mid);const tolerance=(price*BigInt(slippage)+9999n)/10000n;
    const worst=order.side==='long'?price+tolerance:price-tolerance;
    const builder=order.builder??this.options.builder;
    const markup=(s:string|number|undefined)=>{const n=BigInt(toUnits(String(s??10),2));if(n>65535n)throw new Error('Markup exceeds the request range');return Number(n);};
    const notional=builder?markup(builder.notionalMarkupPercent):undefined;const profit=builder?markup(builder.profitMarkupPercent):undefined;
    const margin=toUnits(order.marginUSDC);if(BigInt(margin)<=0n)throw new Error('Margin must be positive');
    const action={action:'open',market_id:market.id,is_long:order.side==='long',margin,leverage:order.leverage,debt_funded:false,worst_price:worst.toString(),
      expected_fee_bps:market.fee_bps,expected_buffer_bps:market.liquidation_buffer_bps,expected_economics_version:1,expected_deadband_ppm:config.deadband_ppm,max_round_trip_fee_ppm:config.round_trip_fee_ppm,
      ...(order.minWinningExposureUSDC===undefined?{}:{min_winning_exposure:toUnits(order.minWinningExposureUSDC)}),
      ...(builder?{builder_wallet:builder.wallet,builder_notional_markup_bps:notional,builder_profit_markup_bps:profit}:{})};
    const expected=builder?{wallet:builder.wallet,notional_markup_bps:Math.min(notional!,config.max_builder_notional_markup_bps),profit_markup_bps:Math.min(profit!,config.max_builder_profit_markup_bps)}:undefined;
    return this.checked(await this.prepare(action),action,expected);
  }
  async closePosition(positionId:string):Promise<Prepared>{if(positionId.length>20||!/^\d+$/.test(positionId)||BigInt(positionId)>18446744073709551615n)throw new Error('Invalid position ID');const action={action:'close',position_id:positionId};return this.checked(await this.prepare(action),action);}
  async submit(prepared:Prepared):Promise<Status>{
    const order=this.orders.get(prepared),signer=this.signer();
    if(!order||prepared.id!==order.id||prepared.transaction!==order.transaction||JSON.stringify(prepared.builder??null)!==order.builder||this.owner()!==order.intent.owner||signer.address!==order.intent.authority||this.options.program!==order.intent.program)throw new Error('Use an unchanged typed order prepared by this client');
    const signed=await signer.signTransaction(order.wire.slice());
    validateSignedTrade(signed,order.wire);
    return this.request('/relay',{id:order.id,transaction:base64(signed)});
  }
  async getTransaction(id:string):Promise<Status>{return this.request(`/transactions/${encodeURIComponent(id)}`,undefined,await this.credential());}
  subscribe(filter:{builder?:string;owner?:string;events?:Event[]},onFrame:(frame:StreamFrame)=>void,onError:(error:Error)=>void):()=>void {
    const builder=filter.builder??this.options.builder?.wallet;
    const owner=filter.owner??(builder?undefined:this.options.owner??this.options.signer?.address);
    const events=filter.events??(builder?['positions','builder_fees']:['positions','balances']);
    if(!builder&&!owner)throw new Error('Set a builder or owner filter');
    if(events.includes('transactions')&&owner!==this.owner())throw new Error('Transaction feed must match the connected wallet');
    const key=this.key();
    let stopped=false;let delay=1000;let socket:WebSocket|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
    const connect=async()=>{
      try {
      if(stopped)return;
      const url=new URL(`${this.base}/stream`);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      if(builder)url.searchParams.set('builder',builder);if(owner)url.searchParams.set('owner',owner);url.searchParams.set('events',events.join(','));if(events.includes('transactions'))url.searchParams.set('authenticate','true');
      if(key)url.searchParams.set('builder_access','true');
      const current=socket=new WebSocket(url);
      current.onopen=()=>{if(key)current.send(JSON.stringify({type:'builder_authenticate',key}));};
      current.onmessage=async event=>{try{const frame=JSON.parse(String(event.data));if(frame.type==='auth_challenge'){
        const admission=await this.authorization();if(!stopped&&current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:'authenticate',authority:this.signer().address,admission}));
      }else{
        if(!['snapshot','delta','settlement','transaction','valuations','builder_fees','wallet','heartbeat'].includes(frame.type))return;
        if(frame.type==='snapshot')delay=1000;
        if(frame.type==='snapshot'||frame.type==='delta'){
          const field=frame.type==='snapshot'?'rows':'upsert';
          frame[field]=frame[field].filter((row:{kind?:string})=>row.kind!=='config'&&row.kind!=='pool');
        }
        onFrame(frame as StreamFrame);
      }}catch(cause){stopped=true;current.close();onError(cause instanceof Error?cause:new Error(String(cause)));}};
      current.onerror=()=>onError(new Error('Stream disconnected; reconnecting for current state'));
      current.onclose=event=>{if(stopped)return;if(event.code===1008){stopped=true;onError(new Error('Stream authorization or filter rejected'));return;}timer=setTimeout(connect,delay);delay=Math.min(delay*2,30_000);};
      }catch(cause){onError(cause instanceof Error?cause:new Error(String(cause)));if(!stopped){timer=setTimeout(connect,delay);delay=Math.min(delay*2,30_000);}}
    };
    void connect();return()=>{stopped=true;clearTimeout(timer);socket?.close();};
  }
}

export {walletStandardSigner} from './wallet-standard.js';
