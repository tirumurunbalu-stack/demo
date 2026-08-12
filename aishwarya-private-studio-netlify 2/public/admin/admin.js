/* ═══════════════════════════════════════════════
   Aishwarya Private Studio — Admin Frontend
   v2.0 · Full flow: setup → OTP → TOTP → recovery → sign in
   ═══════════════════════════════════════════════ */

'use strict';

const app = document.querySelector('#app');
let setup = {};   // accumulates registration state across steps
let login = {};   // holds challengeId after password step

/* ─── API ─────────────────────────────────────── */
async function api(action, body = {}) {
  const res = await fetch('/.netlify/functions/admin?action=' + action, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data.error || 'Something went wrong. Please try again.'),
      { status: res.status }
    );
  }
  return data;
}

/* ─── Utilities ───────────────────────────────── */
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c])
  );

function showMessage(text, type = 'error') {
  const el = app.querySelector('.message');
  if (!el) return;
  el.textContent = text;
  el.className = 'message ' + type;
  if (type === 'error') {
    el.classList.add('shake');
    setTimeout(() => el && el.classList.remove('shake'), 500);
  }
}

function clearMessage() {
  const el = app.querySelector('.message');
  if (el) { el.textContent = ''; el.className = 'message'; }
}

function setLoading(btn, on) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

/* ─── Stepper HTML ────────────────────────────── */
function stepper(active, total = 4) {
  const bars = Array.from({ length: total }, (_, i) => {
    const cls = i < active - 1 ? 'done' : i === active - 1 ? 'active' : '';
    return `<div class="stepper-bar ${cls}"></div>`;
  });
  return `<div class="stepper">${bars.join('')}</div>`;
}

/* ─── OTP 6-box Component ─────────────────────── */
function otpBoxes(wrapId) {
  return `<div class="otp-wrap" id="${wrapId}" role="group" aria-label="6-digit code">
    ${[0, 1, 2, 3, 4, 5].map(i =>
      `<input class="otp-digit" type="text" inputmode="numeric" maxlength="1"
              pattern="[0-9]" autocomplete="${i === 0 ? 'one-time-code' : 'off'}"
              data-idx="${i}" aria-label="Digit ${i + 1}">`
    ).join('')}
  </div>`;
}

function wireOtp(wrapId, onComplete) {
  const inputs = [...app.querySelectorAll(`#${wrapId} .otp-digit`)];

  inputs.forEach((el, i) => {
    el.addEventListener('input', () => {
      el.value = el.value.replace(/\D/g, '').slice(-1);
      el.classList.toggle('filled', !!el.value);
      if (el.value && i < inputs.length - 1) inputs[i + 1].focus();
      if (inputs.every(d => d.value) && onComplete) onComplete();
    });

    el.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !el.value && i > 0) {
        inputs[i - 1].value = '';
        inputs[i - 1].classList.remove('filled');
        inputs[i - 1].focus();
      }
      if (e.key === 'ArrowLeft'  && i > 0)              inputs[i - 1].focus();
      if (e.key === 'ArrowRight' && i < inputs.length - 1) inputs[i + 1].focus();
    });

    el.addEventListener('paste', e => {
      e.preventDefault();
      const digits = (e.clipboardData || window.clipboardData)
        .getData('text').replace(/\D/g, '').slice(0, 6);
      digits.split('').forEach((ch, j) => {
        if (inputs[j]) { inputs[j].value = ch; inputs[j].classList.add('filled'); }
      });
      const next = inputs.findIndex((d, j) => j >= digits.length && !d.value);
      (next >= 0 ? inputs[next] : inputs[inputs.length - 1]).focus();
      if (digits.length === 6 && onComplete) onComplete();
    });
  });

  inputs[0]?.focus();
}

function getOtp(wrapId) {
  return [...app.querySelectorAll(`#${wrapId} .otp-digit`)].map(d => d.value).join('');
}

/* ─── Password Helpers ────────────────────────── */
function strengthScore(pw) {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 12) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
}

function wireStrength(inputId, barId, labelId) {
  const input = app.querySelector('#' + inputId);
  const bar   = app.querySelector('#' + barId);
  const lbl   = app.querySelector('#' + labelId);
  if (!input || !bar || !lbl) return;
  const labels = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  input.addEventListener('input', () => {
    const s = strengthScore(input.value);
    bar.className = 'strength-fill s' + (input.value ? s : 0);
    lbl.textContent = input.value ? labels[s] : '';
  });
}

function wirePwToggle(inputId, btnId) {
  const input = app.querySelector('#' + inputId);
  const btn   = app.querySelector('#' + btnId);
  if (!input || !btn) return;
  btn.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

/* ─── Resend Timer ────────────────────────────── */
let _resendTimer = null;

function startResend(seconds = 60) {
  clearInterval(_resendTimer);
  const btn     = app.querySelector('#resend-btn');
  const counter = app.querySelector('#resend-count');
  if (!btn || !counter) return;
  let rem = seconds;
  btn.disabled = true;
  counter.textContent = rem + 's';
  _resendTimer = setInterval(() => {
    rem--;
    if (rem <= 0) {
      clearInterval(_resendTimer);
      btn.disabled = false;
      counter.textContent = '';
    } else {
      counter.textContent = rem + 's';
    }
  }, 1000);
}

/* ════════════════════════════════════════════════
   SCREENS
   ════════════════════════════════════════════════ */

/* ── Welcome ─────────────────────────────────── */
function welcome(first) {
  app.innerHTML = `<div class="step-content">
    <p class="eyebrow">Private Studio</p>
    <h1>Welcome to your<br><em>private studio.</em></h1>
    <p class="copy">
      ${first
        ? 'Create the one and only owner account, then secure it with your authenticator app.'
        : 'Sign in securely to manage the Aishwarya private studio.'
      }
    </p>
    ${first ? `<button class="btn-primary" id="create-btn">
      <span class="btn-text">Create owner account</span>
      <div class="btn-spinner"></div>
    </button>` : ''}
    <button class="btn-link" id="signin-btn">
      ${first ? 'Already have an account? Sign in' : 'Sign in to your account →'}
    </button>
    <div class="message"></div>
  </div>`;

  app.querySelector('#create-btn')?.addEventListener('click', registration);
  app.querySelector('#signin-btn').addEventListener('click', () => signIn());
}

/* ── Registration ────────────────────────────── */
function registration() {
  app.innerHTML = `<div class="step-content">
    ${stepper(1)}
    <p class="eyebrow">Step 1 of 4</p>
    <h1>Create the owner<br><em>account.</em></h1>
    <p class="copy">This registration is available only once. Use the private setup key supplied at handover.</p>

    <form id="reg-form" novalidate>
      <div class="row">
        <div class="field">
          <label for="reg-name">Full name</label>
          <input type="text" id="reg-name" name="name" required
                 autocomplete="name" placeholder="Aishwarya">
        </div>
        <div class="field">
          <label for="reg-phone">Mobile number</label>
          <input type="tel" id="reg-phone" name="phone" required
                 autocomplete="tel" placeholder="+91 98765 43210">
        </div>
      </div>

      <div class="field">
        <label for="reg-email">Email address</label>
        <input type="email" id="reg-email" name="email" required
               autocomplete="email" placeholder="you@example.com">
      </div>

      <div class="field">
        <label for="reg-pw">Password <span style="opacity:.45;font-size:9px">(min 12 characters)</span></label>
        <div class="input-wrap">
          <input type="password" id="reg-pw" name="password" class="has-toggle"
                 minlength="12" required autocomplete="new-password" placeholder="••••••••••••">
          <button type="button" class="toggle-pw" id="tgl-pw1"
                  aria-label="Show password">👁</button>
        </div>
        <div class="strength-bar"><div class="strength-fill s0" id="s-bar"></div></div>
        <div class="strength-label" id="s-lbl"></div>
      </div>

      <div class="field">
        <label for="reg-confirm">Confirm password</label>
        <div class="input-wrap">
          <input type="password" id="reg-confirm" name="confirm" class="has-toggle"
                 minlength="12" required autocomplete="new-password" placeholder="••••••••••••">
          <button type="button" class="toggle-pw" id="tgl-pw2"
                  aria-label="Show password">👁</button>
        </div>
      </div>

      <div class="field">
        <label for="reg-key">Private setup key</label>
        <div class="input-wrap">
          <input type="password" id="reg-key" name="bootstrapKey" class="has-toggle"
                 required autocomplete="off" placeholder="Provided at handover">
          <button type="button" class="toggle-pw" id="tgl-pw3"
                  aria-label="Show key">👁</button>
        </div>
      </div>

      <button type="submit" class="btn-primary" id="reg-submit">
        <span class="btn-text">Continue to verification →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <button class="btn-link" id="back-btn">← Back to sign in</button>
    <div class="message"></div>
  </div>`;

  wireStrength('reg-pw', 's-bar', 's-lbl');
  wirePwToggle('reg-pw', 'tgl-pw1');
  wirePwToggle('reg-confirm', 'tgl-pw2');
  wirePwToggle('reg-key', 'tgl-pw3');

  app.querySelector('#back-btn').onclick = boot;

  app.querySelector('#reg-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const btn  = app.querySelector('#reg-submit');
    const data = Object.fromEntries(new FormData(e.target));
    if (data.password !== data.confirm) return showMessage('Passwords do not match.');
    setLoading(btn, true);
    try {
      const r = await api('setup/start', data);
      setup = { ...data, pendingId: r.pendingId };
      otpScreen(r.developmentOtp);
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── OTP Verification ────────────────────────── */
function otpScreen(devOtp) {
  app.innerHTML = `<div class="step-content">
    ${stepper(2)}
    <p class="eyebrow">Step 2 of 4</p>
    <h1>Verify it's<br><em>really you.</em></h1>
    <p class="copy">We sent a six-digit code to <b>${esc(setup.email)}</b>.
      It expires in 10 minutes.</p>

    <form id="otp-form" novalidate>
      <label class="lbl">Verification code</label>
      ${otpBoxes('otp-wrap')}
      <button type="submit" class="btn-primary" id="otp-submit" style="margin-top:18px">
        <span class="btn-text">Verify code →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <div class="resend-wrap">
      Resend code in <span id="resend-count"></span>
      <button id="resend-btn" disabled>Resend</button>
    </div>

    ${devOtp ? `<div class="dev-notice">
      <b>Dev mode — code not emailed:</b>
      <span class="dev-otp" id="dev-otp-val">${devOtp}</span>
    </div>` : ''}

    <div class="message"></div>
  </div>`;

  wireOtp('otp-wrap');
  startResend(60);

  app.querySelector('#resend-btn').onclick = async () => {
    clearMessage();
    try {
      const r = await api('setup/start', {
        name: setup.name, email: setup.email,
        phone: setup.phone, password: setup.password,
        bootstrapKey: setup.bootstrapKey,
      });
      setup.pendingId = r.pendingId;
      startResend(60);
      if (r.developmentOtp) {
        const el = app.querySelector('#dev-otp-val');
        if (el) el.textContent = r.developmentOtp;
      }
      showMessage('A new code has been sent.', 'success');
    } catch (err) { showMessage(err.message); }
  };

  app.querySelector('#otp-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const code = getOtp('otp-wrap');
    if (code.length !== 6) return showMessage('Please enter all 6 digits.');
    const btn = app.querySelector('#otp-submit');
    setLoading(btn, true);
    try {
      const r = await api('setup/otp', { pendingId: setup.pendingId, code });
      setup = { ...setup, ...r };  // adds qrDataUrl, manualKey
      totpSetup();
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── TOTP Setup ──────────────────────────────── */
function totpSetup() {
  app.innerHTML = `<div class="step-content">
    ${stepper(3)}
    <p class="eyebrow">Step 3 of 4</p>
    <h1>Secure your<br><em>private studio.</em></h1>
    <p class="copy">Open Google Authenticator (or any TOTP app), scan the QR code, then enter the current six-digit code it shows.</p>

    <div class="qr-wrap">
      <div class="qr-frame">
        <img src="${setup.qrDataUrl}" alt="Authenticator QR code" width="190" height="190">
      </div>
    </div>
    <p class="manual-key-lbl">Can't scan? Enter key manually</p>
    <div class="manual-key">${esc(setup.manualKey)}</div>

    <form id="totp-form" novalidate style="margin-top:22px">
      <label class="lbl">Authenticator code</label>
      ${otpBoxes('totp-wrap')}
      <button type="submit" class="btn-primary" id="totp-submit" style="margin-top:18px">
        <span class="btn-text">Confirm authenticator →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <div class="message"></div>
  </div>`;

  wireOtp('totp-wrap');

  app.querySelector('#totp-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const code = getOtp('totp-wrap');
    if (code.length !== 6) return showMessage('Enter the 6-digit code from your app.');
    const btn = app.querySelector('#totp-submit');
    setLoading(btn, true);
    try {
      const r = await api('setup/totp', { pendingId: setup.pendingId, code });
      recovery(r.recoveryCodes);
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── Recovery Codes ──────────────────────────── */
function recovery(codes) {
  app.innerHTML = `<div class="step-content">
    ${stepper(4)}
    <p class="eyebrow">Step 4 of 4</p>
    <h1>Save your recovery<br><em>codes.</em></h1>
    <p class="copy">Store these somewhere safe and offline. Each code works once if you lose access to your authenticator. <b>They will not be shown again.</b></p>

    <div class="recovery-actions">
      <button class="btn-sm" id="copy-btn">Copy all codes</button>
    </div>
    <div class="recovery-grid">
      ${codes.map(c => `<div class="recovery-code">${esc(c)}</div>`).join('')}
    </div>

    <button class="btn-primary" id="done-btn">
      <span class="btn-text">I have saved these codes ✓</span>
      <div class="btn-spinner"></div>
    </button>
    <div class="message"></div>
  </div>`;

  app.querySelector('#copy-btn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      const btn = app.querySelector('#copy-btn');
      if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => { if (btn) btn.textContent = 'Copy all codes'; }, 2200); }
    } catch { showMessage('Copy failed — please copy the codes manually.'); }
  };

  app.querySelector('#done-btn').onclick = async () => {
    const btn = app.querySelector('#done-btn');
    setLoading(btn, true);
    try {
      await api('setup/complete', { pendingId: setup.pendingId });
      signIn('Owner account created successfully. Please sign in.');
    } catch (err) {
      showMessage(err.message);
      setLoading(btn, false);
    }
  };
}

/* ── Sign In ─────────────────────────────────── */
function signIn(note = '') {
  app.innerHTML = `<div class="step-content">
    <p class="eyebrow">Private Studio</p>
    <h1>Sign in to the<br><em>private studio.</em></h1>
    <p class="copy">Enter your email address or mobile number and password.</p>

    <form id="login-form" novalidate>
      <div class="field">
        <label for="login-id">Email or mobile number</label>
        <input type="text" id="login-id" name="principal" required
               autocomplete="username" placeholder="you@example.com">
      </div>
      <div class="field">
        <label for="login-pw">Password</label>
        <div class="input-wrap">
          <input type="password" id="login-pw" name="password" class="has-toggle"
                 required autocomplete="current-password" placeholder="••••••••••••">
          <button type="button" class="toggle-pw" id="tgl-login-pw"
                  aria-label="Show password">👁</button>
        </div>
      </div>
      <button type="submit" class="btn-primary" id="login-submit">
        <span class="btn-text">Continue →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <div class="message ${note ? 'success' : ''}">${esc(note)}</div>
  </div>`;

  wirePwToggle('login-pw', 'tgl-login-pw');

  app.querySelector('#login-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const btn = app.querySelector('#login-submit');
    setLoading(btn, true);
    try {
      const r = await api('login/password', Object.fromEntries(new FormData(e.target)));
      login = { challengeId: r.challengeId };
      loginTotp();
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── Login TOTP ──────────────────────────────── */
function loginTotp() {
  app.innerHTML = `<div class="step-content">
    <p class="eyebrow">Two-factor authentication</p>
    <h1>One more<br><em>secure step.</em></h1>
    <p class="copy">Your password has been confirmed. Enter the current six-digit code from your authenticator app.</p>

    <form id="ltotp-form" novalidate>
      <label class="lbl">Authenticator code</label>
      ${otpBoxes('ltotp-wrap')}
      <button type="submit" class="btn-primary" id="ltotp-submit" style="margin-top:18px">
        <span class="btn-text">Sign in securely →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <button class="btn-link" id="use-recovery">Use a recovery code instead</button>
    <div class="message"></div>
  </div>`;

  wireOtp('ltotp-wrap');
  app.querySelector('#use-recovery').onclick = recoverySignIn;

  app.querySelector('#ltotp-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const code = getOtp('ltotp-wrap');
    if (code.length !== 6) return showMessage('Enter the 6-digit code from your app.');
    const btn = app.querySelector('#ltotp-submit');
    setLoading(btn, true);
    try {
      const r = await api('login/totp', { ...login, code });
      panel(r.name);
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── Recovery Sign In ────────────────────────── */
function recoverySignIn() {
  app.innerHTML = `<div class="step-content">
    <p class="eyebrow">Account recovery</p>
    <h1>Use a recovery<br><em>code.</em></h1>
    <p class="copy">Enter one of your saved recovery codes. Each code works only once.</p>

    <form id="rec-form" novalidate>
      <div class="field">
        <label for="rec-code">Recovery code</label>
        <input type="text" id="rec-code" name="code" required autofocus
               autocomplete="off" placeholder="XXXXXX-XXXXXX"
               style="font-family:'DM Mono',monospace;letter-spacing:.1em;text-transform:uppercase">
      </div>
      <button type="submit" class="btn-primary" id="rec-submit">
        <span class="btn-text">Sign in securely →</span>
        <div class="btn-spinner"></div>
      </button>
    </form>

    <button class="btn-link" id="back-totp">← Use authenticator instead</button>
    <div class="message"></div>
  </div>`;

  app.querySelector('#back-totp').onclick = loginTotp;

  app.querySelector('#rec-form').onsubmit = async e => {
    e.preventDefault();
    clearMessage();
    const btn  = app.querySelector('#rec-submit');
    const code = new FormData(e.target).get('code');
    setLoading(btn, true);
    try {
      const r = await api('login/recovery', { ...login, code });
      panel(r.name);
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(btn, false);
    }
  };
}

/* ── Owner Panel ─────────────────────────────── */
function panel(name) {
  const initials = (name || '?')
    .split(' ')
    .map(w => w[0] || '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

  app.innerHTML = `<div class="step-content panel-welcome">
    <div class="panel-avatar">${esc(initials)}</div>
    <div class="panel-badge">Authenticated</div>
    <p class="eyebrow">Owner dashboard</p>
    <h1>Welcome back,<br><em>${esc(name)}.</em></h1>
    <p class="copy">Your session is active and secured with two-factor authentication. Connect this panel to your product, order, and customer management modules.</p>
    <hr class="divider">
    <button class="btn-ghost" id="signout-btn">
      <span class="btn-text">Sign out</span>
      <div class="btn-spinner"></div>
    </button>
    <div class="message"></div>
  </div>`;

  app.querySelector('#signout-btn').onclick = async () => {
    const btn = app.querySelector('#signout-btn');
    setLoading(btn, true);
    try { await api('logout'); } catch { /* ignore */ }
    boot();
  };
}

/* ─── Boot ────────────────────────────────────── */
async function boot() {
  app.innerHTML = `<div class="loading-state">
    <div class="loading-spinner"></div>
    <p>Preparing your private studio…</p>
  </div>`;
  try {
    const r = await api('status');
    welcome(!r.ownerExists);
  } catch {
    app.innerHTML = `<div class="step-content">
      <p class="eyebrow">Connection error</p>
      <h1>Unable to<br><em>connect.</em></h1>
      <p class="copy">We could not reach the secure service. Please check your connection and try again.</p>
      <button class="btn-primary" id="retry-btn">
        <span class="btn-text">Try again</span>
        <div class="btn-spinner"></div>
      </button>
      <div class="message"></div>
    </div>`;
    app.querySelector('#retry-btn').onclick = boot;
  }
}

boot();
