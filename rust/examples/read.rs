use cardboard_client::{Client, Result};
fn main() -> Result<()> {
    let mut client = Client::public()?;
    println!("{:#?}", client.get_markets()?);
    if let Some(owner) = std::env::args().nth(1) {
        println!("{:#?}", client.get_account(&owner)?);
        println!("{:#?}", client.get_positions(&owner, None)?);
        println!("{:#?}", client.get_history(&owner, None)?);
    }
    Ok(())
}
