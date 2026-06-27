# Custodial Wallet Interface Sketch

Integrator-authored fallback after the wallet subagent stalled. Scope: Twitter
sign-in to Sui signing authority, plus the migration path away from custody.

## MVP position

Use a custodial wallet service with non-exportable signing keys referenced by
opaque `KeyRef`s. Twitter OAuth binds a stable Twitter subject to an internal
`UserId`; the service creates one Sui address for that user and signs only
typed transaction intents that pass a policy engine.

The backend is trusted in MVP. It can sign for users and can request SEAL keys
for anything those users may decrypt. The design must be honest about that
risk and keep the API shaped so zkLogin or another user-held key path can
replace custodial signing later.

## Service boundary

- `POST /auth/twitter/start` returns an OAuth URL and CSRF nonce.
- `POST /auth/twitter/callback` validates OAuth, binds `TwitterSub`, creates
  or loads `User`, and ensures a custodial `WalletBinding`.
- `GET /me/wallet` returns `{ user_id, sui_address, custody_state }`.
- `POST /tx/intent` accepts a typed action request and returns a canonical
  transaction intent preview.
- `POST /tx/sign-and-submit` signs only a previously previewed intent whose
  scope, amount, market, and nonce still match policy.
- `POST /seal/decrypt` requests SEAL shares and decrypts on behalf of the user
  only when the user's wallet address satisfies the on-chain policy.
- `POST /custody/migrate/start` creates a migration challenge for a user-held
  address.
- `POST /custody/migrate/complete` finalizes account ownership migration after
  both the custodial key and the target key prove control.

## Data model

- `User { id, twitter_sub, twitter_handle_snapshot, status }`
- `WalletBinding { user_id, sui_address, custody_state, key_ref }`
- `CustodyState = custodial | migrating | self_custody | locked`
- `KeyRef`: non-exportable KMS/HSM handle, never raw key bytes.
- `Session { user_id, device_id, expires_at, risk_score }`
- `TxIntent { kind, market_id?, max_amount?, expires_at, nonce, preview_hash }`
- `AuditEvent { actor_user, key_ref, action, market_id?, decision, digest }`

## Signing policy

The service never signs arbitrary programmable transaction blocks. Callers
submit a typed intent:

- create market
- accept invite
- place wager
- attest resolution
- challenge resolution
- claim payout
- migrate custody

The policy engine validates that the user owns the wallet, the intent kind is
allowed, the market scope matches the session/capability, spend is under the
quoted max, the nonce is unused, and the on-chain market state still permits
the action. The resulting PTB is built server-side from templates.

## Abuse controls

- Per-user and per-IP rate limits on OAuth, invite creation, market creation,
  sponsored gas, and failed signing attempts.
- Spend caps per market and per day until the user has higher trust.
- Risk holds for account age anomalies, Twitter handle churn, impossible
  travel, and repeated failed OAuth callbacks.
- Locked wallets can still claim/refund through support-mediated recovery
  flows, but cannot create new risk.

## Recovery

Twitter is not a sufficient recovery root for high value. MVP recovery is:

1. Re-authenticate with the same Twitter subject.
2. Observe a cooldown for sensitive actions after recovery.
3. For account loss/suspension, use support-mediated recovery with an
   out-of-band social proof and a waiting period.
4. For suspected takeover, lock signing, preserve claim/refund ability through
   manual review, and rotate sessions.

The design must not promise cryptographic ownership while custody remains
server-side.

## Migration path

Every app-layer authorization points at `AccountOwner`, not "the backend key".
`AccountOwner` initially resolves to `Custodial(KeyRef)`. Migration creates a
new `SelfCustody(address)` owner after:

- the user authenticates with Twitter,
- the target address signs a migration challenge,
- the custodial key signs a final handoff transaction,
- Move records the replacement owner for future invites, attestations, and
  claims.

Existing market membership and positions continue to reference the Sui address
or an owner indirection object, not the Twitter handle. SEAL policy checks
therefore keep working after migration if the replacement address is recorded
in the market membership table.

## Open issues filed

- `pm-wallet-kms-hsm-choice`
- `pm-wallet-signing-policy-engine`
- `pm-wallet-twitter-recovery-risk`
- `pm-wallet-zklogin-migration`
- `pm-wallet-gas-sponsorship-limits`
