# Trading and builder integration reference

Base URL: `https://cardboardtrade.xyz/v1`. WebSocket: `wss://cardboardtrade.xyz/v1/stream`.

Connect a wallet, create its trading account and deposit USDC before trading. Personal traders and builder apps use the same endpoints and signing flow. Builder attribution is optional; a receiving wallet needs an existing trading account when used.

## Trading flow

1. Read markets and pin the expected exchange program in your app.
2. Obtain and sign an API authorization challenge.
3. Prepare an order, receive effective fee terms and the unsigned Solana transaction.
4. Have the user's wallet or registered session sign that transaction; submit it once.
5. Track the order until confirmed, finalized, failed or expired. An accepted submission is not confirmation.

The SDK handles these steps with `openPosition`, `closePosition`, `submit`, `getTransaction` and `subscribe`. Personal reads use `getAccount`, `getPositions` and `getHistory`; builder reads use `getBuilderEarnings` and `getBuilderPositions` (snake_case in Python/Rust). Typed orders are validated locally before signing: the transaction must match the requested operation, pinned program and wallet, with no extra instructions or address lookups. Keep the same prepared object unchanged through `submit`. Preparing an order does not submit it. Builders decide how their app presents orders and fees.

## Public reads

| Request | Result |
| --- | --- |
| `GET /accounts?kind=market` | Market IDs, symbols and current fee terms |
| `GET /accounts?kind=oracle` | Current market prices |
| `GET /traders/{wallet}` | Public trading-account balances and account state |
| `GET /positions/{wallet}?cursor=OPTIONAL_ADDRESS` | Retained positions owned by the wallet, both open and closed |
| `GET /builders/{wallet}/stats` | Builder earnings totals and market breakdown |
| `GET /builders/{wallet}/positions?owner=OPTIONAL_WALLET&cursor=OPTIONAL_ADDRESS` | Builder-attributed position page |

Amounts and prices are integer base-unit decimal strings: 1 USDC = 1000000. Markup fields are integer basis points **of the base fee**. IDs, amounts and fee totals should not be converted to floating-point numbers. Quotes and account views can lag the chain; the transaction's price/economics guards still apply.

Personal position HTTP reads return a flat array of up to 500 rows, in address order. A full page continues after its last `address`. The SDK's `getPositions` filters open positions; `getHistory` filters closed positions. Both return `{items, next_cursor}` and preserve the continuation cursor even when a filtered page is empty. Continue until `next_cursor` is null. These are retained position histories, not cashflow histories or newest-first feeds. Personal rows are flat position objects; builder position `items` are account envelopes containing `state`.

## Wallet authorization

Request:

```http
GET /prepare-auth?owner=USER_WALLET&authority=SIGNING_WALLET_OR_SESSION&lifetime_seconds=900
```

The response contains `program`, `message`, `expires_at` and `transaction`. Check the expected program, owner and authority in the message before signing. Expiry comes from the API; use its `Date` header and elapsed monotonic time rather than the device's wall clock.

Sign the exact message bytes and construct:

```json
{"expires_at": 0, "signature": "BASE64_SIGNATURE"}
```

Replace `0` with the returned expiry. Wallets supporting OCMS v1 can use `offchain_signature` instead. For wallets without message signing, sign the returned memo transaction and send its base64 wire in `transaction` instead of `signature`. **Never broadcast the authorization memo.** Inspect that it is a memo-only transaction with the signing authority as its sole signer and payer, the exact expected message, and no additional instructions or address lookups; the SDK validates this before and after signing. Supply exactly one proof format.

For preparation, include this object as `admission` in the JSON body. For transaction status reads, encode `{ "owner": "...", "authority": "...", "admission": PROOF }` as base64 JSON and send it as `Authorization: Bearer BASE64_CREDENTIAL`. It is a short-lived credential: keep it out of URLs, logs and shared caches.

A registered session may sign actions within its existing permissions. The root wallet remains necessary for funding, withdrawals and account administration. Reading a user's order details requires that user's wallet authorization.

## Prepare and submit

```http
POST /prepare
Content-Type: application/json
```

```json
{
  "owner": "USER_WALLET",
  "authority": "USER_OR_REGISTERED_SESSION",
  "admission": {"expires_at": 0, "signature": "BASE64_SIGNATURE"},
  "action": "open",
  "market_id": 0,
  "margin": "10000000",
  "leverage": 10,
  "is_long": true,
  "debt_funded": false,
  "worst_price": "CURRENT_PRICE_GUARD_IN_BASE_UNITS"
}
```

Use the selected market's ID (`BTC=0`, `ETH=1`, `SOL=2`) and a current price guard. Typed SDK opens validate the requested market, amounts, economics and effective builder terms before signing. Raw clients can supply `expected_fee_bps`, `expected_buffer_bps`, `expected_economics_version`, `expected_deadband_ppm`, `max_round_trip_fee_ppm` and `min_winning_exposure` to protect quoted economics. Use the SDK when you do not want to construct these guards yourself.

The example is a personal, unattributed trade. A builder app adds `builder_wallet`, `builder_notional_markup_bps` and `builder_profit_markup_bps` to that same request, for example a receiving wallet and `1000` for each markup. A server access key alone never adds builder fees.

The response contains `id`, `transaction` and, for attributed orders, effective `builder` terms (`wallet`, `notional_markup_bps`, `profit_markup_bps`). Inspect the transaction through your signing integration. After wallet signing:

```http
POST /relay
Content-Type: application/json

{"id":"PREPARED_INTENT_ID","transaction":"BASE64_SIGNED_TRANSACTION"}
```

A repeated, authorized relay returns `409` without transaction details. Recover through the authorized status endpoint.

Poll `GET /transactions/{id}` with wallet authorization or subscribe to authenticated transaction updates. If relay times out, check this same intent before preparing another trade. Never automatically resubmit because a response was lost.

Closing uses `action: "close"` and `position_id`. Paired opens use `action: "open_delta_neutral"`, common builder terms and per-leg `long_worst_price`, `short_worst_price`, `long_min_winning_exposure`, `short_min_winning_exposure`. Common margin is per leg. Other account actions use the same prepare/sign/submit flow.

SDK `submit()` accepts only locally validated typed opens/closes. Generic `prepare()` responses require your app's own instruction validation and signing before posting signed bytes to `/relay`. Typed orders validate the requested trade and enforce network-fee limits. If an order fails validation, obtain a fresh order instead of bypassing the check.

## Builder fees

With a builder wallet, each omitted markup defaults to `1000`, meaning 10% of the existing fee. Explicit zero disables that component. Request up to `2500` (25%) per component and inspect the effective terms returned with the prepared order; higher requests are clamped. Omit the builder wallet and both markups for an unattributed trade with no builder surcharge.

These are additional fees, fixed with the receiving wallet when the position opens. With a 0.5 bp base notional fee and a 2% winning-profit fee, 10% markups add 0.05 bp on notional and 0.2% on winning profit. Collection is limited by available proceeds; the profit component only applies to wins. Fees are earned on close regardless of which app initiates it. Credited earnings can be withdrawn from the receiving trading account.

## Earnings

`GET /builders/{wallet}/stats` returns `totals` and a `markets` breakdown. Money and count fields are decimal strings:

| Field | Meaning |
| --- | --- |
| `earned` | Total assessed builder fees on closed positions |
| `notional_fees`, `profit_fees` | Fee components |
| `credited` | Historical cash credits to the receiving trading account; not withdrawals or current balance |
| `queued` | Outstanding unpaid earnings |
| `reused_as_margin` | Unpaid earnings used for debt-funded trading |
| `earned_24h` | Earnings from positions closed in the trailing 24 hours |
| `positions_opened`, `positions_closed`, `traders` | Attributed activity counts |

`earned = credited + queued + reused_as_margin`. Use normal account withdrawals for credited funds. Reports may update after the transaction confirms.

Position pages return `items` and `next_cursor`; follow the cursor until null. Account rows contain `address`, `kind`, `slot`, an opaque increasing `version`, and `state`. A position's `builder_pending`, `builder_paid` and `builder_reused` describe its current fee disposition.

## Live updates

```text
wss://cardboardtrade.xyz/v1/stream?builder=BUILDER_WALLET&events=positions,builder_fees
wss://cardboardtrade.xyz/v1/stream?owner=USER_WALLET&events=positions,balances,transactions&authenticate=true
```

Supported scoped categories: `positions`, `balances`, `transactions`, `builder_fees`, `markets`. Set `builder`, `owner`, or both. Combined position filters intersect. Balances and authenticated transaction statuses remain owner-wide. Builder attribution applies to positions opened through that recipient, not every action a user ever takes.

Positions and on-chain balances are public. Private transaction statuses require matching owner authorization. After `auth_challenge`, send `{ "type": "authenticate", "authority": "SIGNER", "admission": PROOF }`. The server acknowledges `authenticated` and supplies recent transaction states. Revoked and expired sessions lose access.

A `snapshot` supplies initial account `rows`, fee states and an optional position `next_cursor`. Merge subsequent `delta` upserts by address/version; apply removals. `valuations` update position values. An owner-only position stream can also send `settlement` with `owner`, position `address` and confirmed close `signature`. A `builder_fees` frame contains source `position`, `version` and current position `state`; replace the previous state rather than adding the amount again.

After disconnect, reconnect and reconcile a fresh snapshot. Backfill additional positions through the paginated endpoint. This is current-state recovery, not a durable event replay log. The TypeScript SDK handles reconnects and authentication; your app still owns its display state.

## Builder keys

Personal bots and builder apps can connect without a key. If you receive a server access key, keep it on your server. It is independent of fee attribution: it does not authorize trades or withdrawals, choose a receiving wallet or add builder fees. The SDK option is named `builderKey` / `builder_key` / `with_builder_key`.

HTTP requests attach it as `X-Builder-Key: YOUR_BUILDER_KEY`. Keep it out of browser bundles, URLs and logs.

For server WebSockets, add `builder_access=true` and send `{ "type": "builder_authenticate", "key": "cbk_..." }` as the first frame. The server acknowledges `builder_authenticated` before its snapshot. Subscribe with explicit filters; using a key does not change their scope. Wallet authentication for private transaction updates follows separately. Browser WebSockets use the ordinary public connection without a builder key.

## Errors and retries

Respect `429`/`503` and `Retry-After`, use bounded backoff for reads, and reconnect rather than repeatedly opening sockets. Read errors do not justify resubmitting trades. Authorization expires; obtain a fresh proof when needed. Wallet signatures and account permissions apply to every action.
