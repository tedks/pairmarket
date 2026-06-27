# Sui Move Object Model and Market Lifecycle Sketch

This sketch covers only the Move-facing component interface. It assumes the
MVP values a small, auditable settlement core over richer market mechanics.

## MVP Position

Use a pari-mutuel market with one collateral coin type per market, fixed
outcomes `YES`, `NO`, and `VOID`, no secondary trading, no leverage, and no
market maker. A participant deposits stake into one side. On resolution,
winning positions split the post-fee escrow pro rata by shares. On
cancellation or void resolution, every position can reclaim its original
stake and no fee is taken.

This intentionally does not provide confidential on-chain positions. Sui
observers can see market object IDs, transaction timing, stake sizes, position
objects, and outcomes. The private product surface comes from encrypted
Walrus content, SEAL policy membership, pseudonymous custodial addresses, and
not putting relationship subjects or prompts on-chain. If the product requires
cryptographic trade privacy, the Move interface must change to a
commit-reveal, zk, or confidential execution design.

## Objects

`Market<T>` is a shared object, where `T` is the collateral coin type. It owns
the escrow balances and lifecycle state.

Fields:

- `id: UID`
- `creator: address`
- `terms_hash: vector<u8>`: hash of canonical market terms, resolution rule,
  and encrypted metadata manifest.
- `metadata_blob_id: vector<u8>`: Walrus blob identifier, not plaintext.
- `seal_policy_id: vector<u8>`: SEAL policy that gates metadata access.
- `state: u8`: `OPEN`, `LOCKED`, `PROPOSED`, `RESOLVED`, `CANCELLED`.
- `created_ms`, `close_ms`, `proposal_deadline_ms`, `finalize_after_ms`.
- `resolver: address`: MVP oracle or resolver service address.
- `fee_bps: u16`, copied from config at creation for stable terms.
- `yes_pool: Balance<T>`, `no_pool: Balance<T>`, gross stake.
- `fee_balance: Balance<T>`, populated only on successful finalization.
- `payout_pool: Balance<T>`, populated on successful finalization.
- `yes_shares: u64`, `no_shares: u64`.
- `winning_shares_remaining: u64`, decremented on each winning claim.
- `winning_outcome: u8`: unset until finalization.
- `resolution_evidence_hash: vector<u8>`: hash or blob reference, never raw
  evidence.

`InviteTicket` is an address-owned, non-transferable object minted by the
market creator or backend after the privacy layer has decided the invitee may
join. It should have `key` but not `store`, so arbitrary public transfer is
not available. The module can still transfer it when minting.

Fields:

- `id: UID`
- `market_id: ID`
- `grantee: address`
- `max_stake: u64`
- `expires_ms: u64`

`Position<T>` is an address-owned, non-transferable object. It should also
have `key` but not `store`; MVP positions are not tradable.

Fields:

- `id: UID`
- `market_id: ID`
- `owner: address`
- `outcome: u8`
- `stake: u64`
- `shares: u64`
- `claimed: bool`

`Config` is a shared object controlled by `AdminCap`. It stores the package
fee recipient, max fee bps, and emergency pause bit. Markets copy `fee_bps`
at creation so later config changes do not rewrite old terms.

`ResolverCap` is address-owned by the resolver service for a market or a
resolver registry. MVP can use a direct `resolver: address` check instead of
the cap if the wallet service is the only resolver, but a cap gives cleaner
migration to multiple resolvers.

## Entry Interface

Use names like these in the contract package; exact module names can change.

- `create_market<T>(terms_hash, metadata_blob_id, seal_policy_id, close_ms,
  proposal_deadline_ms, finalize_after_ms, resolver, fee_bps, clock, ctx)`
  creates and shares `Market<T>`.
- `mint_invite<T>(&mut Market<T>, &CreatorCap or &AdminCap, grantee,
  max_stake, expires_ms, ctx)` creates an `InviteTicket`.
- `place<T>(&mut Market<T>, InviteTicket, Coin<T>, outcome, &Clock, ctx)`
  consumes the invite, validates sender/grantee, validates `OPEN`, validates
  deadline and stake limit, deposits the coin into the selected pool, and
  returns a `Position<T>`.
- `lock<T>(&mut Market<T>, &Clock)` moves `OPEN` to `LOCKED` after close.
  Resolution calls may also perform this transition lazily.
- `propose_resolution<T>(&mut Market<T>, &ResolverCap, outcome,
  evidence_hash, &Clock)` moves `LOCKED` to `PROPOSED`.
- `finalize_resolution<T>(&mut Market<T>, &ResolverCap, &Clock)` moves
  `PROPOSED` to `RESOLVED`, computes the fee, moves remaining escrow into
  `payout_pool`, and sets `winning_shares_remaining`.
- `cancel<T>(&mut Market<T>, &AdminCap or &ResolverCap, reason_hash, &Clock)`
  moves non-resolved markets to `CANCELLED`.
- `claim<T>(&mut Market<T>, &mut Position<T>, ctx)` pays a resolved winning
  position or marks a losing position claimed. The payout formula is:
  `payout_pool_value * position.shares / winning_shares_remaining`, then
  subtract both payout and shares. This gives the final claimer the rounding
  remainder without needing loops.
- `refund<T>(&mut Market<T>, &mut Position<T>, ctx)` pays `position.stake`
  after `CANCELLED` or `VOID`.
- `withdraw_fees<T>(&mut Market<T>, &Config, ctx)` sends `fee_balance` to the
  configured fee recipient after successful finalization.

All arithmetic that multiplies balances by bps or shares should widen to
`u128` before division and abort if conversion back to `u64` is unsafe.

## Lifecycle

`OPEN`: invites can be minted and positions can be placed before `close_ms`.
The contract should not require all invitees to appear on-chain. Only redeemed
invites become visible.

`LOCKED`: no new positions. The resolver can inspect encrypted evidence
off-chain and submit a proposal.

`PROPOSED`: the proposed outcome and evidence hash are on-chain. Challenge
semantics belong to the resolution design, but the object model reserves this
state so a challenge window does not require a contract rewrite.

`RESOLVED`: escrow has been split into fee and payout pools. Positions are
claimed independently in O(1), with no vector of positions and no settlement
loop.

`CANCELLED`: positions refund stake independently in O(1). No fee is taken.

`VOID` is an outcome, not a separate state. Finalizing to `VOID` should use
the same refund path as cancellation.

## Escrow, Fees, and Payouts

The market holds gross stake until finalization. Taking fees only on
successful resolution makes cancellation fair and keeps refund accounting
simple.

Fee policy for MVP: charge `fee_bps` on total gross escrow at successful
finalization, capped by `Config.max_fee_bps`. The remaining escrow becomes
the payout pool for the winning side. If the winning side has zero shares, the
market must not finalize to that side; it must finalize to `VOID` or cancel.

Positions store stake and shares so refunds and payouts do not depend on an
off-chain indexer. Shares equal gross stake in MVP. That preserves a simple
fixed-pool pari-mutuel model and avoids price-curve or AMM invariants.

## Invariant Boundaries

Move must enforce:

- Escrow conservation: total coins entering a market leave only through
  refunds, payouts, or fee withdrawal.
- State monotonicity: lifecycle transitions never move backward.
- Deadline checks: no placement after close; no finalize before the proposal
  window permits it.
- Single claim/refund: each `Position<T>` pays at most once.
- Cross-market safety: tickets and positions must match `market.id`.
- Sender ownership: invite grantee and position owner must match `ctx.sender`.
- Outcome validity: only `YES`, `NO`, and `VOID` constants are accepted.
- O(1) settlement: no function iterates over all positions or invitees.
- Fee cap: market fee cannot exceed the package-level configured maximum.

Off-chain services must enforce:

- Twitter identity binding and custodial wallet authorization.
- Social graph membership and invite eligibility.
- SEAL policy construction and Walrus ACL correctness.
- Resolution evidence collection, human judgement, and challenge review.
- Abuse controls such as market spam, resolver bribery detection, and account
  recovery.

The indexer may improve UX, but no safety invariant may rely on an indexer.

## Threat Model for This Component

Unauthorized participation is handled by consuming `InviteTicket` and matching
the sender to `grantee`. If tickets are transferable, the market is broken;
the no-`store` ticket shape is load-bearing.

Replay and cross-market claims are handled by embedding `market_id` in both
tickets and positions and checking it on every call.

Double payout is handled by `Position.claimed`, but the implementation must
mutate the position before transferring coins or otherwise make the operation
atomic under Move semantics.

Resolver abuse is not solved by Move alone. The contract can require the
right resolver and a challenge delay, but it cannot decide whether two people
went on a date. That belongs to `pm-resolution-mechanism`.

Privacy leakage is inherent to public-chain settlement. A chain observer can
infer stake timing and side if position objects expose `outcome`. This is
acceptable only for MVP if product copy defines "private" as private content
and invite-gated app access, not confidential economics. Stronger privacy
changes the interface.

Rounding and dust are handled by decrementing `winning_shares_remaining` as
claims occur, causing the final winning claimer to receive the remainder.

Gas griefing is avoided by never storing participant vectors on `Market<T>`.
Each invite, position, refund, and claim is an independent object operation.

Shared-object contention is acceptable for small private MVP markets. If
markets become large or high-frequency, the interface may need per-side pool
objects or batched intent settlement.

## Alternatives That Change the Interface

Confidential positions require a different object model: commitments instead
of clear `Position.outcome`, a reveal phase or zk proof, and different payout
verification. Do not retrofit this into the MVP interface.

Tradable positions require `Position<T>` to have `store`, public transfer or
a marketplace module, and transfer-aware payout authorization. Defer.

AMM pricing requires reserve math, slippage parameters, and different share
accounting. Defer in favor of pari-mutuel pools.

Multi-outcome markets require dynamic outcome pool objects and different
finalization checks. Defer until the product has a concrete non-binary use
case.

## Open Questions

No new ditz issue is needed from this sketch. The unresolved questions are
already covered by existing issues:

- `pm-move-object-lifecycle`: exact contract object fields, state machine,
  escrow math, fees, cancellation, settlement, and claim implementation.
- `pm-privacy-policy-model`: whether MVP privacy limits are acceptable and
  whether later confidential positions are required.
- `pm-resolution-mechanism`: resolver authority, challenge semantics,
  evidence handling, and finality.
- `pm-custodial-wallet-interface`: address custody, signing authority, and
  migration to self-custody.
