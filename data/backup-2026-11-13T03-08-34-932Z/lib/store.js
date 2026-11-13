// Зашифроване сховище налаштувань.
// Ключ виводиться з майстер-пароля через scrypt, дані шифруються AES-256-GCM.
// Без пароля файл config.enc прочитати неможливо; підміна файлу виявляється (GCM auth tag).
const fs = require('fs');
const crypto = require('crypto');

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(password, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));
}

async function encrypt(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(password, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return {
    v: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
  };
}

async function decrypt(file, password) {
  const key = await deriveKey(password, Buffer.from(file.salt, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
  d.setAuthTag(Buffer.from(file.tag, 'base64'));
  try {
    const out = Buffer.concat([d.update(Buffer.from(file.data, 'base64')), d.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    const err = new Error('WRONG_PASSWORD');
    err.code = 'WRONG_PASSWORD';
    throw err;
  }
}

class Store {
  constructor(path) { this.path = path; }
  exists() { return fs.existsSync(this.path); }
  async load(password) {
    return decrypt(JSON.parse(fs.readFileSync(this.path, 'utf8')), password);
  }
  async save(obj, password) {
    const enc = await encrypt(obj, password);
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(enc, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }
}

module.exports = { Store };
