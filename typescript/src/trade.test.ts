import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {validateTrade,validateSignedTrade,type TradeIntent} from '../dist/src/trade.js';
import {CardboardClient,type BuilderFees,type Prepared,type Signer} from '../dist/src/index.js';

interface Case {name:string;action:TradeIntent['action'];builder_terms?:BuilderFees|null;transaction:string}
interface Fixture {program:string;owner:string;authority:string;builder:string;opens:Case[];closes:Case[];invalid:{name:string;case:string;transaction:string}[]}
const fixture:Fixture=JSON.parse(readFileSync(new URL('../../fixtures/trades.json',import.meta.url),'utf8'));
const bytes=(base64:string)=>Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
const intent=(c:Case):TradeIntent=>({program:fixture.program,owner:fixture.owner,authority:fixture.authority,action:c.action,builder:c.builder_terms??undefined});
const sign=(wire:Uint8Array)=>{wire[1]=1;return wire;};

test('wire checks accept real orders and reject hostile transaction instructions',async()=>{
  for(const c of [...fixture.opens,...fixture.closes]){
    const wire=bytes(c.transaction),expected=intent(c);
    await validateTrade(wire,expected);
    validateSignedTrade(sign(wire.slice()),wire);
    for(const malformed of [Uint8Array.from([...wire,0]),wire.slice(0,-1),Uint8Array.from([130,0,...wire.slice(1)]),Uint8Array.from([...wire.slice(0,129),129,...wire.slice(130)]),Uint8Array.from([...wire.slice(0,-1),1])])await assert.rejects(validateTrade(malformed,expected));
    await assert.rejects(validateTrade(wire,{...expected,owner:fixture.authority}));
    for(let n=0;n<wire.length;n++)await assert.rejects(validateTrade(wire.slice(0,n),expected));
    const changed=sign(wire.slice());changed[130]^=1;
    assert.throws(()=>validateSignedTrade(changed,wire));
    const relayer=sign(wire.slice());relayer[65]=1;
    assert.throws(()=>validateSignedTrade(relayer,wire));
  }
  for(const bad of fixture.invalid){
    const [kind,...name]=bad.case.split('_');
    const c=(kind==='open'?fixture.opens:fixture.closes).find(c=>c.name===name.join('_'))!;
    await assert.rejects(validateTrade(bytes(bad.transaction),intent(c)),bad.name);
  }
});

test('submit signs only client-validated orders and preserves its independent snapshot',async()=>{
  const c=fixture.opens[0];let signs=0,relays=0,relayedId='';
  const signer:Signer={address:fixture.authority,signTransaction:async wire=>{signs++;return sign(wire);}};
  const client=new CardboardClient({program:fixture.program,owner:fixture.owner,signer});
  // Exercise the private sealing boundary; network preparation is covered separately.
  const checked=(client as unknown as {checked(p:Prepared,a:TradeIntent['action'],b:TradeIntent['builder']):Promise<Prepared>}).checked.bind(client);
  client.request=async <T>(_path:string,body?:object)=>{relays++;relayedId=(body as {id:string}).id;return {status:'submitted'} as T;};
  const raw=():Prepared=>({id:'intent',transaction:c.transaction,builder:{...c.builder_terms!}});
  await assert.rejects(client.submit(raw()),/unchanged typed order/);assert.equal(signs,0);
  const prepared=await checked(raw(),c.action,c.builder_terms!);
  await client.submit(prepared);assert.equal(signs,1);assert.equal(relays,1);
  prepared.transaction=btoa('changed');await assert.rejects(client.submit(prepared));assert.equal(signs,1);
  prepared.transaction=c.transaction;prepared.builder!.profit_markup_bps++;await assert.rejects(client.submit(prepared));
  prepared.builder={...c.builder_terms!};
  const other=new CardboardClient({program:fixture.program,owner:fixture.owner,signer});await assert.rejects(other.submit(prepared));
  signer.signTransaction=async wire=>{wire[wire.length-2]^=1;return sign(wire);};
  await assert.rejects(client.submit(prepared));assert.equal(relays,1);
  signer.signTransaction=async wire=>{prepared.id='changed-during-signing';return sign(wire);};
  await client.submit(prepared);assert.equal(relayedId,'intent');
});

test('market relabeling never reaches preparation or wallet signing',async()=>{
  const signer:Signer={address:fixture.authority,signTransaction:async()=>{throw new Error('Relabeled market reached wallet');}};
  const client=new CardboardClient({program:fixture.program,owner:fixture.owner,signer});
  client.request=async <T>(path:string)=>{
    if(path==='/config')return {program:fixture.program} as T;
    if(path==='/accounts?kind=market')return [{state:{symbol:'SOL',id:0,retired:false}}] as T;
    if(path==='/accounts?kind=oracle')return [] as T;
    throw new Error('Relabeled market reached preparation');
  };
  await assert.rejects(client.openPosition({market:'SOL',side:'long',marginUSDC:'10',leverage:10}),/identity changed/);
});

test('typed close seals its requested position and rejects unexpected fee metadata',async()=>{
  const signer:Signer={address:fixture.authority,signTransaction:async wire=>sign(wire)};
  const client=new CardboardClient({program:fixture.program,owner:fixture.owner,signer});
  let response:Prepared={id:'close',transaction:fixture.closes[0].transaction};
  client.prepare=async()=>response;
  const closed=await client.closePosition('7');assert.equal(closed.id,'close');
  await assert.rejects(client.closePosition('8'));
  await assert.rejects(client.closePosition('18446744073709551616'),/Invalid position ID/);
  response={...response,builder:fixture.opens[0].builder_terms!};
  await assert.rejects(client.closePosition('7'),/builder fees changed/);
});
