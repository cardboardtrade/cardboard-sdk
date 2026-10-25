//! Reusable trading example for a wallet/session implementing the public Signer trait.
//! Running this binary alone performs no network requests and never trades.
use cardboard_client::{Builder, Client, OpenPosition, Prepared, Result, Side, Signer, Status};

pub fn prepare(
    client: &mut Client,
    owner: &str,
    wallet: &impl Signer,
    builder: Option<&Builder>,
) -> Result<Prepared> {
    client.open_position(
        owner,
        wallet,
        OpenPosition {
            market: "SOL",
            side: Side::Long,
            margin_usdc: "10",
            leverage: 10,
            slippage_bps: 5,
            builder,
        },
    )
}
pub fn submit(client: &mut Client, wallet: &impl Signer, reviewed: &Prepared) -> Result<Status> {
    client.submit(wallet, reviewed)
}
fn main() {
    println!(
        "Call prepare() with your wallet signer and None for a personal trade (or Some(&builder) for attribution), review the order, then explicitly call submit()."
    );
}
