import { MongoClient } from 'mongodb';
import { SignJWT, jwtVerify } from 'jose';

let client;
let clientPromise;

export async function db() {
  if (!process.env.MONGODB_URI) {
    throw new Error('Database not configured');
  }

  if (!clientPromise) {
    client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5
    });

    clientPromise = client.connect().catch(error => {
      client = undefined;
      clientPromise = undefined;
      throw error;
    });
  }

  await clientPromise;

  return client.db(
    process.env.MONGODB_DB || 'neon_really_compress'
  );
}

/**
 * Execute database operations inside a MongoDB transaction.
 *
 * IMPORTANT:
 * Every database operation inside the callback must use
 * the supplied session.
 */
export async function withTransaction(callback) {
  await db();

  if (!client) {
    throw new Error('Database connection unavailable');
  }

  const session = client.startSession();

  try {
    let result;

    await session.withTransaction(async () => {
      result = await callback(
        client.db(
          process.env.MONGODB_DB || 'neon_really_compress'
        ),
        session
      );
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export function fail(res, status, message) {
  return res.status(status).json({
    error: message
  });
}

export function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));

    fail(res, 405, 'Method not allowed');

    return false;
  }

  return true;
}

export function dateMM() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Yangon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

export const defaults = {
  dailyLimit: 5,
  limitEnabled: true,
  maintenance: false,

  pointPackages: [
    { points: 100, ks: 3000 },
    { points: 200, ks: 6000 },
    { points: 300, ks: 9000 },
    { points: 500, ks: 15000 }
  ],

  sizePricing: [
    { maxMB: 50, points: 10 },
    { maxMB: 100, points: 20 },
    { maxMB: 200, points: 40 },
    { maxMB: 500, points: 100 }
  ],

  payments: {
    KBZPay: '',
    WavePay: '',
    uabpay: ''
  }
};

export async function settings(database) {
  const doc = await database
    .collection('settings')
    .findOne({ _id: 'main' });

  return {
    ...defaults,
    ...doc,
    payments: {
      ...defaults.payments,
      ...(doc?.payments || {})
    }
  };
}

function secret() {
  const value = process.env.JWT_SECRET;

  if (!value || value.length < 32) {
    throw new Error(
      'JWT_SECRET must have at least 32 characters'
    );
  }

  return new TextEncoder().encode(value);
}

export async function token(user) {
  return new SignJWT({
    email: user.email,
    role: user.role || 'user'
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user._id))
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

export async function auth(req) {
  const bearer = req.headers.authorization || '';

  if (!bearer.startsWith('Bearer ')) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(
      bearer.slice(7),
      secret()
    );

    const { ObjectId } = await import('mongodb');

    if (!ObjectId.isValid(payload.sub)) {
      return null;
    }

    return await (
      await db()
    )
      .collection('users')
      .findOne({
        _id: new ObjectId(payload.sub)
      });
  } catch {
    return null;
  }
}

export async function handler(req, res, fn) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    await fn();
  } catch (error) {
    console.error('API handler error:', error);

    fail(
      res,
      500,
      'Server error. Check backend configuration.'
    );
  }
}
