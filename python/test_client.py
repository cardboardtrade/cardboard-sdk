import json
import base64
import io
from urllib.error import HTTPError
from pathlib import Path
import unittest
from unittest.mock import patch
from cardboard_sdk import CardboardClient, Builder, Signer, units, _validate_memo, _validate_trade, _parse_trade, ApiError

def trades():
    return json.loads((Path(__file__).parent.parent/'fixtures/trades.json').read_text())

def expected_trade(fixture, case):
    return dict(program=fixture['program'], owner=fixture['owner'], authority=fixture['authority'], action=case['action'], builder=case.get('builder_terms'))

def changed_trade(wire, *, keys=None, instructions=None, header=None):
    message, original_keys, original_instructions, _ = _parse_trade(wire)
    keys = original_keys if keys is None else keys
    instructions = original_instructions if instructions is None else instructions
    # Golden transactions use fewer than 128 keys/instructions/data bytes.
    blockhash = message[5+32*len(original_keys):5+32*len(original_keys)+32]
    return (b'\2'+bytes(128)+(message[:4] if header is None else header)+bytes([len(keys)])+b''.join(keys)+blockhash
            +bytes([len(instructions)])+b''.join(bytes([p,len(a)])+a+bytes([len(d)])+d for p,a,d in instructions)+b'\0')

class ClientTest(unittest.TestCase):
    def test_exact_units(self):
        self.assertEqual(units('10.000001'), '10000001')
        self.assertEqual(units('10', 2), '1000')
        for value in ['-1', '0.0000001', 'NaN']:
            with self.assertRaises(ValueError): units(value)

    def test_memo_rejects_additional_instructions(self):
        fixture = json.loads((Path(__file__).parent.parent/'fixtures/authorization.json').read_text())
        wire = base64.b64decode(fixture['transaction'])
        _validate_memo(wire, fixture['authority'], fixture['message'])
        _validate_memo(base64.b64decode(fixture['signed_transaction']), fixture['authority'], fixture['message'], True)
        extra = bytearray(wire[:-1] + bytes([1,0,1,0,0]))
        extra[166] = 2
        with self.assertRaises(ValueError): _validate_memo(extra, fixture['authority'], fixture['message'])
        for offset in [65,66,68,69,70,166,167,168,len(wire)-1]:
            changed = bytearray(wire)
            changed[offset] ^= 1
            with self.assertRaises(ValueError): _validate_memo(changed, fixture['authority'], fixture['message'])

    def test_builder_server_headers_and_retry_delay(self):
        client = CardboardClient(builder_key='test-server-key')
        calls = []
        def response(request, timeout):
            calls.append(request)
            value = io.BytesIO(b'[]')
            value.headers = {}
            return value
        with patch.object(client._http, 'open', side_effect=response):
            self.assertEqual(client.get_markets(), [])
        self.assertEqual(dict((k.lower(),v) for k,v in calls[0].header_items())['x-builder-key'], 'test-server-key')
        self.assertTrue(calls[0].full_url.endswith('/accounts?kind=market'))
        self.assertIsNone(calls[0].data)
        error = HTTPError('https://api.example',429,'limited',{'Retry-After':'3'},io.BytesIO(b'{"error":"slow down"}'))
        with patch.object(client._http, 'open', side_effect=error):
            with self.assertRaises(ApiError) as raised: client.get_markets()
        self.assertEqual((raised.exception.status,raised.exception.retry_after),(429,'3'))

    def test_typed_order_and_signed_status_read(self):
        fixture = trades()
        case = next(case for case in fixture['opens'] if case.get('builder_terms') and case['builder_terms']['wallet'] == fixture['builder'])
        signed = []
        signer = Signer(fixture['authority'], lambda wire: signed.append(wire) or b'signed')
        client = CardboardClient(program=fixture['program'], owner=fixture['owner'], signer=signer, builder=Builder(fixture['builder'], '30'))
        config = dict(program=fixture['program'], max_leverage=1000, deadband_ppm=20,
                      round_trip_fee_ppm=50, max_builder_notional_markup_bps=2500, max_builder_profit_markup_bps=500)
        calls = []
        def request(path, body=None, authorization=None):
            calls.append((path, body, authorization))
            if path == '/config': return config
            if path.endswith('kind=market'): return [dict(state=dict(id=0,symbol='BTC',retired=False,fee_bps=200,liquidation_buffer_bps=5))]
            if path.endswith('kind=oracle'): return [dict(state=dict(market_id=0,mid='100000000'))]
            if path == '/prepare': return dict(id='intent', transaction=case['transaction'], builder=case['builder_terms'])
            if path.startswith('/transactions/'):
                self.assertTrue(authorization.startswith('Bearer '))
                return dict(id='intent', status='confirmed')
            raise AssertionError(path)
        with patch.object(client, 'request', side_effect=request), patch.object(client, 'authorization', return_value={'expires_at': 100, 'signature': 'signature'}):
            client.open_position(market='BTC',side='long',margin_usdc='10',leverage=10)
            body=next(body for path,body,_ in calls if path=='/prepare')
            self.assertEqual(body['margin'],'10000000')
            self.assertEqual(body['worst_price'],'100050000')
            self.assertEqual(body['builder_notional_markup_bps'],3000)
            self.assertEqual(client.get_transaction('intent')['status'],'confirmed')
        self.assertEqual(signed, []) # Preparation never signs or sends a trade.

    def test_personal_open_has_no_builder_fees_or_signing(self):
        fixture = trades()
        case = next(case for case in fixture['opens'] if case['name'] == 'plain')
        signed = []
        client = CardboardClient(program=fixture['program'], owner=fixture['owner'],
                                 signer=Signer(fixture['authority'], lambda wire: signed.append(wire) or wire))
        config = dict(program=fixture['program'], max_leverage=1000, deadband_ppm=20, round_trip_fee_ppm=50)
        calls = []
        def request(path, body=None, authorization=None):
            calls.append((path, body))
            if path == '/config': return config
            if path.endswith('kind=market'): return [dict(state=dict(id=0,symbol='BTC',retired=False,fee_bps=200,liquidation_buffer_bps=5))]
            if path.endswith('kind=oracle'): return [dict(state=dict(market_id=0,mid='100000000'))]
            if path == '/prepare': return dict(id='personal', transaction=case['transaction'])
            raise AssertionError(path)
        with patch.object(client, 'request', side_effect=request), patch.object(client, 'authorization', return_value={'expires_at': 100, 'signature': 'signature'}):
            order = client.open_position(market='BTC',side='long',margin_usdc='10',leverage=10)
        body = next(body for path, body in calls if path == '/prepare')
        self.assertFalse(any(key.startswith('builder_') for key in body))
        self.assertIsNone(order.get('builder'))
        self.assertEqual(signed, [])

    def test_personal_reads_resolve_owner_without_authorization(self):
        fixture = trades()
        client = CardboardClient(owner=fixture['owner'])
        with patch.object(client, 'request', return_value={}) as request, patch.object(client, 'authorization', side_effect=AssertionError('must not sign')):
            client.get_account()
            request.assert_called_once_with('/traders/' + fixture['owner'])
        with patch.object(client, 'request', return_value=[]) as request:
            client.get_positions('other/wallet', cursor='next?&')
            request.assert_called_once_with('/positions/other%2Fwallet?cursor=next%3F%26')
        with patch.object(client, 'request', return_value=[]) as request:
            client.get_history()
            request.assert_called_once_with('/positions/' + fixture['owner'])
        signer = Signer(fixture['authority'], lambda wire: self.fail('must not sign'))
        with patch.object(CardboardClient, 'request', return_value={}) as request:
            CardboardClient(signer=signer).get_account()
            request.assert_called_once_with('/traders/' + fixture['authority'])
            CardboardClient().get_account(fixture['owner'])
            request.assert_called_with('/traders/' + fixture['owner'])
        with self.assertRaises(ValueError): CardboardClient().get_account()

    def test_personal_position_pages_filter_without_losing_cursor(self):
        client = CardboardClient(owner=trades()['owner'])
        open_row = dict(address='a', open=True, margin='1000000', close_pnl='123')
        closed_row = dict(address='b', open=False, margin='2000000', close_pnl='-456')
        for method, wanted in [(client.get_positions, open_row), (client.get_history, closed_row)]:
            with patch.object(client, 'request', return_value=[open_row, closed_row]):
                self.assertEqual(method(), {'items':[wanted], 'next_cursor':None})
            with patch.object(client, 'request', return_value=[]):
                self.assertEqual(method(), {'items':[], 'next_cursor':None})
            opposite = closed_row if wanted is open_row else open_row
            raw = [dict(opposite, address=f'position-{i:04}') for i in range(500)]
            with patch.object(client, 'request', return_value=raw) as request:
                self.assertEqual(method(), {'items':[], 'next_cursor':'position-0499'})
                request.assert_called_once()
            raw[0] = wanted
            with patch.object(client, 'request', return_value=raw):
                self.assertEqual(method(), {'items':[wanted], 'next_cursor':'position-0499'})

    def test_builder_reads_have_explicit_names_and_routes(self):
        fixture = trades()
        client = CardboardClient(builder=Builder(fixture['builder']))
        with patch.object(client, 'request', return_value={'totals':{}}) as request:
            self.assertEqual(client.get_builder_earnings(), {'totals':{}})
            request.assert_called_once_with('/builders/' + fixture['builder'] + '/stats')
        with patch.object(client, 'request', return_value={'items':[],'next_cursor':None}) as request:
            client.get_builder_positions(owner=fixture['owner'], cursor='next?&')
            request.assert_called_once_with('/builders/' + fixture['builder'] + '/positions?owner=' + fixture['owner'] + '&cursor=next%3F%26')
        self.assertFalse(hasattr(client, 'get_earnings'))

    def test_market_symbol_relabeling_is_rejected_before_preparation(self):
        fixture = trades()
        signed = []
        client = CardboardClient(program=fixture['program'], signer=Signer(fixture['authority'], lambda wire: signed.append(wire) or wire))
        for symbol, api_id in [('SOL', 0), ('BTC', 2), ('BTC', False), ('OTHER', 0)]:
            with self.subTest(symbol=symbol, api_id=api_id):
                def request(path, body=None, authorization=None):
                    if path == '/config': return dict(program=fixture['program'])
                    if path == '/accounts?kind=market': return [dict(state=dict(id=api_id,symbol=symbol,retired=False))]
                    raise AssertionError(path)
                with patch.object(client, 'request', side_effect=request), patch.object(client, 'prepare') as prepare:
                    with self.assertRaises(ValueError): client.open_position(market=symbol,side='long',margin_usdc='10',leverage=10)
                    prepare.assert_not_called()
        self.assertEqual(signed, [])

    def test_transaction_wire_validation(self):
        fixture = trades()
        for bad in fixture['invalid']:
            kind, name = bad['case'].split('_', 1)
            case = next(case for case in fixture[kind+'s'] if case['name'] == name)
            with self.subTest(attack=bad['name']), self.assertRaises(ValueError):
                _validate_trade(base64.b64decode(bad['transaction']), expected_trade(fixture, case))
        for case in fixture['opens']+fixture['closes']:
            with self.subTest(case=case['name']):
                wire, expected = base64.b64decode(case['transaction']), expected_trade(fixture, case)
                message = _validate_trade(wire, expected)
                self.assertEqual(_validate_trade(wire[:1]+b'\1'+wire[2:], expected, True), message)
                for malformed in [wire+b'\0', wire[:-1], b'\x82\0'+wire[1:], wire[:129]+b'\x81'+wire[130:], wire[:-1]+b'\1']:
                    with self.assertRaises(ValueError): _validate_trade(malformed, expected)
                with self.assertRaises(ValueError): _validate_trade(wire, {**expected, 'owner': fixture['authority']})
                _, keys, instructions, _ = _parse_trade(wire)
                def reject(changed):
                    with self.assertRaises(ValueError): _validate_trade(changed, expected)
                reject(changed_trade(wire, keys=[keys[0], keys[0], *keys[2:]]))
                reject(changed_trade(wire, header=b'\x80\2\0'+message[3:4]))
                reject(changed_trade(wire, instructions=instructions+[(instructions[2][0], b'', b'\0')]))
                for i, data in ((0,b'\2'+(400001).to_bytes(4,'little')), (1,b'\3'+(1000001).to_bytes(8,'little'))):
                    changed = instructions.copy()
                    changed[i] = (changed[i][0], changed[i][1], data)
                    reject(changed_trade(wire, instructions=changed))
                p, accounts, data = instructions[2]
                changed = instructions.copy()
                changed[2] = (p, accounts, data[:1]+bytes([data[1]^1])+data[2:])
                if case['action']['action'] == 'open':
                    reject(changed_trade(wire, instructions=changed))
                    wrong_position = 4
                else:
                    wrong_position = 7
                changed_accounts = bytearray(accounts)
                changed_accounts[wrong_position] = 0
                changed[2] = (p, bytes(changed_accounts), data)
                reject(changed_trade(wire, instructions=changed))

    def test_submit_requires_validated_order_and_preserves_wire(self):
        fixture = trades()
        case = fixture['opens'][0]
        signed_calls, relays = [], []
        def signer(wire):
            signed_calls.append(wire)
            return wire[:1]+b'\1'+wire[2:]
        client = CardboardClient(program=fixture['program'], owner=fixture['owner'], signer=Signer(fixture['authority'], signer))
        raw = dict(id='intent', transaction=case['transaction'], builder=case.get('builder_terms'))
        with self.assertRaises(ValueError): client.submit(raw)
        with patch.object(client, 'request', side_effect=lambda path, body=None, authorization=None: relays.append((path, body)) or {'status':'submitted'}):
            order = client._checked(raw, case['action'], case.get('builder_terms'))
            self.assertEqual(client.submit(order)['status'], 'submitted')
            self.assertEqual(relays[0][1]['id'], 'intent')
            order['id'] = 'changed'
            with self.assertRaises(ValueError): client.submit(order)
            order = client._checked(raw, case['action'], case.get('builder_terms'))
            other = CardboardClient(program=fixture['program'], owner=fixture['owner'], signer=client.signer)
            with self.assertRaises(ValueError): other.submit(order)
            def changed_message(wire):
                return wire[:1]+b'\1'+wire[2:-2]+bytes([wire[-2]^1])+wire[-1:]
            client.signer = Signer(fixture['authority'], changed_message)
            with self.assertRaises(ValueError): client.submit(order)
            client.signer = Signer(fixture['authority'], lambda wire: wire[:1]+b'\1'+wire[2:65]+b'\1'+wire[66:])
            with self.assertRaises(ValueError): client.submit(order)
        self.assertEqual(len(relays), 1)
        self.assertEqual(len(signed_calls), 1)

    def test_submit_captures_intent_before_wallet_callback(self):
        fixture = trades()
        case = fixture['opens'][0]
        client = CardboardClient(program=fixture['program'], owner=fixture['owner'], signer=Signer(fixture['authority'], lambda wire: wire))
        order = client._checked(dict(id='original',transaction=case['transaction'],builder=case.get('builder_terms')), case['action'], case.get('builder_terms'))
        def signer(wire):
            order['id'] = 'changed-during-signing'
            return wire[:1]+b'\1'+wire[2:]
        client.signer = Signer(fixture['authority'], signer)
        with patch.object(client, 'request', return_value={'status':'submitted'}) as request:
            client.submit(order)
        self.assertEqual(request.call_args.args[1]['id'], 'original')

    def test_prepared_metadata_is_bound_and_bounded(self):
        fixture = trades()
        plain = next(case for case in fixture['opens'] if case['name'] == 'plain')
        builder = next(case for case in fixture['opens'] if case['name'] == 'builder')
        signed_calls = []
        client = CardboardClient(program=fixture['program'], owner=fixture['owner'], signer=Signer(fixture['authority'], lambda wire: signed_calls.append(wire) or wire))
        raw = dict(id='intent', transaction=plain['transaction'])
        for bad in ({**raw,'builder':builder['builder_terms']}, {**raw,'id':''}, {**raw,'id':'x'*65}, {**raw,'transaction':'A'*1648}):
            with self.assertRaises(ValueError): client._checked(bad, plain['action'])
        with self.assertRaises(ValueError): client._checked(raw, {**plain['action'], 'debt_funded':True})
        metadata = builder['builder_terms'].copy()
        order = client._checked(dict(id='intent',transaction=builder['transaction'],builder=metadata), builder['action'], metadata)
        metadata['notional_markup_bps'] += 1
        with self.assertRaises(ValueError): client.submit(order)
        self.assertEqual(signed_calls, [])

if __name__ == '__main__': unittest.main()
