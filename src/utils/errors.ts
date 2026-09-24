export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\b(api[_-]?key|authorization)\s*[:=]\s*[^\s,"'}]+/gi, '$1=[redacted]');
}
