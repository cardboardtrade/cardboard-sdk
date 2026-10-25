use super::{public_key, BuilderFees, Result};
use sha2::{Digest, Sha256};

pub(crate) struct Open<'a> {
    pub market: u16,
    pub margin: u64,
    pub leverage: u16,
    pub long: bool,
    pub worst: u64,
    pub min_exposure: u64,
    pub fee: u16,
    pub buffer: u16,
    pub deadband: u32,
    pub round_trip: u32,
    pub builder: Option<&'a BuilderFees>,
}

pub(crate) enum Intent<'a> {
    Open(Open<'a>),
    Close(u64),
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(n).ok_or("Invalid transaction length")?;
        let value = self.data.get(self.at..end).ok_or("Truncated transaction")?;
        self.at = end;
        Ok(value)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn short(&mut self) -> Result<usize> {
        let mut value = 0;
        for shift in [0, 7, 14] {
            let b = self.byte()?;
            if shift == 14 && b > 3 {
                return Err("Invalid transaction length encoding".into());
            }
            value |= usize::from(b & 127) << shift;
            if b < 128 {
                if shift != 0 && b == 0 {
                    return Err("Noncanonical transaction length".into());
                }
                return Ok(value);
            }
        }
        Err("Invalid transaction length encoding".into())
    }
}

struct Instruction<'a> {
    program: usize,
    accounts: &'a [u8],
    data: &'a [u8],
}

struct Message<'a> {
    start: usize,
    signatures: usize,
    writable_end: usize,
    keys: Vec<&'a [u8]>,
    instructions: Vec<Instruction<'a>>,
}
fn message(wire: &[u8]) -> Result<Message<'_>> {
    if wire.len() > 1232 {
        return Err("Transaction exceeds Solana packet limit".into());
    }
    let mut r = Reader { data: wire, at: 0 };
    let signatures = r.short()?;
    if signatures != 2 {
        return Err("Trade must require only the wallet and relayer signatures".into());
    }
    r.take(64 * signatures)?;
    let start = r.at;
    if r.take(3)? != [128, 2, 1] {
        return Err("Unexpected trade message or signer privileges".into());
    }
    let readonly = usize::from(r.byte()?);
    let count = r.short()?;
    if !(3..=32).contains(&count) || readonly > count - signatures {
        return Err("Invalid trade account header".into());
    }
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        let key = r.take(32)?;
        if keys.contains(&key) {
            return Err("Duplicate trade account".into());
        }
        keys.push(key);
    }
    r.take(32)?; // Recent blockhash; the wallet signs these exact bytes.
    let count = r.short()?;
    if count != 3 {
        return Err("Trade must contain only compute settings and one order".into());
    }
    let mut instructions = Vec::with_capacity(count);
    for _ in 0..count {
        let program = usize::from(r.byte()?);
        let count = r.short()?;
        let accounts = r.take(count)?;
        let count = r.short()?;
        let data = r.take(count)?;
        if program >= keys.len() || accounts.iter().any(|a| usize::from(*a) >= keys.len()) {
            return Err("Invalid trade account index".into());
        }
        instructions.push(Instruction {
            program,
            accounts,
            data,
        });
    }
    if r.short()? != 0 || r.at != wire.len() {
        return Err("Address lookup tables and trailing data are unsupported".into());
    }
    Ok(Message {
        start,
        signatures,
        writable_end: keys.len() - readonly,
        keys,
        instructions,
    })
}

fn pda(key: &[u8], seeds: &[&[u8]], program: &[u8; 32]) -> bool {
    // The exchange enforces the canonical bump; this check binds owner/position.
    (0..=255).any(|bump| {
        let mut hash = Sha256::new();
        for seed in seeds {
            hash.update(seed);
        }
        hash.update([bump]);
        hash.update(program);
        hash.update(b"ProgramDerivedAddress");
        hash.finalize().as_slice() == key
    })
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
}
fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn u64_at(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

pub(crate) fn validate(
    wire: &[u8],
    program: &str,
    owner: &str,
    authority: &str,
    intent: Intent<'_>,
) -> Result<()> {
    let msg = message(wire)?;
    let program = public_key(program)?;
    let owner = public_key(owner)?;
    let authority = public_key(authority)?;
    if msg.keys[0] != authority || wire[1..msg.start].iter().any(|b| *b != 0) {
        return Err("Trade signer or unsigned signatures changed".into());
    }
    let compute = public_key("ComputeBudget111111111111111111111111111111")?;
    for (ix, tag, len) in [(&msg.instructions[0], 2, 5), (&msg.instructions[1], 3, 9)] {
        if msg.keys[ix.program] != compute
            || !ix.accounts.is_empty()
            || ix.data.len() != len
            || ix.data[0] != tag
            || ix.program < msg.writable_end
        {
            return Err("Unexpected compute budget instruction".into());
        }
    }
    let limit = u32_at(msg.instructions[0].data, 1);
    let price = u64_at(msg.instructions[1].data, 1);
    if limit != 400_000 || price > 1_000_000 {
        return Err("Trade network fee exceeds SDK safety limit".into());
    }
    let ix = &msg.instructions[2];
    if msg.keys[ix.program] != program || ix.program < msg.writable_end || ix.accounts.len() < 8 {
        return Err("Unexpected trade program or account layout".into());
    }
    let key = |slot: usize| msg.keys[usize::from(ix.accounts[slot])];
    if ix.accounts[0] != 1
        || ix.accounts[1] != 0
        || ix.accounts[2..].iter().any(|account| *account < 2)
        || !pda(key(4), &[b"trader", &owner], &program)
    {
        return Err("Trade owner or authority changed".into());
    }
    match intent {
        Intent::Open(open) => {
            let d = ix.data;
            let expected_length = if open.builder.is_some() {
                88
            } else if open.round_trip == 50 {
                48
            } else {
                52
            };
            if d.len() != expected_length
                || ix.accounts.len() != if open.builder.is_some() { 12 } else { 11 }
                || key(8) != [0; 32]
            {
                return Err("Unexpected open layout".into());
            }
            if d[0] != 6
                || u16_at(d, 1) != open.market
                || u64_at(d, 3) != open.margin
                || u16_at(d, 11) != open.leverage
                || d[13] != u8::from(open.long)
                || d[14] != 0
                || u64_at(d, 15) != open.worst
                || u64_at(d, 23) == 0
                || u64_at(d, 31) != open.min_exposure
                || u16_at(d, 39) != open.fee
                || u16_at(d, 41) != open.buffer
                || d[43] != 1
                || u32_at(d, 44) != open.deadband
            {
                return Err("Prepared order differs from the requested open".into());
            }
            let round_trip = if d.len() >= 52 { u32_at(d, 48) } else { 50 };
            if round_trip != open.round_trip {
                return Err("Prepared round-trip fee changed".into());
            }
            match open.builder {
                Some(builder) => {
                    if d.len() != 88
                        || d[52..84] != public_key(&builder.wallet)?
                        || u16_at(d, 84) != builder.notional_markup_bps
                        || u16_at(d, 86) != builder.profit_markup_bps
                        || !pda(
                            key(10),
                            &[b"trader", &public_key(&builder.wallet)?],
                            &program,
                        )
                    {
                        return Err("Prepared builder terms changed".into());
                    }
                }
                None if d.len() == 88 => return Err("Unexpected builder fee".into()),
                None => {}
            }
        }
        Intent::Close(id) => {
            if !matches!(ix.accounts.len(), 14 | 16)
                || ix.data.len() != 17
                || ix.data[0] != 7
                || u64_at(ix.data, 1) == 0
                || u64_at(ix.data, 9) == 0
                || key(9) != [0; 32]
                || key(12) != public_key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")?
                || !pda(key(7), &[b"position", &owner, &id.to_le_bytes()], &program)
            {
                return Err("Prepared order differs from the requested close".into());
            }
        }
    }
    if key(ix.accounts.len() - 1) != program {
        return Err("Missing exchange event account".into());
    }
    let writes: &[usize] = if ix.data[0] == 6 {
        &[1, 3, 4, 5, 7]
    } else if ix.accounts.len() == 16 {
        &[1, 3, 4, 5, 7, 8, 10, 11, 13, 14]
    } else {
        &[1, 3, 4, 5, 7, 8, 10, 11]
    };
    let mut writable = vec![false; msg.keys.len()];
    let mut used = vec![false; msg.keys.len()];
    for instruction in &msg.instructions {
        used[instruction.program] = true;
        for account in instruction.accounts {
            used[usize::from(*account)] = true;
        }
    }
    for slot in writes {
        writable[usize::from(ix.accounts[*slot])] = true;
    }
    for (index, expected) in writable.iter().enumerate() {
        let actual = index == 0 || (index >= 2 && index < msg.writable_end);
        if actual != *expected || !used[index] {
            return Err("Unexpected trade account privileges".into());
        }
    }
    Ok(())
}

pub(crate) fn signed_message(prepared: &[u8], signed: &[u8]) -> Result<()> {
    let before = message(prepared)?;
    let after = message(signed)?;
    if prepared[before.start..] != signed[after.start..]
        || signed[1..65].iter().all(|b| *b == 0)
        || prepared[65..before.start] != signed[65..after.start]
        || before.signatures != after.signatures
    {
        return Err("Wallet changed the prepared transaction or did not sign it".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::Value;

    fn number(value: &Value) -> u64 {
        value
            .as_u64()
            .unwrap_or_else(|| value.as_str().unwrap().parse().unwrap())
    }
    fn validate_case(f: &Value, case: &Value, wire: &[u8], open: bool) -> Result<()> {
        let a = &case["action"];
        let builder: Option<BuilderFees> =
            serde_json::from_value(case["builder_terms"].clone()).unwrap();
        let intent = if open {
            Intent::Open(Open {
                market: number(&a["market_id"]) as u16,
                margin: number(&a["margin"]),
                leverage: number(&a["leverage"]) as u16,
                long: a["is_long"].as_bool().unwrap(),
                worst: number(&a["worst_price"]),
                min_exposure: a.get("min_winning_exposure").map(number).unwrap_or(0),
                fee: number(&a["expected_fee_bps"]) as u16,
                buffer: number(&a["expected_buffer_bps"]) as u16,
                deadband: number(&a["expected_deadband_ppm"]) as u32,
                round_trip: number(&a["max_round_trip_fee_ppm"]) as u32,
                builder: builder.as_ref(),
            })
        } else {
            Intent::Close(number(&a["position_id"]))
        };
        validate(
            wire,
            f["program"].as_str().unwrap(),
            f["owner"].as_str().unwrap(),
            f["authority"].as_str().unwrap(),
            intent,
        )
    }

    #[test]
    fn typed_trade_wires_match_intents_and_reject_tampering() {
        let f: Value = serde_json::from_str(include_str!("../../fixtures/trades.json")).unwrap();
        for (kind, open) in [("opens", true), ("closes", false)] {
            let cases = f[kind].as_array().unwrap();
            assert!(!cases.is_empty());
            for case in cases {
                let wire = STANDARD
                    .decode(case["transaction"].as_str().unwrap())
                    .unwrap();
                validate_case(&f, case, &wire, open)
                    .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
                let parsed = message(&wire).unwrap();
                let data = parsed.instructions[2].data.as_ptr() as usize - wire.as_ptr() as usize;
                let program_key = parsed.keys[parsed.instructions[2].program].as_ptr() as usize
                    - wire.as_ptr() as usize;
                for role in if open { &[4][..] } else { &[4, 7][..] } {
                    let key = parsed.keys[usize::from(parsed.instructions[2].accounts[*role])]
                        .as_ptr() as usize
                        - wire.as_ptr() as usize;
                    let mut changed = wire.clone();
                    changed[key] ^= 1;
                    assert!(validate_case(&f, case, &changed, open).is_err());
                }
                let fields: &[usize] = if open {
                    &[0, 1, 3, 11, 13, 14, 15, 31, 39, 41, 43, 44, 48, 52, 84, 86]
                } else {
                    &[0]
                };
                for field in fields
                    .iter()
                    .filter(|field| **field < parsed.instructions[2].data.len())
                {
                    let mut changed = wire.clone();
                    changed[data + field] ^= 1;
                    assert!(
                        validate_case(&f, case, &changed, open).is_err(),
                        "{} field {field}",
                        case["name"]
                    );
                }
                let mut changed = wire.clone();
                changed[program_key] ^= 1;
                assert!(validate_case(&f, case, &changed, open).is_err());
                let mut changed = wire.clone();
                changed[parsed.start + 3] ^= 1;
                assert!(validate_case(&f, case, &changed, open).is_err());
                let price =
                    parsed.instructions[1].data.as_ptr() as usize - wire.as_ptr() as usize + 1;
                let mut changed = wire.clone();
                changed[price..price + 8].copy_from_slice(&1_000_001u64.to_le_bytes());
                assert!(validate_case(&f, case, &changed, open).is_err());
                let mut trailing = wire.clone();
                trailing.push(0);
                assert!(validate_case(&f, case, &trailing, open).is_err());
                let mut noncanonical = vec![0x82, 0];
                noncanonical.extend(&wire[1..]);
                assert!(validate_case(&f, case, &noncanonical, open).is_err());
                let mut lookup = wire.clone();
                *lookup.last_mut().unwrap() = 1;
                assert!(validate_case(&f, case, &lookup, open).is_err());
                for length in 0..wire.len() {
                    assert!(validate_case(&f, case, &wire[..length], open).is_err());
                }
                let mut signed = wire.clone();
                signed[1] = 1;
                signed_message(&wire, &signed).unwrap();
                signed[data] ^= 1;
                assert!(signed_message(&wire, &signed).is_err());
                let mut changed_relayer = wire.clone();
                changed_relayer[1] = 1;
                changed_relayer[65] = 1;
                assert!(signed_message(&wire, &changed_relayer).is_err());
            }
        }
        for bad in f["invalid"].as_array().unwrap() {
            let (kind, name) = bad["case"].as_str().unwrap().split_once('_').unwrap();
            let open = kind == "open";
            let case = f[if open { "opens" } else { "closes" }]
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["name"] == name)
                .unwrap();
            let wire = STANDARD
                .decode(bad["transaction"].as_str().unwrap())
                .unwrap();
            assert!(
                validate_case(&f, case, &wire, open).is_err(),
                "{} was accepted",
                bad["name"]
            );
        }
    }
}
