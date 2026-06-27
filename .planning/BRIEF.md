# pairmarket — Vision Brief

Source-of-truth product/technical brief. The design doc the spec-writing
agent produces should be derivable from this; this file is for grounding,
not a substitute for the design doc itself.

## Product

A prediction-market app for friends speculating, privately, on each
other's relationships. Examples of markets:

- "Will A and B last 3 dates?"
- "Will A and B still be together at the end of Q4?"
- "Will C and D, who haven't met yet, go on a second date if introduced?"

Markets are **private by invitation**. The set of participants is
determined by a social graph: a user can invite people in their graph to
markets they create. Operationalizations (the resolution criterion) are
authored per-market and must be checkable — the design doc must propose
a resolution mechanism (oracle? attestor? subject self-report with
challenge period?) and defend it.

A second-pass goal: aggregate signals across markets to surface
recommendations ("the wisdom of your friends thinks you and X would
work"), without leaking individual positions.

## Constraints

- **Sui** for the settlement layer; markets, escrow, payouts live in
  Move.
- **Walrus** for content (prompts, attachments, off-chain market
  metadata that doesn't need to be on-chain but does need to be
  reconstructible).
- **SEAL** for access control on Walrus blobs and for any private-state
  market mechanics that need encrypted-to-a-policy semantics.
- **Twitter sign-in → custodial wallet.** The friction floor is
  "click sign in with Twitter, you have a wallet." No seed phrase. A
  migration path to self-custody (zkLogin or equivalent) must be in the
  design doc from day one.
- **Type-system load-bearing stack.** Either strongly typed TypeScript
  (with brand types / phantom types on IDs, capabilities, encrypted
  blobs, etc.) or an ML-family language (OCaml, Rescript, Reason). The
  design doc picks, with tradeoffs spelled out — *not* a default. Move
  is non-negotiable for contracts.

## Non-goals (initial)

- Public markets, market-making bots, professional-tier liquidity.
- Cross-chain bridging.
- Mobile-first UX (web-first; mobile is later).
- Identity verification beyond Twitter (no KYC).

## What the spec-writing agent must produce

A design doc of the quality an L7+ would sign off on. Specifically:

1. **Problem statement and user stories** — concrete, not abstract.
2. **Non-goals** — explicit.
3. **System architecture** — components, data flow, trust boundaries,
   one diagram if useful.
4. **On-chain design** — Move object model, ownership model, market
   lifecycle, settlement, fees.
5. **Privacy model** — what is private to whom, enforced by what
   mechanism (SEAL policies, Walrus ACLs, contract-level invariants).
   Threat model included; this is the part most likely to be wrong.
6. **Custodial wallet design** — key custody, signing flow, abuse
   resistance, recovery, the path off custody.
7. **Type system strategy** — which language, which invariants are
   encoded in types, which are runtime, and *why* that split.
8. **Resolution mechanism** — how markets settle. This is hard and
   should not be glossed.
9. **Alternatives considered** — for the load-bearing decisions, what
   else was on the table and why it lost.
10. **Phasing** — MVP slice, then what.

Use [ditz](https://github.com/tedks/ditz) for issue tracking from day
one — `ditz init` before the first work item, then file ditz issues for
each major design question rather than letting them rot in the doc.

## Working style

The spec-writing agent should use `spawn-agent` to fan out subagents
that own component interfaces (e.g., one for the Move contract
interface, one for the SEAL policy interface, one for the wallet
service interface) so the design doc converges from concrete API
sketches, not pure prose. Sub-agents file their findings as ditz
issues against this repo; the spec-writing agent integrates.
