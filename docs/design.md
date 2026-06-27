# pairmarket Design

Status: draft for architecture review

Last updated: 2026-06-27

## Executive summary

pairmarket is a private prediction-market app for friends speculating on
relationship outcomes. The product promise is not "public market liquidity";
it is a small, invitation-only market where private prompts, relationship
details, comments, and evidence are encrypted, while settlement is enforced by
Sui Move.

This design chooses:

- Sui Move for escrow, lifecycle, attestations, refunds, fees, and payout
  conservation.
- Walrus for encrypted off-chain market content and evidence.
- SEAL for policy-bound decryption of Walrus blobs.
- TypeScript with branded and phantom types for the app, backend services, and
  shared typed primitives.
- A custodial wallet keyed from Twitter sign-in for MVP, with a deliberate
  `KeyRef`/owner indirection so zkLogin or another user-held key path can
  replace custody later.
- Pari-mutuel binary markets for MVP: no secondary trading, no AMM, no
  leverage.
- Subject co-attestation plus a bonded challenge window and 3-of-5 community
  dispute committee for resolution.

The biggest product risk is privacy language. MVP does not hide Sui object
existence, trade timing, stake sizes, or settlement payouts from chain
observers. It hides the relationship content, subject mapping, comments,
attachments, and resolution evidence from anyone outside the relevant SEAL
policy. If confidential trading is required for launch, the Move object model
must change materially.

## Assumptions

- A market may be created only about two real subjects after both subjects
  consent to being the subject of that market.
- "Private by invitation" means the application gates market discovery and
  content access. On-chain settlement objects remain public.
- MVP collateral is one Sui coin type per market, initially SUI or a single
  app-approved stable coin.
- The backend is trusted for custody in MVP. This is a product compromise, not
  a cryptographic guarantee.
- No KYC. Twitter OAuth is identity and recovery input, not legal identity.
- The first implementation should optimize for auditable correctness over
  advanced market mechanics.

## Problem statement

Friends often hold private beliefs about relationship outcomes: whether two
people will make it to a third date, whether a couple will still be together
by a given date, or whether two people should be introduced. Today those
beliefs live in group chats. They are informal, hard to settle, and often
leakier than participants realize.

pairmarket turns those beliefs into invitation-only markets with explicit
operationalizations and enforceable settlement. The hard part is not the
staking math. The hard part is preserving dignity and privacy for the people
being discussed while giving participants enough resolution integrity to make
the market meaningful.

Success means:

- A creator can create a private relationship market with a concrete,
  checkable resolution rule.
- Subjects can accept or decline being the subject of the market before money
  is at risk.
- Invitees can participate without learning seed phrases.
- Private content is reconstructible and decryptable only by the intended
  policy members.
- Escrow and payouts are correct even if the backend disappears.
- Resolution can handle ambiguity and bad behavior without pretending that a
  blockchain can know whether people went on a date.

## User stories

- As a creator, I can draft "Will A and B last 3 dates?", invite specific
  friends, and see the market open only after both subjects consent.
- As a subject, I can see the operationalization before trading starts,
  decline without penalty, withdraw consent later with refunds, and attest the
  outcome when the answer is known.
- As an invitee, I can sign in with Twitter, receive a custodial wallet, read
  encrypted market details, place a stake, and later claim payout or refund.
- As a participant who believes the subjects attested falsely, I can open a
  bonded challenge during a short window and submit encrypted evidence.
- As an operator, I can inspect audit logs for custody signing, SEAL decrypt
  requests, and dispute committee verdicts without storing plaintext content.
- As a future self-custody user, I can migrate control of my account without
  losing market membership, positions, pending claims, or SEAL access.

## Non-goals

- Public markets.
- Professional liquidity, market-making bots, AMMs, leverage, or secondary
  position trading.
- Confidential on-chain positions in MVP.
- Cross-chain bridging.
- Mobile-first native apps.
- Identity verification beyond Twitter OAuth.
- KYC, fiat on-ramps, or regulated exchange features.
- Fully decentralized dispute resolution at launch.
- Retroactive revocation of content already decrypted by a former member.

## System architecture

### Components

- Web app: React/Next.js or Remix TypeScript app, using the shared `core/`
  package for branded IDs, capabilities, encrypted refs, and transaction
  intents.
- API backend: session management, Twitter OAuth, invite orchestration,
  Walrus writes, SEAL decrypt proxy for custodial users, transaction intent
  building, rate limits, and audit logs.
- Custodial wallet service: non-exportable key storage, policy-gated signing,
  gas sponsorship, recovery locks, and migration to self-custody.
- Sui Move package: markets, invites, positions, attestations, challenges,
  dispute verdicts, escrow, fees, refunds, and payouts.
- Walrus: stores encrypted market bodies, comments, attachments, subject
  mapping blobs, and resolution evidence.
- SEAL key servers: release decryption shares only when the caller satisfies
  the on-chain policy predicate.
- Indexer: derives market state, user portfolio, claims, and event timelines
  from Sui events. It improves UX but is not a safety dependency.
- Dispute committee: MVP 3-of-5 multisig for challenged resolution verdicts.

### Diagram

```text
                  Twitter OAuth
                       |
                       v
+-----------+    +-----------+       +-------------------+
| Web app   |<-->| API       |<----->| Custodial wallet  |
| TS strict |    | backend   |       | KeyRef + policy   |
+-----------+    +-----------+       +-------------------+
      |               |                         |
      | read/write    | write encrypted blobs   | sign typed PTBs
      v               v                         v
+-----------+    +-----------+       +-------------------+
| SEAL key  |<-->| Walrus    |<----->| Sui Move package  |
| servers   |    | blobs     | refs  | market + escrow   |
+-----------+    +-----------+       +-------------------+
      ^                                         |
      | policy checks                           | events
      +-----------------------------------------+
                                                v
                                      +-------------------+
                                      | Indexer           |
                                      +-------------------+
```

### Data flow: create market

1. Creator signs in with Twitter. Backend creates or loads a custodial wallet.
2. Creator drafts terms and chooses invitees. Draft content is local or stored
   as P3 creator-only encrypted Walrus content.
3. Backend creates canonical terms: structured resolution kind, deadlines,
   subject opaque IDs, invite policy, fee bps, and content manifest.
4. Backend writes encrypted market metadata to Walrus under the initial SEAL
   policies.
5. Backend builds a `create_market` transaction intent. Custodial wallet signs
   after policy checks. Move creates a shared `Market<T>` in `Proposed`.
6. Both subjects sign `ConsentToBeMarketSubject`. After both signatures, Move
   transitions to `Trading`.
7. Invitees receive invite links. The backend mints or redeems invite tickets
   only for eligible users.

### Data flow: place wager

1. Participant authenticates and obtains an `InviteCap`.
2. Web app displays decrypted market body after SEAL policy approval.
3. Participant chooses side and amount. Backend builds a typed
   `place-wager` intent with market, side, max amount, and nonce.
4. Wallet service signs only if the user owns the wallet, the invite is valid,
   the amount is within limits, and the market is still open.
5. Move consumes the invite ticket, deposits the coin into the correct pool,
   and returns a non-transferable `Position<T>`.

### Data flow: resolve

1. Earliest-attestation time passes.
2. Subjects submit matching signed attestations over outcome and optional
   evidence blob hashes.
3. Move opens a challenge window.
4. If no participant challenges, anyone finalizes after the window.
5. If challenged, the committee reads gated evidence and submits a 3-of-5
   verdict before the hard timeout.
6. Move finalizes to `YES`, `NO`, or `INVALID`. `INVALID` refunds.
7. Positions claim payouts or refunds independently in O(1).

### Trust boundaries

- Browser to backend: untrusted input. All IDs, intents, and blob manifests are
  parsed and branded at the API boundary.
- Backend to wallet service: privileged but constrained. Wallet signs only
  typed intents built from templates.
- Wallet service to Sui: cryptographic signing authority for custodial users.
- Walrus: public storage. Every sensitive blob is encrypted before upload.
- SEAL key servers: policy gate for decryption. A compromised threshold
  majority can disclose content encrypted under that server set.
- Sui Move: authoritative for escrow, lifecycle, membership facts used by
  SEAL, and payout authorization.
- Indexer: not trusted for safety.

## On-chain design

### Market model

MVP uses a shared `Market<T>` object, where `T` is the collateral coin type.
It is binary and pari-mutuel.

Core fields:

- `id: UID`
- `creator: address`
- `terms_hash: vector<u8>`
- `metadata_ref: EncryptedRef<P1Participant>`
- `subject_ref: EncryptedRef<P2Subject>`
- `evidence_ref: Option<EncryptedRef<P4Evidence>>`
- `seal_policy_id: vector<u8>`
- `policy_epoch: u32`
- `state: u8`
- `created_ms`, `close_ms`, `earliest_attest_ms`, `resolution_deadline_ms`
- `challenge_window_ms`, `dispute_deadline_ms`
- `subject_a`, `subject_b: address`
- `resolver_committee: vector<address>`
- `fee_bps: u16`
- `yes_pool`, `no_pool`, `fee_balance`, `payout_pool: Balance<T>`
- `yes_shares`, `no_shares`, `winning_shares_remaining: u64`
- `winning_outcome: u8`
- `membership: Table<address, MemberRecord>`

Additional owned objects:

- `InviteTicket`: non-transferable, address-owned, consumed on wager.
- `Position<T>`: non-transferable, address-owned, claim/refund authority.
- `Attestation`: stored or represented in market fields by subject and round.
- `Challenge`: object or market field opened by a bonded participant.
- `AdminCap`, `CommitteeCap`, `ResolverCap`: deployment/operator authority.
- `Config`: shared object for fee cap, fee recipient, pause bit, and supported
  collateral types.

### Lifecycle

```text
Draft off-chain
  -> Proposed
  -> Trading
  -> Locked
  -> AttestationPending
  -> ChallengeWindowOpen
  -> Settled

Terminal alternatives:
  Proposed -> Cancelled
  Trading  -> Cancelled
  Trading  -> Expired
  Disputed -> Settled
  Disputed -> InvalidRefund
```

`INVALID` is an outcome that routes to refunds, not a profitable side.

### Entry points

Names are indicative:

- `create_market<T>(terms_hash, encrypted_refs, subjects, timings, fee_bps,
  committee, clock, ctx)`
- `record_subject_consent<T>(&mut Market<T>, subject_sig, clock, ctx)`
- `mint_invite<T>(&mut Market<T>, grantee, max_stake, expires_ms, ctx)`
- `place<T>(&mut Market<T>, InviteTicket, Coin<T>, outcome, clock, ctx):
  Position<T>`
- `lock<T>(&mut Market<T>, clock)`
- `submit_attestation<T>(&mut Market<T>, outcome, evidence_hash, sig, clock,
  ctx)`
- `open_challenge<T>(&mut Market<T>, PositionProof, Coin<T>, evidence_hash,
  clock, ctx)`
- `submit_verdict<T>(&mut Market<T>, outcome, committee_sigs, clock, ctx)`
- `finalize<T>(&mut Market<T>, clock)`
- `claim<T>(&mut Market<T>, &mut Position<T>, ctx): Coin<T>`
- `refund<T>(&mut Market<T>, &mut Position<T>, ctx): Coin<T>`
- `withdraw_fees<T>(&mut Market<T>, &Config, ctx): Coin<T>`

### Move-enforced invariants

- Escrow conservation: coins leave only through claim, refund, or fee
  withdrawal.
- Lifecycle monotonicity: no transition returns to an earlier phase.
- O(1) settlement: no function iterates over all positions or participants.
- Invite correctness: invite market ID and grantee match the sender.
- Position correctness: position market ID and owner match the claim/refund
  caller.
- Single use: invites are consumed once; positions pay once.
- Deadline correctness: Sui `Clock` is the only time source.
- Outcome validity: only `YES`, `NO`, and `INVALID`.
- Fee cap: copied market fee is at or below deployment max.
- Challenge gate: only staked participants can challenge.
- Committee verdict: requires threshold distinct signatures from the committee
  set bound when the market was created.

### Fees and payouts

Fee is taken only on successful `YES`/`NO` settlement. Cancellation, expiry,
and `INVALID` refund original stake and take no protocol fee, except a
separately documented gas-reservation policy if later approved.

Winner payout:

```text
payout = payout_pool * position.shares / winning_shares_remaining
winning_shares_remaining -= position.shares
```

This gives the final winning claimer the rounding remainder and avoids loops.
All multiplication widens to `u128` before division.

### Events

Move emits enough events for the indexer to reconstruct state:

- `MarketCreated`
- `SubjectConsented`
- `MarketOpened`
- `InviteMinted`
- `PositionOpened`
- `MarketLocked`
- `AttestationSubmitted`
- `AttestationMismatch`
- `MatchedOutcome`
- `ChallengeOpened`
- `CommitteeVerdict`
- `MarketSettled`
- `MarketCancelled`
- `MarketExpired`
- `Claimed`
- `Refunded`
- `PolicyEpochBumped`
- `MemberAdded`
- `MemberRemoved`

## Privacy model

### Data classes

| Class | Examples | Readers | Storage |
| --- | --- | --- | --- |
| P0 public | sanitized market object, timings, aggregate pools, state | anyone | Sui and plaintext events |
| P1 participant | prompt, operationalization prose, comments, invite context | participants | Walrus encrypted with SEAL participant policy |
| P2 subject | subject handle mapping and consent details | subjects and policy-approved participants | Walrus encrypted with subject policy |
| P3 creator draft | unpublished drafts | creator | local or Walrus creator-only policy |
| P4 evidence | screenshots, statements, attestation evidence | subjects, resolver, committee during dispute, participants after configured disclosure | Walrus encrypted with evidence policy |

Walrus is public storage. It has durability and addressability, not private
reads. Privacy comes from client-side encryption and SEAL policy gating.

### SEAL policy identity

SEAL identity bytes are derived from:

```text
version || package_id || policy_kind || scope_id || policy_epoch || content_nonce
```

- `package_id`: deployed pairmarket Move package.
- `policy_kind`: participant, subject, creator, evidence, or draft.
- `scope_id`: market object ID for market content or user object ID for drafts.
- `policy_epoch`: bumped on membership removal or server-set rotation.
- `content_nonce`: random per blob.

Move exposes policy approval functions, one per policy family. Key servers run
the approval function against the caller address and requested identity before
releasing shares.

### Walrus envelope

Every encrypted blob uses a versioned envelope:

```text
PMBLOB v1
header:
  content_type
  policy_kind
  scope_id
  policy_epoch
  nonce
  alg
  created_at_ms
payload:
  AEAD ciphertext, with header bytes as AAD
```

The header is authenticated data so an attacker cannot relabel ciphertext
under a more permissive policy.

### Membership and revocation

`Market` stores membership with `joined_epoch` and optional `left_epoch`.
Approval for participant content requires:

```text
joined_epoch <= requested_epoch
and (left_epoch is none or left_epoch > requested_epoch)
```

Removing a member bumps `policy_epoch`. Revocation is forward-only. A removed
member may retain anything already decrypted or any old keys already cached.
The UX must say this plainly.

Late joiners do not get historical content by default. If product decides
otherwise, the creator must explicitly rewrap history under the new epoch.

### Accepted leakage

MVP accepts these leaks:

- Market object existence.
- Market timings and settlement state.
- Walrus blob existence and size.
- Participant wallet addresses once they redeem invites, unless the app adds
  an address abstraction later.
- Trade timing, stake size, and payout timing.
- SEAL key-server access logs visible to the key-server operators.
- Walrus fetch patterns visible to storage/network observers.
- Information participants screenshot and share outside the app.

Rejected launch claim: "No one can tell you bet on a side." That is false for
the MVP object model.

### Threat model

Defended:

- Non-invitee attempts to fetch private content: ciphertext only; no SEAL
  shares.
- Participant attempts to decrypt another policy class: policy kind and scope
  are bound into the key identity and AEAD header.
- Removed participant seeking future content: epoch bump denies future keys.
- Cross-market blob substitution: authenticated headers and digest checks.
- Backend bug confusing plaintext and ciphertext: branded types and runtime
  schemas reduce accidental misuse.

Partially defended:

- Compromised custodial backend: can sign and decrypt as users. Mitigations are
  policy-scoped signing, audit logs, key isolation, and migration off custody.
- Compromised minority of SEAL key servers: threshold scheme should prevent
  unilateral disclosure.
- Bad dispute committee: committee can settle challenged markets incorrectly.
  Mitigations are public verdict signatures, conflict rules, and replacement.

Not defended in MVP:

- Chain analysis of economic activity.
- Retroactive deletion of content already decrypted.
- Participant screenshots.
- Legal compulsion or majority compromise of SEAL key servers.
- Subject deanonymization from off-platform context.

## Custodial wallet design

### Identity and account model

Twitter OAuth yields a stable subject claim. The backend maps:

```text
TwitterSub -> UserId -> AccountOwner -> SuiAddress
```

`AccountOwner` is an indirection:

- `Custodial(KeyRef)` for MVP.
- `Migrating(from KeyRef, to SuiAddress)` during handoff.
- `SelfCustody(SuiAddress)` after migration.
- `Locked(reason)` during suspected takeover or support review.

The application never treats Twitter handle text as identity. Handles are
display metadata and may change.

### Key custody

MVP uses non-exportable signing keys behind opaque `KeyRef`s. The open
implementation question is the backend: cloud KMS/HSM, local HSM, or envelope
encryption. The design requirement is stable:

- raw private keys are never returned to app code,
- signing requires a typed intent and policy approval,
- every signing decision is auditable,
- backup/rotation is explicit,
- break-glass access is logged and rare.

### Signing flow

1. Web app asks backend to preview an action.
2. Backend builds a canonical `TxIntent`.
3. Wallet service policy engine checks session, risk, market scope, max spend,
   nonce, on-chain state, and intent type.
4. Wallet service signs a generated PTB template, not arbitrary caller bytes.
5. Backend submits and records digest.

Allowed intent kinds:

- create market
- consent as subject
- accept invite
- place wager
- submit attestation
- open challenge
- claim payout
- refund
- migrate custody

### Abuse resistance

- Rate limits for OAuth, market creation, invite creation, signing failures,
  sponsored gas, and decrypt requests.
- Spend caps for new accounts.
- Per-market max stake at invite and wallet policy layers.
- Risk locks for account takeover signals.
- No server-generated transaction may exceed the previewed amount or scope.
- Audit logs store intent metadata and digests, not plaintext private content.

### Recovery

Twitter re-authentication is sufficient for routine session recovery, not for
high-risk ownership transfer. Sensitive recovery has cooldowns and support
review. If Twitter is suspended or compromised, signing locks first; claims and
refunds are handled through a conservative support path.

### Migration off custody

Migration must not rewrite every market. The account indirection does the
work:

1. User authenticates and starts migration.
2. Target self-custody address signs a challenge.
3. Custodial key signs a handoff transaction.
4. Move records the new owner address or updates an owner object referenced by
   future policies.
5. Markets and SEAL membership use the new address for future approvals.

Existing positions remain claimable by the migrated owner. If a position is
address-owned and cannot be reassigned safely, the migration flow must claim or
transfer it through an explicit Move entry point during handoff.

## Type-system strategy

Use TypeScript in strict mode with branded and phantom types across frontend,
backend, and a shared `core/` workspace package. Move remains the authority for
on-chain invariants.

### Why TypeScript

- First-party Sui, Walrus, and SEAL SDKs are TypeScript-first.
- One language can cover web, backend, scripts, and shared primitives.
- The key host-language invariants are opaque IDs, capability possession,
  validation boundaries, and "ciphertext versus plaintext" state. Brands are a
  good fit.
- ML-family stacks would improve exhaustiveness but introduce SDK binding risk
  exactly where privacy and settlement integrations are most sensitive.

### Compile-time invariants

The `core/` package defines branded types for:

- `UserId`
- `TwitterSub`
- `SuiAddress`
- `MarketId`
- `InviteId`
- `PositionId`
- `WalrusBlobId`
- `SealPolicyId`
- `KeyRef`
- `TxIntent`
- `SignedIntent`
- `SubmittedIntent`
- `PolicyBound<T>`
- `SealCiphertext<T>`
- `Plaintext<T>`
- `InviteCap`
- `WagerCap`
- `ResolverCap`
- `CustodyCap`

Brands are minted only by parse/verify functions. A custom lint rule bans
casts to branded types outside those functions.

### Runtime invariants

Runtime schemas validate:

- HTTP request bodies.
- OAuth callback payloads.
- Sui RPC responses.
- Walrus envelope headers.
- SEAL key-share responses.
- Signed attestation and committee verdict formats.
- Transaction preview hashes before signing.

The recommended schema library is unresolved between zod, valibot, and io-ts;
ditz tracks that as `pm-types-runtime-schema-choice`.

### Move/protocol invariants

Move enforces escrow, ownership, lifecycle, deadlines, and payout authority.
Cryptographic protocols enforce signature authenticity, ciphertext integrity,
SEAL policy-bound key release, and Walrus content digest checks.

## Resolution mechanism

### MVP mechanism

Use subject co-attestation with a 72-hour challenge window.

- Both subjects must consent before trading.
- Both subjects must attest the same outcome.
- Matched attestation opens a challenge window.
- Any staked participant can challenge with a bond.
- A 3-of-5 dispute committee decides challenged markets.
- If the committee misses its hard deadline, the market resolves `INVALID` and
  refunds.

This is not maximally decentralized. It is the smallest mechanism that treats
relationship facts as private social facts rather than pretending an oracle can
observe them.

### Operationalization

MVP uses a closed enum:

- `LastsNDates(n)`
- `TogetherByDate(date)`
- `MeetByDate(date)`

Each kind defines valid outcomes, earliest attestation time, default deadline,
and UI copy. Free-form text is allowed as explanatory prose, but it is not the
contract-readable resolution rule.

### Consent

Subjects sign a payload containing:

- market ID,
- terms hash,
- operationalization kind and parameters,
- resolution deadline,
- challenge window,
- their role as subject,
- initial visibility rules.

If either subject declines, the market cancels before funds can enter.

### Attestation

Each attestation signs:

```text
market_id
attestation_round
outcome
evidence_blob_id
evidence_content_hash
nonce
```

Mismatched outcomes reset the attestation round and emit an event. Failure to
produce a matched attestation by the deadline expires the market and refunds.

### Challenge and dispute

Challenge bond is initially 3x median participant stake, bounded by config.
Only staked participants and the subjects can challenge. The dispute committee
receives evidence access only while the challenge is open. Verdict requires
threshold signatures from the committee set bound at market creation.

### Failure modes

- Subjects refuse to attest: deadline expiry refunds.
- Subjects collude: participants can challenge, but final integrity depends on
  committee quality.
- Committee disappears: hard timeout refunds.
- Participant spams challenges: bond makes spam expensive.
- Subject withdraws consent mid-market: market cancels and refunds. Ditz tracks
  whether a gas-reservation fee applies.

## Social graph and invitation boundary

MVP uses Twitter OAuth for identity and invite delivery, but should not depend
on scraping or continuously syncing the full Twitter graph.

Recommended MVP:

- Creator can invite specific Twitter users or pairmarket users they know.
- Backend records invite eligibility as an off-chain decision and Move enforces
  only redeemed invite tickets.
- Subject consent is mandatory and separate from creator/invitee graph.
- App discovery shows only markets a user was invited to, created, or is a
  subject of.
- Future graph expansion can import mutual-follow or contact evidence, but that
  is not required to make the market private.

Open design question `pm-social-graph-boundary` remains: what social proof is
strong enough for MVP admission control without overcollecting graph data.

## Alternatives considered

### Confidential on-chain positions

Rejected for MVP. It would require commit-reveal, zk proofs, confidential
execution, or a different settlement architecture. The product can launch if it
states the privacy boundary honestly: private content, not private economics.

### AMM or order book

Rejected for MVP. Private friend markets are small and sparse. Pari-mutuel
pools avoid liquidity provisioning, price-curve bugs, and tradable-position
privacy problems.

### Tradable positions

Rejected for MVP. Transferable positions complicate payout authority, invite
privacy, and subject bribery risk. Non-transferable `Position<T>` is simpler
and safer.

### Optimistic oracle

Deferred. It is plausible for v2 disputes, but relationship facts are private
and often known only by subjects. Subject co-attestation gives a better ground
truth source for launch.

### Third-party witness

Deferred. A designated friend referee creates a new bribery and consent
surface. It may work for specific market kinds later.

### LLM judge

Rejected. It is privacy-toxic, non-deterministic, and poorly aligned with
human relationship facts.

### ML-family host language

Rejected for MVP. ReScript/Reason/OCaml improve closed-sum exhaustiveness and
abstract types, but SDK binding risk outweighs the gain. If TypeScript brands
prove insufficient, extract `core/` to Rust/WASM after MVP rather than
rewriting the app in an ML dialect.

### Non-custodial from day one

Rejected for MVP friction. Twitter-to-wallet custody is a hard product
constraint. The design mitigates this by isolating custody behind `KeyRef` and
`AccountOwner`, not by pretending custody is harmless.

## Phasing

### Phase 0: design and scaffolding

- Land this design.
- Add Nix flake and pinned toolchain.
- Scaffold `contracts/`, `apps/web/`, `services/api/`, `services/wallet/`,
  `packages/core/`, and `docs/adr/`.
- Add basic CI for formatting, TypeScript, Move build/test, and docs lint.

Recommended toolchain pins as of 2026-06-27:

- Sui CLI: `mainnet-v1.73.2` for mainnet-compatible Move validation; optionally
  also test against `testnet-v1.74.0`.
- `@mysten/sui`: `2.20.1`.
- `@mysten/walrus`: `1.2.3`.
- `@mysten/seal`: `1.2.3`.
- TypeScript: `6.0.3`.
- pnpm: `11.9.0`.
- Node.js: current active LTS line in the Nix flake at scaffold time.

Re-check these pins before scaffolding; they are intentionally time-stamped.

### Phase 1: contract core

- Implement binary pari-mutuel `Market<T>`.
- Implement invite tickets, non-transferable positions, escrow, fees, claim,
  refund, cancellation, and events.
- Unit test lifecycle and arithmetic invariants.
- Property test escrow conservation and single-claim behavior.

### Phase 2: typed app core

- Implement branded primitives and runtime schemas.
- Add lint rule for brand minting.
- Define transaction intent types.
- Generate or hand-maintain Move object decoders.

### Phase 3: privacy path

- Implement Walrus envelope.
- Implement SEAL policy IDs and approval functions.
- Build decrypt/read path for participant content.
- Add policy epoch rotation.
- Document accepted leakage in product copy.

### Phase 4: custody path

- Implement Twitter OAuth.
- Create custodial wallet binding.
- Implement typed signing policy engine.
- Add gas sponsorship and rate limits.
- Add audit logs with no plaintext.

### Phase 5: resolution path

- Implement subject consent.
- Implement subject attestations.
- Implement challenge window and committee verdict.
- Implement encrypted evidence handling.
- Add UX for claim/refund.

### Phase 6: private beta

- Invite-only markets with known users.
- Manual dispute committee.
- Low stake caps.
- No public discovery.
- Collect resolution failure cases and privacy confusion.

### Phase 7: v2 candidates

- zkLogin or equivalent self-custody migration.
- Better subject bonds or reputation.
- Optimistic-oracle dispute replacement.
- Aggregated recommendations without individual position leakage.
- Confidential trading if product evidence says it is necessary.
- Mobile UX.

## Open issues

The design intentionally leaves some decisions tracked in ditz rather than
burying them in prose. Important open issues include:

- `pm-move-object-lifecycle`
- `pm-privacy-policy-model`
- `pm-custodial-wallet-interface`
- `pm-resolution-mechanism`
- `pm-type-system-strategy`
- `pm-social-graph-boundary`
- `pm-wallet-kms-hsm-choice`
- `pm-wallet-signing-policy-engine`
- `pm-wallet-twitter-recovery-risk`
- `pm-wallet-zklogin-migration`
- `pm-wallet-gas-sponsorship-limits`
- `pm-resolution-dispute-committee`
- `pm-resolution-kind-enum`
- `pm-privacy-key-server-set`
- `pm-privacy-trade-aggregation`
- `pm-types-brand-mint-lint`

## References

- `.planning/BRIEF.md`
- `.planning/subagents/move-object-model.md`
- `.planning/subagents/seal-walrus-privacy.md`
- `.planning/subagents/resolution.md`
- `.planning/subagents/type-system-strategy.md`
- `.planning/subagents/custodial-wallet.md`
- Sui release data checked via `gh release list --repo MystenLabs/sui` on
  2026-06-27.
- Package versions checked via `npm view` for `@mysten/sui`,
  `@mysten/walrus`, `@mysten/seal`, `typescript`, and `pnpm` on 2026-06-27.
