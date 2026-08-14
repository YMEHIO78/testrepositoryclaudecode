// Minimal static server for Railway.
// Swap this out for a real backend (Express routes + a database) as you
// wire up Outlook, Outlook Calendar, and Wave — this just serves the
// front-end mockup in /public so it's deployable as-is.

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Throttle repeated failed logins per IP to make password brute-forcing
// impractical. Successful requests (anything not returning an error
// status) don't count against the limit.
//
// Railway's edge sets X-Real-IP to the actual client IP (their proxy
// chain doesn't give a fixed-depth X-Forwarded-For, so Express's
// built-in `trust proxy` hop-counting resolves the wrong address here —
// see https://docs.railway.com/networking/public-networking/specs-and-limits).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many failed login attempts. Try again in 15 minutes.',
  keyGenerator: (req) => req.headers['x-real-ip'] || req.socket.remoteAddress,
});

app.use(loginLimiter);

// Basic auth gate — placeholder until real login is built. Credentials
// live only in Railway's Variables tab (AUTH_USER / AUTH_PASS).
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use((req, res, next) => {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  if (!user || !pass) {
    console.warn('AUTH_USER/AUTH_PASS not set — app is running with no login gate.');
    return next();
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [reqUser, reqPass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (reqUser && reqPass && timingSafeEqual(reqUser, user) && timingSafeEqual(reqPass, pass)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Pocket Data Office"');
  return res.status(401).send('Authentication required.');
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Pocket Data Office listening on port ${PORT}`);
});
