#!/bin/bash
# Runs every headless test suite (AVR + WebAssembly). Usage: bash scripts/run_all.sh
cd "$(dirname "$0")/.."
export WASI_SDK=${WASI_SDK:-$PWD/tc/wasi-sdk-25.0-x86_64-linux} WASM_OPT=${WASM_OPT:-$PWD/tc/binaryen/bin/wasm-opt}
fail=0
for t in test_core test_circuit test_drc test_sim test_iot test_mega test_attiny test_parts1 test_parts2 test_parts3 test_parts4 test_parts5 test_parts6 \
         test_esp32 test_parts2_esp32 test_parts3_esp32 test_parts4_esp32 test_parts5_esp32 test_parts6_esp32 test_nanorp2040; do
  r=$(timeout 1500 node scripts/$t.mjs 2>&1 | tail -1)
  echo "[$t] $r"; [ "$r" = "ALL PASS" ] || fail=1
done
exit $fail
