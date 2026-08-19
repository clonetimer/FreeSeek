/** Durable session id validation shared by EventLog, index, headless and eval hosts. */
export function assertSafeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId) || sessionId === "." || sessionId === "..") {
    throw new Error("非法 session id：仅允许 1-128 位字母、数字、点、下划线和连字符");
  }
  return sessionId;
}
