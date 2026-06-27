# ADR 0003 — Custodial decrypt logging policy

- Status: Proposed
- Date: 2026-06-27
- Tracks ditz: `pm-privacy-custodial-decrypt-logging`
- Related: `pm-privacy-policy-model`, `pm-privacy-key-server-set`,
  `pm-privacy-resolver-evidence-disclosure`, ADR 0002

## Context

In MVP, Twitter-authenticated users do not hold a signing key in the
browser that satisfies the on-chain `seal_approve_*` predicates. The
custodial wallet service signs SEAL key-share requests on the user's
behalf and decrypts Walrus blobs in-process before returning the
plaintext to the web app over the user's authenticated session.

This makes the backend's decrypt capability the largest standing
privacy compromise in the system. The design doc names it explicitly
("Compromised custodial backend ... can sign and decrypt as users")
in the threat model section. The integrator sketch in
[`.planning/subagents/seal-walrus-privacy.md`](../../.planning/subagents/seal-walrus-privacy.md)
identifies the open question — what does the backend log when it
decrypts, who can read it, what is the retention — and this ADR
answers it.

Two failure modes drive the decision:

1. The logs themselves becoming a leak channel. A naive "log the
   request and response for debugging" wipes out the privacy of
   every blob a user has ever read.
2. Inability to detect abuse. Without structured per-decrypt records
   we cannot catch a compromised session, a rogue insider scripting
   bulk decrypts, or a buggy code path that decrypts more than it
   should.

The decision must keep both possibilities small without claiming
cryptographic privacy from a malicious operator. The custodial
backend will remain trusted in MVP; this ADR bounds the harm, it does
not eliminate it.

## Decision

### 1. Every server-side decrypt emits one `DecryptAuditEvent`

```ts
export interface DecryptAuditEvent {
  event_id: Ulid;
  ts_ms: TimestampMs;

  // identity
  user_id: UserId;
  session_id: SessionId;
  account_owner_kind: "custodial" | "migrating" | "self_custody" | "locked";

  // what was requested
  policy_kind: PolicyKind; // P1Participant | P2Subject | P3Draft
  // | P4Evidence
  policy_phase: PolicyPhase; // "n_a" for P1/P2/P3;
  // "pre_settle" | "post_settle" for P4
  scope_id: ObjectId; // raw Market or User object id;
  // see note below on why this is not hashed
  policy_epoch: u32;
  blob_id: WalrusBlobId; // public Walrus identifier
  ciphertext_digest: Sha256; // SHA-256 of the ciphertext envelope
  envelope_alg: EnvelopeAlg; // e.g. "seal-aes256-gcm-v1"

  // who answered
  seal_key_servers: KeyServerId[]; // committee members queried
  threshold: { t: u8; n: u8 };

  // outcome
  decision:
    | { tag: "granted" }
    | {
        tag: "refused";
        reason_code: DecryptRefusal;
        // one of: not_member | wrong_epoch | scope_mismatch
        //       | digest_mismatch | aad_mismatch | key_server_refused
        //       | rate_limited | account_locked
        //       | p4_pre_settle_non_resolver
      };

  // diagnostics
  request_origin: ApiRoute; // closed enum of caller endpoints
  duration_ms: u32;
  ciphertext_bytes: u32; // size in bytes; not content
  policy_version: PolicyVersion;
}
```

Schema invariants (enforced at construction):

- `decision.tag == "granted"` implies `account_owner_kind != "locked"`.
  A locked account cannot produce a successful decrypt.
- `policy_phase == "n_a"` iff `policy_kind` is `P1Participant`,
  `P2Subject`, or `P3Draft`. `P4Evidence` events MUST carry
  `pre_settle` or `post_settle`, taken from the market's lifecycle
  state at the moment of decrypt and committed to the audit row
  alongside the decrypt result. This is what makes the policy-flip
  auditable instead of collapsing both halves under one label.

Why `scope_id` is raw, not hashed (revised from the prior draft):
the Walrus envelope header carries `policy: { kind, scope_id,
epoch }` in the clear
(`.planning/subagents/seal-walrus-privacy.md:64-78`). Any log reader
who has `blob_id` can fetch the public ciphertext from Walrus and
read `scope_id` plain. An unsalted-hash in the log table therefore
adds operator friction without adversarial benefit, and gives the
false impression that joins to Sui require chain access. The
correct gate is the log-table access control (see §4), not field
hashing. If a future revision needs to break the join, use a keyed
PRF whose key lives in a separate trust zone — but that comes with
the cost of a resolver table and is not part of this ADR.

### 2. Prohibited log fields

These exclusions are part of the schema, not advice. The `DecryptAuditEvent`
type MUST NOT carry, and the audit logger MUST NOT accept, any of:

- plaintext bytes from the decrypted payload,
- excerpts, length-truncated previews, or summaries of plaintext,
- SEAL key shares (raw or combined),
- the derived AEAD content key,
- HKDF salts or other key-derivation intermediates,
- raw private signing key material of any kind,
- Twitter handle text — handles change and are not identity;
  `user_id` is the join key,
- any field of the SEAL request beyond what is enumerated above.

### 3. Implementation rules that make the prohibitions enforceable

The "shall not log plaintext" rule is the kind of rule that holds for
six months and then breaks at 3 AM. The architecture has to do the
work, not the policy text — but the architecture cannot do _all_ the
work in TypeScript. This section is precise about what the type
system catches and what falls to lint, code review, and module
boundaries.

What the type system catches:

- **The audit logger is the closed surface.** Its signature is
  `audit(event: SigningAuditEvent | DecryptAuditEvent): void`. Both
  shapes are themselves built from `LoggableValue`s — primitive
  IDs, enums, hashes, fixed-shape decision tags. Trying to put a
  `Plaintext<T>` or `Secret<KeyMaterial>` into either schema is a
  compile error because neither implements `LoggableValue`. This
  guarantees the **audit tables** stay free of plaintext and key
  material; it is the load-bearing claim, and it is enforceable in
  TypeScript.
- **`Plaintext<T>` is an opaque wrapper, not a brand on a string.**
  The shape is:

  ```ts
  export class Plaintext<T> {
    readonly #inner: T; // ECMAScript private, runtime-enforced
    private constructor(inner: T) {
      this.#inner = inner;
    }
    static of<T>(inner: T): Plaintext<T> {
      return new Plaintext(inner);
    }
    use<R>(f: (raw: T) => R): R {
      return f(this.#inner);
    }
    toJSON(): never {
      throw new TypeError("Plaintext is not JSON-serializable");
    }
    get [Symbol.toStringTag]() {
      return "Plaintext";
    }
  }
  ```

  The runtime guarantees rest on three TypeScript/ECMAScript
  semantics that the implementation MUST keep aligned:

  1. `#inner` is an ECMAScript private field (not TypeScript
     `private`). Runtime reflection — including `JSON.stringify`,
     `Object.keys`, bracket access, and structural destructuring
     — cannot reach it. `JSON.stringify` of a containing object
     calls `Plaintext.toJSON()`, which throws; this loudly fails
     attempts to serialize plaintext through any code path that
     uses `JSON.stringify` (most general-purpose loggers do).
     `JSON.stringify` directly on a `Plaintext` also throws.
  2. `Symbol.toStringTag` makes
     `Object.prototype.toString.call(pt)` and `String(pt)` return
     `"[object Plaintext]"` instead of the default
     `"[object Object]"`. Template-literal interpolation
     (`` `${pt}` ``) routes through `String()` and shows the tag,
     not the inner value.
  3. The only accessor is the `use` continuation. There is no
     `valueOf`, no `toString` returning `T`, and no public
     getter. The `use` callsite is the deliberately greppable
     escape hatch.

  These properties together close the most common accidental leak
  paths through the _general_ logger as well as the audit one. If
  the implementation drops `#inner` for TypeScript `private`, the
  guarantee silently disappears — TypeScript `private` is a
  compile-time check only, the runtime field is enumerable and
  `JSON.stringify` will emit it. Code review and the implementing
  package's tests MUST assert the runtime behavior, not just the
  type signature.

- **`Secret<KeyMaterial>` uses the same opaque-wrapper shape with
  the same ECMAScript-private discipline:**

  ```ts
  export class Secret<T> {
    readonly #inner: T;
    private constructor(inner: T) {
      this.#inner = inner;
    }
    static of<T>(inner: T): Secret<T> {
      return new Secret(inner);
    }
    use<R>(f: (raw: T) => R): R {
      return f(this.#inner);
    }
    toJSON(): never {
      throw new TypeError("Secret is not JSON-serializable");
    }
    get [Symbol.toStringTag]() {
      return "Secret";
    }
  }
  ```

  Same caveat: TypeScript `private` is not enough; the
  implementation MUST use the `#` private form, or the JSON
  serializer of a containing object will silently emit the key
  material.

What the type system does _not_ catch, and what carries the rest:

- `console.log(plaintextInstance)` will print `Plaintext {}` (good)
  but `console.log(plaintext.use(x => x))` extracts and prints the
  raw value (bad). The `use` continuation is the only escape hatch,
  and it is deliberately syntactically heavy so that uses of it are
  greppable. An ESLint rule in the wallet/decrypt module
  (`pm-types-no-plaintext-use-outside-response`) restricts
  `.use(...)` to call sites within the response-serializer module.
- `console.*`, `logger.info`, and other free-form text loggers are
  not gated by `LoggableValue`. An ESLint rule in the
  wallet/decrypt module bans those entirely; the only loggers
  permitted are the typed `audit()` function and a `diag()`
  function whose signature also takes `LoggableValue` only.
- OpenTelemetry span attributes, structured-error fields, and
  process stdout in third-party libraries can all be leakage
  surfaces. The decrypt module wraps third-party SDK calls so they
  only receive `LoggableValue` arguments, and span-attribute setters
  are typed against the same trait.

Error paths in the decrypt module use `Result<Plaintext<T>,
DecryptError>`. `DecryptError` is `Display`-safe and carries only
enum-shaped failure data; it never contains plaintext or key
material. Stack traces are scrubbed of any captured locals before
they leave the process.

`Plaintext<T>` lifetime: a `Plaintext<T>` is created at decrypt
time, lives only on the request scope, and is consumed exactly once
by the response serializer via `.use()`. After serialization the
buffer is overwritten where the runtime permits. The wording in
earlier drafts ("dropped before the response handler returns") was
imprecise — the plaintext is consumed _by_ the response handler so
the response body can be sent; it is not retained past that point
in any service-side state.

### 4. Retention and access

- `DecryptAuditEvent` retention: 180 days hot. After 180 days, only
  daily aggregates per `(user_id, policy_kind, policy_phase,
decision)` survive.
- Read access (hot): privacy-eng + ops on-call. Every read is itself
  recorded as a `LogAccessEvent` with the requesting operator id.
  Break-glass requires two-person approval.
- Read access (aggregates): same roles; used for rate alerting.
- Replication: write to two regions before the decrypt response is
  returned. A decrypt success that we cannot record is treated as
  an incident; we do not silently degrade to "decrypt without
  logging".

Retention rationale and the asymmetry with ADR 0002 (signing events
at 365 days): decrypt events record what a user _read_ of private
content and are more sensitive than the corresponding signing
events, which record actions that become public on Sui anyway.
Shorter retention reduces the harm surface of an internal log
breach. The two retentions are deliberately different and reviewed
together each `policy_version` bump; if a future incident class
requires the cross-table join past 180 days, that revision lands in
both ADRs at once.

### 5. User-facing disclosure

Product copy in the consent surface must say, in user terms:

> While you are signed in with Twitter, our servers can read messages
> you can read. We log when this happens so we can detect misuse.
> We do not log the message content.

The self-serve "Decrypt history" view shows the user's own
`DecryptAuditEvent`s with the following fields:

- timestamp,
- policy kind ("Market chat", "Subject info", "Evidence", "Draft"),
- which market (resolved from `scope_id`),
- whether the request was granted or refused, with a friendly
  reason.

It deliberately omits `seal_key_servers`, `threshold`, `policy_version`,
and `duration_ms` — those are operational, not user-relevant, and
including them gives a targeted observer a fingerprinting surface.
Even with those fields hidden, the market resolution in the
history view is itself fingerprintable if the user shares a
screenshot, so the view is a sensitive route with step-up auth on
its own.

### 6. Abuse signals (derived, not raw)

Computed from `DecryptAuditEvent`s in a streaming pipeline. "Baseline"
means a per-user exponentially weighted moving average of decrypt
rate over a configurable window (default 7-day half-life), recomputed
nightly; the alert fires when the current window's rate exceeds the
baseline by a configurable factor.

- decrypts/min per user above baseline,
- decrypts against markets where Move shows no membership for the
  user at the current `policy_epoch` (membership table check vs
  decrypt target),
- **`P4Evidence` decrypts where `policy_phase == "pre_settle"` and
  the user is not in the resolver/committee set** — this is the
  case where the policy_phase field pays its rent; it is also a
  refusal reason (`p4_pre_settle_non_resolver`) at request time,
  but if a refusal stream spikes the same signal flags it,
- decrypts during sessions tagged `Risk(High)`,
- ratio of `refused` decisions per session above a threshold,
- decrypts under operator break-glass after a meta-audit read.

Each signal can auto-lock the account (`AccountOwner = Locked`),
which routes through the soft-lock behavior in ADR 0002.

### 7. zkLogin migration removes the backend from the path

Once a user holds a key in-browser that satisfies `seal_approve_*`,
the SEAL key-share request is signed client-side and the backend is
not in the decrypt loop. From that point the user's `decrypts`
table stops growing because the backend has no operations to record.

The implication is that this ADR is the privacy backstop _until_
migration, and the rate of `DecryptAuditEvent`s after a population
migrates to self-custody is itself an indicator: if it is not
falling, something is calling the custodial decrypt path that
should not be.

## Consequences

Positive:

- The audit log can be shared with on-call without becoming a
  second privacy channel; it carries no content.
- The compile-time `LoggableValue` bound makes the "no plaintext in
  the audit table" rule architectural, not aspirational. The
  opaque-wrapper shape of `Plaintext<T>` and `Secret<T>` extends
  most of that guarantee to general-purpose loggers; ESLint rules
  and module boundaries cover the remainder (see §3).
- Users can see what the backend decrypted on their behalf without
  having to trust the operator's word.

Negative:

- The backend retains read-equivalent access for any signed-in user.
  No amount of log discipline turns custodial decryption into
  cryptographic privacy. Product copy must keep saying this.
- Per-decrypt audit events at full Walrus blob volume could be the
  dominant write rate; we pay for two-region replication on the
  hot path.
- "Show my decrypt history" is itself a targeting surface — an
  attacker who already controls a session can read the user's
  history. Mitigated by treating that view as a sensitive route
  with step-up.

## Alternatives considered

- **No per-decrypt logging.** Rejected. We lose detection entirely
  and cannot answer "did the breach include this user's content?"
  after an incident.
- **Log plaintext length as a debugging signal.** Rejected. Length
  is already approximated by ciphertext size; logging plaintext
  length leaks the AEAD overhead constant, which is fine, but
  invites mission creep into "log a hash of plaintext", which then
  invites "log the first N bytes". The schema is closed.
- **Log SEAL combined key for debugging.** Rejected outright; that
  is the key. Debugging the share-combination logic uses synthetic
  test data and key servers, not production decrypts.
- **Wait for zkLogin and skip the audit table.** Rejected.
  zkLogin migration is staged over months; we cannot operate the
  custodial decrypt path in MVP without detection.

## Open questions

- Which SEAL key-server set is queried, and how is it identified in
  `seal_key_servers` — `pm-privacy-key-server-set`.
- Exact `P4Evidence` policy-flip semantics at settlement — what
  triggers the `pre_settle` → `post_settle` transition, and how a
  late-arriving challenge re-opens the pre-settle phase —
  `pm-privacy-resolver-evidence-disclosure`. The schema in §1
  records the phase but the lifecycle rules belong in that ticket.
- Whether the "Decrypt history" view needs an additional
  fingerprinting defense beyond step-up auth — tracked in
  `pm-privacy-decrypt-history-fingerprinting`.

(Resolved in this ADR: `scope_id` hashing is dropped in favour of
log-table access controls; see the note in §1.)
