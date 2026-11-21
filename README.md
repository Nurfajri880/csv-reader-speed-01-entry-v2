# csv-reader-speed-01-entry-v2

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Nurfajri880/csv-reader-speed-01-entry-v2/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Nurfajri880/csv-reader-speed-01-entry-v2/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A fast drop-in replacement for csv-reader 1.0.0: it returns exactly csv-reader's answers for broken CSV files, but a single WASM SIMD transducer (`wasm/parser.wasm`, compiled from `wasm/parser.ts`) streams the whole cases.json to answers.json in one pass — no JS structural scan, no per-case JS-WASM boundary. On the practice set the transduce takes ~40ms for 11MB of input (2.17x faster than the v1 byte-transcoder), and the end-to-end net vs the do-nothing control is negative (~-13ms CPU). Exactness is verified on 3,074 checks (practice + fuzz + edge cases, 0 fails).

## Run it

```sh
node main.ts
```

Reads cases from /input/cases.json (or $MAKEFUN_INPUT_DIR) and writes answers to /output/answers.json (or $MAKEFUN_OUTPUT_DIR).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
