#!/usr/bin/env sh
set -eu
API_BASE=${API_BASE:-https://cardboardtrade.xyz/v1}
curl --fail-with-body --silent --show-error "$API_BASE/accounts?kind=market"
printf '\n'
if [ -n "${USER_WALLET:-}" ]; then
  curl --fail-with-body --silent --show-error "$API_BASE/traders/$USER_WALLET"
  printf '\n'
  curl --fail-with-body --silent --show-error "$API_BASE/positions/$USER_WALLET"
  printf '\n'
fi
if [ -n "${BUILDER_WALLET:-}" ]; then
  curl --fail-with-body --silent --show-error "$API_BASE/builders/$BUILDER_WALLET/stats"
  printf '\n'
fi
