# NEON access system (Vercel + MongoDB Atlas)

This is a starter implementation, **not production security audited**.

1. Install packages with `npm install`; commit `package-lock.json` when available.
2. Deploy project to Vercel (root, Vite framework, build `npm run build`, output `dist`). The existing GitHub Pages workflow is unchanged but GitHub Pages cannot run `/api` routes.
3. Configure Vercel environment variables `MONGODB_URI`, `MONGODB_DB`, `JWT_SECRET` (32+ random characters), `ADMIN_EMAIL` (set before registering admin). Never commit secrets.
4. MongoDB Atlas Network Access must permit outbound Vercel server connections. Restrict access where possible and use a least-privilege database user.
5. In MongoDB Atlas create a unique index on `users.email` (required to prevent duplicate accounts). For example `db.users.createIndex({email:1},{unique:true})`.
6. Register your `ADMIN_EMAIL` through the main site; then open `/admin/`. If that account already existed, setting ADMIN_EMAIL alone will not promote it: set the user's role securely in Atlas.
7. Set real payment destination accounts and desired point packages in Admin. Default `100 points = 3000 Ks` is only a placeholder **not confirmed**. Payment is **manual**: users pay externally and submit transaction ID; admin independently verifies funds received before approving. No auto-verification, no screenshot upload.
8. Free guest quota resets by Asia/Yangon calendar date. Browser-generated guest IDs can be cleared/replaced, so this is a soft limit, not reliable anti-abuse protection. Add server-side rate limiting and bot protection before public launch.
9. Quota/points are charged when processing STARTS; failures are not refunded automatically. This avoids free processing via bypass but needs a robust job authorization/settlement design for production. Browser-local processing can be bypassed by a modified client; no DRM-like enforcement is possible.
10. Do not store payment credentials in browser. Auth token is stored in localStorage in this starter; production should use HttpOnly Secure SameSite cookies, CSRF defenses, request validation, rate limiting, audit logging and a secure admin enrollment flow.
11. Do not expose the site publicly as a payment service without security testing. Atlas free-tier deployment constraints and Vercel costs/limits may change.

`src/processing.js` and `reference-original/App.tsx` are preserved byte-for-byte.
