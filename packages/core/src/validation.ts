export type ParseIssue = {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly string[];
};

export class ParseError extends Error {
  readonly issue: ParseIssue;
  readonly input: unknown;

  constructor(issue: ParseIssue, input: unknown) {
    super(issue.message);
    this.name = "ParseError";
    this.issue = issue;
    this.input = input;
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

    const issue: ParseIssue = {
      code: "schema_error",
      message: error instanceof Error ? error.message : "Schema parse failed",
    };
    return { ok: false, error: new ParseError(issue, raw) };
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
