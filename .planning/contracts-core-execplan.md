# pairmarket contracts-core: Move package for private binary pari-mutuel markets

This ExecPlan is a living document. The sections `Progress`, `Surprises &
Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up
to date as work proceeds.

This plan must be maintained in accordance with `.planning/PLANS.md`.

## Purpose / Big Picture

After this change, a contributor with a working Sui Move toolchain can
`cd contracts/pairmarket && sui move build` and see a compiled package that
implements the Move object model described in `docs/design.md` and
`.planning/subagents/move-object-model.md`: a shared `Market<T>` for binary
pari-mutuel betting on private relationship outcomes, address-owned
non-transferable `InviteTicket` and `Position<T>` objects, an explicit
lifecycle from `Proposed` through `Settled`, escrow conservation enforced
by the type system, and `sui move test` exercising the lifecycle, the
single-claim invariant, the cross-market invariant, and arithmetic
conservation across a binary settlement.

The user-visible behavior this enables is the on-chain half of the MVP:
once the off-chain wallet, privacy, and resolution paths land, the
contract is the part of the system that holds the money correctly and
refuses to release it to the wrong party. Everything else can fail
gracefully; this cannot.

## Progress

- [x] (2026-06-27Z) Author this ExecPlan from design.md and the
  move-object-model sketch.
- [ ] Scaffold `contracts/pairmarket/` with `Move.toml`, `sources/`, and
  `tests/` directory layout.
- [ ] Implement `market.move` with `Market<T>`, `InviteTicket`,
  `Position<T>`, `Config`, `AdminCap`, lifecycle state constants,
  outcome constants, error codes, and events.
- [ ] Implement entry functions: `create_market`, `record_subject_consent`,
  `mint_invite`, `place`, `lock`, `submit_attestation`,
  `submit_committee_verdict`, `finalize`, `claim`, `refund`, `cancel`,
  `withdraw_fees`.
- [ ] Implement helpers: payout math widening to `u128`, share accounting,
  invite consumption, position single-claim mutation.
- [ ] Write `tests/market_tests.move` covering lifecycle happy path,
  cross-market reject, single-claim, fee cap, outcome validity,
  cancellation refund, and binary escrow conservation.
- [ ] Attempt `sui move build` and `sui move test` against the locally
  available Sui CLI; record exact output and gap to the design's
  pinned toolchain version.
- [ ] Open a draft PR targeting `agent/codex-4b7333ab` (design PR #1)
  or `agent/scaffold-toolchain` once that branch exists.

## Surprises & Discoveries

- Observation: `agent/scaffold-toolchain` exists as a worktree but has
  not progressed beyond the initial scaffold commit (`66bf20a`), so no
  Nix flake or pinned Sui CLI exists yet at the time this plan is
  authored.
  Evidence: `git log agent/scaffold-toolchain --oneline -5` returns the
  same four commits as `master`.
- Observation: the locally installed Sui CLI is `sui 1.57.2`, which is
  older than the design's recommended pin `mainnet-v1.73.2`. Any build
  attempt from this worktree is informational only; the canonical build
  gate lives in a future Nix flake.
  Evidence: `sui --version` returns `sui 1.57.2-83e72a664e88`.
- Observation: The Move package depends on `MystenLabs/sui` git revs
  (Sui framework, `Sui` and `MoveStdlib` packages). On first build,
  `sui move build` will attempt to fetch those over the network. In a
  sandboxed environment, `--skip-fetch-latest-git-deps` may be needed if
  the deps are cached, or the build is gated on outbound network.

## Decision Log

- Decision: Place the Move package at `contracts/pairmarket/` rather
  than `contracts/` directly.
  Rationale: design.md describes `contracts/` as the scope for "Sui Move"
  but a real Sui repository typically nests the named Move package one
  level down (`contracts/<package-name>/Move.toml`). The package name
  `pairmarket` matches the on-chain `package_id` referenced in the SEAL
  policy identity scheme. Future packages (e.g. an integration test
  package) can live as siblings under `contracts/`.
  Date/Author: 2026-06-27 / contracts-core agent.

- Decision: Implement everything in a single `market` module rather
  than splitting `market`, `invite`, `position`, and `config` into
  separate modules.
  Rationale: All four objects share invariants (escrow, lifecycle,
  membership) that are easier to express as `friend` relationships
  inside a single module. Splitting buys nothing for MVP and costs
  cross-module `public(friend)` ceremony. We can split after the test
  suite stabilizes if the file grows past readable.
  Date/Author: 2026-06-27 / contracts-core agent.

- Decision: Drop the `&CreatorCap` from `mint_invite` and use a
  `creator: address` check against `tx_context::sender`.
  Rationale: The market already stores `creator` and `mint_invite` is a
  trusted-creator action. An explicit `CreatorCap` would require minting
  and transferring a capability object during `create_market`, which
  burns an object slot for no extra safety — a stolen `CreatorCap` is
  equivalent to a compromised creator key. Address check is simpler and
  equivalent. Re-evaluate if multi-creator markets land.
  Date/Author: 2026-06-27 / contracts-core agent.

- Decision: Represent lifecycle states as `u8` constants on the
  `Market<T>` struct rather than as an enum-of-objects (e.g. a phantom
  type parameter).
  Rationale: Move 2024 has enums but a `u8` state matches the
  serialization that off-chain TypeScript will decode anyway, keeps the
  shared object's Move type stable across state transitions, and avoids
  needing to wrap/unwrap the Market into typed phase markers each
  transition. The cost is runtime checks for state instead of
  type-system checks; that cost is acceptable for a small state machine
  with eight states.
  Date/Author: 2026-06-27 / contracts-core agent.

- Decision: Subject co-attestation and committee verdict are
  implemented as `u8` `last_attestation_a/b` fields on the market plus
  attached `Attestation` records via dynamic fields, not as a separate
  shared `Attestation` object.
  Rationale: Minimizes the number of shared objects per market. The
  challenge object is the only object the resolution path needs to
  expose to non-subjects, and even that can be a per-market field for
  MVP since at most one challenge is open at a time.
  Date/Author: 2026-06-27 / contracts-core agent.

- Decision: The Position has both `stake` and `shares` even though
  shares equal stake in MVP.
  Rationale: design.md says shares equal stake for MVP but reserves the
  right to evolve. Storing them separately costs eight bytes per
  position and lets the payout formula remain stable if MVP evolves to
  scoring rule pricing.
  Date/Author: 2026-06-27 / contracts-core agent.

## Outcomes & Retrospective

To be filled in at completion.

## Context and Orientation

The repository root is `/home/tedks/Projects/pairmarket/`. This worktree
is `agent/contracts-core/` on branch `agent/contracts-core`. The
authoritative design document is `docs/design.md`. The companion
component sketch most relevant to this work is
`.planning/subagents/move-object-model.md`. Both are committed at the
branch base `66bf20a`.

Key terms used below:

- "Pari-mutuel": a betting pool where stakes from losers are
  redistributed pro-rata to winners after fees, with no fixed odds set
  at trade time. The pool sets the price implicitly.
- "Shared object" (Sui): a Move object stored in global state and
  accessible by any transaction that names its object ID. Updates to a
  shared object are serialized by Sui consensus.
- "Address-owned, non-transferable object": a Move object that has
  `key` ability but not `store`. It is held by a Sui address and can
  only be transferred or destroyed by the module that defined it.
  Public transfer is impossible.
- "Phantom type parameter": a type parameter used to brand a struct
  with an external type without storing a value of that type. Here, the
  collateral coin type `T` brands `Market<T>` and `Position<T>` so a
  position from market A cannot be claimed against market B if their
  collateral types differ.
- "SEAL policy id": an opaque byte string identifying a decryption
  policy registered with SEAL key servers. Move stores it as
  `vector<u8>` because the contract does not interpret the bytes.

There is no Nix flake in the repo yet. Locally, the Sui CLI is at
`sui 1.57.2-83e72a664e88`, older than the design's recommendation of
`mainnet-v1.73.2`. The defensible posture is: write the package and
tests, attempt to build for smoke validation, and document the missing
canonical build gate explicitly in this plan and on the ditz issue
`pm-move-object-lifecycle`.

## Plan of Work

1. Create `contracts/pairmarket/Move.toml` declaring a package named
   `pairmarket` with edition `2024.beta` (Move 2024 with enum syntax)
   and a `Sui` framework dependency pinned to a recent
   `framework/testnet` rev. The exact rev should match whatever the
   future Nix flake pins; until then, target the same rev the local
   `sui` CLI defaults to so a smoke build is feasible. Record the
   chosen rev in this plan when known.

2. Create `contracts/pairmarket/sources/market.move`. Define, in order:

   a. Module preamble and imports from `sui::object`, `sui::coin`,
      `sui::balance`, `sui::clock`, `sui::event`, `sui::transfer`,
      `sui::table`, and `sui::tx_context`.

   b. Lifecycle state constants:
      `STATE_PROPOSED`, `STATE_TRADING`, `STATE_LOCKED`,
      `STATE_ATTESTATION_PENDING`, `STATE_CHALLENGE_WINDOW`,
      `STATE_DISPUTED`, `STATE_SETTLED`, `STATE_CANCELLED`,
      `STATE_EXPIRED`.

   c. Outcome constants: `OUTCOME_UNSET`, `OUTCOME_YES`, `OUTCOME_NO`,
      `OUTCOME_INVALID`.

   d. Error codes (`EWrongState`, `EWrongMarket`, `ENotInvitee`,
      `EInviteExpired`, `EStakeExceedsCap`, `EUnknownOutcome`,
      `ECloseDeadlinePassed`, `EAttestTooEarly`,
      `EChallengeWindowOpen`, `EDoubleClaim`,
      `EFeeCapExceeded`, `ENotSubject`, `ENotCommittee`,
      `EZeroStake`, `EWrongCoin`).

   e. `Config` shared struct (`key`) with `max_fee_bps: u16`,
      `fee_recipient: address`, `paused: bool`, `version: u8`.

   f. `AdminCap` (`key`, no `store`).

   g. `Market<phantom T>` (`key`) with the fields listed in
      design.md.

   h. `InviteTicket` (`key`, no `store`) with `market_id`,
      `grantee`, `max_stake`, `expires_ms`.

   i. `Position<phantom T>` (`key`, no `store`) with `market_id`,
      `owner`, `outcome`, `stake`, `shares`, `claimed`.

   j. `MemberRecord` (`store`, used inside the `Table`).

   k. Event structs for the events listed in design.md.

   l. Entry functions enumerated in design.md, each implementing the
      invariants enumerated in `move-object-model.md` "Invariant
      Boundaries".

   The intent is to keep this module under ~700 lines for first
   review and to fold helper math into private functions
   (`compute_payout`, `widen_mul_div`, `assert_state`,
   `assert_market_id`).

3. Create `contracts/pairmarket/tests/market_tests.move` with `#[test]`
   functions per scenario. Each scenario uses `sui::test_scenario` to
   simulate epochs and senders. The minimum suite is:

   - `happy_path_yes_resolves_pays`: create, both subjects consent,
     mint two invites, place YES stake from A and NO stake from B,
     lock, both subjects attest YES, challenge window passes,
     finalize, A claims and receives the post-fee pool, B's refund
     attempt aborts.
   - `happy_path_no_resolves_pays`: symmetric.
   - `cross_market_invariant`: positions from market X cannot claim
     against market Y; assert abort `EWrongMarket`.
   - `single_claim_invariant`: same position cannot claim twice;
     second `claim` aborts `EDoubleClaim`.
   - `invite_single_use`: same invite cannot back two `place` calls.
   - `cancel_refunds_full_stake_no_fee`: cancellation path refunds
     gross stake and never moves coins to the fee balance.
   - `binary_escrow_conservation`: after settlement, sum of payouts +
     fee balance equals sum of stakes; assert in test.
   - `attestation_mismatch_resets_round`: A says YES, B says NO, the
     round advances and the matched-attestation event does not fire.
   - `fee_cap_enforced`: `create_market` aborts when the requested
     `fee_bps` exceeds `Config.max_fee_bps`.

4. Build and test:

       cd contracts/pairmarket
       sui move build
       sui move test

   Record output verbatim under `Artifacts and Notes`. If the build
   fails due to a stale Sui CLI or a missing framework rev, record the
   failure with the exact command and message and leave the
   appropriate Progress checkbox unchecked.

## Concrete Steps

The working directory for every command below is the contracts worktree
unless stated otherwise:

    cd /home/tedks/Projects/pairmarket/agent/contracts-core

1. Create the package directory:

       mkdir -p contracts/pairmarket/sources contracts/pairmarket/tests

2. Author `contracts/pairmarket/Move.toml`. Use the system Sui CLI's
   default framework rev for the smoke build (the actual canonical rev
   will be set by the Nix flake once `agent/scaffold-toolchain`
   produces it). Record the chosen rev in this plan when committing.

3. Author `contracts/pairmarket/sources/market.move`. Follow the order
   in the "Plan of Work" section above.

4. Author `contracts/pairmarket/tests/market_tests.move`.

5. Attempt build and test. If the local Sui CLI 1.57.2 cannot resolve
   the chosen framework rev (likely, since 1.57.2 predates many
   `framework/testnet` revs), run with `--skip-fetch-latest-git-deps`
   if a cached copy exists; otherwise capture the failure and proceed
   without claiming a green build.

## Validation and Acceptance

Acceptance is, in order:

1. `sui move build` in `contracts/pairmarket/` reports
   `BUILDING pairmarket` and no errors against the toolchain pinned by
   the future Nix flake. Until that flake exists, an equivalent build
   under the locally available Sui CLI is best-effort and noted as
   such.

2. `sui move test` runs all `#[test]` functions in
   `tests/market_tests.move` and reports `Test result: OK`.

3. The escrow conservation test (`binary_escrow_conservation`) asserts
   that for every closed market, the sum of all coins paid out via
   `claim`, all coins refunded via `refund`, and the value of
   `fee_balance` equals the sum of all coins deposited via `place`.
   The test must fail (deliberately, by editing payout math to skim a
   unit) and then pass when the math is correct.

4. The single-claim test must fail before the `Position.claimed`
   mutation is added and pass after.

5. PR description summarizes the design references, invariants, the
   exact toolchain used for the smoke build, and what gate is missing
   until the Nix flake exists.

## Idempotence and Recovery

Every step in this plan is additive: creating a new directory, adding
new files, adding ditz comments. Re-running the create/edit steps
overwrites the same files with the same content. The build and test
commands are read-only against the file system except for the
`build/` directory, which is ignored by `.gitignore` (`/build/`,
`/target/`).

If a build cache becomes corrupted, remove the local `build/`
directory:

    rm -rf contracts/pairmarket/build

If a Sui CLI upgrade is required, `agent/scaffold-toolchain` is the
canonical place to add the Nix flake. Do not pin a global Sui version
from this branch.

## Artifacts and Notes

Build and test transcripts are appended here as they are produced.

## Interfaces and Dependencies

In `contracts/pairmarket/sources/market.move`, the public Move API must
include the following signatures (names match `docs/design.md`; exact
parameter names can vary):

    public entry fun create_market<T>(
        terms_hash: vector<u8>,
        metadata_ref: vector<u8>,
        subject_ref: vector<u8>,
        seal_policy_id: vector<u8>,
        subject_a: address,
        subject_b: address,
        close_ms: u64,
        earliest_attest_ms: u64,
        resolution_deadline_ms: u64,
        challenge_window_ms: u64,
        dispute_deadline_ms: u64,
        fee_bps: u16,
        resolver_committee: vector<address>,
        config: &Config,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun record_subject_consent<T>(
        market: &mut Market<T>,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun mint_invite<T>(
        market: &mut Market<T>,
        grantee: address,
        max_stake: u64,
        expires_ms: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun place<T>(
        market: &mut Market<T>,
        invite: InviteTicket,
        stake: Coin<T>,
        outcome: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun lock<T>(
        market: &mut Market<T>,
        clock: &Clock,
    )

    public entry fun submit_attestation<T>(
        market: &mut Market<T>,
        outcome: u8,
        evidence_hash: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun submit_committee_verdict<T>(
        market: &mut Market<T>,
        outcome: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    )

    public entry fun finalize<T>(
        market: &mut Market<T>,
        clock: &Clock,
    )

    public entry fun claim<T>(
        market: &mut Market<T>,
        position: &mut Position<T>,
        ctx: &mut TxContext,
    )

    public entry fun refund<T>(
        market: &mut Market<T>,
        position: &mut Position<T>,
        ctx: &mut TxContext,
    )

    public entry fun cancel<T>(
        market: &mut Market<T>,
        admin: &AdminCap,
        clock: &Clock,
    )

    public entry fun withdraw_fees<T>(
        market: &mut Market<T>,
        config: &Config,
        ctx: &mut TxContext,
    )

Dependencies:

- Sui Move framework (`Sui`, `MoveStdlib`) at a rev resolvable by the
  toolchain in use. Canonical rev TBD by the Nix flake on
  `agent/scaffold-toolchain`.

- No external Move packages. `Walrus` and `SEAL` references are stored
  as opaque `vector<u8>`; the contract does not link against their
  Move modules.

## Revision Notes

- 2026-06-27 / contracts-core agent: initial plan authored from
  `docs/design.md` and `.planning/subagents/move-object-model.md` at
  commit `66bf20a`.
