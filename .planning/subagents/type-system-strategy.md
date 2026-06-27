# Type-System Strategy Sketch

Subagent output. Scope: pick the host language for app + backend services
and specify which invariants live where. Not a final ADR - feeds into
docs/design.md and resolves ditz issue `pm-type-system-strategy`.

Adjacent issues this sketch touches but does not own: `pm-move-object-
lifecycle` (the Move side of every invariant table row marked
"Move-enforced"), `pm-privacy-policy-model` (SEAL/Walrus boundary),
`pm-custodial-wallet-interface` (custody state machine), and
`pm-social-graph-boundary` (invitation graph).

## Recommendation

Use **TypeScript in `strict` mode with nominal brand types** for the
frontend, the backend services, and a shared `core/` package of typed
primitives. Use **Move** for on-chain invariants. Use **io-ts (or zod
with branded outputs)** at every trust boundary so brand types are
*minted by validation*, never by `as` casts.

Reject OCaml / ReScript / Reason for the MVP, with the door left open to
extract a pure `core/` crate into Rust later if invariant pressure
exceeds what brands can carry. Rationale in section Alternatives.

The split below is the load-bearing claim of this sketch:

| Invariant | Enforced by |
|---|---|
| Object ownership, escrow custody, supply conservation, market phase transitions, payout authorization | **Move** |
| SEAL-ciphertext confidentiality; policy-key derivation; Walrus blob content-addressing; signed-intent authenticity | **Cryptographic / protocol** |
| ID namespacing; capability possession; ciphertext-vs-plaintext state; signed-vs-unsigned intent; draft-vs-finalized market in app code; custody-state phase; participant-set membership tag | **Compile-time (TS brands)** |
| Wire-format parsing at trust boundary; Sui object-state reconciliation; oracle/attestor signature verification; rate-limits and abuse heuristics | **Runtime (validated -> brand)** |

## Why TS over the ML family

- **SDK gravity.** Sui (`@mysten/sui`), Walrus (`@mysten/walrus`), and
  SEAL (`@mysten/seal`) ship first-class TS SDKs. ReScript bindings
  would be hand-rolled and lag every breaking change; OCaml bindings
  would be even further out. The brief's "privacy is load-bearing"
  cuts against using stale SDK shims for the exact components that
  enforce privacy.
- **One language across the stack.** Frontend (React/Next.js or
  Remix), backend (Node/Bun), and a `core/` package of branded
  primitives share types directly. ML choices either fragment the
  stack or force JS interop at the boundary that matters most.
- **Brands cover the invariants we actually need.** The pairmarket
  invariant set is "don't confuse one opaque handle for another and
  don't operate on a value before it's been validated." Brand /
  phantom types in TS handle that. We do not need GADTs, polymorphic
  variants, or row polymorphism to express the safety story; we need
  *minted-only* opaque types that survive across module boundaries.
- **Hiring + agent tooling.** TS is what subagents, code-review tools,
  and contributors are fluent in. ML choice taxes every future
  collaborator for marginal type-system gain over what brands give us.

What we lose by picking TS: exhaustive pattern matching on closed sums
is weaker than ML's; "make illegal states unrepresentable" requires
discipline (discriminated unions + `never` checks) rather than being
the default; structural typing leaks across modules unless we are
careful with brand exports. These are acceptable; they are not
existential for an invitation-only prediction market.

## `core/` package - interface sketch

All examples are illustrative TypeScript. The actual package will live
at `core/` (path to be confirmed in design doc).

### 1. IDs and handles

    // core/src/ids.ts
    declare const Brand: unique symbol;
    export type Brand<T, B> = T & { readonly [Brand]: B };

    export type UserId       = Brand<string, "UserId">;        // app-internal pseudonymous id
    export type TwitterSub   = Brand<string, "TwitterSub">;    // OAuth subject claim
    export type SuiAddress   = Brand<string, "SuiAddress">;    // 0x-prefixed, validated
    export type MarketId     = Brand<string, "MarketId">;      // Sui object id of Market<T>
    export type InviteId     = Brand<string, "InviteId">;      // off-chain invite handle
    export type WalrusBlobId = Brand<string, "WalrusBlobId">;  // content hash / CID
    export type SealPolicyId = Brand<string, "SealPolicyId">;  // policy identifier

    // Minted only via parse - never `as`.
    export function parseSuiAddress(s: string): SuiAddress { /* hex check, len, checksum */ }
    export function parseMarketId(s: string): MarketId     { /* 0x + 64 hex */ }

Brand symbols are `unique symbol` per-file so callers cannot fabricate
the brand. Re-exports must come from one canonical module per brand to
prevent definitional drift.

### 2. Capabilities

Capabilities are *unforgeable handles*: holding the value is proof of
permission. They model what the contract or the wallet service has
already authorized for this caller.

    // core/src/caps.ts
    export type InviteCap   = Brand<{ market: MarketId; invitee: UserId }, "InviteCap">;
    export type WagerCap    = Brand<{ market: MarketId; participant: UserId }, "WagerCap">;
    export type ResolverCap = Brand<{ market: MarketId },                   "ResolverCap">;
    export type CustodyCap  = Brand<{ user: UserId; scope: CustodyScope },  "CustodyCap">;

    export type CustodyScope =
      | { kind: "sign-tx"; market: MarketId; maxAmount: bigint }
      | { kind: "sign-attestation"; market: MarketId }
      | { kind: "rotate-key" };

A capability is minted by the only function authorized to mint it -
e.g. `mintWagerCap` lives in the same module as `verifyParticipantRow`
and never gets exported in raw form. Code that needs to call
`placeWager(cap, ...)` must hold a `WagerCap`; the type system refuses
to compile if it does not.

These are *app-layer* capabilities: they reflect a Move-enforced or
SEAL-enforced fact. The contract still re-checks on chain. Brands stop
honest mistakes from reaching the chain; Move stops dishonest ones.

### 3. Encrypted blobs and policy-bound access

The ciphertext / plaintext distinction is the most leaky invariant in
an SDK-driven codebase. Brand it.

    // core/src/blobs.ts
    export type SealCiphertext<T> = Brand<Uint8Array, ["SealCiphertext", T]>;
    export type Plaintext<T>      = Brand<T,          "Plaintext">;

    export interface PolicyBound<T> {
      readonly blob:   WalrusBlobId;
      readonly policy: SealPolicyId;
      readonly ct:     SealCiphertext<T>;
    }

    // Decryption requires presenting a derived key proven against the policy.
    // The key value is itself branded so it cannot be reused across policies.
    export type SealDerivedKey = Brand<Uint8Array, "SealDerivedKey">;

    export function decrypt<T>(
      pb: PolicyBound<T>,
      key: SealDerivedKey,
      schema: Schema<T>,
    ): Plaintext<T>;  // throws on auth/parse failure

The phantom `T` parameter is the *shape* of the plaintext (e.g. an
`OperationalizationDraft`). A `SealCiphertext<MarketBody>` cannot be
passed to a function expecting `SealCiphertext<InviteEnvelope>` even
though the runtime bytes look identical. This catches a real class of
bug: copy-pasting a decrypt call across blob kinds.

The cryptographic guarantee (confidentiality, integrity, policy
binding) is enforced by SEAL/Walrus. The brand only stops the host
code from *forgetting* which thing it is holding.

### 4. Custody state

Custody state should be a discriminated union, not a bag of nullable
fields. Brand the OAuth subject so it can never become a `string` again
without re-validation.

    // core/src/custody.ts
    export type CustodyState =
      | { kind: "anonymous" }
      | { kind: "awaiting-oauth"; nonce: Nonce }
      | { kind: "linked"; sub: TwitterSub; address: SuiAddress; keyRef: KeyRef }
      | { kind: "migrating-to-self"; from: KeyRef; to: SuiAddress; zkProof?: ZkLoginProof }
      | { kind: "self-custody"; address: SuiAddress };

    export type KeyRef    = Brand<string, "KeyRef">;    // HSM/KMS handle, never raw key
    export type Nonce     = Brand<string, "Nonce">;
    export type ZkLoginProof = Brand<Uint8Array, "ZkLoginProof">;

    export function authorize<T extends CustodyState["kind"]>(
      s: CustodyState, want: T,
    ): asserts s is Extract<CustodyState, { kind: T }>;

The `KeyRef` brand is the wedge for "design for the eventual migration
path": every signing path takes a `KeyRef`, not raw bytes, so the day
we move to zkLogin we change the resolver behind `KeyRef`, not every
caller. See `pm-custodial-wallet-interface`.

### 5. Transaction intents

Signing happens in three steps: build, sign, submit. Each step is a
distinct branded type so a half-finished intent cannot reach the
network.

    // core/src/tx.ts
    export type TxIntent      = Brand<{ kind: TxKind; payload: unknown }, "TxIntent">;
    export type SignedIntent  = Brand<{ intent: TxIntent; sig: Uint8Array }, "SignedIntent">;
    export type SubmittedIntent = Brand<{ digest: string }, "SubmittedIntent">;

    export type TxKind =
      | "create-market"
      | "accept-invite"
      | "place-wager"
      | "resolve-market"
      | "claim-payout";

    export function buildTx(spec: TxSpec): TxIntent;
    export function signTx(cap: CustodyCap, intent: TxIntent): SignedIntent;
    export function submitTx(s: SignedIntent): Promise<SubmittedIntent>;

`signTx` requires a `CustodyCap` whose `scope` matches the intent
kind; the type checker rejects calls that mix scopes. Signing logs the
`{ kind, market, maxAmount }` for the abuse-resistance story regardless
of whether the caller remembered to.

### 6. Validation boundary

Trust-boundary inputs (HTTP requests, Sui RPC responses, Walrus blob
metadata, SEAL policy responses) flow through `parse` functions that
return `Result<Branded, ParseError>`. *No* code path may mint a brand
without going through one of these.

    // core/src/parse.ts
    export type Schema<T> = (raw: unknown) => T;  // throws ParseError

    export const InviteEnvelope = (raw: unknown): InviteEnvelope => { /* zod */ };

The lint rule (custom eslint) bans `as` casts to any branded type; the
only escape hatch is `__BRAND_MINT__` inside a `parse*` function.

## What ML would buy and why it's not worth it here

A ReScript / OCaml stack would give us closed sums by default,
exhaustive matching as a compile error, and abstract types that cannot
be accidentally widened. In return we pay:

- Hand-maintained Sui/Walrus/SEAL bindings, lagging every SDK release
  on the privacy-critical path.
- A JS interop boundary in the middle of the wallet service, which is
  exactly where bugs are most expensive.
- Smaller contributor pool, weaker agent tooling, slower iteration on
  the design doc.

If, after the MVP, the privacy and resolution invariants outgrow
brands, the right move is to extract `core/` into a Rust crate compiled
to WASM (for browser) and reused on the server, not to rewrite the app
in ReScript. That decision belongs in a future ADR; see proposed ditz
issue below.

## Open questions to file as ditz issues

If `ditz add` fails (concurrent metadata write by another subagent),
the proposals below should be filed by the integrator.

- **pm-types-brand-mint-lint**: enforce "brands minted only via
  parse*" via a custom eslint rule. Component: tooling.
- **pm-types-core-package-layout**: confirm `core/` path, packaging
  (workspace package vs published), and which artifacts the frontend
  vs backend imports. Component: architecture.
- **pm-types-rescript-spike**: time-box a ReScript spike against the
  Sui SDK to validate or kill the ML option for real. Component:
  architecture. Blocks closure of `pm-type-system-strategy`.
- **pm-types-rust-core-extraction**: post-MVP, evaluate moving
  `core/` to a Rust crate (WASM + native) when invariant pressure
  exceeds brands. Component: architecture.
- **pm-types-runtime-schema-choice**: pick zod vs io-ts vs valibot
  for boundary parsing; criteria are bundle size, brand ergonomics,
  and error shape. Component: architecture.
- **pm-types-seal-key-handle**: confirm whether `SealDerivedKey` can
  remain opaque (HSM-held) end-to-end or must traverse app memory;
  affects whether the brand is sufficient. Component: privacy.
  Cross-refs `pm-privacy-policy-model`.
- **pm-types-custody-keyref-abstraction**: pin the `KeyRef` indirection
  so the zkLogin migration is a resolver swap, not a caller rewrite.
  Component: wallet. Cross-refs `pm-custodial-wallet-interface`.

## Status

Sketch only. Picks TS+brands as the working assumption so other
subagents (wallet, privacy, Move, resolution) can write APIs against
concrete primitives. Convergence to a final ADR happens in
`docs/design.md`.
