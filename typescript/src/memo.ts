// Canonical Solana v0 memo: one payer/signer, one instruction, no lookup tables.
export function publicKey(address:string):Uint8Array {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if(!address||address.length>44)throw new Error('Invalid wallet address');
  let n=0n;
  for(const c of address){const digit=alphabet.indexOf(c);if(digit<0)throw new Error('Invalid wallet address');n=n*58n+BigInt(digit);}
  const raw=n.toString(16);const hex=raw.padStart(raw.length+raw.length%2,'0');
  const body=n===0n?[]:hex.match(/../g)!.map(b=>parseInt(b,16));
  const zeros=address.match(/^1*/)![0].length;
  if(zeros+body.length!==32)throw new Error('Invalid wallet address');
  return Uint8Array.from([...Array(zeros).fill(0),...body]);
}
export function validateMemo(wire:Uint8Array,authority:string,message:string,signed=false):void {
  const text=new TextEncoder().encode(message);const size:number[]=[];
  for(let n=text.length;;n>>>=7){size.push((n&127)|(n>=128?128:0));if(n<128)break;}
  const expected=Uint8Array.from([1,...Array(64).fill(0),128,1,0,1,2,...publicKey(authority),
    ...publicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),...wire.slice(134,166),1,1,0,...size,...text,0]);
  if(wire.length>1232||wire.length!==expected.length||!expected.every((b,i)=>signed&&i>=1&&i<65||wire[i]===b)||signed&&!wire.slice(1,65).some(b=>b!==0))throw new Error('Authorization transaction must contain only the expected memo');
}
