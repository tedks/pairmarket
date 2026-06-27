# ADR 0001 — Wallet service boundary: typed transaction intents

- Status: Proposed
- Date: 2026-06-27
- Tracks ditz: `pm-wallet-signing-policy-engine`
- Related: `pm-custodial-wallet-interface`, `pm-wallet-kms-hsm-choice`,
  `pm-wallet-zklogin-migration`, `pm-wallet-gas-sponsorship-limits`

## Context

The custodial wallet service signs Sui transactions on behalf of users
authenticated via Twitter OAuth. The design doc (Custodial wallet
design in [docs/design.md](../design.md)) and the integrator sketch
[`.planning/subagents/custodial-wallet.md`](../../.planning/subagents/custodial-wallet.md)
fix the high-level shape: a typed-intent API, a policy engine, no raw
PTB pass-through, and an `AccountOwner` indirection that survives
migration off custody.

This ADR pins the contract: the exact set of intents, what the policy
engine checks before signing, what the audit log records, and what it
is forbidden from recording. Reviewers need a single artifact to
point at when judging a wallet-service change.

The biggest risk this ADR mitigates is **silent expansion of the
backend's signing authority**. A custodial key can sign anything the
chain accepts. Without a tight type-level boundary, any future code
path that walks through the wallet service grows the implicit trust
the backend already holds. The decision below moves that boundary
into types and runtime schemas so growing it requires an explicit,
reviewable code change.

## Decision

### 1. The service signs typed intents, never bytes

The wallet API accepts `TxIntent` values describing *actions*. It
never accepts a serialized PTB from the caller. The wallet service
rebuilds the canonical PTB from server-side templates parameterized
by the intent.

`TxIntent` is a closed discriminated union. Adding a kind requires a
code change in three places — Move entry point, wallet-service
template, and TypeScript intent enum — by design.

```ts
// in packages/core (sketch; final file lands with the core scaffold)
export type TxIntent =
  | { kind: "create_market";          params: CreateMarketParams }
  | { kind: "record_subject_consent"; params: ConsentParams }
  | { kind: "mint_invite";            params: MintInviteParams }
  | { kind: "place";                  params: PlaceParams }
  | { kind: "submit_attestation";     params: AttestParams }
  | { kind: "open_challenge";         params: OpenChallengeParams }
  | { kind: "claim";                  params: ClaimParams }
  | { kind: "refund";                 params: RefundParams }
  | { kind: "migrate_custody";        params: MigrateCustodyParams };

export type TxIntentKind = TxIntent["kind"];

export interface IntentEnvelope<P> {
  user_id:       UserId;
  session_id:    SessionId;
  market_id:     MarketId | null;   // null only for migrate_custody / create_market
  max_amount:    MistAmount | null; // null for non-spending intents
  nonce:         Nonce;             // 16 random bytes; replay-checked under
                                    // (user_id, scope, nonce) where scope is
                                    // market_id or a sentinel for null
  expires_at_ms: TimestampMs;       // server enforces; <= 5 min after issue
  preview_hash:  PreviewHash;       // see §2 for what this actually defends
  params:        P;
}
```

Intent kinds map 1:1 to Move entry points in
[`docs/design.md`](../design.md) "On-chain design / Entry points":

| `TxIntent.kind`          | Move entry point          |
|--------------------------|---------------------------|
| `create_market`          | `create_market<T>`        |
| `record_subject_consent` | `record_subject_consent<T>` |
| `mint_invite`            | `mint_invite<T>`          |
| `place`                  | `place<T>`                |
| `submit_attestation`     | `submit_attestation<T>`   |
| `open_challenge`         | `open_challenge<T>`       |
| `claim`                  | `claim<T>`                |
| `refund`                 | `refund<T>`               |
| `migrate_custody`        | (see §6; lands in Move alongside the owner-indirection work in ditz `pm-move-owner-indirection`) |

The following Move entry points are **deliberately not signable** by
the custodial wallet service and use separate authority:

| Move entry point        | Authority                       | Rationale |
|-------------------------|---------------------------------|-----------|
| `lock<T>`               | keeper or any participant       | Time-driven lifecycle transition; not a user action requiring custodial spend authority. |
| `finalize<T>`           | keeper or any participant       | Same; "anyone finalizes after the window" per `docs/design.md:189`. |
| `submit_verdict<T>`     | committee multisig (`CommitteeCap`) | Committee seats are out-of-band keys, not Twitter-bound custodial users. If a committee seat is later held by a custodial user, that is a separate ADR. |
| `withdraw_fees<T>`      | ops (`AdminCap`)                | Ops action, not a user action. Handled by deployment tooling, not the wallet API. |

Subject *withdrawal* of consent mid-`Trading` is a known gap in
[`docs/design.md`](../design.md) — the lifecycle lists
`Cancelled` as a terminal state but does not name an entry point. A
follow-up ditz `pm-move-consent-withdrawal-entry-point` tracks
specifying that Move call and the corresponding `TxIntent.kind`
addition. Until then this is documented absence, not silent gap.

Per-intent `params` shapes are sketched in an appendix below. The
envelope is load-bearing; the params follow Move entry-point
signatures and are pinned in `packages/core` when scaffolded.

### 2. The policy engine: a single gate

For every `sign_and_submit(intent)` call the wallet service runs the
checks below in order. Any failure aborts before any key material is
touched. Each check produces a structured `RejectionReason` used in
audit events.

| # | Check                | Failure reason code         |
|---|----------------------|-----------------------------|
| 1 | Session validity     | `session_invalid`           |
| 2 | Ownership            | `key_not_owned`             |
| 3 | Intent kind allowed  | `unknown_intent_kind`       |
| 4 | Scope authority      | `out_of_scope`              |
| 5 | Atomic reservation: spend + nonce | `spend_cap_exceeded`, `nonce_replay` |
| 6 | On-chain precondition (advisory) | `state_not_permitted`  |
| 7 | Intent-record consistency        | `preview_hash_mismatch` |
| 8 | Risk / lock state    | `account_locked`            |

Specifics:

- **Session validity**: `session_id` is live, not revoked, within its
  idle and absolute timeouts. Step-up auth is required for the
  `high_risk` partition (`migrate_custody`; `create_market` when the
  account has signed fewer than `N_NEW_ACCOUNT_INTENTS` intents
  total, where `N_NEW_ACCOUNT_INTENTS` is a configured constant
  reviewed alongside spend caps).
- **Ownership**: the `AccountOwner` resolved from `user_id` is
  `Custodial(KeyRef)` and the `KeyRef` is the one we are about to
  sign with. Cross-user signing is impossible at the API surface
  because the API never receives a `KeyRef`; it is looked up from
  `user_id` inside the service.
- **Intent kind**: runtime schema rejects unknown kinds; the policy
  engine re-checks against the signing allowlist.
- **Scope authority**: if `market_id` is set, the user must be in the
  market's membership table at the current `policy_epoch` and hold
  the capability the intent implies (e.g. `place` requires an
  unredeemed `InviteCap`; `submit_attestation` requires `subject_a`
  or `subject_b`).
- **Atomic reservation: spend + nonce.** Spend caps and nonce
  freshness are *not* read-then-check; they are a single
  compare-and-insert transaction against a reservation table keyed
  on `(user_id, scope, nonce)`, where `scope` is `market_id` or a
  per-kind sentinel for the null-market intents
  (`migrate_custody`, `create_market`). The transaction
  conditionally decrements remaining daily-spend and per-market
  caps and inserts the nonce row in one step; failure of either
  condition aborts signing. The reservation row is committed to
  durable storage before any key material is touched, so two
  concurrent `sign_and_submit` calls cannot both pass.

  Compensation rule (asymmetric on purpose): on submit failure the
  **spend-cap decrement is released** by an idempotent compensating
  write keyed on `event_id` — the user did not actually spend.
  The **nonce row is NOT released**. A submit that fails locally
  may still confirm on-chain via validator delay, network retry, or
  an equivocating relayer, and releasing the nonce would let a
  duplicate sign produce a second submittable transaction with the
  same `(user, scope, nonce)`. Nonces are therefore single-use
  forever within their replay window regardless of submit outcome.
  The replay window is bounded by GC: nonce rows are retained for
  a window strictly greater than the envelope's
  `expires_at_ms` ceiling (currently 5 minutes) by a safety margin
  — the operational default is 24h. The relationship
  `gc_window > max(expires_at_ms - issued_at_ms) + clock_skew_budget`
  is what enforces safety, not the literal 24h.

  This replaces the prior wording's "freshness check"; that wording
  was a TOCTOU race.
- **On-chain precondition (advisory).** Fresh `getObject` on the
  relevant `Market<T>` confirms the lifecycle phase the intent
  assumes (e.g. `place` requires `Market.state == Trading`; `claim`
  requires `Settled` and a winning side that matches the position;
  `refund` requires `Cancelled | Expired | InvalidRefund`). The
  authoritative safety check is the Move entry point's own state
  assertion; this server-side check is defense-in-depth and UX (we
  refuse to sign known-bad transactions and tell the user to
  refresh). The fetched object version is included in the audit
  event so stale-read patterns are detectable after the fact. The
  ADR does not promise the signed PTB is bound to a specific object
  version; that would require an explicit
  `assert_object_version` argument in the Move call and is tracked
  separately as `pm-move-object-version-pinning`.
- **Intent-record consistency (`preview_hash`).** This check binds
  the `POST /tx/intent` server-side intent record to the
  `POST /tx/sign-and-submit` rebuild. The server canonicalizes the
  rebuilt PTB inputs into a `PreviewHash` and compares to the
  hash issued with the original preview. The check defends against
  intent records being rehydrated with wrong or stale parameters in
  multi-instance deployments and against bugs in the intent-storage
  layer; it does **not** defend against a malicious server quietly
  rebuilding a different PTB (both ends are the same code path) and
  it does **not** defend against UI tampering on its own. A
  client-derived preview hash that pins what the user actually saw
  is the right additional layer; tracked in
  `pm-types-client-preview-hash`. The current name is kept for
  continuity but the threat-model wording in earlier drafts was
  wrong.
- **Risk / lock state**: `AccountOwner` is not `Locked(reason)` and
  the session is not flagged `Risk(High)`. Exception: `claim` and
  `refund` remain available for `Locked` accounts via the
  support-mediated recovery path; refusing them would turn a soft
  lock into custody loss.

If all checks pass, the service builds the PTB, signs with the
non-exportable key behind `KeyRef`, submits, and records the audit
event below. On failure it records the same event with
`decision = Rejected { reason_code }` and returns a structured error.

### 3. KeyRef is opaque

`KeyRef` is a handle to a non-exportable key inside a KMS or HSM
(concrete backend tracked in `pm-wallet-kms-hsm-choice`):

- `KeyRef` carries no key material. Its serialized form is a backend
  handle (e.g. KMS ARN or HSM key id), nothing more.
- The wallet service exposes no API that returns raw private-key
  bytes. There is no export endpoint and the type system has no
  conversion from `KeyRef` to `Uint8Array`.
- Signing is performed inside the wallet-service process. The
  internal signing function accepts `(KeyRef,
  canonical_ptb_bytes) -> Signature` and delegates to the KMS/HSM
  SDK. The signature is the only thing that crosses back out.
- Audit search and joins MUST NOT key on `KeyRef` directly. They key
  on `key_ref_fpr = sha256(canonical_serialization(KeyRef))`. The
  fingerprint is stable enough for correlation and does not disclose
  the KMS/HSM handle or the underlying key, but it remains
  pseudonymous, sensitive metadata: it identifies a specific KMS
  resource and is sufficient to join across audit tables. Treat it
  as a personal identifier for access-control purposes; it is
  emphatically not "reveals nothing."

A lint rule (`pm-types-brand-mint-lint`) bans constructing `KeyRef`
outside the wallet-service `mintKeyRef()` factory.

### 4. Audit event schema

Every signing decision — accepted or rejected — emits exactly one
`SigningAuditEvent`. The schema is fixed by this ADR; new fields
require an ADR amendment.

```ts
export interface SigningAuditEvent {
  event_id: Ulid;
  ts_ms: TimestampMs;

  // identity
  user_id: UserId;
  key_ref_fpr: Sha256;                 // never the KeyRef itself;
                                       // pseudonymous sensitive metadata
  session_id: SessionId;
  account_owner_kind:
    | "custodial" | "migrating" | "self_custody" | "locked";

  // intent
  intent_kind: TxIntentKind;
  market_id: MarketId | null;
  max_amount: MistAmount | null;
  nonce: Nonce;                        // logged for replay-detection forensics;
                                       // expected unique within the 24h window
  preview_hash: PreviewHash;
  policy_version: PolicyVersion;       // bumps on policy-engine change

  // outcome
  decision:
    | { tag: "accepted"; tx_digest: TxDigest;
        on_chain_version: SequenceNumber }
    | { tag: "rejected"; reason_code: RejectionReason };

  // diagnostics (all derived, no plaintext)
  rebuilt_ptb_hash: Sha256;
  checks_elapsed_ms: u32;
  risk_score_at_decision: u16;
}
```

Schema invariant (enforced at construction): `decision.tag ==
"accepted"` implies `account_owner_kind != "locked"`. A locked
account that successfully signs is a contradiction in terms; reject
at the type/constructor boundary, not at audit-table read time.

`SigningAuditEvent` MUST NOT contain any of the following. These
exclusions are part of the schema, not advice:

- plaintext market content of any class (P1–P4),
- raw key material, KMS/HSM session tokens, or SEAL key shares,
- the `KeyRef` value itself (only its fingerprint),
- full PTB bytes (only their hash),
- the user's Twitter handle text — handles change and are not
  identity; `user_id` is the join key,
- request body fields beyond what is enumerated above.

`LoggableValue` carries part of this load — but only part. See
[ADR 0002 §3](0002-custodial-decrypt-logging.md) for the full
scope and limits of the type-level enforcement; the same machinery
covers signing-side logging. Briefly: the audit logger accepts only
`LoggableValue`, and `Plaintext<T>`, `Secret<T>`, `KeyRef`, and raw
PTB bytes are not `LoggableValue`. That keeps the audit table free
of plaintext. It does *not* close every log surface in the process
(stdout, OpenTelemetry attributes, error string interpolation);
those are governed by ESLint rules forbidding `console.*` and
`logger.info(${...})` patterns in the wallet/decrypt modules and by
code review at the module boundary.

### 5. Retention and access

- `SigningAuditEvent` retention: 365 days hot. After that, only
  per-(user, kind, decision) daily counts survive.
- Read access: ops + wallet-eng roles, with every read producing a
  meta-audit event. Break-glass requires two-person approval.
- Replication: write to two regions before acking the signing
  decision. A signing success that we cannot record is treated as an
  incident, not as a fast path.

Note on retention asymmetry with ADR 0002 (decrypt events at 180
days): signing events stay hot longer because the action they record
becomes public on Sui anyway — joining a settled-on-chain digest to
its signing event remains useful well past 180 days for incident
response, while a `DecryptAuditEvent` reveals what a user *read* and
is correspondingly more sensitive. The two retentions are
deliberately different and reviewed together each policy version.

### 6. Migration to self-custody

The signing boundary is one of two migration points. `AccountOwner`
is the **app-layer** indirection that lets the same intent flow
serve custodial and self-custody users:

```ts
export type AccountOwner =
  | { tag: "custodial";    key_ref: KeyRef }
  | { tag: "migrating";    from: KeyRef; to: SuiAddress }
  | { tag: "self_custody"; address: SuiAddress }
  | { tag: "locked";       reason: LockReason };
```

The intent and policy paths do not branch on owner kind until the
final dispatch step:

| AccountOwner       | Final dispatch                                                |
|--------------------|---------------------------------------------------------------|
| `custodial`        | Wallet service signs with `KeyRef`, submits, returns digest.  |
| `migrating`        | Same as `custodial`, plus `migrate_custody` is allowed.       |
| `self_custody`     | Wallet service returns the unsigned canonical PTB; browser signs. |
| `locked`           | Reject everything except `claim`/`refund` via support flow.   |

The policy-engine checks (1–8) are identical across owner kinds. We
do not weaken the boundary for self-custody users just because the
backend is no longer holding their key — same intent enum, same
scope checks, same audit log. The privacy posture stays honest as
the population migrates.

**What this does NOT do.** `docs/design.md` keys `Market.membership`
on `address` (Move object model, "Core fields") and treats
`Position<T>` as address-owned. SEAL `seal_approve_*` predicates
match `caller` against those address-keyed records. When a user's
controlling address changes during migration, the on-chain side
needs one of:

- (a) an explicit per-market Move transition that swaps the user's
  address in every `MemberRecord` they belong to and reassigns
  ownership of every address-owned `Position<T>` and unredeemed
  `InviteCap` they hold, or
- (b) a Move `OwnerIndirection` object that membership rows and
  position ownership refer to by identifier, so a single Move write
  switches the controlling address for all of the user's markets at
  once.

Option (a) is `O(markets-user-is-in)` Move transactions. Option (b)
is `O(1)` per user but requires a Move-side design that does not
exist yet in `docs/design.md`. The integrator's note at
`docs/design.md:546-548` already acknowledges that address-owned
positions may need an explicit transfer entry point at handoff.

This ADR therefore claims only:

- the **signing surface** does not need to be rewritten for
  migration (one intent enum, one policy engine, one audit schema
  serve both `Custodial` and `SelfCustody` `AccountOwner`s),
- the **Move side** needs concrete work that is tracked separately
  in ditz `pm-move-owner-indirection`. Until that lands, migration
  is a multi-step on-chain process per user, not a server-side
  config change. Implementers should size migration tooling
  accordingly.

### 7. Closed enum: kinds and partitions

| Kind                      | Partition  | Spends?     | Required Move state |
|---------------------------|------------|-------------|---------------------|
| `create_market`           | high_risk  | gas only    | `Config` not paused |
| `record_subject_consent`  | routine    | no          | `Proposed` |
| `mint_invite`             | routine    | gas only    | `Proposed \| Trading` and caller is creator |
| `place`                   | routine    | yes         | `Trading` |
| `submit_attestation`      | routine    | no          | `AttestationPending` and caller is `subject_a` or `subject_b` |
| `open_challenge`          | routine    | yes (bond)  | `ChallengeWindowOpen` |
| `claim`                   | routine    | no          | `Settled` |
| `refund`                  | routine    | no          | `Cancelled \| Expired \| InvalidRefund` |
| `migrate_custody`         | high_risk  | gas only    | owner not already `self_custody` (intended invariant; the Move call lands with `pm-move-owner-indirection`) |

Anything not in the table cannot be signed by the wallet service.
Move entry points that exist on-chain but are not in `TxIntent` are
enumerated in §1: `lock`, `finalize`, `submit_verdict`,
`withdraw_fees`. They use separate authority and are deliberately
outside the custodial signing surface.

## Consequences

Positive:

- Backend insiders cannot quietly broaden signing authority. New
  authority requires changes visible in code review across Move,
  service, and core packages.
- The audit log is small, structured, and free of plaintext, so it
  can be shared with on-call without becoming a second privacy
  channel.
- The policy engine does not depend on which key backs
  `AccountOwner`, so the *signing surface* does not need rewriting
  for a user migrating off custody. The Move-side rewrite required
  to swap the controlling address in membership/positions is
  separate work (see §6 and `pm-move-owner-indirection`).

Negative:

- Every new market mechanic costs a coordinated change in three
  packages. This friction is intentional but has a velocity cost.
- Storing every nonce for replay defense costs storage proportional
  to signing volume. Window cleanup older than 24h is required.
- Refusing to sign on stale on-chain reads will occasionally surface
  to users as "please reload the market" — a tradeoff against a
  silent race window.

Risks this ADR does *not* address:

- KMS/HSM compromise. Tracked in `pm-wallet-kms-hsm-choice`. The
  fingerprint-based audit indexing helps detect anomalous use; it
  does not prevent it.
- Twitter takeover. Tracked in `pm-wallet-twitter-recovery-risk`.
  This ADR only governs the signing surface once a session exists.

## Alternatives considered

- **Sign arbitrary PTBs after a "policy preflight".** Rejected. Any
  preflight that parses a caller-supplied PTB has to model every
  effect the call may have on every shared object; the model lags
  the Move package and the gap is exploitable. Rebuilding from
  templates is finite, auditable, and obviously correct.
- **Per-intent endpoints (`POST /tx/place` etc.) instead of one
  `/tx/sign`.** Workable but spreads the policy engine across many
  handlers. We keep one handler and one closed enum.
- **Store raw PTB bytes in the audit log.** Rejected. The hash is
  enough to correlate to submitted transactions, and the bytes can
  contain user-supplied opaque arguments we have no business
  retaining.

## Open questions

- KMS vs HSM vs envelope encryption — `pm-wallet-kms-hsm-choice`.
- Sponsored gas cap interaction with `max_amount` —
  `pm-wallet-gas-sponsorship-limits`.
- How `AccountOwner` resolution changes when zkLogin replaces the
  custodial branch — `pm-wallet-zklogin-migration`.
- Move-side owner indirection so migration is `O(1)` per user
  rather than `O(markets)` — `pm-move-owner-indirection`.
- Client-derived preview hash for a real UI-tampering defense —
  `pm-types-client-preview-hash`.
- Pinning the signed PTB to a specific on-chain object version —
  `pm-move-object-version-pinning`.
- Move entry point for subject withdrawing consent mid-`Trading` —
  `pm-move-consent-withdrawal-entry-point`.

## Appendix: per-intent param sketches

These shapes are sketches to make the surface concrete. They land
in `packages/core` alongside the Move entry-point signatures.

```ts
export interface CreateMarketParams {
  terms_hash: Sha256;
  encrypted_refs: {
    metadata: EncryptedRef<"P1Participant">;
    subject:  EncryptedRef<"P2Subject">;
  };
  subject_a: SuiAddress;
  subject_b: SuiAddress;
  timings: {
    close_ms:               TimestampMs;
    earliest_attest_ms:     TimestampMs;
    resolution_deadline_ms: TimestampMs;
    challenge_window_ms:    u32;
    dispute_deadline_ms:    TimestampMs;
  };
  fee_bps: u16;
  committee: SuiAddress[];
}

export interface PlaceParams {
  invite_cap_id: ObjectId;
  outcome:       "yes" | "no";
  amount:        MistAmount;   // <= envelope.max_amount
  coin_in:       ObjectId;     // Coin<T> selected by the wallet, not the caller
}

export interface MintInviteParams {
  grantee:    SuiAddress;
  max_stake:  MistAmount;
  expires_ms: TimestampMs;
}

export interface ClaimParams  { position_id: ObjectId; }
export interface RefundParams { position_id: ObjectId; }
```
