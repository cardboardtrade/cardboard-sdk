# Cardboard SDK and examples

> **Use at your own risk · Warranty and liability disclaimer**
>
> This software and all examples are provided *"as is" and "as available,"* without warranties or guarantees of any kind, express or implied, including merchantability, fitness for a particular purpose, non-infringement, accuracy, security or availability. You use them entirely at your own risk.
>
> To the maximum extent permitted by applicable law, Cardboard and the software's authors, contributors, maintainers and distributors will not be liable for any claim, loss, damage or other liability arising from or related to the software or the use of, or inability to use, the software. This includes loss of funds or tokens, trading losses, liquidations, fees, lost profits, data loss, service interruptions, bugs, security vulnerabilities and unauthorized access, whether in contract, tort (including negligence) or otherwise, even if advised of the possibility of such losses or damages.
>
> You are responsible for testing and securing your integration and for every transaction you authorize. Trading and software failures can result in the loss of all funds. Nothing in this notice excludes liability that applicable law does not allow to be excluded.
>
> Access to and use of Cardboard's services is subject to the [Terms of Service](https://docs.cardboardtrade.xyz/terms.html), including eligibility and use restrictions.

---

## Contents

- [Trade your own account](#trade-your-own-account)
- [Build a trading app](#build-a-trading-app)
- [Account and position helpers](#account-and-position-helpers)
- [Python](#python)
- [Rust](#rust)
- [curl and plain HTTP](#curl-and-plain-http)
- [Fees and accounts](#fees-and-accounts)
- [Optional server access keys](#optional-server-access-keys)
- [Checks](#checks)
- [License](#license)

Trade your own account, automate a strategy, or build a trading app with optional builder fees. One SDK handles wallet authorization, exact amounts and trade validation for all three. You do not need to encode smart-contract instructions. The read examples do not place trades.

## Trade your own account

```sh
cd typescript
npm ci
npm run build
node dist/examples/read.js
```

Connect a wallet using your app's Wallet Standard connection, then:

```typescript
import {CardboardClient, walletStandardSigner} from '@cardboard-trade/sdk';

const client = new CardboardClient({
  program: EXPECTED_EXCHANGE_PROGRAM,
  signer: walletStandardSigner(wallet, account),
});

const balances = await client.getAccount();
const positions = await client.getPositions(); // open positions
const history = await client.getHistory();     // retained closed positions

const order = await client.openPosition({
  market: 'SOL', side: 'long', marginUSDC: '10', leverage: 10,
});
// Inspect the prepared order before submitting it.
const submitted = await client.submit(order); // wallet signs; explicit submission
const status = await client.getTransaction(submitted.id);
const stop = client.subscribe({}, event => console.log(event), console.error);
// stop() when your app no longer needs the subscription.
```

Omitting `builder` opens an unattributed position with normal protocol fees and no builder surcharge. Closing an existing attributed position still applies its original terms. A personal bot uses the same client with its own wallet or registered-session signer.

For reads without a signer, pass a wallet explicitly: `client.getAccount(USER_WALLET)`, `client.getPositions(USER_WALLET)` and `client.getHistory(USER_WALLET)`. Reading account data does not request a signature. Running `node dist/examples/read.js USER_WALLET` demonstrates these reads.

## Build a trading app

Use the same client, with the end user's signer and an optional fee-receiving wallet:

```typescript
const app = new CardboardClient({
  program: EXPECTED_EXCHANGE_PROGRAM,
  signer: walletStandardSigner(wallet, account), // the end user's wallet
  builder: {wallet: BUILDER_RECEIVING_WALLET},   // 10% of each base fee by default
});
const order = await app.openPosition({
  market: 'SOL', side: 'long', marginUSDC: '10', leverage: 10,
});
console.log(order.builder); // effective recipient and fee terms
const submitted = await app.submit(order); // the user signs
const earnings = await app.getBuilderEarnings();
const positions = await app.getBuilderPositions();
```

Builders choose how their app presents orders and fees. The receiving wallet grants no authority over users' accounts. No separate builder SDK or signing flow is required.

Install the package from this checkout with `npm install /path/to/cardboard-sdk/typescript` after building it. The runnable [browser connection example](typescript/examples/browser.ts) shows Wallet Standard discovery and connection. The client also accepts a small `Signer` interface for other wallets or registered sessions: provide an address, transaction-signing callback and optionally message/off-chain-message signing. Signing stays in the wallet. The memo fallback is used only for authorization and is never broadcast.

`openPosition()` and `closePosition()` return validated prepared orders; pass the same, unchanged object to `submit()`. The SDK checks the requested trade, wallet and builder fees before signing. Typed opens use a default 5 bp price tolerance. Pin the expected exchange program in your app and use current quotes when presenting orders.

A USDC margin is a decimal string, not a floating-point number. Standard opens use the user's trading balance. For custom account actions, `prepare()` returns an unsigned transaction for your app to validate and sign; those raw responses cannot use SDK `submit()`. Post your signed transaction to `/relay` as described in [the integration reference](API.md#prepare-and-submit).

If submission times out, call `getTransaction(order.id)` before preparing another order. The client never automatically resubmits a trade. Subscriptions reconnect for a fresh snapshot; fee frames describe current state and must not be summed repeatedly. Wallets and apps should still inspect transactions as part of their signing flow.

## Account and position helpers

| Purpose | TypeScript | Python / Rust |
| --- | --- | --- |
| Trading balances | `getAccount` | `get_account` |
| Open positions | `getPositions` | `get_positions` |
| Closed position history | `getHistory` | `get_history` |
| Builder earnings | `getBuilderEarnings` | `get_builder_earnings` |
| Builder-attributed positions | `getBuilderPositions` | `get_builder_positions` |

Personal position and history helpers return `{items, next_cursor}`. Pass `next_cursor` to the next call until it is null, even if `items` is empty. Pages use address order, not newest-first order. History includes exit price/time, liquidation status and settlement amounts; amounts, IDs and timestamps remain decimal strings.

Personal TypeScript subscriptions default to the connected wallet's positions and balances. Builder subscriptions default to builder-attributed positions and earnings. To receive private order statuses, explicitly include `transactions` and use the connected owner's filter: `client.subscribe({owner: USER_WALLET, events: ['positions', 'balances', 'transactions']}, onFrame, onError)`.

## Python

Python 3.11 or later; no runtime dependencies. Install with `python3 -m pip install ./python` or run directly:

```sh
cd python
python3 example.py
python3 -m unittest -v test_client
```

```python
from cardboard_sdk import CardboardClient, Signer

client = CardboardClient(
    program=EXPECTED_EXCHANGE_PROGRAM,
    signer=Signer(wallet_address, wallet_sign_transaction, wallet_sign_message),
)
print(client.get_account())
print(client.get_positions())
print(client.get_history())
order = client.open_position(market='SOL', side='long', margin_usdc='10', leverage=10)
# Present/review the order in your app before explicitly submitting it.
status = client.submit(order)
print(client.get_transaction(status['id']))
```

Callbacks accept bytes and return signed bytes (a signature for messages; the complete signed wire for transactions). Omit `sign_message` for a transaction-signing-only wallet. A registered session uses its signer address with the user wallet passed as `owner`.

For a builder app, import `Builder` and pass `builder=Builder(BUILDER_RECEIVING_WALLET)` to the same constructor. Use `get_builder_earnings()` and `get_builder_positions()` for attribution reads. `python3 example.py USER_WALLET` reads a personal account without signing.

## Rust

```sh
cd rust
cargo test --locked
cargo run --example read --locked
```

`cardboard_client::Client` provides markets, personal accounts, positions, history, orders and builder earnings. Personal reads take an owner explicitly, such as `client.get_positions(USER_WALLET, None)`. Implement the `Signer` trait using your Solana wallet/session integration. See [the trading example](rust/examples/trade.rs); running it alone does not trade. Pass `None` for unattributed opens or `Some(&builder)` to attach builder fees. `Builder::new(wallet)` defaults both markups to 10%.

## curl and plain HTTP

```sh
./http/read.sh
USER_WALLET=YOUR_WALLET ./http/read.sh
BUILDER_WALLET=YOUR_RECEIVING_WALLET ./http/read.sh
```

[requests.http](http/requests.http) shows personal balances/positions, builder earnings, wallet authorization, trading and order tracking. Wallet signatures must come from a wallet; an access key grants no trading authority.

## Fees and accounts

Traders need a Cardboard trading account and deposited trading funds. If you attach builder fees, the receiving wallet also needs a trading account. A builder wallet receives fees; it does not gain permission to trade or withdraw for users.

Builder fees are additional percentages **of existing fees**. At 10%, a 0.5 bp base notional fee adds 0.05 bp, and a 2% winning-profit fee adds 0.2% of winning profit. Each markup defaults to 10%, with a maximum of 25%; inspect the effective terms returned with your prepared order. Terms are fixed when a position opens. Collection is limited by available proceeds, and the profit component only applies to wins. Credited earnings can be withdrawn from the receiving trading account.

Use decimal strings for percentages in TypeScript and Python, such as `'10'` for 10%. Raw HTTP uses markup basis points: `1000` means 10%, not a fee of 1000 bp on notional. [API.md](API.md) covers requests, signing and live updates.

## Optional server access keys

Personal bots and builder apps can use the SDK without a key. If you receive a server access key, it is independent of builder fee attribution. Keep it on your server:

```typescript
const server = new CardboardClient({builderKey: process.env.CARDBOARD_BUILDER_KEY!});
const markets = await server.getMarkets();
```

The option is named `builderKey` (Python: `builder_key`; Rust: `with_builder_key`). Setting it does not attach a receiving wallet or add a builder fee. User actions still require wallet signatures. Never expose a key in a browser bundle, URL or log.

Respect request errors and retry delays. See [API.md](API.md#builder-keys) for how to attach a key to HTTP and live subscriptions.

## Checks

```sh
(cd typescript && npm ci && npm run build && npm test)
(cd python && python3 -m unittest -v test_client)
(cd rust && cargo test --locked && cargo clippy --all-targets --locked -- -D warnings)
```

All automated tests use local fixtures. They never sign or submit live transactions. TypeScript includes reconnecting WebSocket subscriptions; Python and Rust provide HTTP clients and examples.

## License

Copyright 2026 Cardboard SDK contributors. Licensed under the [Apache License, Version 2.0](LICENSE).
