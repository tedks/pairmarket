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
  | { kind: "create_market";       params: CreateMarketParams }
  | { kind: "consent_as_subject";  params: ConsentParams }
  | { kind: "accept_invite";       params: AcceptInviteParams }
  | { kind: "place_wager";         params: PlaceWagerParams }
  | { kind: "submit_attestation";  params: AttestParams }
  | { kind: "open_challenge";      params: OpenChallengeParams }
  | { kind: "claim";               params: ClaimParams }
  | { kind: "refund";              params: RefundParams }
  | { kind: "migrate_custody";     params: MigrateCustodyParams };

export type TxIntentKind = TxIntent["kind"];

export interface IntentEnvelope<P> {
  user_id:       UserId;
  session_id:    SessionId;
  market_id:     MarketId | null;   // null only for migrate_custody / create_market
  max_amount:    MistAmount | null; // null for non-spending intents
  nonce:         Nonce;             // 16 random bytes, fresh per (user, market)
  expires_at_ms: TimestampMs;       // server enforces; <= 5 min after issue
  preview_hash:  PreviewHash;       // sha256 over canonicalized PTB inputs
  params:        P;
}
```

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
| 5 | Spend caps           | `spend_cap_exceeded`        |
| 6 | Nonce freshness      | `nonce_replay`              |
| 7 | On-chain precondition| `state_not_permitted`       |
| 8 | Preview-hash match   | `preview_hash_mismatch`     |
| 9 | Risk / lock state    | `account_locked`            |

Specifics:

- **Session validity**: `session_id` is live, not revoked, within its
  idle and absolute timeouts. Step-up auth is required for the
  `high_risk` partition (`migrate_custody`; `create_market` for
  new accounts).
- **Ownership**: the `AccountOwner` resolved from `user_id` is
  `Custodial(KeyRef)` and the `KeyRef` is the one we are about to
  sign with. Cross-user signing is impossible at the API surface
  because the API never receives a `KeyRef`; it is looked up from
  `user_id` inside the service.
- **Intent kind**: runtime schema rejects unknown kinds; the policy
  engine re-checks against the signing allowlist.
- **Scope authority**: if `market_id` is set, the user must be in the
  market's membership table at the current `policy_epoch` and hold
  the capability the intent implies (e.g. `place_wager` requires an
  unredeemed `InviteCap`; `submit_attestation` requires `subject_a`
  or `subject_b`).
- **Spend caps**: `intent.max_amount <= min(account_daily_cap,
  market_cap, per_intent_cap[kind])`. Sponsored gas is accounted
  separately and capped per `pm-wallet-gas-sponsorship-limits`.
- **Nonce freshness**: `(user_id, market_id, nonce)` not seen in the
  24h nonce window. Stored in a write-once table; we do not consult
  chain state for replay defense.
- **On-chain precondition**: fresh `getObject` on the relevant
  `Market<T>` confirms the lifecycle phase the intent assumes. For
  example, `place_wager` requires `Market.state == Trading`; `claim`
  requires `Market.state == Settled` and a winning side that matches
  the position; `refund` requires `Cancelled | Expired |
  InvalidRefund`. The fetched object version is included in the
  audit event so a stale read is visible after the fact.
- **Preview-hash match**: the caller supplies a `preview_hash` taken
  from `POST /tx/intent`. The signing endpoint recomputes the
  canonical hash from the just-rebuilt PTB inputs. Mismatch ⇒
  refuse; the user is shown the new preview and must re-confirm.
  This defends against UI tampering and against the server quietly
  rebuilding a different PTB.
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
  fingerprint is stable enough for correlation and reveals nothing
  about the key.

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
  key_ref_fpr: Sha256;                 // never the KeyRef itself
  session_id: SessionId;
  account_owner_kind:
    | "custodial" | "migrating" | "self_custody" | "locked";

  // intent
  intent_kind: TxIntentKind;
  market_id: MarketId | null;
  max_amount: MistAmount | null;
  nonce: Nonce;                        // public; collisions are the point
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

`SigningAuditEvent` MUST NOT contain any of the following. These
exclusions are part of the schema, not advice:

- plaintext market content of any class (P1–P4),
- raw key material, KMS/HSM session tokens, or SEAL key shares,
- the `KeyRef` value itself (only its fingerprint),
- full PTB bytes (only their hash),
- the user's Twitter handle text — handles change and are not
  identity; `user_id` is the join key,
- request body fields beyond what is enumerated above.

A `LoggableValue` trait in `packages/core` makes this enforceable: the
audit logger only accepts `LoggableValue`, and types holding any of
the above (`Plaintext<T>`, `Secret<T>`, `KeyRef`, raw PTB bytes) do
not implement it. Attempting to log them is a compile error, not a
runtime guard.

### 5. Retention and access

- `SigningAuditEvent` retention: 365 days hot. After that, only
  per-(user, kind, decision) daily counts survive.
- Read access: ops + wallet-eng roles, with every read producing a
  meta-audit event. Break-glass requires two-person approval.
- Replication: write to two regions before acking the signing
  decision. A signing success that we cannot record is treated as an
  incident, not as a fast path.

### 6. Migration to self-custody

The signing boundary is the migration point. `AccountOwner` is the
indirection that lets the same intent flow serve custodial and
self-custody users:

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

The policy-engine checks (1–9) are identical across owner kinds. We
do not weaken the boundary for self-custody users just because the
backend is no longer holding their key — same intent enum, same
scope checks, same audit log. The privacy posture stays honest as
the population migrates.

### 7. Closed enum: kinds and partitions

| Kind                 | Partition  | Spends?     | Required Move state |
|----------------------|------------|-------------|---------------------|
| `create_market`      | high_risk  | gas only    | `Config` not paused |
| `consent_as_subject` | routine    | no          | `Proposed` |
| `accept_invite`      | routine    | no          | `Trading` |
| `place_wager`        | routine    | yes         | `Trading` |
| `submit_attestation` | routine    | no          | `AttestationPending` |
| `open_challenge`     | routine    | yes (bond)  | `ChallengeWindowOpen` |
| `claim`              | routine    | no          | `Settled` |
| `refund`             | routine    | no          | `Cancelled \| Expired \| InvalidRefund` |
| `migrate_custody`    | high_risk  | gas only    | owner not already `self_custody` |

Anything not in the table cannot be signed by the wallet service.

## Consequences

Positive:

- Backend insiders cannot quietly broaden signing authority. New
  authority requires changes visible in code review across Move,
  service, and core packages.
- The audit log is small, structured, and free of plaintext, so it
  can be shared with on-call without becoming a second privacy
  channel.
- The policy engine does not depend on which key backs
  `AccountOwner`, so the day a user migrates off custody is a config
  flip, not a rewrite.

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
- **Per-intent endpoints (`POST /tx/place_wager` etc.) instead of one
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

export interface PlaceWagerParams {
  invite_cap_id: ObjectId;
  outcome:       "yes" | "no";
  amount:        MistAmount;   // <= envelope.max_amount
  coin_in:       ObjectId;     // Coin<T> selected by the wallet, not the caller
}

export interface ClaimParams  { position_id: ObjectId; }
export interface RefundParams { position_id: ObjectId; }
```
