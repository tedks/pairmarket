/// <reference types="node" />

import { createHash, randomBytes } from "node:crypto";

import {
  parseKeyRef,
  parsePreviewHash,
  parseSha256,
  parseSuiAddress,
  parseTxDigest,
  toolchainPins,
  type AccountOwner,
  type AccountScopedTxKind,
  type CustodyCap,
  type CustodyScope,
  type KeyRef,
  type MarketId,
  type MarketScopedTxKind,
  type MistAmount,
  type PreviewHash,
  type SessionId,
  type Sha256,
  type SignedIntent,
  type SuiAddress,
  type TxDigest,
  type TxIntent,
  type TxKind,
  type UserId,
} from "@pairmarket/core";

export const walletScaffold = {
  service: "wallet",
  toolchainPins,
} as const;

export type LoggableScalar = string | number | boolean | null;
export type LoggableValue =
  | LoggableScalar
  | readonly LoggableValue[]
  | { readonly [key: string]: LoggableValue };

export type SigningRejectionReason =
  | "session_invalid"
  | "key_not_owned"
  | "unknown_intent_kind"
  | "out_of_scope"
  | "spend_cap_exceeded"
  | "account_locked"
  | "preview_hash_mismatch"
  | "sender_mismatch";

export type AccountOwnerKind = AccountOwner["kind"];

export type SigningAuditEvent = {
  readonly eventId: Sha256;
  readonly tsMs: number;
  readonly userId: UserId;
  readonly keyRefFingerprint: Sha256 | null;
  readonly sessionId: SessionId;
  readonly accountOwnerKind: AccountOwnerKind;
  readonly intentKind: TxKind;
  readonly marketId: MarketId | null;
  readonly maxAmountMist: string | null;
  readonly nonce: string;
  readonly previewHash: PreviewHash;
  readonly policyVersion: number;
  readonly decision:
    | {
        readonly tag: "accepted";
        readonly txDigest: TxDigest;
        readonly onChainVersion: number;
      }
    | { readonly tag: "rejected"; readonly reasonCode: SigningRejectionReason };
  readonly rebuiltPtbHash: Sha256;
  readonly checksElapsedMs: number;
  readonly riskScoreAtDecision: number;
};

export function auditSigningDecision(event: SigningAuditEvent): void {
  void (event satisfies LoggableValue);
}

export type CustodialAccount = {
  readonly userId: UserId;
  readonly address: SuiAddress;
  readonly owner: Extract<AccountOwner, { readonly kind: "custodial" }>;
};

export type PublicCustodialAccount = {
  readonly userId: UserId;
  readonly address: SuiAddress;
  readonly ownerKind: "custodial";
};

export type ProvisionCustodialAccountInput = {
  readonly userId: UserId;
};

export type RegisterSessionInput = {
  readonly userId: UserId;
  readonly sessionId: SessionId;
};

export type AccountSigningKind = AccountScopedTxKind | "migrate-custody";

export type AccountSigningGrant<TKind extends AccountSigningKind> = {
  readonly kind: "account";
  readonly userId: UserId;
  readonly txKind: TKind;
  readonly custodyCap: CustodyCap;
};

export type MarketSigningGrant<TKind extends MarketScopedTxKind> = {
  readonly kind: "market";
  readonly userId: UserId;
  readonly txKind: TKind;
  readonly marketId: MarketId;
  readonly maxAmountMist: MistAmount;
  readonly custodyCap: CustodyCap;
};

export type SigningGrantFor<TKind extends TxKind> =
  TKind extends MarketScopedTxKind
    ? MarketSigningGrant<TKind>
    : TKind extends AccountSigningKind
      ? AccountSigningGrant<TKind>
      : never;

export type SignPolicyGatedIntentRequest<TKind extends TxKind> = {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly intent: TxIntent<TKind>;
  readonly grant: SigningGrantFor<NoInfer<TKind>>;
  readonly previewHash: PreviewHash;
};

export type AcceptedSigningResult<TKind extends TxKind> = {
  readonly tag: "accepted";
  readonly signedIntent: SignedIntent<TKind>;
  readonly txDigest: TxDigest;
  readonly auditEvent: SigningAuditEvent;
};

export type RejectedSigningResult = {
  readonly tag: "rejected";
  readonly reason: SigningRejectionReason;
  readonly auditEvent: SigningAuditEvent;
};

export type SigningResult<TKind extends TxKind> =
  | AcceptedSigningResult<TKind>
  | RejectedSigningResult;

export interface WalletAuthPort {
  provisionCustodialAccount(
    input: ProvisionCustodialAccountInput,
  ): CustodialAccount;

  registerSession(input: RegisterSessionInput): void;

  publicAccount(account: CustodialAccount): PublicCustodialAccount;

  signPolicyGatedIntent<TKind extends TxKind>(
    request: SignPolicyGatedIntentRequest<TKind>,
  ): SigningResult<TKind>;
}

export type InMemoryWalletServiceOptions = {
  readonly nowMs?: () => number;
  readonly policyVersion?: number;
  readonly auditSink?: (event: SigningAuditEvent) => void;
  readonly keyRefFingerprintSalt?: string;
};

export function createInMemoryWalletService(
  options: InMemoryWalletServiceOptions = {},
): WalletAuthPort {
  const accounts = new Map<UserId, CustodialAccount>();
  const sessions = new Map<SessionId, UserId>();
  const nowMs = options.nowMs ?? Date.now;
  const policyVersion = options.policyVersion ?? 1;
  // Production should inject a stable deployment secret; random is the safer prototype default.
  const keyRefFingerprintSalt =
    options.keyRefFingerprintSalt ?? randomBytes(32).toString("hex");

  function provisionCustodialAccount(
    input: ProvisionCustodialAccountInput,
  ): CustodialAccount {
    const existing = accounts.get(input.userId);
    if (existing !== undefined) {
      return existing;
    }

    const account: CustodialAccount = {
      userId: input.userId,
      address: deterministicAddress(input.userId),
      owner: {
        kind: "custodial",
        keyRef: parseKeyRef(`prototype-kms:${input.userId}`),
      },
    };
    accounts.set(input.userId, account);
    return account;
  }

  function registerSession(input: RegisterSessionInput): void {
    if (!accounts.has(input.userId)) {
      throw new Error("Cannot register a session before provisioning account");
    }

    const existingOwner = sessions.get(input.sessionId);
    if (existingOwner !== undefined && existingOwner !== input.userId) {
      throw new Error("Cannot reassign session to a different user");
    }

    sessions.set(input.sessionId, input.userId);
  }

  function publicAccount(account: CustodialAccount): PublicCustodialAccount {
    return {
      userId: account.userId,
      address: account.address,
      ownerKind: "custodial",
    };
  }

  function signPolicyGatedIntent<TKind extends TxKind>(
    request: SignPolicyGatedIntentRequest<TKind>,
  ): SigningResult<TKind> {
    const startedAt = nowMs();
    const account = accounts.get(request.userId);
    const owner = account?.owner;
    const rejection = rejectByPolicy(
      request,
      account,
      sessions.get(request.sessionId),
    );
    const keyRef = owner?.kind === "custodial" ? owner.keyRef : null;

    if (rejection !== null) {
      const auditEvent = buildAuditEvent({
        request,
        keyRef,
        accountOwnerKind: owner?.kind ?? "locked",
        decision: { tag: "rejected", reasonCode: rejection },
        checksElapsedMs: elapsed(nowMs(), startedAt),
        policyVersion,
        tsMs: nowMs(),
        keyRefFingerprintSalt,
      });
      emitAudit(auditEvent, options.auditSink);
      return { tag: "rejected", reason: rejection, auditEvent };
    }

    const signedIntent = {
      intent: request.intent,
      signature: mockSignature(keyRef, request.intent),
    } as SignedIntent<TKind>;
    const txDigest = mockTxDigest(request.intent);
    const auditEvent = buildAuditEvent({
      request,
      keyRef,
      accountOwnerKind: "custodial",
      decision: { tag: "accepted", txDigest, onChainVersion: 1 },
      checksElapsedMs: elapsed(nowMs(), startedAt),
      policyVersion,
      tsMs: nowMs(),
      keyRefFingerprintSalt,
    });
    emitAudit(auditEvent, options.auditSink);
    return { tag: "accepted", signedIntent, txDigest, auditEvent };
  }

  return {
    provisionCustodialAccount,
    registerSession,
    publicAccount,
    signPolicyGatedIntent,
  };
}

function rejectByPolicy<TKind extends TxKind>(
  request: SignPolicyGatedIntentRequest<TKind>,
  account: CustodialAccount | undefined,
  sessionUserId: UserId | undefined,
): SigningRejectionReason | null {
  if (account === undefined || account.userId !== request.userId) {
    return "key_not_owned";
  }

  if (account.owner.kind !== "custodial") {
    return "account_locked";
  }

  if (sessionUserId !== request.userId) {
    return "session_invalid";
  }

  if (request.intent.sender !== account.address) {
    return "sender_mismatch";
  }

  if (request.previewHash !== previewHashForPrototype(request.intent)) {
    return "preview_hash_mismatch";
  }

  if (request.grant.userId !== request.userId) {
    return "out_of_scope";
  }

  if (request.grant.txKind !== request.intent.kind) {
    return "out_of_scope";
  }

  const capRejection = rejectByCustodyCap(request);
  if (capRejection !== null) {
    return capRejection;
  }

  if (request.grant.kind === "market") {
    const marketId = marketIdForIntent(request.intent);
    if (marketId === null || marketId !== request.grant.marketId) {
      return "out_of_scope";
    }

    const amount = spendingAmountForIntent(request.intent);
    if (amount !== null && amount > request.grant.maxAmountMist) {
      return "spend_cap_exceeded";
    }
  }

  if (
    request.grant.kind === "account" &&
    marketIdForIntent(request.intent) !== null
  ) {
    return "out_of_scope";
  }

  return null;
}

function rejectByCustodyCap<TKind extends TxKind>(
  request: SignPolicyGatedIntentRequest<TKind>,
): SigningRejectionReason | null {
  const cap = request.grant.custodyCap;
  if (cap.user !== request.userId) {
    return "key_not_owned";
  }

  if (request.grant.kind === "market") {
    const scope = cap.scope;
    if (!isMarketSigningScope(scope)) {
      return "out_of_scope";
    }

    const marketId = marketIdForIntent(request.intent);
    if (
      marketId === null ||
      scope.market !== marketId ||
      scope.market !== request.grant.marketId
    ) {
      return "out_of_scope";
    }

    if (!scope.txKinds.includes(request.intent.kind as MarketScopedTxKind)) {
      return "out_of_scope";
    }

    const amount = spendingAmountForIntent(request.intent);
    if (
      amount !== null &&
      (amount > request.grant.maxAmountMist || amount > scope.maxAmountMist)
    ) {
      return "spend_cap_exceeded";
    }

    return null;
  }

  const scope = cap.scope;
  if (request.grant.txKind === "migrate-custody") {
    return scope.kind === "migrate-custody" ? null : "out_of_scope";
  }

  if (!isAccountSigningScope(scope)) {
    return "out_of_scope";
  }

  return scope.txKinds.includes(request.intent.kind as AccountScopedTxKind)
    ? null
    : "out_of_scope";
}

function isMarketSigningScope(
  scope: CustodyScope,
): scope is Extract<CustodyScope, { readonly kind: "sign-market-tx" }> {
  return scope.kind === "sign-market-tx";
}

function isAccountSigningScope(
  scope: CustodyScope,
): scope is Extract<CustodyScope, { readonly kind: "sign-account-tx" }> {
  return scope.kind === "sign-account-tx";
}

function marketIdForIntent(intent: TxIntent): MarketId | null {
  switch (intent.kind) {
    case "create-market":
    case "migrate-custody":
      return null;
    case "consent-as-subject":
    case "accept-invite":
    case "place-wager":
    case "submit-attestation":
    case "open-challenge":
    case "claim-payout":
    case "refund":
      return intent.market;
  }
}

function spendingAmountForIntent(intent: TxIntent): MistAmount | null {
  switch (intent.kind) {
    case "place-wager":
      return intent.payload.amountMist;
    case "open-challenge":
      return intent.payload.bondMist;
    case "create-market":
    case "consent-as-subject":
    case "accept-invite":
    case "submit-attestation":
    case "claim-payout":
    case "refund":
    case "migrate-custody":
      return null;
  }
}

function buildAuditEvent<TKind extends TxKind>(input: {
  readonly request: SignPolicyGatedIntentRequest<TKind>;
  readonly keyRef: KeyRef | null;
  readonly accountOwnerKind: AccountOwnerKind;
  readonly decision: SigningAuditEvent["decision"];
  readonly checksElapsedMs: number;
  readonly policyVersion: number;
  readonly tsMs: number;
  readonly keyRefFingerprintSalt: string;
}): SigningAuditEvent {
  const amount = spendingAmountForIntent(input.request.intent);
  const rebuiltPtbHash = sha256(intentAuditMaterial(input.request.intent));
  return {
    eventId: sha256(
      [
        input.request.userId,
        input.request.sessionId,
        input.request.intent.nonce,
        rebuiltPtbHash,
        decisionAuditKey(input.decision),
      ].join(":"),
    ),
    tsMs: input.tsMs,
    userId: input.request.userId,
    keyRefFingerprint:
      input.keyRef === null
        ? null
        : keyRefFingerprint(input.keyRef, input.keyRefFingerprintSalt),
    sessionId: input.request.sessionId,
    accountOwnerKind: input.accountOwnerKind,
    intentKind: input.request.intent.kind,
    marketId: marketIdForIntent(input.request.intent),
    maxAmountMist: amount === null ? null : amount.toString(),
    nonce: input.request.intent.nonce,
    previewHash: input.request.previewHash,
    policyVersion: input.policyVersion,
    decision: input.decision,
    rebuiltPtbHash,
    checksElapsedMs: input.checksElapsedMs,
    riskScoreAtDecision: 0,
  };
}

function decisionAuditKey(decision: SigningAuditEvent["decision"]): string {
  return decision.tag === "rejected"
    ? `${decision.tag}:${decision.reasonCode}`
    : `${decision.tag}:${decision.txDigest}`;
}

function intentAuditMaterial(intent: TxIntent): string {
  return JSON.stringify(canonicalize(intent));
}

function deterministicAddress(userId: UserId): SuiAddress {
  return parseSuiAddress(`0x${hashHex(`address:${userId}`).slice(0, 64)}`);
}

function keyRefFingerprint(keyRef: KeyRef, salt: string): Sha256 {
  return sha256(`key-ref:${salt}:${keyRef}`);
}

function sha256(input: string): Sha256 {
  return parseSha256(hashHex(input));
}

function hashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function mockSignature(keyRef: KeyRef | null, intent: TxIntent): Uint8Array {
  const material = `${keyRef ?? "missing-key"}:${intentAuditMaterial(intent)}`;
  return createHash("sha256").update(material).digest();
}

function mockTxDigest(intent: TxIntent): TxDigest {
  const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digest = createHash("sha256")
    .update(`tx:${intentAuditMaterial(intent)}`)
    .digest();
  let out = "";

  for (let i = 0; i < 44; i += 1) {
    const byte = digest[i % digest.length];
    if (byte === undefined) {
      throw new Error("sha256 digest unexpectedly empty");
    }
    out += base58.charAt(byte % base58.length);
  }

  return parseTxDigest(out);
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, now - startedAt);
}

export function previewHashForPrototype(intent: TxIntent): PreviewHash {
  return parsePreviewHash(hashHex(`preview:${intentAuditMaterial(intent)}`));
}

function emitAudit(
  event: SigningAuditEvent,
  sink: ((event: SigningAuditEvent) => void) | undefined,
): void {
  auditSigningDecision(event);
  sink?.(event);
}

function canonicalize(value: unknown): LoggableValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === "object") {
    const result: Record<string, LoggableValue> = {};
    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record).sort()) {
      const field = record[key];
      if (field !== undefined) {
        result[key] = canonicalize(field);
      }
    }

    return result;
  }

  throw new TypeError("Intent audit material must be JSON-compatible");
}
