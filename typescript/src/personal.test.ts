import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {CardboardClient,type Signer,type UserPosition} from '../dist/src/index.js';

test('personal account, open positions and history use owner-scoped reads without signing',async()=>{
  const original=globalThis.fetch;const paths:string[]=[];let full=false;
  const closed={address:'closed',id:'9007199254740993',owner:'owner',market_id:0,open:false,is_long:true,margin:'9007199254740999',leverage:10,entry_price:'100000000',exit_price:'100000001',liquidated:false,returned_margin:'9007199254740998',settled_claim:'2',fees_charged:'1',closed_at:'1792844100',settlement_signature:null} satisfies UserPosition;
  const opened={...closed,address:'open',open:true};
  try{
    globalThis.fetch=async(url)=>{
      const u=new URL(String(url));paths.push(u.pathname+u.search);
      if(u.pathname.startsWith('/v1/traders/'))return Response.json({owner:'owner',available:'9007199254740993'});
      assert.equal(u.pathname,'/v1/positions/owner');
      return Response.json(full?Array.from({length:500},(_,i)=>({...opened,address:`p${String(i).padStart(3,'0')}`})):[closed,opened]);
    };
    const client=new CardboardClient({owner:'owner'});
    assert.equal((await client.getAccount()).available,'9007199254740993');
    assert.deepEqual((await client.getPositions()).items,[opened]);
    const history=await client.getHistory('owner','next?&');
    assert.deepEqual(history,{items:[closed],next_cursor:null});
    assert.equal(history.items[0].closed_at,'1792844100');
    assert.equal(BigInt(history.items[0].returned_margin)+BigInt(history.items[0].settled_claim)-BigInt(history.items[0].margin),1n);
    assert.equal(paths.at(-1),'/v1/positions/owner?cursor=next%3F%26');
    full=true;
    assert.deepEqual(await client.getHistory(),{items:[],next_cursor:'p499'});
    const signer:Signer={address:'owner',signMessage:async()=>{throw new Error('Reads must not sign');},signTransaction:async()=>{throw new Error('Reads must not sign');}};
    await new CardboardClient({signer}).getAccount();
    await new CardboardClient().getAccount('other/wallet?scope=all');
    assert.equal(paths.at(-1),'/v1/traders/other%2Fwallet%3Fscope%3Dall');
  }finally{globalThis.fetch=original;}
});

test('builder reads have explicit names and preserve attribution filters',async()=>{
  const original=globalThis.fetch;const urls:URL[]=[];
  try{
    globalThis.fetch=async(url)=>{urls.push(new URL(String(url)));return Response.json({items:[],next_cursor:null});};
    const client=new CardboardClient({builder:{wallet:'builder'}});
    await client.getBuilderEarnings();
    assert.equal(urls.at(-1)!.pathname,'/v1/builders/builder/stats');
    await client.getBuilderPositions(undefined,'owner','next?&');
    assert.equal(urls.at(-1)!.pathname,'/v1/builders/builder/positions');
    assert.equal(urls.at(-1)!.searchParams.get('owner'),'owner');
    assert.equal(urls.at(-1)!.searchParams.get('cursor'),'next?&');
  }finally{globalThis.fetch=original;}
});

test('personal opens omit builder attribution and reject an unexpected surcharge',async()=>{
  const fixture=JSON.parse(readFileSync(new URL('../../fixtures/trades.json',import.meta.url),'utf8'));
  const auth=JSON.parse(readFileSync(new URL('../../fixtures/authorization.json',import.meta.url),'utf8'));
  const plain=fixture.opens.find((row:{name:string})=>row.name==='plain');
  const original=globalThis.fetch;let posted:Record<string,unknown>={};let unexpected=false;let signatures=0;
  const server=auth.expires_at-900;
  try{
    globalThis.fetch=async(url,options)=>{
      const u=new URL(String(url));let value:unknown;
      if(u.pathname.endsWith('/config'))value={program:fixture.program,max_builder_notional_markup_bps:2500,max_builder_profit_markup_bps:2500,max_leverage:1000,deadband_ppm:20,round_trip_fee_ppm:50};
      else if(u.searchParams.get('kind')==='market')value=[{state:{id:0,symbol:'BTC',retired:false,fee_bps:200,liquidation_buffer_bps:5}}];
      else if(u.searchParams.get('kind')==='oracle')value=[{state:{market_id:0,mid:'100000000'}}];
      else if(u.pathname.endsWith('/prepare-auth'))value={program:fixture.program,expires_at:auth.expires_at,message:`Cardboard API access\nprogram=${fixture.program}\nowner=${fixture.owner}\nauthority=${fixture.authority}\nexpires_at=${auth.expires_at}`};
      else if(u.pathname.endsWith('/prepare')){posted=JSON.parse(String(options?.body));value={id:'intent',transaction:plain.transaction,...(unexpected?{builder:{wallet:fixture.builder,notional_markup_bps:1,profit_markup_bps:1}}:{})};}
      else throw new Error('Unexpected request, including trade submission');
      return Response.json(value,{headers:{Date:new Date(server*1000).toUTCString()}});
    };
    const signer:Signer={address:fixture.authority,signMessage:async()=>new Uint8Array(64).fill(1),signTransaction:async()=>{signatures++;throw new Error('Do not submit from a read/prepare test');}};
    const client=new CardboardClient({program:fixture.program,owner:fixture.owner,signer});
    const order={market:'BTC' as const,side:'long' as const,marginUSDC:'10',leverage:10};
    const prepared=await client.openPosition(order);
    assert.equal(prepared.builder,undefined);
    assert.ok(!Object.keys(posted).some(key=>key.startsWith('builder_')));
    assert.equal(signatures,0);
    unexpected=true;
    await assert.rejects(client.openPosition(order),/builder fees changed/);
  }finally{globalThis.fetch=original;}
});
