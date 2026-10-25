import { getWallets } from '@wallet-standard/app';
import type { StandardConnectFeature } from '@wallet-standard/features';
import { CardboardClient, type Prepared } from '../src/index.js';
import { walletStandardSigner } from '../src/wallet-standard.js';

/** Invoke from your app's connect action; never called automatically on page load. */
export async function connect(walletName:string,expectedProgram:string,builderWallet?:string){
  const wallet=getWallets().get().find(w=>w.name===walletName);
  const connect=wallet?.features['standard:connect'] as StandardConnectFeature['standard:connect']|undefined;
  if(!wallet||!connect)throw new Error('Choose an installed wallet');
  const {accounts}=await connect.connect();const account=accounts.find(a=>a.chains.includes('solana:mainnet'));
  if(!account)throw new Error('Choose a Solana mainnet wallet account');
  return new CardboardClient({program:expectedProgram,signer:walletStandardSigner(wallet,account),...(builderWallet?{builder:{wallet:builderWallet}}:{})});
}
export async function prepareOrder(client:CardboardClient):Promise<Prepared>{
  return client.openPosition({market:'SOL',side:'long',marginUSDC:'10',leverage:10});
}
// Present the order however your app chooses, then call client.submit(prepared).
// For live updates: client.subscribe({}, onFrame, onError).
