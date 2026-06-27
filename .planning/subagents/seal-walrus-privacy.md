# Subagent sketch: SEAL policy + Walrus ACL/content model

Scope: how private data is classified, encrypted, stored, addressed,
decrypted, rotated, and audited. MVP-opinionated. Sui Move enforces the
policy predicate; SEAL key servers evaluate it; Walrus stores ciphertext.

## 1. Background assumptions (call out if wrong)

- SEAL is threshold identity-based encryption keyed on a Move package's
  `seal_approve_*` function. The "policy" is the on-chain check the key
  servers run before releasing a key share. Anyone who can satisfy the
  predicate can decrypt.
- Walrus has no read ACL. Any blob id is publicly fetchable. Privacy is
  achieved entirely by encrypting before write. Walrus's on-chain `Blob`
  object controls write/extend/delete (ownership), not read.
- Both SEAL key-server selection and Walrus durability tier are
  operator choices, not user choices. The MVP picks one of each.

## 2. Private-data classes

Five classes, ranked by sensitivity. Each maps to a distinct policy
family so a bug in one does not collapse another.

| Class | Examples | Who reads | Storage |
|---|---|---|---|
| P0 Public | market title (sanitized), AMM curve params, total volume buckets | anyone | Sui state + plaintext Walrus |
| P1 Participant | full prompt, comments, per-trade memo | invited participants | Walrus + SEAL `participants` policy |
| P2 Subject | the names/handles of A and B if the operationalization references real people | participants AND subjects (if opted in); subjects-only if opted out of participation | Walrus + SEAL `subjects_or_participants` policy |
| P3 Creator-draft | unpublished market drafts | author | Walrus + SEAL `author_only` policy (or local-only pre-publish) |
| P4 Resolver-evidence | screenshots, self-report, attestor signature | resolver + creator + (later) participants on settle | Walrus + SEAL `resolver_then_participants` policy that flips at settle time |

Non-goal for MVP: hiding the participant set itself. The invitation
graph is on-chain (see leakage in section 8).

## 3. Policy-ID schema

A SEAL policy id is the tuple `(package_id, policy_kind, scope_id,
epoch)` serialized into the key identity. We bind it to Move objects:

```
package_id   = pairmarket package address (constant per deployment)
policy_kind  = u8 enum: PARTICIPANTS | SUBJECTS | AUTHOR | RESOLVER_THEN_P | DRAFT
scope_id     = address of the Move object that owns membership
               (Market.id for P1/P2/P4, User.id for P3)
epoch        = u32, bumped on every membership rotation (see s.7)
```

Identity bytes fed to SEAL: `0x01 || package_id || policy_kind ||
scope_id || epoch || content_nonce`.  `content_nonce` is a 16-byte
random per blob so two encryptions of the same plaintext yield distinct
ciphertexts.

Move side exposes one `seal_approve_*` per `policy_kind`. The key
server passes `(scope_id, epoch, caller)`; the Move function looks up
`Market` (or `User`) and checks the predicate at the requested epoch.

Rationale: keeping epoch inside the identity (not just inside the
predicate) means a removed member who cached a SEAL key share for
epoch N cannot use it against blobs encrypted at epoch N+1. Removal is
not retroactive but is at least forward-secret per epoch.

## 4. Walrus blob layout

Every encrypted blob is a versioned envelope:

```
PMBLOB v1
header (CBOR):
  v: 1
  ct: "text/markdown" | "image/png" | "application/json+pm.trade" | ...
  policy: { kind, scope_id, epoch }
  nonce: 16B
  alg: "seal-aes256-gcm-v1"
  created_at_ms: u64
payload:
  AES-256-GCM(key = SEAL-derived, aad = header bytes, plaintext)
```

`alg` is required so we can rotate ciphers without breaking old blobs.
`aad = header bytes` binds the policy fields to the ciphertext so a
malicious uploader cannot relabel a blob to a more permissive policy.

The Walrus `Blob` Move object is owned by the pairmarket package (not
the user) so the package can manage lifetime and refuse user-driven
deletion of evidence blobs. Cost is charged through the custodial
wallet.

On-chain reference: each Market stores typed handles, not raw blob ids:

```
struct EncryptedRef<phantom Class> has store, copy, drop {
  blob_id: vector<u8>,    // walrus blob id
  policy_epoch: u32,      // must match envelope.header.policy.epoch
  digest: vector<u8>,     // sha256 of ciphertext, for integrity
}
```

`phantom Class` is one of `P1Participant`, `P2Subject`,
`P4ResolverEvidence` - phantom-typed so Move functions cannot accept
an evidence blob where a comment blob is expected. Type-system load
bearing per the brief.

## 5. ACL change semantics

Membership lives in a `Table<address, MemberRecord>` on the Market.
`MemberRecord` records `joined_epoch` and (if removed) `left_epoch`.
The `seal_approve_participants` predicate is:

```
exists r in market.participants where r.addr == caller
  AND r.joined_epoch <= requested_epoch
  AND (r.left_epoch is none OR r.left_epoch > requested_epoch)
```

Effect:

- Adding a member: free. They can decrypt blobs at the current epoch
  and any past epoch they were a member of. To grant access to *new*
  members for *older* content, we do not rewrap; we extend their
  `joined_epoch` window only forward. Backfill access is an explicit
  product decision and an open question (see ditz proposal).
- Removing a member: bumps the Market's `current_epoch`. Future writes
  use the new epoch. Past blobs are still decryptable by the removed
  member if they cached the SEAL key share before removal. Treat
  removal as "they stop receiving new info," not "they forget."
- Subject opt-in/out (P2): handled by a separate `subjects` table on
  the Market, gated by signature from the subject's account. Until
  opt-in, the operationalization stored in P2 must use opaque ids
  (UUIDs minted by the creator) and the lookup table from id -> handle
  lives in a P2 blob the subject controls.

## 6. Decryption flow (client)

1. Client reads the Move `Market` object, gets `EncryptedRef`.
2. Fetch ciphertext blob from Walrus by `blob_id`. Verify `digest`.
3. Parse header. Verify `policy.scope_id == market.id` and `policy.epoch`
   is in the allowed set for this user.
4. Request `t`-of-`n` SEAL key shares from the key-server committee for
   identity `0x01 || package || kind || scope_id || epoch || nonce`.
   The key servers run the on-chain `seal_approve_*` predicate against
   the caller's wallet address.
5. Combine shares, derive content key via HKDF, AES-GCM-decrypt with
   `aad = header`.
6. On failure modes: integrity (bad digest/GCM tag) -> hard error and
   report to backend; authorization (key server refused) -> render as
   "no access" with epoch info; staleness (epoch mismatch) -> prompt to
   refresh Market state.

The custodial wallet performs steps 4-5 on behalf of Twitter-signed-in
users. zkLogin migration only changes who signs the SEAL key-share
request; the Move predicate is unchanged.

## 7. Rotation, revocation, lifetime

- **Rotation knob:** `Market.current_epoch`. Bumped by: membership
  removal, suspected key-server compromise, scheduled rollover (e.g.
  every N days for long-lived markets).
- **Per-blob freshness:** `content_nonce` ensures even same-epoch
  re-encrypts are distinct ciphertexts.
- **Revocation is not retroactive** by design; we do not claim
  otherwise in UX. The MVP shows "X was removed at epoch N; content
  written before N may still be readable by X."
- **Walrus blob lifetime:** funded by the package at write time for a
  fixed epoch count (Walrus's notion of epoch, separate from ours).
  Long-form content gets renewed by the backend cron; ephemeral blobs
  (chat messages over N days old) are not renewed. Deletion of the
  Walrus `Blob` object is package-only.
- **Key-server compromise response:** rotate to a new server set;
  bump `current_epoch` on every Market; do *not* attempt to delete
  Walrus blobs (deletion is not confidential since Walrus state is
  public).

## 8. Metadata leakage (the threats we accept)

These leak by design or by platform constraint; the design doc must say
so plainly.

- **Existence and size** of every blob (Walrus is public).
- **Participant set** of every market (Move object state).
- **Per-trade timing and size** on Sui. Position direction and
  approximate magnitude are derivable. Mitigation in MVP: bucketed
  volume display only; *no* on-chain mitigation. Tradeable-private
  mechanics are out of scope until v2.
- **Access patterns to SEAL key servers** reveal who decrypted what
  and when, to whoever runs the servers. MVP: trust the Mysten-operated
  set. v2: option to run our own threshold set.
- **Walrus access patterns** reveal who fetched which blob to whoever
  observes Walrus storage nodes.
- **Subject identity (P2)** leaks to anyone in the participant set;
  only opt-out hides it from non-subject participants.
- **Resolution evidence (P4)** becomes visible to all participants on
  settle; resolver must know this when uploading.

Out of scope for MVP: traffic-analysis defenses (mixnets, cover
traffic, batched trades).

## 9. Auditability

- Move emits `PolicyEpochBumped{ market, old_epoch, new_epoch, reason }`
  on every rotation.
- Move emits `MemberAdded` / `MemberRemoved` with the epoch.
- SEAL key servers (Mysten set) log per-request metadata; we do not
  control retention. We will not advertise SEAL access logs as a user-
  facing audit feature in MVP.
- Client-side decrypt failures are reported to the backend with the
  market id and failure reason for ops; this report path does *not*
  include plaintext or key material.

## 10. Threat model

Adversaries we defend against:

- **Honest-but-curious participant.** Sees what their policy grants;
  cannot escalate.
- **Malicious participant.** Tries to upload a blob labeled P1 that
  references a forged policy scope. Defeated by `aad`-binding of the
  policy header (s.4) and by Move requiring `EncryptedRef` writes to
  be performed by the package, not raw users.
- **Removed participant.** Loses forward access at the next epoch.
  Retains anything they cached. Documented.
- **Compromised custodial backend.** Has signing capability for every
  Twitter-bound user and can therefore decrypt every blob those users
  could. Mitigated only by minimizing backend storage of long-lived
  decrypted plaintext and by audit logging server-side decrypts. Real
  fix is zkLogin migration; flagged as a known-MVP risk.
- **Compromised single SEAL key server.** Threshold `t > n/2` prevents
  unilateral key disclosure. MVP: rely on Mysten-set threshold.
- **Compromised key-server majority.** Catastrophic; can decrypt
  everything ever encrypted to those servers. Response is
  re-encryption under a new server set going forward; past content is
  considered burned.
- **Chain observer.** Sees participant graphs, trade timing, payouts.
  Accepted (s.8).
- **Network observer.** Sees Walrus fetches and SEAL requests.
  Accepted in MVP; TLS only.

Adversaries we do not defend against in MVP:

- Subject-targeted deanonymization via combining public market metadata
  with off-platform context. (User education only.)
- A participant screenshotting and sharing P1/P2 content.
- Legal compulsion of Mysten / SEAL key servers.

## 11. Open questions (file as ditz if not duplicates)

Proposed ditz issues, all `pm-privacy-*`, component `privacy`. If
`ditz add` is contended, the proposals stay here as the record.

- `pm-privacy-key-server-set` - which SEAL key-server set for MVP?
  Mysten-operated default vs self-hosted threshold. Affects trust
  model (s.10) and auditability (s.9).
- `pm-privacy-backfill-access` - when a member is added mid-market,
  do they get to read history? Default proposal: no (consistent with
  s.5), but creator may opt to rewrap. Interface decision.
- `pm-privacy-subject-consent-flow` - exact UX and on-chain artifact
  for a subject opting in/out of P2 visibility, including markets
  created about subjects who never sign in.
- `pm-privacy-walrus-renewal-policy` - which blob classes get
  perpetual renewal vs TTL'd? Cost vs evidentiary value tradeoff.
- `pm-privacy-resolver-evidence-disclosure` - at settle, does P4 flip
  to all participants automatically, or only on creator opt-in? Affects
  the `RESOLVER_THEN_P` policy state machine.
- `pm-privacy-trade-aggregation` - accept on-chain trade leakage (s.8)
  for MVP or design a batching/commit-reveal mitigation now? Decision
  shapes whether `EncryptedRef<P1Participant>` extends to per-trade
  memos or only to chat/comments.
- `pm-privacy-custodial-decrypt-logging` - what does the backend log
  when it decrypts on a user's behalf, and who can read those logs?

## 12. What this sketch does not cover

- The Move object graph for Markets in detail - owned by the
  pm-move-object-lifecycle subagent. This sketch only requires that
  `Market` exposes `id`, `current_epoch`, `participants: Table<address,
  MemberRecord>`, optional `subjects: Table<address, ...>`, and a
  package-only `EncryptedRef` write path.
- The Twitter -> custodial-wallet keying - owned by
  pm-custodial-wallet-interface. This sketch assumes the wallet can
  sign a SEAL key-share request and that its Sui address is the
  `caller` SEAL passes to `seal_approve_*`.
- The social-graph definition of "who can be invited" - owned by
  pm-social-graph-boundary. This sketch treats membership as a given
  table on the Market.
- The resolution mechanism that decides when P4 evidence is sufficient
  - owned by pm-resolution-mechanism. This sketch only specifies that
  resolution events can bump the Market's policy state.
