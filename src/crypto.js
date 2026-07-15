import crypto from 'crypto';

const RAW_KEY = process.env.ENCRYPTION_KEY;
if (!RAW_KEY) {
  throw new Error('ENCRYPTION_KEY is not set');
}
function parseKey(raw) {
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    return Buffer.from(raw, 'hex');
    }
  return Buffer.from(raw, 'base64');
}

const KEY = parseKey(RAW_KEY);
if (KEY.length !== 32) {
  throw new Error('ENCRYPTION_KEY must be 32 bytes (base64 or hex encoded)');

}
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decrypt(payload) {
  if (!payload) return null;
  const data = Buffer.from(payload, 'base64');
  const iv = data.slice(0, 12);
  const tag = data.slice(12, 28);
  const ciphertext = data.slice(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
