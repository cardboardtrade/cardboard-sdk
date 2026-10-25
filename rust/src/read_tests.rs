use super::*;
use std::io::{BufRead, BufReader, Read, Write};

fn serve(responses: Vec<(&'static str, Value)>) -> (Client, std::thread::JoinHandle<Vec<Value>>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for (path, body) in responses {
            let (mut socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            assert_eq!(request.split_whitespace().nth(1), Some(path));
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse().unwrap();
                }
            }
            let mut bytes = vec![0; length];
            reader.read_exact(&mut bytes).unwrap();
            requests.push(if bytes.is_empty() {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap()
            });
            let body = body.to_string();
            write!(socket, "HTTP/1.1 200 OK\r\nDate: Sat, 24 Oct 2026 12:00:00 GMT\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
        requests
    });
    (
        Client::new(&format!("http://{address}"), None).unwrap(),
        server,
    )
}

fn position(address: &str, open: bool) -> Value {
    json!({"address":address,"id":"18446744073709551615","owner":"alice","market_id":0,
        "open":open,"is_long":true,"margin":"18446744073709551615","leverage":10,
        "entry_price":"9007199254740993","exit_price":"9007199254740995",
        "closed_at":"1792844100","returned_margin":"18446744073709551614",
        "settled_claim":"9007199254740997","fees_charged":"9007199254740999",
        "liquidated":false,"close_pnl":"-9007199254740993",
        "settlement_signature":null,"internal_field":"ignored"})
}

#[test]
fn personal_reads_are_owner_scoped_and_preserve_exact_amounts() {
    let account = json!({"owner":"alice","available":"18446744073709551615","queued":"0",
        "staked":"9007199254740993","frozen":false,"activated":true,
        "reward_balance":"11","pending_reward":"12","internal_field":"ignored"});
    let positions = json!([position("closed", false), position("open", true)]);
    let (mut client, server) = serve(vec![
        ("/traders/alice", account),
        ("/positions/alice", positions.clone()),
        ("/positions/alice?cursor=previous", positions),
    ]);
    let account = client.get_account("alice").unwrap();
    assert_eq!(account.available, "18446744073709551615");
    assert_eq!(account.staked, "9007199254740993");
    let open = client.get_positions("alice", None).unwrap();
    assert_eq!(open.items.len(), 1);
    assert_eq!(open.items[0].address, "open");
    assert_eq!(open.items[0].entry_price, "9007199254740993");
    assert_eq!(open.items[0].mark_price, None);
    assert_eq!(open.next_cursor, None);
    let history = client.get_history("alice", Some("previous")).unwrap();
    assert_eq!(history.items.len(), 1);
    assert_eq!(history.items[0].address, "closed");
    assert_eq!(history.items[0].id, "18446744073709551615");
    assert_eq!(history.items[0].exit_price, "9007199254740995");
    assert_eq!(history.items[0].closed_at, "1792844100");
    assert_eq!(history.items[0].returned_margin, "18446744073709551614");
    assert_eq!(history.items[0].settled_claim, "9007199254740997");
    assert_eq!(history.items[0].fees_charged, "9007199254740999");
    assert!(!history.items[0].liquidated);
    assert_eq!(
        history.items[0].close_pnl.as_deref(),
        Some("-9007199254740993")
    );
    server.join().unwrap();

    assert!(client.get_account("alice?scope=all").is_err());
    assert!(client.get_positions("alice", Some("../other")).is_err());
    assert!(client.get_history("alice/other", None).is_err());
}

#[test]
fn empty_filtered_pages_keep_the_unfiltered_cursor() {
    let closed: Vec<_> = (0..500)
        .map(|i| position(&format!("p{i:03}"), false))
        .collect();
    let opened: Vec<_> = (0..500)
        .map(|i| position(&format!("p{i:03}"), true))
        .collect();
    let (mut client, server) = serve(vec![
        ("/positions/alice", json!(closed)),
        ("/positions/alice", json!(opened)),
        ("/positions/alice?cursor=p499", json!([])),
    ]);
    let open = client.get_positions("alice", None).unwrap();
    assert!(open.items.is_empty());
    assert_eq!(open.next_cursor.as_deref(), Some("p499"));
    let history = client.get_history("alice", None).unwrap();
    assert!(history.items.is_empty());
    assert_eq!(history.next_cursor.as_deref(), Some("p499"));
    let last = client
        .get_history("alice", history.next_cursor.as_deref())
        .unwrap();
    assert!(last.items.is_empty());
    assert_eq!(last.next_cursor, None);
    server.join().unwrap();
}

#[test]
fn builder_reads_use_explicit_builder_routes() {
    let stats = json!({"builder_wallet":"builder","totals":{"earned":"123","credited":"0",
        "queued":"0","reused_as_margin":"0","earned_24h":"0"},"markets":[]});
    let (mut client, server) = serve(vec![
        ("/builders/builder/stats", stats),
        (
            "/builders/builder/positions?owner=alice&cursor=previous",
            json!({"positions":[]}),
        ),
    ]);
    assert_eq!(
        client
            .get_builder_earnings("builder")
            .unwrap()
            .totals
            .earned,
        "123"
    );
    client
        .get_builder_positions("builder", Some("alice"), Some("previous"))
        .unwrap();
    server.join().unwrap();
    assert!(client.get_builder_earnings("builder/other").is_err());
    assert!(client
        .get_builder_positions("builder", Some("alice?all"), None)
        .is_err());
}

#[test]
fn personal_open_has_no_builder_attribution_and_does_not_submit() {
    struct Wallet(String);
    impl Signer for Wallet {
        fn address(&self) -> &str {
            &self.0
        }
        fn sign_message(&self, _: &[u8]) -> Result<Option<Vec<u8>>> {
            Ok(Some(vec![1; 64]))
        }
        fn sign_transaction(&self, _: &[u8]) -> Result<Vec<u8>> {
            panic!("Preparation must not sign or submit a trade")
        }
    }
    let fixture: Value = serde_json::from_str(include_str!("../../fixtures/trades.json")).unwrap();
    let program = fixture["program"].as_str().unwrap();
    let owner = fixture["owner"].as_str().unwrap();
    let authority = fixture["authority"].as_str().unwrap();
    let case = fixture["opens"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "plain")
        .unwrap();
    let expiry = 1_792_844_100i64;
    let challenge = json!({"program":program,"expires_at":expiry,
        "message":format!("Cardboard API access\nprogram={program}\nowner={owner}\nauthority={authority}\nexpires_at={expiry}")});
    let (mut client, server) = serve(vec![
        ("/config", json!({"program":program,"max_leverage":1000,"deadband_ppm":20,"round_trip_fee_ppm":50})),
        ("/accounts?kind=market", json!([{"address":owner,"state":{"id":0,"symbol":"BTC","retired":false,"fee_bps":200,"liquidation_buffer_bps":5}}])),
        ("/accounts?kind=oracle", json!([{"address":owner,"state":{"market_id":0,"mid":"100000000"}}])),
        ("/prepare-auth?owner=4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi&authority=8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR&lifetime_seconds=900", challenge),
        ("/prepare", json!({"id":"personal","transaction":case["transaction"],"builder":null})),
    ]);
    client.program = Some(program.into());
    let prepared = client
        .open_position(
            owner,
            &Wallet(authority.into()),
            OpenPosition {
                market: "BTC",
                side: Side::Long,
                margin_usdc: "10",
                leverage: 10,
                slippage_bps: 5,
                builder: None,
            },
        )
        .unwrap();
    assert!(prepared.builder.is_none());
    assert!(prepared.verified.is_some());
    let requests = server.join().unwrap();
    let action = requests.last().unwrap();
    assert!(action.get("builder_wallet").is_none());
    assert!(action.get("builder_notional_markup_bps").is_none());
    assert!(action.get("builder_profit_markup_bps").is_none());
}
