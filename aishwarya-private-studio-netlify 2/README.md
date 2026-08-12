# Aishwarya Private Studio

This deployable Netlify site includes the public luxury storefront and a real server-backed `/admin/` owner flow.

## What the flow does

1. Before an owner exists, `/admin/` shows **Create owner account**.
2. The real owner enters name, email, phone, password, confirmation, and the private one-time setup key.
3. A six-digit email OTP verifies control of the email address.
4. A QR code sets up Google Authenticator (or another TOTP app); its six-digit code is verified.
5. Recovery codes appear once. The owner saves them and finishes setup.
6. The server writes the owner record to Netlify Blobs. Future setup attempts are rejected by the API, not merely hidden in the page.
7. Later sign-in always verifies email/phone + password **before** asking for the authenticator code. A signed, secure cookie is only issued after both steps succeed.

## Deploy to Netlify from GitHub

1. Upload the **contents** of this project folder to the root of the GitHub repository. Do not upload the enclosing folder or the ZIP itself.
2. In Netlify, import the repository (or trigger a deploy if it is already connected). Netlify reads `netlify.toml`; no manual build command is required.
3. In **Site configuration → Environment variables**, add every value from `.env.example`:
   - `ADMIN_BOOTSTRAP_KEY`: generate a long random value. Give it privately only to the actual owner during handover. It prevents a stranger from claiming the owner account.
   - `AUTH_SECRET`: a different random value of 32+ characters. Keep it private forever; changing it signs everyone out.
   - `RESEND_API_KEY`, `OTP_FROM_EMAIL`, `SITE_URL`: needed for genuine production email OTP delivery. Verify the sending domain in Resend first.
4. Deploy, then visit `https://your-domain/admin/`. The actual owner completes the flow. Do **not** use your own details unless you are intended to become the permanent owner.

## Test checklist

- In a Netlify deploy preview, confirm `/admin/` offers **Create owner account** only when no owner record exists.
- Confirm an incorrect setup key or OTP is rejected.
- Scan the QR with Google Authenticator and confirm an invalid six-digit code is rejected.
- Save recovery codes and complete setup.
- Reload `/admin/`: owner setup must be gone; `Create owner account` must be rejected by the API as well.
- Sign in with a wrong password: no TOTP prompt appears.
- Sign in with valid credentials: TOTP prompt appears, and a wrong code is rejected.
- Sign in with the current authenticator code and verify the private panel opens.

## Important operational notes

- Local development intentionally displays the OTP on the page and logs it. Production does not; production refuses setup until Resend email delivery is configured.
- The phone number is accepted as a login identifier. OTP verification is delivered to the email address in this version; adding SMS delivery requires an SMS provider such as Twilio.
- Netlify Blobs is the persistent backend store. Never delete the `aishwarya-admin` blob store after the real owner has registered, or the owner-lock state will be lost.
