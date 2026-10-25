"""Read-only: python3 example.py [USER_WALLET]. No signing or funds movement."""
import json
import sys
from cardboard_sdk import CardboardClient

client = CardboardClient()
print(json.dumps(client.get_markets(), indent=2))
if len(sys.argv) == 2:
    owner = sys.argv[1]
    print(json.dumps(client.get_account(owner), indent=2))
    print(json.dumps(client.get_positions(owner), indent=2))
    print(json.dumps(client.get_history(owner), indent=2))

# For trading, provide your wallet/session callbacks. They receive bytes and
# must preserve existing signatures and instructions in a transaction.
#
# signer = Signer(address, sign_transaction=wallet.sign_transaction,
#                 sign_message=wallet.sign_message)
# client = CardboardClient(program=EXPECTED_PROGRAM, signer=signer)
# prepared = client.open_position(market='SOL', side='long', margin_usdc='10', leverage=10)
# review(prepared)                 # Your app decides how to present the order.
# status = client.submit(prepared) # Explicit action; never part of read-only startup.
#
# For an app, add builder=Builder(BUILDER_WALLET) to the same client.
# Read attributed positions and earnings with get_builder_positions() and
# get_builder_earnings(); API credentials never replace a user's signature.
