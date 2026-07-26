import crypto from 'crypto';

const CHARSET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$';
const PASSWORD_LENGTH = 14;

export function generatePassword(length = PASSWORD_LENGTH) {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes)
    .map((b) => CHARSET[b % CHARSET.length])
    .join('');
}