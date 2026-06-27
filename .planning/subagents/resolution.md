# Resolution Component Interface Sketch

Scope: how a private relationship market settles. MVP-opinionated. Alternatives
called out only where they would change the contract or off-chain interface.

Tracked by ditz issue `pm-resolution-mechanism`. Sub-questions filed as
`pm-resolution-*` (see "Open issues" below).

## One-line MVP

Two-of-two **subject co-attestation** with a **72-hour challenge window**,
bonded challenges, and a small **community-multisig dispute path**. No
third-party oracles, no LLM judges. Move enforces the attestation gate and
window arithmetic; SEAL/Walrus protect evidence.

## Roles

- **Subjects** (`Subject`): the two real people the market is *about*. Identified
  on-chain by Sui addresses bound at market creation; the binding is signed by
  each subject's wallet (custodial wallet signs on their behalf after a
  Twitter-authenticated consent step - see `pm-custodial-wallet-interface`).
  In MVP, the only **eligible attestors** are the two subjects, jointly.
- **Participants** (`Bettor`): the inviter and anyone they invite into the
  private market. Can stake, can challenge.
- **Creator**: the inviter who authored the market. Special only during the
  pre-trade window (see Cancellation).
- **Dispute committee**: a small (3-of-5) community multisig held by
  pairmarket operators + trusted community members. Only invoked when a
  challenge fires. Hardcoded address set per-deployment; rotatable via a
  separate governance object.

Rejected for MVP: independent third-party attestors, designated "friend
witnesses", LLM oracles, optimistic-oracle (UMA-style) markets. See
"Alternatives" for the optimistic-oracle option, which is the most credible
v2 replacement for the dispute committee.

## Subject consent and visibility

- A market is **proposed** but does not enter the `Trading` state until
  *both* subjects sign a `ConsentToBeMarketSubject` payload containing the
  market id, the operationalization text hash, the resolution deadline, and
  the attestor set (`{subject_a, subject_b}`). Without both signatures the
  Move object stays in `Proposed`; no stakes accepted.
- A subject can **decline** at consent time; this terminates the market with
  no economic side effects.
- Default **visibility to subjects** while `Trading`:
  - They see: question text, operationalization, resolution deadline,
    *count* of participants, *aggregate* implied probability.
  - They do **not** see: per-participant positions or identities.
- This is enforced at the application/content layer: the app does not disclose
  participant-roster blobs or per-position metadata to subjects by default.
  The Sui layer still exposes redeemed wallet addresses and position objects
  to chain observers; MVP explicitly accepts that leakage.
- Subjects opt-in to seeing identities at market end (post-finalization); a
  market-creation flag can hide identities forever (default for MVP: hide).
- Open question: should subjects see the *list* of inviters even with
  counts hidden? Filed as `pm-resolution-subject-visibility-leakage`.

## Operationalization

- Stored as plain text + a structured tag (`enum Kind { LastsNDates,
  TogetherByDate, MeetByDate, ... }`) and bound parameters
  (`n_dates: u8`, `by_date: u64`). The structured form is what the
  contract reads; the text is what humans confirm.
- The set of `Kind`s is a closed enum in MVP. Adding a new `Kind` is a
  contract upgrade. This is deliberate: free-form questions are how
  resolution disputes happen.
- Each `Kind` defines (a) which outcomes are valid (`YES | NO | INVALID`),
  (b) when attestation may begin, (c) the default resolution deadline.

## Evidence

- Evidence is **optional** in MVP - the canonical signal is the matched
  pair of subject signatures over the outcome. Evidence exists to make the
  challenge process meaningful and to give the dispute committee something
  to look at.
- When provided, evidence is one Walrus blob per attestation containing a
  short free-text claim and any attachments. Encrypted under a SEAL policy
  that grants read to the subjects and resolver by default, grants the dispute
  committee read access only while a live challenge exists, and grants
  participant read access after finalization only if the market's disclosure
  setting allows it.
- Only the Walrus blob id + content hash + SEAL policy id are stored
  on-chain. No plaintext, no PII on-chain.
- Hash binding: each attestation signs over `(market_id, outcome,
  evidence_blob_id, evidence_content_hash, nonce)`. This prevents
  swap-evidence attacks after the fact.

## Attestation flow

1. Earliest-attestation timestamp passes (e.g., for "lasts 3 dates", the
   earliest the question can be answered).
2. Either subject calls `submit_attestation(market_id, outcome,
   evidence_blob_id, evidence_content_hash, sig)`. The contract stores it
   as a pending attestation.
3. The second subject calls the same with matching `outcome`. If outcomes
   match, market transitions to `ChallengeWindowOpen`.
4. If outcomes *mismatch*, the contract emits `Mismatch` and resets both
   pending slots; subjects may retry. Mismatched attestations are public
   on-chain (this is a feature: it signals disagreement to participants).
5. If no matched pair by `resolution_deadline`, market transitions to
   `Expired` and refunds (see Cancellation).

## Challenge window

- **Length**: 72 hours wall-clock (Sui clock). Configurable per-market at
  creation within `[24h, 168h]`; default 72h. Hard cap exists so funds are
  never locked indefinitely.
- **Who can challenge**: any participant with a non-zero stake. Subjects
  can also challenge their *own* matched attestation (e.g., one was coerced
  and now retracts). Non-participants cannot - this is a private market.
- **How**: `open_challenge(market_id, claimed_outcome, evidence_blob_id,
  bond)`. Bond is a fixed multiple of the median per-participant stake
  in the market (MVP: 3x). The bond goes into escrow.
- **Effect**: market transitions to `Disputed`. Challenge window does not
  re-open after dispute resolution.

## Dispute resolution (MVP: community multisig)

- The dispute committee reads evidence (gated by the `ChallengeOpen`
  capability that SEAL honors) and signs a `Verdict { outcome, slash }`.
- 3-of-5 signatures finalize the verdict on-chain.
- Bond disposition:
  - Challenge upheld: bond returned + a slice of subject-attestation
    slash (see below) to challenger.
  - Challenge rejected: bond forfeited; split between the two subjects
    and the protocol fee bucket.
- Subject slashing: subjects post no bond by default in MVP (lowers
  friction). A challenged-and-upheld outcome therefore has no slashable
  subject bond; the only deterrent on lying subjects is reputation +
  losing access to future markets (off-chain). This is a known weakness;
  see `pm-resolution-subject-bond`.
- Hard deadline: 14 days from challenge open. If no verdict, market
  finalizes to `INVALID` and everyone is refunded. Bond is returned to
  the challenger. This bounds liveness risk from a dormant committee.

## Finality

- `ChallengeWindowOpen` + window elapses with no challenge -> anyone calls
  `finalize(market_id)` -> `Settled { outcome }`. Payouts become claimable.
- `Disputed` + multisig verdict -> `Settled { outcome }`.
- `Settled` is terminal. No appeals on-chain.
- Off-chain appeals route: a Settled market that someone believes is wrong
  can be raised in a follow-up governance issue; the contract cannot reopen
  it, but the committee can be removed/replaced and a new market created.
  This is intentional - finality must be cheap to verify on-chain.

## Cancellation and refunds

- **Pre-trade cancellation** (`Proposed`): creator may cancel; either
  subject declining also cancels. No funds at risk.
- **Mid-trade cancellation** (`Trading`):
  - Mutual subject revocation: both subjects sign `RevokeConsent`. Market
    transitions to `Cancelled`, refunds pro rata.
  - One-sided withdrawal: a subject can declare `WithdrawConsent`
    unilaterally, which moves the market to `Cancelled` with refunds.
    This is asymmetric on purpose - a subject must always be able to exit
    a market they no longer want to be the subject of. The participants
    knew this was the deal.
- **Expiry** (`Expired`): no matched attestation by deadline -> refunds.
- All refund paths are pro rata over current stakes, minus a small
  protocol fee that covers gas reservation; no profit/loss distribution.
- Open question: should one-sided withdrawal be penalty-free, or should
  the withdrawing subject pay the gas reservation? Filed as
  `pm-resolution-withdraw-fee`.

## Griefing and bribery resistance

The mechanism choices above are doing the following work:

- **Bribery (whale pays subjects to attest a particular way)**: positions
  are SEAL-encrypted and identities are hidden from subjects during
  `Trading`. A subject cannot verify a briber's claimed position, which
  taxes bribery substantially. Aggregate implied probability is still
  visible - a subject can in principle infer that the market thinks they'll
  break up - but cannot target an individual.
- **False attestation**: requires *both* subjects to collude. The challenge
  window + bonded challenge gives any losing participant a recourse. The
  cap on this is the multisig - bad multisig is the failure mode.
- **Refusal to attest (subject griefing)**: bounded by `resolution_deadline`
  and refund path. Subjects who chronically refuse are off-chain
  reputationally punished but not slashed in MVP.
- **Challenge spam**: bond requirement (3x median stake) + only participants
  can challenge. Cheap challenges are unattractive because the bond is
  larger than typical stakes.
- **Mismatched-attestation thrash**: emitting `Mismatch` publicly and
  resetting pending slots discourages a subject from spamming wrong
  outcomes; participants will see the disagreement.
- **Privacy-leak via outcome correlation**: a settled outcome plus visible
  market metadata reveals "A and B broke up" to all participants. This
  is inherent to the product and not something the contract should try to
  obscure further; it is what the participants signed up for. See
  `pm-privacy-policy-model`.

## What the settlement contract must require

Move-side invariants enforced at compile time where possible (phantom
types over `Market<Trading>` vs `Market<Settled>` etc.), runtime checks
elsewhere:

1. State machine: `Proposed -> Trading -> {AttestationPending -> }
   ChallengeWindowOpen -> {Settled | Disputed -> Settled}`,
   plus `{Cancelled, Expired}` as terminal sinks from `Trading`.
2. Attestation gate: `submit_attestation` must verify
   `tx_sender in {subject_a, subject_b}` and that the subject has not
   already attested *this round* (mismatches reset).
3. Attestation hash bind: signature must cover `(market_id, outcome,
   evidence_blob_id, evidence_content_hash, attestation_round_nonce)`.
4. Window arithmetic: `challenge_window_end = matched_at +
   challenge_window_duration`, read from Sui `Clock`, never trusted
   from caller. `finalize` requires `clock.now >= challenge_window_end`
   and `state == ChallengeWindowOpen`.
5. Challenge gate: caller must have a recorded stake in the market and
   must transfer the required bond in the same PTB.
6. Dispute verdict: requires `>=3` distinct signatures from the
   committee key set bound at market creation (not at verdict time, to
   prevent committee-swap attacks mid-dispute).
7. Outcome enum is closed: `YES | NO | INVALID`. `INVALID` triggers refund,
   not payout.
8. Idempotent finalize/claim: `finalize` is callable by anyone, only
   transitions state once; `claim_payout` per-participant is idempotent
   and burns the position object.
9. No reopening: once `Settled`, `Cancelled`, or `Expired`, all
   state-mutating entrypoints abort.
10. Event emission: `Proposed`, `Consented`, `Traded`, `Attested`,
    `Mismatch`, `MatchedPending`, `ChallengeOpened`, `Verdict`,
    `Settled`, `Cancelled`, `Expired`. The off-chain indexer
    reconstructs lifecycle from these.

## Off-chain interface (resolution service)

A small backend ("resolution service") that the frontend talks to. It does
not custody settlement authority - it only orchestrates UX. Surface:

- `POST /markets/{id}/consent` - subject signs `ConsentToBeMarketSubject`;
  service relays to custodial wallet for signing then submits PTB.
- `POST /markets/{id}/attest` - accepts plaintext claim + attachments,
  writes Walrus blob under SEAL policy, returns `(blob_id, content_hash)`,
  builds and submits the `submit_attestation` PTB.
- `POST /markets/{id}/challenge` - quotes bond, builds the
  `open_challenge` PTB.
- `GET /markets/{id}/state` - derived from on-chain events; tells the
  frontend whether to show "attest", "challenge", "claim".
- `POST /markets/{id}/cancel` - wraps `WithdrawConsent` /
  `RevokeConsent`.

The service is stateless w.r.t. settlement authority. Losing the service
does not lose markets - anyone can submit the same PTBs directly.

## Alternatives considered

- **Optimistic oracle (UMA-style) without subject attestation**: a single
  proposer asserts the outcome with a bond, anyone may dispute, dispute
  goes to a token-voted DVM. Stronger for public markets, but for a
  *private* market over a *private* fact ("did A and B last 3 dates"),
  the only people who actually know are the subjects. Optimism just
  reduces to "whichever participant cares enough to assert first" with no
  ground truth - which is worse than asking the subjects. Keep as v2 for
  the dispute path: replace the multisig with an optimistic-oracle
  finalizer once volume justifies it.
- **Third-party witness attestation** (one friend in the social graph
  designated as referee): adds a real human in the loop who is not
  a counterparty, but doubles the consent surface and creates an obvious
  bribery target. Defer.
- **LLM-judged resolution** (e.g., GPT reads the chat log): privacy-toxic
  and non-deterministic. Reject.
- **No challenge window, instant finality on matched attestation**:
  removes the participant recourse against collusive subjects. The 72h
  delay is a small UX cost for a real safety property.
- **Subject bonds**: would strengthen incentive alignment but kill the
  custodial-wallet UX (subjects would need balances to be a subject of
  a market, which inverts the "frictionless invitation" property). Defer
  to v2 - file as `pm-resolution-subject-bond`.

## Open issues to file

These are filed against component `resolution` with deterministic ids.
If `ditz add` fails due to metadata contention with a sibling subagent,
treat this list as the source of truth and let the orchestrator file
them later.

- `pm-resolution-subject-visibility-leakage` - can subjects see inviter
  list (even with counts hidden), and what does the SEAL policy on the
  participant roster look like in detail.
- `pm-resolution-withdraw-fee` - should unilateral subject withdrawal
  carry a gas-reservation fee, and if so, paid in what.
- `pm-resolution-subject-bond` - v2: introduce a subject bond and slash
  on upheld challenge; design the UX so it does not break custodial
  onboarding.
- `pm-resolution-dispute-committee` - bootstrap, rotation, conflict-of-
  interest rules, and quorum tuning for the 3-of-5 multisig.
- `pm-resolution-evidence-seal-policy` - exact SEAL policy predicates
  for the evidence blob, including the `ChallengeOpen` capability
  predicate used to grant the committee read access only during a
  live dispute.
- `pm-resolution-kind-enum` - initial closed set of operationalization
  `Kind`s (`LastsNDates`, `TogetherByDate`, `MeetByDate`, ...) and the
  per-kind earliest-attestation and default-deadline rules.
- `pm-resolution-optimistic-v2` - v2 plan to swap the multisig dispute
  path for an optimistic-oracle finalizer.
