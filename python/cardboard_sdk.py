"""Small synchronous Cardboard client; Python 3.11+, standard library only."""
from __future__ import annotations
import base64
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import re
import struct
from email.utils import parsedate_to_datetime
import json
import time
from typing import Any, Callable
from urllib.error import HTTPError
from urllib.parse import urlencode, quote
from urllib.request import Request, HTTPRedirectHandler, build_opener

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

@dataclass(frozen=True)
class Signer:
    address: str
    sign_transaction: Callable[[bytes], bytes]
    sign_message: Callable[[bytes], bytes] | None = None

@dataclass(frozen=True)
class Builder:
    wallet: str
    notional_markup_percent: str = "10"
    profit_markup_percent: str = "10"

class ApiError(Exception):
    def __init__(self, status: int, message: str, retry_after: str | None):
        super().__init__(message)
        self.status, self.retry_after = status, retry_after

def units(value: str, decimals: int = 6) -> str:
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
        raise ValueError('Use an exact nonnegative decimal amount')
    whole, _, fraction = value.partition('.')
    if len(fraction) > decimals:
        raise ValueError('Invalid amount precision')
    n = int(whole) * 10**decimals + int(fraction.ljust(decimals, '0') or '0')
    if n > 18446744073709551615:
        raise ValueError('Amount exceeds the supported range')
    return str(n)

def _public_key(address: str) -> bytes:
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    if not address or len(address) > 44:
        raise ValueError('Invalid wallet address')
    n = 0
    for char in address:
        n = n * 58 + alphabet.index(char)
    result = b'\0' * (len(address) - len(address.lstrip('1'))) + n.to_bytes((n.bit_length()+7)//8, 'big')
    if len(result) != 32:
        raise ValueError('Invalid wallet address')
    return result

def _validate_memo(wire: bytes, authority: str, message: str, signed: bool = False) -> None:
    text, size = message.encode(), bytearray()
    n = len(text)
    while n >= 128:
        size.append((n & 127) | 128)
        n >>= 7
    size.append(n)
    expected = (b'\1' + b'\0'*64 + bytes([128,1,0,1,2]) + _public_key(authority)
                + _public_key('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
                + wire[134:166] + bytes([1,1,0]) + size + text + b'\0')
    if len(wire) > 1232 or (wire[:1]+b'\0'*64+wire[65:] if signed else wire) != expected or signed and not any(wire[1:65]):
        raise ValueError('Authorization transaction must contain only the expected memo')

class PreparedOrder(dict):
    """A typed order checked by this client; generic prepare responses cannot be submitted."""
    def __init__(self, value: dict[str, Any], token: object, expected: dict[str, Any]):
        if not isinstance(value.get('id'), str) or not 1 <= len(value['id']) <= 64:
            raise ValueError('Invalid prepared intent ID')
        super().__init__(value)
        self._token, self._expected = token, deepcopy(expected)
        self._builder = deepcopy(value.get('builder'))
        self._id, self._wire = value['id'], _trade_bytes(value['transaction'])

def _trade_bytes(transaction: str) -> bytes:
    if not isinstance(transaction, str) or not 1 <= len(transaction) <= 1644:
        raise ValueError('Invalid prepared transaction size')
    return base64.b64decode(transaction, validate=True)

def _parse_trade(wire: bytes) -> tuple[bytes, list[bytes], list[tuple[int, bytes, bytes]], int]:
    """Parse bounded canonical v0 trade transactions without lookup tables."""
    if not isinstance(wire, bytes) or not 1 <= len(wire) <= 1232:
        raise ValueError('Invalid prepared transaction')
    at = 0
    def take(size: int) -> bytes:
        nonlocal at
        if at + size > len(wire):
            raise ValueError('Truncated prepared transaction')
        value, at = wire[at:at+size], at+size
        return value
    def count() -> int:
        value = 0
        for i in range(3):
            byte = take(1)[0]
            value |= (byte & 127) << (7*i)
            if not byte & 128:
                if (i and byte == 0) or value > 65535:
                    raise ValueError('Noncanonical transaction length')
                return value
        raise ValueError('Invalid transaction length')
    signatures = count()
    if signatures != 2:
        raise ValueError('Unexpected transaction signers')
    take(signatures*64)
    start = at
    if take(1) != b'\x80':
        raise ValueError('Prepared transaction must use v0 without lookup tables')
    required, readonly_signed, readonly_unsigned = take(3)
    keys = [take(32) for _ in range(count())]
    if required != signatures or readonly_signed != 1 or required > len(keys) or readonly_unsigned > len(keys)-required or len(set(keys)) != len(keys):
        raise ValueError('Invalid prepared account privileges')
    take(32) # Recent blockhash; the wallet must preserve it.
    instructions = [(take(1)[0], take(count()), take(count())) for _ in range(count())]
    if take(1) != b'\0' or at != len(wire) or any(p >= len(keys) or any(a >= len(keys) for a in accounts) for p, accounts, _ in instructions):
        raise ValueError('Unexpected lookup tables or trailing transaction data')
    return wire[start:], keys, instructions, required

def _pda_matches(key: bytes, program: bytes, *seeds: bytes) -> bool:
    # Matching seeds binds the intended account; the program verifies its canonical bump.
    return any(hashlib.sha256(b''.join(seeds)+bytes([bump])+program+b'ProgramDerivedAddress').digest() == key for bump in range(255, -1, -1))

def _validate_trade(wire: bytes, expected: dict[str, Any], signed: bool = False) -> bytes:
    message, keys, instructions, signers = _parse_trade(wire)
    authority, program, owner = (_public_key(expected[name]) for name in ('authority', 'program', 'owner'))
    if keys[0] != authority or len(instructions) != 3:
        raise ValueError('Prepared transaction changed the payer or instructions')
    prefix = len(wire)-len(message)
    if (not signed and any(wire[1:prefix])) or signed and not any(wire[1:65]):
        raise ValueError('Invalid prepared transaction signatures')
    compute = _public_key('ComputeBudget111111111111111111111111111111')
    limit, price = instructions[:2]
    if keys[limit[0]] != compute or limit[1] or limit[2] != b'\x02'+(400000).to_bytes(4, 'little') or keys[price[0]] != compute or price[1] or len(price[2]) != 9 or price[2][0] != 3:
        raise ValueError('Unexpected compute budget instructions')
    if int.from_bytes(price[2][1:], 'little') > 1000000:
        raise ValueError('Prepared priority fee exceeds the supported maximum')
    instruction = instructions[2]
    accounts, data = instruction[1], instruction[2]
    if keys[instruction[0]] != program or len(accounts) < 9 or accounts[:2] != b'\1\0' or any(a < 2 for a in accounts[2:]):
        raise ValueError('Prepared transaction changed the exchange or authority')
    if not _pda_matches(keys[accounts[4]], program, b'trader', owner):
        raise ValueError('Prepared transaction changed the trading account')
    action, builder = expected['action'], expected.get('builder')
    if action['action'] == 'open':
        if action.get('debt_funded') is not False:
            raise ValueError('Typed opens cannot use debt funding')
        if len(data) != (88 if builder else 48 if action['max_round_trip_fee_ppm'] == 50 else 52) or data[0] != 6:
            raise ValueError('Prepared transaction is not the requested open')
        values = struct.unpack('<HQHBBQQQHHBI', data[1:48])
        wanted = (action['market_id'], int(action['margin']), action['leverage'], int(action['is_long']), 0,
                  int(action['worst_price']), values[6], int(action.get('min_winning_exposure', '0')),
                  action['expected_fee_bps'], action['expected_buffer_bps'], action['expected_economics_version'], action['expected_deadband_ppm'])
        fee_cap = int.from_bytes(data[48:52], 'little') if len(data) >= 52 else 50
        if values != wanted or values[6] == 0 or fee_cap != action['max_round_trip_fee_ppm']:
            raise ValueError('Prepared open terms changed')
        if len(accounts) != (12 if builder else 11) or keys[accounts[-1]] != program:
            raise ValueError('Unexpected prepared open accounts')
        if keys[accounts[8]] != bytes(32):
            raise ValueError('Unexpected system program')
        if builder:
            terms = _public_key(builder['wallet'])+struct.pack('<HH', builder['notional_markup_bps'], builder['profit_markup_bps'])
            if len(data) != 88 or data[52:] != terms or not _pda_matches(keys[accounts[10]], program, b'trader', terms[:32]):
                raise ValueError('Prepared builder fees changed')
        elif len(data) == 88:
            raise ValueError('Unexpected builder fees')
        writable = {1, 3, 4, 5, 7}
    elif action['action'] == 'close':
        if len(data) != 17 or data[0] != 7 or len(accounts) not in (14, 16) or keys[accounts[-1]] != program:
            raise ValueError('Prepared transaction is not the requested close')
        if not _pda_matches(keys[accounts[7]], program, b'position', owner, int(action['position_id']).to_bytes(8, 'little')):
            raise ValueError('Prepared transaction changed the position')
        if int.from_bytes(data[1:9], 'little') == 0 or int.from_bytes(data[9:], 'little') == 0:
            raise ValueError('Prepared close requires price and expiry guards')
        if keys[accounts[9]] != bytes(32) or keys[accounts[12]] != _public_key('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'):
            raise ValueError('Unexpected settlement programs')
        writable = {1, 3, 4, 5, 7, 8, 10, 11} | ({13, 14} if len(accounts) == 16 else set())
    else:
        raise ValueError('Only typed opens and closes can be submitted')
    used = set(accounts) | {limit[0], price[0], instruction[0]}
    write_keys = {accounts[role] for role in writable}
    if used != set(range(len(keys))) or any((i < signers-1 if i < signers else i < len(keys)-message[3]) != (i in write_keys) for i in range(len(keys))):
        raise ValueError('Unexpected prepared account privileges')
    return message

class CardboardClient:
    def __init__(self, *, api_base: str = "https://cardboardtrade.xyz/v1", program: str | None = None,
                 signer: Signer | None = None, owner: str | None = None, builder: Builder | None = None, builder_key: str | None = None):
        self.base, self.program, self.signer, self.owner, self.builder = api_base.rstrip('/'), program, signer, owner, builder
        self.builder_key = builder_key
        self._order_token = object()
        self._http = build_opener(NoRedirect)
        self._proof: dict[str, Any] | None = None
        self._clock: tuple[float, float] | None = None

    def request(self, path: str, body: dict[str, Any] | None = None, authorization: str | None = None) -> Any:
        headers = {"Content-Type": "application/json"} if body is not None else {}
        if self.builder_key:
            headers['X-Builder-Key'] = self.builder_key
        if authorization:
            headers["Authorization"] = authorization
        request = Request(self.base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with self._http.open(request, timeout=15) as response:
                if response.headers.get('Date'):
                    self._clock = parsedate_to_datetime(response.headers['Date']).timestamp(), time.monotonic()
                return json.load(response)
        except HTTPError as error:
            try:
                message = json.load(error).get('error', f'API {error.code}')
            except (ValueError, AttributeError):
                message = f'API {error.code}'
            raise ApiError(error.code, message, error.headers.get('Retry-After')) from error

    def _trading_terms(self) -> dict[str, Any]:
        return self.request('/config')

    def get_markets(self) -> list[dict[str, Any]]:
        return self.request('/accounts?kind=market')

    def get_builder_earnings(self, wallet: str | None = None) -> dict[str, Any]:
        wallet = wallet or (self.builder.wallet if self.builder else None)
        if not wallet:
            raise ValueError('Set a builder wallet')
        return self.request(f'/builders/{quote(wallet, safe="")}/stats')

    def get_builder_positions(self, wallet: str | None = None, *, owner: str | None = None, cursor: str | None = None) -> dict[str, Any]:
        wallet = wallet or (self.builder.wallet if self.builder else None)
        if not wallet:
            raise ValueError('Set a builder wallet')
        query = urlencode({k: v for k, v in {'owner': owner, 'cursor': cursor}.items() if v is not None})
        return self.request(f'/builders/{quote(wallet, safe="")}/positions' + ('?' + query if query else ''))

    def _read_owner(self, owner: str | None) -> str:
        owner = owner or self.owner or (self.signer.address if self.signer else None)
        if not owner:
            raise ValueError('Set a wallet owner')
        return owner

    def get_account(self, owner: str | None = None) -> dict[str, Any]:
        return self.request('/traders/' + quote(self._read_owner(owner), safe=''))

    def _positions(self, owner: str | None, cursor: str | None, opened: bool) -> dict[str, Any]:
        query = '?' + urlencode({'cursor': cursor}) if cursor is not None else ''
        rows = self.request('/positions/' + quote(self._read_owner(owner), safe='') + query)
        return {'items': [row for row in rows if row.get('open') is opened],
                'next_cursor': rows[-1]['address'] if len(rows) >= 500 else None}

    def get_positions(self, owner: str | None = None, *, cursor: str | None = None) -> dict[str, Any]:
        """One page of open positions. Continue with next_cursor even if items is empty."""
        return self._positions(owner, cursor, True)

    def get_history(self, owner: str | None = None, *, cursor: str | None = None) -> dict[str, Any]:
        """One page of retained closed positions. Continue until next_cursor is None."""
        return self._positions(owner, cursor, False)

    def _owner(self) -> str:
        if not self.signer:
            raise ValueError('A wallet signer is required')
        return self.owner or self.signer.address

    def _now(self) -> float:
        if self._clock is None:
            raise ValueError('API Date header missing')
        return self._clock[0] + time.monotonic() - self._clock[1]

    def authorization(self) -> dict[str, Any]:
        owner = self._owner()
        assert self.signer is not None
        if not self.program:
            raise ValueError('Set the expected exchange program before signing')
        if self._proof:
            self._clock = None
            self._trading_terms()
            if self._proof['expires_at'] > self._now() + 15:
                return self._proof
        self._clock = None
        challenge = self.request('/prepare-auth?' + urlencode({'owner': owner, 'authority': self.signer.address, 'lifetime_seconds': 900}))
        expiry = challenge['expires_at']
        expected = f'Cardboard API access\nprogram={self.program}\nowner={owner}\nauthority={self.signer.address}\nexpires_at={expiry}'
        if challenge['program'] != self.program or challenge['message'] != expected or type(expiry) is not int or not self._now() < expiry <= self._now()+905:
            raise ValueError('Invalid authorization challenge')
        if self.signer.sign_message:
            signed = {'signature': base64.b64encode(self.signer.sign_message(expected.encode())).decode()}
        else:
            # Authentication memo is never broadcast.
            wire = base64.b64decode(challenge['transaction'], validate=True)
            _validate_memo(wire, self.signer.address, expected)
            result = self.signer.sign_transaction(wire)
            _validate_memo(result, self.signer.address, expected, True)
            if result[65:] != wire[65:]:
                raise ValueError('Wallet changed the authorization transaction')
            signed = {'transaction': base64.b64encode(result).decode()}
        self._proof = {'expires_at': expiry, **signed}
        return self._proof

    def prepare(self, action: dict[str, Any]) -> dict[str, Any]:
        owner = self._owner()
        assert self.signer is not None
        return self.request('/prepare', {**action, 'owner': owner, 'authority': self.signer.address, 'admission': self.authorization()})

    def open_position(self, *, market: str, side: str, margin_usdc: str, leverage: int,
                      slippage_bps: int = 5, builder: Builder | None = None) -> PreparedOrder:
        market_id = {'BTC': 0, 'ETH': 1, 'SOL': 2}.get(market)
        if market_id is None:
            raise ValueError('Unsupported market symbol')
        config = self._trading_terms()
        if config['program'] != self.program:
            raise ValueError('Exchange program changed')
        markets = self.get_markets()
        selected = next((m['state'] for m in markets if m['state']['symbol'] == market), None)
        if not selected or selected['retired']:
            raise ValueError('Market is unavailable')
        if type(selected['id']) is not int or selected['id'] != market_id:
            raise ValueError('Market symbol does not match its expected ID')
        if side not in ('long', 'short') or type(leverage) is not int or not 1 <= leverage <= config['max_leverage']:
            raise ValueError('Invalid side or leverage')
        if type(slippage_bps) is not int or not 0 <= slippage_bps <= 1000:
            raise ValueError('Slippage must be 0..1000 basis points')
        oracles = self.request('/accounts?kind=oracle')
        mid = next((o['state']['mid'] for o in oracles if o['state']['market_id'] == market_id), None)
        if mid is None or int(mid) <= 0:
            raise ValueError('A current market price is required')
        price, margin = int(mid), units(margin_usdc)
        if int(margin) <= 0:
            raise ValueError('Margin must be positive')
        tolerance = (price*slippage_bps+9999)//10000
        action = {'action': 'open', 'market_id': market_id, 'is_long': side == 'long', 'margin': margin,
                  'leverage': leverage, 'debt_funded': False, 'worst_price': str(price+tolerance if side == 'long' else price-tolerance),
                  'expected_fee_bps': selected['fee_bps'], 'expected_buffer_bps': selected['liquidation_buffer_bps'],
                  'expected_economics_version': 1, 'expected_deadband_ppm': config['deadband_ppm'], 'max_round_trip_fee_ppm': config['round_trip_fee_ppm']}
        builder = builder or self.builder
        if builder:
            notional, profit = int(units(builder.notional_markup_percent, 2)), int(units(builder.profit_markup_percent, 2))
            if max(notional, profit) > 65535:
                raise ValueError('Markup exceeds the request range')
            action.update(builder_wallet=builder.wallet, builder_notional_markup_bps=notional, builder_profit_markup_bps=profit)
        prepared = self.prepare(action)
        effective = {'wallet': builder.wallet, 'notional_markup_bps': min(notional, config['max_builder_notional_markup_bps']),
                     'profit_markup_bps': min(profit, config['max_builder_profit_markup_bps'])} if builder else None
        return self._checked(prepared, action, effective)

    def close_position(self, position_id: str) -> PreparedOrder:
        if not position_id.isascii() or not position_id.isdigit() or len(position_id) > 20 or int(position_id) > 18446744073709551615:
            raise ValueError('Invalid position ID')
        action = {'action': 'close', 'position_id': position_id}
        return self._checked(self.prepare(action), action)

    def _checked(self, prepared: dict[str, Any], action: dict[str, Any], builder: dict[str, Any] | None = None) -> PreparedOrder:
        assert self.signer is not None
        if prepared.get('builder') != builder:
            raise ValueError('Prepared builder fees changed; refresh the quote')
        expected = dict(program=self.program, owner=self._owner(), authority=self.signer.address, action=action.copy(), builder=builder)
        order = PreparedOrder(prepared, self._order_token, expected)
        _validate_trade(order._wire, expected)
        return order

    def submit(self, prepared: PreparedOrder) -> dict[str, Any]:
        self._owner()
        assert self.signer is not None
        if not isinstance(prepared, PreparedOrder) or prepared._token is not self._order_token:
            raise ValueError('Submit requires a typed order validated by this client')
        wire = _trade_bytes(prepared['transaction'])
        if prepared['id'] != prepared._id or wire != prepared._wire or prepared.get('builder') != prepared._builder or prepared._expected['authority'] != self.signer.address or prepared._expected['owner'] != self._owner() or prepared._expected['program'] != self.program:
            raise ValueError('Prepared order or signing context changed')
        message = _validate_trade(wire, prepared._expected)
        intent_id = prepared._id
        signed = self.signer.sign_transaction(wire)
        if _validate_trade(signed, prepared._expected, True) != message or signed[65:129] != wire[65:129]:
            raise ValueError('Wallet changed the prepared transaction')
        # Never automatically retry an ambiguous trade submission.
        return self.request('/relay', {'id': intent_id, 'transaction': base64.b64encode(signed).decode()})

    def get_transaction(self, intent_id: str) -> dict[str, Any]:
        owner = self._owner()
        assert self.signer is not None
        credential = {'owner': owner, 'authority': self.signer.address, 'admission': self.authorization()}
        return self.request('/transactions/'+quote(intent_id, safe=''), authorization='Bearer '+base64.b64encode(json.dumps(credential).encode()).decode())
