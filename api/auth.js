import bcrypt from 'bcryptjs';
import {
  db,
  auth,
  token,
  handler,
  method,
  fail
} from '../lib/core.js';

export default async function (req, res) {
  if (!method(req, res, ['POST', 'GET'])) return;

  await handler(req, res, async () => {
    const d = await db();

    // GET: Return the authenticated user's account information.
    if (req.method === 'GET') {
      const u = await auth(req);

      if (!u) {
        return fail(res, 401, 'Login required');
      }

      return res.json({
        email: u.email,
        points: u.points || 0,
        role: u.role || 'user'
      });
    }

    const { action, email, password } = req.body || {};

    if (
      !['register', 'login'].includes(action) ||
      typeof email !== 'string' ||
      typeof password !== 'string'
    ) {
      return fail(res, 400, 'Invalid request');
    }

    const normalized = email.trim().toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
      password.length < 10 ||
      password.length > 128
    ) {
      return fail(
        res,
        400,
        'Valid email and password (10+ characters) required'
      );
    }

    const users = d.collection('users');
    let user;

    // REGISTER
    if (action === 'register') {
      // All public registrations receive the user role.
      // Admin privileges must be granted separately by the server.
      const role = 'user';

      try {
        const inserted = await users.insertOne({
          email: normalized,
          hash: await bcrypt.hash(password, 12),
          role,
          points: 0,
          creditedPayments: [],
          createdAt: new Date()
        });

        user = await users.findOne({
          _id: inserted.insertedId
        });
      } catch (e) {
        if (e.code === 11000) {
          return fail(res, 409, 'Account already exists');
        }

        throw e;
      }
    }

    // LOGIN
    else {
      user = await users.findOne({
        email: normalized
      });

      if (
        !user ||
        !await bcrypt.compare(password, user.hash)
      ) {
        return fail(res, 401, 'Invalid credentials');
      }
    }

    return res.json({
      token: await token(user),
      email: user.email,
      points: user.points || 0,
      role: user.role || 'user'
    });
  });
}
