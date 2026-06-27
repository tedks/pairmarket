import type { Brand } from "./brand.js";
import type {
  Nonce,
  PolicyEpoch,
  SealPolicyId,
  SuiObjectId,
  UnixMs,
  WalrusBlobId,
} from "./ids.js";

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

export class Plaintext<T> {
  readonly #inner: T;

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

  get [Symbol.toStringTag](): string {
    return "Plaintext";
  }
}

export function makePlaintext<T>(inner: T): Plaintext<T> {
  return Plaintext.of(inner);
}

export function usePlaintext<T, R>(
  plaintext: Plaintext<T>,
  f: (raw: T) => R,
): R {
  return plaintext.use(f);
}

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
