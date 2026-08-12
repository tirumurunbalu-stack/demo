const { connectLambda, getStore } = require('@netlify/blobs');
const crypto = require('crypto');
const QRCode = require('qrcode');

// Netlify Blobs needs the invocation context when this runs as a legacy
// Netlify Function. It is initialised inside the handler below.
let store;
const OWNER = 'owner.json';
const PRODUCTS = 'store/products.json';
const ORDERS = 'store/orders.json';
const CUSTOMERS = 'store/customers.json';
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
const STORE_IMAGE_LIMIT = 3 * 1024 * 1024;

function json(statusCode, body, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
  if (cookie) headers['set-cookie'] = cookie;
  return { statusCode, headers, body: JSON.stringify(body) };
}
function getCookie(event, key) { const raw = event.headers.cookie || ''; return (raw.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`)) || [])[1]; }
function cookie(name, value, seconds = 0) { return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Secure; ${seconds ? `Max-Age=${seconds}` : 'Max-Age=0'}`; }
async function read(key) { for (let attempt = 0; attempt < 5; attempt += 1) { const value = await store.get(key, { type: 'json' }); if (value || attempt === 4) return value || null; await new Promise(resolve => setTimeout(resolve, 180)); } return null; }
async function put(key, value) { await store.setJSON(key, value); }
async function remove(key) { await store.delete(key); }
async function storeList(key) { const value = await read(key); return Array.isArray(value) ? value : []; }
function session(event) { return verify(getCookie(event, 'aishwarya_session')); }
function ownerSession(event) { const value = session(event); if (!value) throw fail(401, 'Please sign in again to manage the studio.'); return value; }
function customerSession(event) { const value = verify(getCookie(event, 'aishwarya_customer_session')); if (!value || value.role !== 'customer') throw fail(401, 'Please sign in to your customer account.'); return value; }
function productId() { return `P-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function orderId() { return `AIS-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (e, derived) => e ? reject(e) : resolve(`${salt}:${derived.toString('hex')}`))); }
async function matchesPassword(password, saved) { const [salt, hash] = saved.split(':'); const fresh = await hashPassword(password, salt); return crypto.timingSafeEqual(Buffer.from(fresh.split(':')[1], 'hex'), Buffer.from(hash, 'hex')); }
function base32(bytes) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0, out = ''; for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; } } return out + (bits ? alphabet[(value << (5 - bits)) & 31] : ''); }
function fromBase32(input) { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0, out = []; for (const char of input.replace(/\s/g, '').toUpperCase()) { const n = alphabet.indexOf(char); if (n < 0) throw fail(400, 'Invalid authenticator secret.'); value = (value << 5) | n; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totp(secret, time = now()) { const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000))); const hash = crypto.createHmac('sha1', fromBase32(secret)).update(counter).digest(); const offset = hash[19] & 15; const value = ((hash[offset] & 127) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3]; return String(value % 1000000).padStart(6, '0'); }
function validTotp(secret, code) { const value = String(code || ''); return /^\d{6}$/.test(value) && [-30000, 0, 30000].some(offset => same(totp(secret, now() + offset), value)); }
function sign(data) { const secret = authSecret(); if (!secret) throw fail(500, 'AUTH_SECRET is not configured.'); const encoded = b64url(JSON.stringify(data)); return `${encoded}.${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}`; }
function verify(token) { if (!token || !authSecret()) return null; const [encoded, signature] = token.split('.'); if (!encoded || !signature) return null; const expected = crypto.createHmac('sha256', authSecret()).update(encoded).digest('base64url'); if (!same(signature, expected)) return null; try { const payload = JSON.parse(unb64url(encoded)); return payload.exp > now() ? payload : null; } catch { return null; } }
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
async function resetPassword(body) { const owner = await read(OWNER); if (!owner || normalEmail(body.email) !== owner.email) throw fail(400, 'We could not verify those reset details.'); const value = clean(body.recoveryCode).toUpperCase(); const index = await (async () => { for (let i = 0; i < owner.recoveryHashes.length; i += 1) if (await matchesPassword(value, owner.recoveryHashes[i])) return i; return -1; })(); if (index < 0) throw fail(400, 'That recovery code is not correct or has already been used.'); const password = String(body.password || ''); if (password.length < 12) throw fail(400, 'Use a password with at least 12 characters.'); owner.passwordHash = await hashPassword(password); owner.recoveryHashes.splice(index, 1); await put(OWNER, owner); return { ok: true }; }
function checkCustomerDetails(body) { const name = clean(body.name), email = normalEmail(body.email), phone = normalPhone(body.phone), password = String(body.password || ''); if (name.length < 2 || name.length > 80) throw fail(400, 'Enter your full name.'); if (!/^\S+@\S+\.\S+$/.test(email)) throw fail(400, 'Enter a valid email address.'); if (!/^\+?[0-9]{8,16}$/.test(phone)) throw fail(400, 'Enter a valid mobile number including the country code.'); if (password.length < 8) throw fail(400, 'Use a password with at least 8 characters.'); return { name, email, phone, password }; }
async function customerSignup(body) { const details = checkCustomerDetails(body); const customers = await storeList(CUSTOMERS); if (customers.some(customer => customer.email === details.email || customer.phone === details.phone)) throw fail(409, 'An account already exists with this email or mobile number. Please sign in.'); const customer = { id: random(18), name: details.name, email: details.email, phone: details.phone, passwordHash: await hashPassword(details.password), createdAt: new Date().toISOString() }; customers.unshift(customer); await put(CUSTOMERS, customers); const token = sign({ sub: customer.id, role: 'customer', exp: now() + 30 * 24 * 60 * 60 * 1000 }); return { response: { customer: { name: customer.name, email: customer.email } }, cookie: cookie('aishwarya_customer_session', token, 30 * 24 * 60 * 60) }; }
async function customerLogin(body) { const principal = clean(body.principal); const password = String(body.password || ''); const customer = (await storeList(CUSTOMERS)).find(item => item.email === normalEmail(principal) || item.phone === normalPhone(principal)); if (!customer || !(await matchesPassword(password, customer.passwordHash))) throw fail(401, 'Email or mobile number and password do not match.'); const token = sign({ sub: customer.id, role: 'customer', exp: now() + 30 * 24 * 60 * 60 * 1000 }); return { response: { customer: { name: customer.name, email: customer.email } }, cookie: cookie('aishwarya_customer_session', token, 30 * 24 * 60 * 60) }; }
async function customerMe(event) { const account = customerSession(event); const customer = (await storeList(CUSTOMERS)).find(item => item.id === account.sub); if (!customer) throw fail(401, 'Please sign in again.'); return { customer: { name: customer.name, email: customer.email, phone: customer.phone } }; }
async function publicProducts() { return { products: (await storeList(PRODUCTS)).filter(item => item.active !== false && item.stock > 0).map(({ image, ...item }) => ({ ...item, image })) }; }
async function adminProducts(event) { ownerSession(event); return { products: await storeList(PRODUCTS) }; }
async function saveProduct(body, event) { ownerSession(event); const items = await storeList(PRODUCTS); const name = clean(body.name); const price = Number(body.price); const stock = Number(body.stock);
  if (name.length < 2 || !Number.isFinite(price) || price < 0 || !Number.isInteger(stock) || stock < 0) throw fail(400, 'Enter a product name, valid price, and whole stock quantity.');
  const image = clean(body.image); if (image && (!image.startsWith('data:image/') || image.length > STORE_IMAGE_LIMIT)) throw fail(400, 'Use a photo under 3 MB.');
  const item = { id: clean(body.id) || productId(), name, category: clean(body.category) || 'Uncategorised', price, stock, description: clean(body.description), image: image || clean(body.existingImage), active: body.active !== false, updatedAt: new Date().toISOString() };
  const index = items.findIndex(product => product.id === item.id); if (index >= 0) items[index] = { ...items[index], ...item }; else { item.createdAt = item.updatedAt; items.unshift(item); } await put(PRODUCTS, items); return { product: item };
}
async function deleteProduct(body, event) { ownerSession(event); const items = await storeList(PRODUCTS); await put(PRODUCTS, items.filter(item => item.id !== body.id)); return { ok: true }; }
async function createOrder(body) { const products = await storeList(PRODUCTS); const cart = Array.isArray(body.items) ? body.items : []; if (!cart.length) throw fail(400, 'Your bag is empty.');
  const customer = body.customer || {}; const required = ['name','phone','address','city','pincode']; if (required.some(key => !clean(customer[key]))) throw fail(400, 'Please complete your delivery address.');
  const lineItems = cart.map(line => { const product = products.find(item => item.id === line.id && item.active !== false); const quantity = Number(line.quantity); if (!product || !Number.isInteger(quantity) || quantity < 1 || product.stock < quantity) throw fail(400, 'One of the selected pieces is no longer available.'); return { id: product.id, name: product.name, price: product.price, quantity, image: product.image }; });
  const subtotal = lineItems.reduce((sum, item) => sum + item.price * item.quantity, 0); const shipping = subtotal >= 5000 ? 0 : 250; const paymentMethod = body.paymentMethod === 'cod' ? 'cod' : 'online';
  if (paymentMethod === 'online' && !process.env.RAZORPAY_KEY_ID) throw fail(400, 'Online payment will be available once the studio connects its payment account. Please choose Cash on Delivery for this test.');
  for (const line of lineItems) products.find(item => item.id === line.id).stock -= line.quantity;
  const order = { id: orderId(), items: lineItems, customer: { name: clean(customer.name), email: normalEmail(customer.email), phone: normalPhone(customer.phone), address: clean(customer.address), landmark: clean(customer.landmark), city: clean(customer.city), state: clean(customer.state), pincode: clean(customer.pincode) }, subtotal, shipping, total: subtotal + shipping, paymentMethod, paymentStatus: paymentMethod === 'cod' ? 'due on delivery' : 'awaiting payment', fulfillmentStatus: 'new', deliveryPartner: 'Delhivery — ready to connect', createdAt: new Date().toISOString() };
  const orders = await storeList(ORDERS); orders.unshift(order); await put(PRODUCTS, products); await put(ORDERS, orders); return { order };
}
async function adminOrders(event) { ownerSession(event); return { orders: await storeList(ORDERS) }; }
async function updateOrder(body, event) { ownerSession(event); const orders = await storeList(ORDERS); const order = orders.find(item => item.id === body.id); if (!order) throw fail(404, 'Order not found.'); const allowed = ['new','confirmed','packed','shipped','delivered','cancelled']; if (!allowed.includes(body.fulfillmentStatus)) throw fail(400, 'Invalid order status.'); order.fulfillmentStatus = body.fulfillmentStatus; order.updatedAt = new Date().toISOString(); if (body.trackingNumber) order.trackingNumber = clean(body.trackingNumber); await put(ORDERS, orders); return { order }; }
async function dashboard(event) { ownerSession(event); const [products, orders] = await Promise.all([storeList(PRODUCTS), storeList(ORDERS)]); return { products: products.length, lowStock: products.filter(item => item.stock < 3).length, orders: orders.length, revenue: orders.filter(item => item.fulfillmentStatus !== 'cancelled').reduce((sum, item) => sum + item.total, 0), recent: orders.slice(0, 5) }; }

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
    if (action === 'password/reset') return json(200, await resetPassword(body));
    if (action === 'customer/signup') { const result = await customerSignup(body); return json(200, result.response, result.cookie); }
    if (action === 'customer/login') { const result = await customerLogin(body); return json(200, result.response, result.cookie); }
    if (action === 'customer/me') return json(200, await customerMe(event));
    if (action === 'customer/logout') return json(200, { ok: true }, cookie('aishwarya_customer_session', ''));
    if (action === 'store/products') return json(200, await publicProducts());
    if (action === 'store/checkout') return json(200, await createOrder(body));
    if (action === 'admin/dashboard') return json(200, await dashboard(event));
    if (action === 'admin/products') return json(200, await adminProducts(event));
    if (action === 'admin/product/save') return json(200, await saveProduct(body, event));
    if (action === 'admin/product/delete') return json(200, await deleteProduct(body, event));
    if (action === 'admin/orders') return json(200, await adminOrders(event));
    if (action === 'admin/order/update') return json(200, await updateOrder(body, event));
    if (action === 'logout') return json(200, { ok: true }, cookie('aishwarya_session', ''));
    throw fail(404, 'Unknown request.');
  } catch (error) { console.error(error); return json(error.status || 500, { error: error.message || 'Server error.' }); }
};
