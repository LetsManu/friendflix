import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM. Output: base64url(iv | tag | ciphertext). */
export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decrypt(key: Buffer, blob: string): string {
  const raw = Buffer.from(blob, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

export const keyFromBase64 = (b64: string): Buffer => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('APP_ENC_KEY must decode to 32 bytes');
  return k;
};

export const randomPassword = () => randomBytes(24).toString('base64url');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
