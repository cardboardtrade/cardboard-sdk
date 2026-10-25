import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {validateMemo} from '../dist/src/memo.js';
const fixture=JSON.parse(readFileSync(new URL('../../fixtures/authorization.json',import.meta.url),'utf8'));
const owner=fixture.authority;
const trades=JSON.parse(readFileSync(new URL('../../fixtures/trades.json',import.meta.url),'utf8'));
import {CardboardClient,toUnits,fromUnits,type Signer,type StreamFrame} from '../dist/src/index.js';

test('decimal conversion rejects precision loss',()=>{
  assert.equal(toUnits('10.000001'),'10000001');assert.equal(toUnits('10',2),'1000');assert.equal(fromUnits('10000001'),'10.000001');
  assert.equal(toUnits('10000000000000.000001'),'10000000000000000001');
  assert.throws(()=>toUnits(10000000000000.000001 as unknown as string));
  for(const input of ['-1','0.0000001','1e8','NaN'])assert.throws(()=>toUnits(input));
});
test('typed open protects quote economics, clamps fees, authenticates reads and never retries submissions',async()=>{
  const originalFetch=globalThis.fetch,originalNow=Date.now;const server=fixture.expires_at-900;
  const {program,owner,authority,builder}=trades,order=trades.opens[0];
  const signed:string[]=[];let relays=0;let posted:Record<string,unknown>={};let missingDate=false;
  try{
    Date.now=()=>0;
    globalThis.fetch=async(url,options)=>{
      const path=new URL(String(url)).pathname;let value:unknown={};
      if(path.endsWith('/config'))value={program,max_builder_notional_markup_bps:2500,max_builder_profit_markup_bps:500,max_leverage:1000,deadband_ppm:20,round_trip_fee_ppm:50};
      else if(String(url).includes('kind=market'))value=[{state:{id:0,symbol:'BTC',retired:false,fee_bps:200,liquidation_buffer_bps:5}}];
      else if(String(url).includes('kind=oracle'))value=[{state:{market_id:0,mid:'100000000'}}];
      else if(path.endsWith('/prepare-auth'))value={program,expires_at:server+900,message:`Cardboard API access\nprogram=${program}\nowner=${owner}\nauthority=${authority}\nexpires_at=${server+900}`};
      else if(path.endsWith('/prepare')){posted=JSON.parse(String(options?.body));value={id:'intent',transaction:order.transaction,builder:order.builder_terms};}
      else if(path.endsWith('/relay')){relays++;throw new Error('response lost');}
      else if(path.endsWith('/transactions/intent')){const headers=options?.headers as Record<string,string>;const credential=JSON.parse(atob(headers.Authorization.slice(7)));assert.equal(credential.owner,owner);assert.equal(typeof credential.admission.signature,'string');value={id:'intent',status:'confirmed'};}
      return new Response(JSON.stringify(value),{headers:missingDate?{}:{Date:new Date(server*1000).toUTCString()}});
    };
    const signer:Signer={address:authority,signMessage:async()=>{signed.push('message');return new Uint8Array(64).fill(1);},signTransaction:async wire=>{signed.push('trade');const result=wire.slice();result[1]=1;return result;}};
    const client=new CardboardClient({program,owner,signer,builder:{wallet:builder,notionalMarkupPercent:30}});
    const prepared=await client.openPosition({market:'BTC',side:'long',marginUSDC:'10',leverage:10});
    assert.equal(posted.margin,'10000000');assert.equal(posted.worst_price,'100050000');assert.equal(posted.max_round_trip_fee_ppm,50);assert.equal(posted.builder_notional_markup_bps,3000);
    assert.deepEqual(signed,['message']);await assert.rejects(client.submit(prepared),/response lost/);assert.equal(relays,1);
    assert.equal((await client.getTransaction('intent')).status,'confirmed');assert.deepEqual(signed,['message','trade']);
    missingDate=true;await assert.rejects(new CardboardClient({program,owner,signer}).authorization(),/Date header missing/);
  }finally{globalThis.fetch=originalFetch;Date.now=originalNow;}
});

test('authorization memo rejects extra instructions, changed signers and wallet mutations',()=>{
  const wire=Uint8Array.from(atob(fixture.transaction),c=>c.charCodeAt(0));
  validateMemo(wire,owner,fixture.message);
  const signed=Uint8Array.from(atob(fixture.signed_transaction),c=>c.charCodeAt(0));
  validateMemo(signed,owner,fixture.message,true);
  const extra=Uint8Array.from([...wire.slice(0,-1),1,0,1,0,0]);extra[166]=2;
  assert.throws(()=>validateMemo(extra,owner,fixture.message));
  for(const offset of [65,66,68,69,70,166,167,168,wire.length-1]){const changed=wire.slice();changed[offset]^=1;assert.throws(()=>validateMemo(changed,owner,fixture.message));}
  assert.throws(()=>validateMemo(wire,owner,fixture.message+' changed'));
});

test('server keys preserve retry errors and stay out of browser requests',async()=>{
  const original=globalThis.fetch;const windowDescriptor=Object.getOwnPropertyDescriptor(globalThis,'window');const key='cbk_'+'b'.repeat(64);
  try {
    let calls=0;
    globalThis.fetch=async(_url,options)=>{calls++;assert.equal((options?.headers as Record<string,string>)['X-Builder-Key'],key);return new Response('{}');};
    const server=new CardboardClient({builderKey:key});await server.getMarkets();assert.equal(calls,1);
    globalThis.fetch=async()=>new Response('{"error":"slow down"}',{status:429,headers:{'Retry-After':'3'}});
    await assert.rejects(server.getMarkets(),error=>Boolean(error&&typeof error==='object'&&'status'in error&&error.status===429&&'retryAfter'in error&&error.retryAfter===3));
    Object.defineProperty(globalThis,'window',{value:{},configurable:true});
    globalThis.fetch=async()=>{throw new Error('A server key escaped to browser fetch');};
    await assert.rejects(server.getMarkets(),/never be used in a browser/);
    assert.throws(()=>server.subscribe({builder:'builder'},()=>{},()=>{}),/never be used in a browser/);
  } finally {
    globalThis.fetch=original;
    if(windowDescriptor)Object.defineProperty(globalThis,'window',windowDescriptor);else Reflect.deleteProperty(globalThis,'window');
  }
});

test('public and server subscriptions keep explicit scope and deliver typed settlements',async()=>{
  const original=globalThis.WebSocket;const sockets:FakeSocket[]=[];const key='cbk_'+'a'.repeat(64);
  class FakeSocket {
    static OPEN=1;readyState=1;sent:string[]=[];onopen?:()=>void;onmessage?:(event:{data:string})=>void;onclose?:(event:{code:number})=>void;onerror?:()=>void;
    constructor(readonly url:URL){sockets.push(this);queueMicrotask(()=>this.onopen?.());}
    send(value:string){this.sent.push(value);}
    close(){this.onclose?.({code:1000});}
  }
  const stops:(()=>void)[]=[];const frames:StreamFrame[]=[];
  try {
    globalThis.WebSocket=FakeSocket as unknown as typeof WebSocket;
    for(const builderKey of [undefined,key]) {
      const client=new CardboardClient({owner,builder:{wallet:'builder'},builderKey});
      stops.push(client.subscribe({},frame=>frames.push(frame),error=>{throw error;}));
    }
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sockets.length,2);
    for(const socket of sockets){assert.equal(socket.url.searchParams.get('builder'),'builder');assert.equal(socket.url.searchParams.get('owner'),null);assert.ok(!String(socket.url).includes(key));}
    assert.equal(sockets[0].sent.length,0);
    assert.deepEqual(JSON.parse(sockets[1].sent[0]),{type:'builder_authenticate',key});
    sockets[1].onmessage?.({data:'{"type":"builder_authenticated"}'});
    const settlement:Extract<StreamFrame,{type:'settlement'}>={type:'settlement',owner,address:'position',signature:'signature'};
    sockets[0].onmessage?.({data:JSON.stringify(settlement)});
    assert.deepEqual(frames,[settlement]);
    for(const type of ['system','metrics','future_event','authenticated','builder_authenticated'])sockets[0].onmessage?.({data:JSON.stringify({type})});
    assert.deepEqual(frames,[settlement]);
    sockets[0].onmessage?.({data:JSON.stringify({type:'snapshot',rows:[{kind:'config'},{kind:'pool'},{kind:'position',address:'position'}],builder_fees:[],next_cursor:null})});
    assert.deepEqual(frames.at(-1),{type:'snapshot',rows:[{kind:'position',address:'position'}],builder_fees:[],next_cursor:null});
    stops.push(new CardboardClient({builderKey:key}).subscribe({builder:'builder',owner},()=>{},()=>{}));
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sockets[2].url.searchParams.get('owner'),owner);
    stops.push(new CardboardClient({owner}).subscribe({},()=>{},()=>{}));
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(sockets[3].url.searchParams.get('owner'),owner);
    assert.equal(sockets[3].url.searchParams.get('builder'),null);
    assert.equal(sockets[3].url.searchParams.get('events'),'positions,balances');
    assert.equal(sockets[3].url.searchParams.get('authenticate'),null);
    assert.throws(()=>new CardboardClient({owner}).subscribe({owner:'different',events:['transactions']},()=>{},()=>{}),/connected wallet/);
  } finally {for(const stop of stops)stop();globalThis.WebSocket=original;}
});
