import type { Brand } from "./brand";
import type { SealPolicyId, SuiObjectId, WalrusBlobId } from "./ids";

export type PolicyKind =
  | "participant"
  | "subject"
  | "creator"
  | "evidence"
  | "draft";

export type SealCiphertext<TPlaintext> = Brand<
  Uint8Array,
  readonly ["SealCiphertext", TPlaintext]
>;

export type Plaintext<T> = Brand<T, "Plaintext">;

export type SealDerivedKey = Brand<Uint8Array, "SealDerivedKey">;

export type PolicyBound<TPlaintext> = {
  readonly blob: WalrusBlobId;
  readonly policy: SealPolicyId;
  readonly policyKind: PolicyKind;
  readonly scope: SuiObjectId;
  readonly ciphertext: SealCiphertext<TPlaintext>;
};

export type WalrusEnvelopeHeader = {
  readonly version: "PMBLOB v1";
  readonly contentType: string;
  readonly policyKind: PolicyKind;
  readonly scope: SuiObjectId;
  readonly policyEpoch: number;
  readonly nonce: string;
  readonly alg: string;
  readonly createdAtMs: number;
};
