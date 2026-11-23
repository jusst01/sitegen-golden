# sitegen-golden — site-generator-speed-01

A faster drop-in reimplementation of makefun-site 1.0.0: byte-identical output trees, several times faster.

[![make.fun bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/jusst01/sitegen-golden/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/jusst01/sitegen-golden/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122) on make.fun.

## Layout

- `main.ts` — driver: reads `MAKEFUN_INPUT_DIR/cases.json`, calls `run(input)` per case, writes `MAKEFUN_OUTPUT_DIR/answers.json`
- `solve.js` — the optimized generator, exporting `run(input)`; Node builtins only, no cross-case caching
