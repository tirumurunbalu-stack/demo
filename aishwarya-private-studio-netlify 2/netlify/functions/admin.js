const { connectLambda, getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Netlify Blobs needs the invocation context when this runs as a legacy
// Netlify Function. It is initialised inside the handler below.
let store;
const OWNER = 'owner.json';
const PENDING = id => `pending/${id}.json`;
const CHALLENGE = id => `challenge/${id}.json`;
const b64url = value => Buffer.from(value).toString('base64url');
const unb64url = value => Buffer.from(value, 'base64url').toString();
const now = () => Date.now();
const random = bytes => crypto.randomBytes(bytes).toString('base64url');
const clean = value => String(value || '').trim();
const normalEmail = value => clean(value).toLowerCase();
const normalPhone = value => clean(value).replace(/[\s().-]/g, '');
const fail = (status, error) => Object.assign(new Error(error), { status });
const same = (a, b) => { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && crypto.timingSafeEqual(left, right); };
const authSecret = () => process.env.AUTH_SECRET || (process.env.CONTEXT !== 'production' ? 'development-only-secret-change-this-before-production' : '');
const publicOrigin = event => process.env.SITE_URL || `https://${event.headers.host}`;

function json(statusCode, body, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  if (cookie) headers['set-cookie'] = cookie;
  return { statusCode, headers, body: JSON.stringify(body) };
}
function getCookie(event, key) { const raw = event.headers.cookie || ''; return (raw.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)) || [])[1]; }
function cookie(name, value, seconds = 0) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; ${seconds ? `Max-Age=${seconds}` : 'Max-Age=0'}`; }
async function read(key) { const value = await store.get(key, { type: 'json' }); return value || null; }
async function put(key, value) { await store.setJSON(key, value); }
async function remove(key) { await store.delete(key); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, derived) => e ? reject(e) : resolve(`${salt}:${derived.toString('hex')}`))); }
async function matchesPassword(password, saved) { const [salt, hash] = saved.split(':'); const fresh = await hashPassword(password, salt); return crypto.timingSafeEqual(Buffer.from(fresh.split(':')[1], 'hex'), Buffer.from(hash, 'hex')); }
function base32(bytes) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0, out = ''; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } return out + (bits ? alphabet[(value << (5 - bits)) & 31] : ''); }
function fromBase32(input) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0, out = []; for (const char of input.replace(/\s/g, '').toUpperCase()) { const n = alphabet.indexOf(char); if (n < 0) throw fail(400, 'Invalid authenticator secret.'); value = (value << 5) | n; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, time = now()) { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000))); const hash = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest(); const offset = hash[19] & 15; const value = ((hash[offset] & 127) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3]; return String(value % 1000000).padStart(6, '0'); }
function validTotp(secret, code) { const value = String(code || ''); return /^\d{6}$/.test(value) && [-30000, 0, 30000].some(offset => same(totp(secret, now() + offset), value)); }
function sign(data) { const secret = authSecret(); if (!secret) throw fail(500, 'AUTH_SECRET is not configured.'); const encoded = b64url(JSON.stringify(data)); return `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`; }
function verify(token) { if (!token || !authSecret()) return null; const [encoded, signature] = token.split('.'); if (!encoded || !signature) return null; const expected = crypto.createHmac('sha256', authSecret()).update(encoded).digest('base64url'); if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { const payload = JSON.parse(unb64url(encoded)); return payload.exp > now() ? payload : null; } catch { return null; } }
function code() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
async function sendOtp(email, value, event) {
  if (process.env.RESEND_API_KEY && process.env.OTP_FROM_EMAIL) {
    const result = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.OTP_FROM_EMAIL, to: [email], subject: 'Your Aishwarya Private Studio verification code', text: `Your Aishwarya Private Studio verification code is ${value}. It expires in 10 minutes. If you did not request this, ignore this email.` }) });
    if (!result.ok) throw fail(502, 'We could not send the verification email. Please try again.');
    return null;
  }
  if (process.env.CONTEXT === 'production') throw fail(500, 'Email OTP is not configured. Add RESEND_API_KEY and OTP_FROM_EMAIL in Netlify before using owner setup.');
  console.info(`[Aishwarya development OTP] ${email}: ${value} (${publicOrigin(event)})`);
  return value;
}
function checkDetails(body) { const name = clean(body.name), email = normalEmail(body.email), phone = normalPhone(body.phone), password = String(body.password || ''); if (name.length < 2 || name.length > 80) throw fail(400, 'Enter the owner’s full name.'); if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Enter a valid email address.'); if (!/^\+?[0-9]{8,16}$/.test(phone)) throw fail(400, 'Enter a valid mobile number including the country code.'); if (password.length < 12) throw fail(400, 'Use a password with at least 12 characters.'); return { name, email, phone, password }; }
function requirePending(pending) { if (!pending || pending.expiresAt < now()) throw fail(400, 'This setup session has expired. Start again.'); }
async function status() { return { ownerExists: Boolean(await read(OWNER)) }; }
async function setupStart(body, event) {
  if (await read(OWNER)) throw fail(403, 'Owner registration is closed because an owner already exists.');
  if (!process.env.ADMIN_BOOTSTRAP_KEY) throw fail(500, 'ADMIN_BOOTSTRAP_KEY is not configured.');
  if (!same(body.bootstrapKey || '', process.env.ADMIN_BOOTSTRAP_KEY)) throw fail(403, 'The private setup key is incorrect.');
  const details = checkDetails(body); const otp = code(); const id = random(24);
  await put(PENDING(id), { id, ...details, passwordHash: await hashPassword(details.password), otpHash: await hashPassword(otp), stage: 'otp', expiresAt: now() + 10 * 60 * 1000 });
  const developmentOtp = await sendOtp(details.email, otp, event);
  return { pendingId: id, ...(developmentOtp ? { developmentOtp } : {}) };
}
async function setupOtp(body, event) { const pending = await read(PENDING(body.pendingId)); requirePending(pending); if (pending.stage !== 'otp' || !(await matchesPassword(String(body.code || ''), pending.otpHash))) throw fail(400, 'That verification code is not correct.'); pending.stage = 'totp'; pending.totpSecret = base32(crypto.randomBytes(20)); pending.expiresAt = now() + 10 * 60 * 1000; await put(PENDING(pending.id), pending); const issuer = 'Aishwarya Private Studio'; const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(pending.email)}?secret=${pending.totpSecret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`; return { qrDataUrl: await QRCode.toDataURL(uri, { width: 280, margin: 1, color: { dark: '#293c31', light: '#fffdf9' } }), manualKey: pending.totpSecret }; }
async function setupTotp(body) { const pending = await read(PENDING(body.pendingId)); requirePending(pending); if (pending.stage !== 'totp' || !validTotp(pending.totpSecret, body.code)) throw fail(400, 'That authenticator code is not correct.'); if (await read(OWNER)) throw fail(403, 'Owner registration has already been completed.'); const recoveryCodes = Array.from({ length: 8 }, () => `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`); pending.stage = 'recovery'; pending.recoveryHashes = await Promise.all(recoveryCodes.map(value => hashPassword(value))); pending.expiresAt = now() + 10 * 60 * 1000; await put(PENDING(pending.id), pending); return { recoveryCodes }; }
async function setupComplete(body) { const pending = await read(PENDING(body.pendingId)); requirePending(pending); if (pending.stage !== 'recovery') throw fail(400, 'Complete authenticator verification first.'); if (await read(OWNER)) throw fail(403, 'Owner registration has already been completed.'); await put(OWNER, { id: random(18), name: pending.name, email: pending.email, phone: pending.phone, passwordHash: pending.passwordHash, totpSecret: pending.totpSecret, recoveryHashes: pending.recoveryHashes, createdAt: new Date().toISOString() }); await remove(PENDING(pending.id)); return { ok: true }; }
async function loginPassword(body) { const owner = await read(OWNER); if (!owner) throw fail(403, 'Owner setup has not been completed yet.'); const principal = clean(body.principal); const principalMatches = normalEmail(principal) === owner.email || normalPhone(principal) === owner.phone; if (!principalMatches || !(await matchesPassword(String(body.password || ''), owner.passwordHash))) throw fail(401, 'Email or mobile number and password do not match.'); const id = random(24); await put(CHALLENGE(id), { id, ownerId: owner.id, expiresAt: now() + 5 * 60 * 1000 }); return { challengeId: id }; }
async function loginTotp(body) { const challenge = await read(CHALLENGE(body.challengeId)); if (!challenge || challenge.expiresAt < now()) throw fail(401, 'Your sign-in session expired. Start again.'); const owner = await read(OWNER); if (!owner || owner.id !== challenge.ownerId || !validTotp(owner.totpSecret, body.code)) throw fail(401, 'That authenticator code is not correct.'); await remove(CHALLENGE(challenge.id)); const token = sign({ sub: owner.id, exp: now() + 8 * 60 * 60 * 1000 }); return { response: { name: owner.name }, cookie: cookie('aishwarya_session', token, 8 * 60 * 60) }; }
async function loginRecovery(body) { const challenge = await read(CHALLENGE(body.challengeId)); if (!challenge || challenge.expiresAt < now()) throw fail(401, 'Your sign-in session expired. Start again.'); const owner = await read(OWNER); if (!owner || owner.id !== challenge.ownerId) throw fail(401, 'Sign in again.'); const value = clean(body.code).toUpperCase(); const index = await (async () => { for (let i = 0; i < owner.recoveryHashes.length; i += 1) if (await matchesPassword(value, owner.recoveryHashes[i])) return i; return -1; })(); if (index < 0) throw fail(401, 'That recovery code is not correct or has already been used.'); owner.recoveryHashes.splice(index, 1); await put(OWNER, owner); await remove(CHALLENGE(challenge.id)); const token = sign({ sub: owner.id, exp: now() + 8 * 60 * 60 * 1000 }); return { response: { name: owner.name }, cookie: cookie('aishwarya_session', token, 8 * 60 * 60) }; }

exports.handler = async event => {
  connectLambda(event);
  store = getStore({ name: 'aishwarya-admin', consistency: 'eventual' });
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    const action = new URLSearchParams(event.rawQuery || '').get('action'); const body = event.body ? JSON.parse(event.body) : {};
    if (action === 'status') return json(200, await status());
    if (action === 'setup/start') return json(200, await setupStart(body, event));
    if (action === 'setup/otp') return json(200, await setupOtp(body, event));
    if (action === 'setup/totp') return json(200, await setupTotp(body));
    if (action === 'setup/complete') return json(200, await setupComplete(body));
    if (action === 'login/password') return json(200, await loginPassword(body));
    if (action === 'login/totp') { const result = await loginTotp(body); return json(200, result.response, result.cookie); }
    if (action === 'login/recovery') { const result = await loginRecovery(body); return json(200, result.response, result.cookie); }
    if (action === 'logout') return json(200, { ok: true }, cookie('aishwarya_session', ''));
    throw fail(404, 'Unknown request.');
  } catch (error) { console.error(error); return json(error.status || 500, { error: error.message || 'Server error.' }); }
};
