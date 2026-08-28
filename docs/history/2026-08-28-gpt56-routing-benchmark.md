# GPT-5.6 routing benchmark (2026-08-28)

## Scope and method

Six native L1 builders received the same isolated Node.js route-gate task and
visible acceptance suite. The task covered fresh discovery, exact model/effort,
hostile catalog rejection, no default inference, immutable lineage, drift
failure, and prompt-only write authority. Lead acceptance required 7/7 visible
tests plus 8/8 hidden tests. Each route was allowed one bounded correction.

This is one task (`n=1`) in the HarnessDock contract domain. It is useful for
route calibration, not a global model ranking.

## Strict accepted-task ledger

All six attempts were explicitly lead-accepted. Terra-high required one
correction after retaining an extra `write` key; the other five passed first
try. Cost is an estimate, not an invoice, using the local Standard API price
snapshot effective 2026-08-06 (`sha256
cb3c1e5da544b43d76f72af812c009ce1742598267191118a7646e185de4f74b`).
The estimator treats reasoning output as output and reports cache reads
separately.

| Route | Result | Wall | Fresh input | Cache read | Output | Reasoning | Total tokens | Est. USD | LOC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| luna-max | first pass | 248s | 42,269 | 266,240 | 13,160 | 10,628 | 321,669 | 0.0296 | 141 |
| terra-medium | first pass | 72s | 33,693 | 256,768 | 3,851 | 1,487 | 294,312 | 0.1650 | 93 |
| terra-xhigh | first pass | 113s | 34,518 | 161,280 | 7,462 | 5,517 | 203,260 | 0.1908 | 91 |
| terra-high | one correction | 363s | 37,556 | 283,392 | 5,690 | 3,400 | 326,638 | 0.2001 | 92 |
| terra-max | first pass | 184s | 49,198 | 170,752 | 13,912 | 11,500 | 233,862 | 0.2995 | 125 |
| sol-medium | first pass | 78s | 33,994 | 196,864 | 3,964 | 1,722 | 234,822 | 0.3873 | 93 |

Strict denominator: 6 accepted tasks; all six priced; aggregate estimated cost
`$1.272241`; parse errors 0. The Terra-high row includes both its first attempt
and correction.

## Decision

- Terra is not displaced across the board. Terra-medium was the fastest
  accepted route; Terra-xhigh produced the shortest accepted implementation
  and cost only about 16% more than Terra-medium.
- Sol-medium matched acceptance and compactness but cost about 2.35x
  Terra-medium and 2.03x Terra-xhigh on this task. Reserve Sol for semantic
  review/architecture uncertainty rather than the default bounded L1 builder.
- Luna-max was by far the cheapest accepted route, but it was slower and wrote
  the longest implementation. Use it for deterministic, verifier-rich work
  when cost dominates latency, with an explicit simplicity constraint.
- Terra-high's sole rework makes it a poor default from this sample. Prefer
  Terra-medium for ordinary bounded builds and Terra-xhigh when silent
  correctness/search depth matters. Terra-max showed no acceptance advantage
  over Terra-xhigh.

These recommendations should remain provisional until repeated on additional
task classes with the same strict acceptance and correction accounting.
