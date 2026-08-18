export type ErrorCode =
  | "auth_failed"
  | "invalid_request"
  | "policy_denied"
  | "tool_failed"
  | "timeout"
  | "output_limit";

export type NodeError = Error & { code: ErrorCode; status: number };

export function nodeError(code: ErrorCode, message: string, status = 400): NodeError {
  return Object.assign(new Error(message), { name: "NodeError", code, status });
}

export function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error
    && typeof (error as Partial<NodeError>).code === "string"
    && typeof (error as Partial<NodeError>).status === "number";
}

export function toNodeError(error: unknown): NodeError {
  if (isNodeError(error)) return error;
  if (error instanceof Error) return nodeError("tool_failed", error.message, 500);
  return nodeError("tool_failed", "Unknown tool failure", 500);
}
