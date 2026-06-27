/// <reference types="node" />

import { createHash, randomUUID } from "node:crypto";

import {
  parseSessionId,
  parseUserId,
  toolchainPins,
  type SessionId,
  type TwitterSub,
  type TxIntent,
  type TxKind,
  type UserId,
} from "@pairmarket/core";
import {
  createInMemoryWalletService,
  type PublicCustodialAccount,
  type SignPolicyGatedIntentRequest,
  type SigningGrantFor,
  type SigningResult,
  type WalletAuthPort,
} from "@pairmarket/wallet";

export const apiScaffold = {
  service: "api",
  toolchainPins,
} as const;

export type PrototypeTwitterAssertion = {
  readonly sub: TwitterSub;
};

export type PrototypeSession = {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly account: PublicCustodialAccount;
};

export type PrototypeAuthApi = {
  readonly signInWithTwitter: (
    assertion: PrototypeTwitterAssertion,
  ) => PrototypeSession;
  readonly signPolicyGatedIntent: <TKind extends TxKind>(input: {
    readonly session: PrototypeSession;
    readonly intent: TxIntent<TKind>;
    readonly grant: SigningGrantFor<NoInfer<TKind>>;
    readonly previewHash: SignPolicyGatedIntentRequest<TKind>["previewHash"];
  }) => SigningResult<TKind>;
};

export type PrototypeAuthApiOptions = {
  readonly wallet?: WalletAuthPort;
};

export function createPrototypeAuthApi(
  options: PrototypeAuthApiOptions = {},
): PrototypeAuthApi {
  const wallet = options.wallet ?? createInMemoryWalletService();

  function signInWithTwitter(
    assertion: PrototypeTwitterAssertion,
  ): PrototypeSession {
    const userId = userIdFromTwitterSub(assertion.sub);
    const account = wallet.provisionCustodialAccount({ userId });
    const sessionId = sessionIdFromTwitterSub(assertion.sub);
    wallet.registerSession({ userId, sessionId });
    return {
      userId,
      sessionId,
      account: wallet.publicAccount(account),
    };
  }

  function signPolicyGatedIntent<TKind extends TxKind>(input: {
    readonly session: PrototypeSession;
    readonly intent: TxIntent<TKind>;
    readonly grant: SigningGrantFor<NoInfer<TKind>>;
    readonly previewHash: SignPolicyGatedIntentRequest<TKind>["previewHash"];
  }): SigningResult<TKind> {
    return wallet.signPolicyGatedIntent({
      userId: input.session.userId,
      sessionId: input.session.sessionId,
      intent: input.intent,
      grant: input.grant,
      previewHash: input.previewHash,
    });
  }

  return { signInWithTwitter, signPolicyGatedIntent };
}

function userIdFromTwitterSub(sub: TwitterSub): UserId {
  return parseUserId(sub.startsWith("twitter:") ? sub : `twitter:${sub}`);
}

function sessionIdFromTwitterSub(sub: TwitterSub): SessionId {
  return parseSessionId(
    createHash("sha256")
      .update(`session:${sub}:${randomUUID()}`)
      .digest("base64url"),
  );
}
