import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { SolanaSignOffchainMessageFeature, SolanaSignMessageFeature, SolanaSignTransactionFeature } from '@solana/wallet-standard-features';
import type { Signer } from './index.js';

/** Adapt an already-connected Wallet Standard account. Key material stays in the wallet. */
export function walletStandardSigner(wallet:Wallet,account:WalletAccount,chain=`solana:mainnet` as `${string}:${string}`):Signer {
  const transactions=wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
  if(!transactions||!account.features.includes('solana:signTransaction'))throw new Error('Wallet cannot sign transactions');
  const messages=wallet.features['solana:signMessage'] as SolanaSignMessageFeature['solana:signMessage']|undefined;
  const offchain=wallet.features['solana:signOffchainMessage'] as SolanaSignOffchainMessageFeature['solana:signOffchainMessage']|undefined;
  return {address:account.address,
    signOffchainMessage:offchain?.supportedMessageVersions.includes(1)&&account.features.includes('solana:signOffchainMessage')?async message=>{
      const expected=new Uint8Array([0xff,...new TextEncoder().encode('solana offchain'),1,1,...account.publicKey,...new TextEncoder().encode(message)]);
      const [result]=await offchain.signOffchainMessage({account,messageVersion:1,message,requiredSigners:[account.publicKey]});
      if(!result||result.signatureType&&result.signatureType!=='ed25519'||result.signedOffchainMessage.length!==expected.length||!result.signedOffchainMessage.every((b,i)=>b===expected[i]))throw new Error('Wallet changed the authorization message');
      return Uint8Array.from(result.signature);
    }:undefined,
    signMessage:messages&&account.features.includes('solana:signMessage')?async message=>{
      const [result]=await messages.signMessage({account,message});
      if(!result||result.signedMessage.length!==message.length||!result.signedMessage.every((b,i)=>b===message[i]))throw new Error('Wallet changed the authorization message');
      return result.signature;
    }:undefined,
    signTransaction:async transaction=>{
      const [result]=await transactions.signTransaction({account,chain,transaction});
      if(!result)throw new Error('Wallet did not return a signed transaction');
      return result.signedTransaction;
    },
  };
}
