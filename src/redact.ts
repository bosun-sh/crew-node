const SECRET_PATTERNS: { pattern: RegExp; replace: (match: string) => string }[] = [
  {
    pattern: /\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)[A-Z0-9_]*)\s*=\s*["']?[^\s"']+["']?/g,
    replace: (match) => `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
  },
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: () => "Bearer [redacted]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => "[redacted:openai-key]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: () => "[redacted:github-token]" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: () => "[redacted:github-token]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => "[redacted:aws-key-id]" },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => "[redacted:slack-token]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replace: () => "[redacted:jwt]" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[redacted:private-key]",
  },
];

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/,
  /\.pem$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)[^/]*$/,
  /\.(key|p12|pfx|jks|keystore)$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)(credentials|secrets)\.(json|ya?ml|toml)$/i,
  /(^|\/)\.aws\//,
  /(^|\/)\.ssh\//,
  /(^|\/)\.git\//,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, { pattern, replace }) => current.replace(pattern, replace), text);
}

export function isSensitivePath(path: string): boolean {
  const normalized = path.split("\\").join("/");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}
