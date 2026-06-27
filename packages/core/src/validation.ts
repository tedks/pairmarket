export type ParseIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
};

export type ParseInputSummary = {
  readonly type: string;
  readonly length?: number;
};

export class ParseError extends Error {
  readonly issue: ParseIssue;
  readonly inputSummary: ParseInputSummary;

  constructor(issue: ParseIssue, input: unknown) {
    super(issue.message);
    this.name = "ParseError";
    this.issue = issue;
    this.inputSummary = summarizeInput(input);
  }
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParseError };

export type Schema<T> =
  | ((raw: unknown) => T)
  | { readonly parse: (raw: unknown) => T };

export function parseWith<T>(schema: Schema<T>, raw: unknown): T {
  if (typeof schema === "function") {
    return schema(raw);
  }

  return schema.parse(raw);
}

export function tryParse<T>(schema: Schema<T>, raw: unknown): ParseResult<T> {
  try {
    return { ok: true, value: parseWith(schema, raw) };
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, error };
    }

    throw error;
  }
}

export function parseError(
  code: string,
  message: string,
  input: unknown,
  path?: readonly string[],
): ParseError {
  const issue: ParseIssue =
    path === undefined ? { code, message } : { code, message, path };
  return new ParseError(issue, input);
}

function summarizeInput(input: unknown): ParseInputSummary {
  if (typeof input === "string") {
    return { type: "string", length: input.length };
  }

  if (input instanceof Uint8Array) {
    return { type: "Uint8Array", length: input.byteLength };
  }

  if (Array.isArray(input)) {
    return { type: "array", length: input.length };
  }

  return { type: input === null ? "null" : typeof input };
}
