import type { Brand } from "./brand";
import type {
  Nonce,
  PolicyEpoch,
  SealPolicyId,
  SuiObjectId,
  UnixMs,
  WalrusBlobId,
} from "./ids";

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

export type WalrusEnvelopeVersion = "PMBLOB/v1";

export type WalrusEnvelopeAlg = "seal-v1-aead";

export type PolicyBound<TPlaintext> = {
  readonly blob: WalrusBlobId;
  readonly policy: SealPolicyId;
  readonly policyKind: PolicyKind;
  readonly scope: SuiObjectId;
  readonly ciphertext: SealCiphertext<TPlaintext>;
};

export type WalrusEnvelopeHeader = {
  readonly version: WalrusEnvelopeVersion;
  readonly contentType: string;
  readonly policyKind: PolicyKind;
  readonly scope: SuiObjectId;
  readonly policyEpoch: PolicyEpoch;
  readonly nonce: Nonce;
  readonly alg: WalrusEnvelopeAlg;
  readonly createdAtMs: UnixMs;
};
