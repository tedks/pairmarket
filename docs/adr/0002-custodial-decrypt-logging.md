# ADR 0002 — Custodial decrypt logging policy

- Status: Proposed
- Date: 2026-06-27
- Tracks ditz: `pm-privacy-custodial-decrypt-logging`
- Related: `pm-privacy-policy-model`, `pm-privacy-key-server-set`,
  `pm-privacy-resolver-evidence-disclosure`, ADR 0001

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
  account_owner_kind:
    | "custodial" | "migrating" | "self_custody" | "locked";

  // what was requested
  policy_kind: PolicyKind;   // P1Participant | P2Subject | P3Draft
                             // | P4Evidence
  scope_id: Sha256;          // hashed Market or User object id
  policy_epoch: u32;
  blob_id: WalrusBlobId;     // public Walrus identifier
  ciphertext_digest: Sha256; // SHA-256 of the ciphertext envelope
  envelope_alg: EnvelopeAlg; // e.g. "seal-aes256-gcm-v1"

  // who answered
  seal_key_servers: KeyServerId[]; // committee members queried
  threshold: { t: u8; n: u8 };

  // outcome
  decision:
    | { tag: "granted" }
    | { tag: "refused";
        reason_code: DecryptRefusal;
        // one of: not_member | wrong_epoch | scope_mismatch
        //       | digest_mismatch | aad_mismatch | key_server_refused
        //       | rate_limited | account_locked
      };

  // diagnostics
  request_origin: ApiRoute;        // closed enum of caller endpoints
  duration_ms: u32;
  ciphertext_bytes: u32;           // size in bytes; not content
  policy_version: PolicyVersion;
}
```

The `scope_id` is the SHA-256 of the on-chain object id, not the raw
id. The raw id is public on Sui, but hashing in the log keeps the log
table from being trivially joinable to other Sui data by an
unprivileged log reader. Operators with chain access can still
correlate when they need to.

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
work, not the policy text.

- The decrypt code path returns `Plaintext<T>` (a branded type from
  `packages/core`). The audit logger accepts only a `LoggableValue`
  bound. `Plaintext<T>` does not implement `LoggableValue`. Passing
  one to the logger is a compile error.
- The HKDF output and the AEAD content key are wrapped in
  `Secret<KeyMaterial>`. Its `toString` returns `"<redacted>"`; its
  JSON serializer throws. Tracing/span attribute APIs accept only
  `LoggableValue`, which `Secret` likewise does not implement.
- `Plaintext<T>` lives only on the request scope. It is not written
  to disk, queue, or trace span attribute. It is dropped before the
  response handler returns; the linter forbids capturing it in a
  closure that outlives the request.
- Error paths in the decrypt module use `Result<Plaintext<T>,
  DecryptError>`. `DecryptError` is `Display`-safe and carries only
  enum-shaped failure data; it never contains plaintext or key
  material. Stack traces are scrubbed of any captured locals before
  they leave the process.

### 4. Retention and access

- `DecryptAuditEvent` retention: 180 days hot. After 180 days, only
  daily aggregates per `(user_id, policy_kind, decision)` survive.
- Read access (hot): privacy-eng + ops on-call. Every read is itself
  recorded as a `LogAccessEvent` with the requesting operator id.
  Break-glass requires two-person approval.
- Read access (aggregates): same roles; used for rate alerting.
- Replication: write to two regions before the decrypt response is
  returned. A decrypt success that we cannot record is treated as
  an incident; we do not silently degrade to "decrypt without
  logging".

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

### 6. Abuse signals (derived, not raw)

Computed from `DecryptAuditEvent`s in a streaming pipeline:

- decrypts/min per user above baseline,
- decrypts against markets where Move shows no interaction by the
  user (membership table check vs decrypt target),
- decrypts during sessions tagged `Risk(High)`,
- ratio of `refused` decisions per session above a threshold,
- decrypts under operator break-glass after a meta-audit read.

Each signal can auto-lock the account (`AccountOwner = Locked`),
which routes through the soft-lock behavior in ADR 0001.

### 7. zkLogin migration removes the backend from the path

Once a user holds a key in-browser that satisfies `seal_approve_*`,
the SEAL key-share request is signed client-side and the backend is
not in the decrypt loop. From that point the user's `decrypts`
table stops growing because the backend has no operations to record.

The implication is that this ADR is the privacy backstop *until*
migration, and the rate of `DecryptAuditEvent`s after a population
migrates to self-custody is itself an indicator: if it is not
falling, something is calling the custodial decrypt path that
should not be.

## Consequences

Positive:

- The audit log can be shared with on-call without becoming a
  second privacy channel; it carries no content.
- The compile-time `LoggableValue` bound makes the "no plaintext
  logging" rule architectural, not aspirational.
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
- How `P4Evidence` access is logged when the policy flips at
  settlement — `pm-privacy-resolver-evidence-disclosure`.
- Whether `scope_id` hashing in the log is worth the operator
  inconvenience; alternative is plain object ids gated by stricter
  log-read controls.
