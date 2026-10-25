import {publicKey} from './memo.js';
import type {BuilderFees} from './index.js';

type Action=Record<string,string|number|boolean|undefined>;
export interface TradeIntent {program:string;owner:string;authority:string;action:Action;builder?:BuilderFees}
interface Instruction {program:number;accounts:number[];data:Uint8Array}
interface Transaction {message:Uint8Array;signatures:Uint8Array;keys:Uint8Array[];readonly:number;instructions:Instruction[]}
const equal=(a:Uint8Array,b:Uint8Array)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const reject=():never=>{throw new Error('Prepared transaction does not match the requested trade');};

function transaction(wire:Uint8Array):Transaction {
  if(wire.length>1232)reject();
  let at=0;
  const take=(n:number)=>{if(at+n>wire.length)reject();const b=wire.slice(at,at+n);at+=n;return b;};
  const byte=()=>take(1)[0];
  const short=()=>{let n=0;for(let i=0;i<3;i++){const b=byte();n|=(b&127)<<(i*7);if(!(b&128)){if(n>65535||(i>0&&b===0))reject();return n;}}return reject();};
  if(short()!==2)reject();
  const signatures=take(128),start=at;
  if(byte()!==128||byte()!==2||byte()!==1)reject();
  const readonly=byte(),count=short();
  if(count<3||count>256||readonly>count-2)reject();
  const keys=Array.from({length:count},()=>take(32));
  if(keys.some((k,i)=>keys.slice(0,i).some(p=>equal(k,p))))reject();
  take(32); // Recent blockhash is checked by the network and preserved through signing.
  if(short()!==3)reject();
  const instructions=Array.from({length:3},()=>{
    const program=byte(),accounts=Array.from(take(short()));
    if(program>=count||accounts.some(i=>i>=count))reject();
    return {program,accounts,data:take(short())};
  });
  if(short()!==0||at!==wire.length)reject(); // No lookup tables or trailing bytes.
  const used=new Set(instructions.flatMap(i=>[i.program,...i.accounts]));
  if(used.size!==count)reject();
  return {message:wire.slice(start),signatures,keys,readonly,instructions};
}

function number(data:Uint8Array,at:number,size:number):bigint {
  if(at+size>data.length)reject();
  let n=0n;for(let i=size-1;i>=0;i--)n=n*256n+BigInt(data[at+i]);return n;
}
function field(data:Uint8Array,at:number,size:number,value:string|number|boolean|undefined):void {
  const expected=typeof value==='boolean'?(value?1n:0n):BigInt(value??0);
  if(number(data,at,size)!==expected)reject();
}
async function pda(address:Uint8Array,seeds:Uint8Array[],program:Uint8Array):Promise<void> {
  const suffix=new TextEncoder().encode('ProgramDerivedAddress');
  const data=new Uint8Array(seeds.reduce((n,s)=>n+s.length,0)+1+32+suffix.length);
  let at=0;for(const seed of seeds){data.set(seed,at);at+=seed.length;}
  data.set(program,at+1);data.set(suffix,at+33);
  // Match the requested identity without curve arithmetic. The pinned program
  // rejects noncanonical bumps; such a transaction cannot affect another account.
  for(let bump=255;bump>=0;bump--){data[at]=bump;if(equal(address,new Uint8Array(await crypto.subtle.digest('SHA-256',data))))return;}
  reject();
}
function u64(value:string):Uint8Array {
  let n=BigInt(value);if(n<0n||n>18446744073709551615n)reject();
  const bytes=new Uint8Array(8);for(let i=0;i<8;i++){bytes[i]=Number(n&255n);n>>=8n;}return bytes;
}

export async function validateTrade(wire:Uint8Array,intent:TradeIntent):Promise<void> {
  const tx=transaction(wire),[limit,price,trade]=tx.instructions;
  const program=publicKey(intent.program),owner=publicKey(intent.owner);
  const budget=publicKey('ComputeBudget111111111111111111111111111111');
  if(!equal(tx.keys[0],publicKey(intent.authority))||tx.signatures.some(b=>b!==0))reject();
  if(!equal(tx.keys[limit.program],budget)||limit.accounts.length||limit.data.length!==5||limit.data[0]!==2||number(limit.data,1,4)!==400000n)reject();
  if(!equal(tx.keys[price.program],budget)||price.accounts.length||price.data.length!==9||price.data[0]!==3||number(price.data,1,8)>1000000n)reject();
  if(!equal(tx.keys[trade.program],program)||trade.accounts[0]!==1||trade.accounts[1]!==0)reject();
  const accounts=trade.accounts.map(i=>tx.keys[i]),data=trade.data,action=intent.action;
  if(accounts.length<2||!equal(accounts.at(-1)!,program)||trade.accounts.slice(2).some(i=>i<2))reject();
  const open=action.action==='open',close=action.action==='close';
  if(!open&&!close)reject();
  if(open){
    const builder=intent.builder;
    const length=builder?88:Number(action.max_round_trip_fee_ppm)===50?48:52;
    if(accounts.length!==(builder?12:11)||data.length!==length||data[0]!==6)reject();
    for(const [at,size,key] of [[1,2,'market_id'],[3,8,'margin'],[11,2,'leverage'],[13,1,'is_long'],[15,8,'worst_price'],[31,8,'min_winning_exposure'],[39,2,'expected_fee_bps'],[41,2,'expected_buffer_bps'],[43,1,'expected_economics_version'],[44,4,'expected_deadband_ppm']] as const)field(data,at,size,action[key]);
    if(data[14]!==0||action.debt_funded!==false||number(data,23,8)===0n)reject();
    if(length>48)field(data,48,4,action.max_round_trip_fee_ppm);
    if(builder){
      if(!equal(data.slice(52,84),publicKey(builder.wallet)))reject();
      field(data,84,2,builder.notional_markup_bps);field(data,86,2,builder.profit_markup_bps);
      await pda(accounts[10],[new TextEncoder().encode('trader'),publicKey(builder.wallet)],program);
    }
  }else{
    if((accounts.length!==14&&accounts.length!==16)||data.length!==17||data[0]!==7||number(data,1,8)===0n||number(data,9,8)===0n)reject();
    await pda(accounts[7],[new TextEncoder().encode('position'),owner,u64(String(action.position_id))],program);
    if(!equal(accounts[12],publicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')))reject();
  }
  if(!equal(accounts[open?8:9],new Uint8Array(32)))reject();
  await pda(accounts[4],[new TextEncoder().encode('trader'),owner],program);
  const writableRoles=open?[1,3,4,5,7]:[1,3,4,5,7,8,10,11,...(accounts.length===16?[13,14]:[])];
  const writable=new Set(writableRoles.map(i=>trade.accounts[i]));
  if(tx.keys.some((_,i)=>writable.has(i)!==(i===0||(i>=2&&i<tx.keys.length-tx.readonly))))reject();
}

export function validateSignedTrade(signed:Uint8Array,original:Uint8Array):void {
  const before=transaction(original),after=transaction(signed);
  if(!equal(before.message,after.message)||!after.signatures.slice(0,64).some(b=>b!==0)||!equal(before.signatures.slice(64),after.signatures.slice(64)))reject();
}
