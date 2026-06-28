import {
  parseNonce,
  parseSessionId,
  parseSuiAddress,
  parseTwitterSub,
  userIdFromTwitterSub,
  type Nonce,
  type PublicAccountOwner,
  type SessionId,
  type SuiAddress,
  type TwitterSub,
  type UserId,
} from "@pairmarket/core";
import type { UserProfile } from "../types.ts";

export type TwitterCustodyChallenge = {
  readonly nonce: Nonce;
  readonly profile: UserProfile;
};

export type TwitterCustodySession = {
  readonly sub: TwitterSub;
  readonly userId: UserId;
  readonly sessionId: SessionId;
  readonly address: SuiAddress;
  readonly owner: Extract<PublicAccountOwner, { readonly kind: "custodial" }>;
};

export interface TwitterCustodyClient {
  beginSignIn(profile: UserProfile): TwitterCustodyChallenge;
  completeSignIn(
    challenge: TwitterCustodyChallenge,
  ): Promise<TwitterCustodySession>;
}

export function createPrototypeTwitterCustodyClient(): TwitterCustodyClient {
  return {
    beginSignIn(profile) {
      return {
        nonce: randomNonce("twitter_oauth"),
        profile,
      };
    },
    async completeSignIn(challenge) {
      const sub = twitterSubForProfile(challenge.profile);
      return {
        sub,
        userId: userIdFromTwitterSub(sub),
        sessionId: randomSessionId("twitter_session"),
        // Prototype fixtures include the public account address. Production
        // custody will return the provisioned address from the API instead.
        address: parseSuiAddress(challenge.profile.address),
        owner: { kind: "custodial" },
      };
    },
  };
}

function twitterSubForProfile(profile: UserProfile): TwitterSub {
  return parseTwitterSub(`twitter:${profile.handle}`);
}

function randomNonce(prefix: string): Nonce {
  return parseNonce(`${prefix}_${randomToken()}`);
}

function randomSessionId(prefix: string): SessionId {
  return parseSessionId(`${prefix}_${randomToken()}`);
}

function randomToken(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "_");
}
