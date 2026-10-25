import {
  db,
  settings,
  auth,
  handler,
  method,
  fail,
  dateMM,
  withTransaction
} from '../lib/core.js';

const validId = value =>
  typeof value === 'string' &&
  /^[a-f0-9-]{36}$/i.test(value);

export default async function (req, res) {
  if (!method(req, res, ['GET', 'POST'])) return;

  await handler(req, res, async () => {
    const d = await db();
    const s = await settings(d);

    if (s.maintenance) {
      return fail(res, 503, 'Maintenance mode');
    }

    const day = dateMM();
    const limit = Number(s.dailyLimit);

    // GET: Read quota without consuming it.
    if (req.method === 'GET') {
      const guestId = req.query?.guestId;

      if (!validId(guestId)) {
        return fail(res, 400, 'Invalid guest ID');
      }

      if (!s.limitEnabled) {
        return res.json({
          ok: true,
          mode: 'free',
          unlimited: true
        });
      }

      if (!Number.isInteger(limit) || limit < 0) {
        return fail(res, 500, 'Invalid limit settings');
      }

      const record = await d.collection('daily_usage').findOne({
        _id: `${day}:${guestId}`
      });

      const used = record ? Number(record.used) || 0 : 0;

      return res.json({
        ok: true,
        mode: 'free',
        used,
        limit,
        remaining: Math.max(0, limit - used)
      });
    }

    const {
      requestId,
      guestId,
      mode = 'free',
      sizeMB
    } = req.body || {};

    if (!validId(requestId)) {
      return fail(res, 400, 'Valid requestId is required');
    }

    if (!['free', 'points'].includes(mode)) {
      return fail(res, 400, 'Invalid access mode');
    }

    const user = await auth(req);

    if (mode === 'points' && !user) {
      return fail(res, 401, 'Login required for points');
    }

    if (mode === 'free' && !validId(guestId)) {
      return fail(res, 400, 'Invalid guest ID');
    }

    let price = 0;
    let usageId = null;
    let mb = 0;

    if (mode === 'points') {
      mb = Number(sizeMB);

      if (!Number.isFinite(mb) || mb <= 0 || mb > 500) {
        return fail(res, 400, 'Unsupported file size');
      }

      const pricing = Array.isArray(s.sizePricing)
        ? [...s.sizePricing].sort(
            (a, b) => Number(a.maxMB) - Number(b.maxMB)
          )
        : [];

      const tier = pricing.find(
        x =>
          Number.isFinite(x.maxMB) &&
          x.maxMB > 0 &&
          Number.isSafeInteger(x.points) &&
          x.points >= 0 &&
          mb <= x.maxMB
      );

      if (!tier) {
        return fail(res, 400, 'Pricing unavailable');
      }

      price = tier.points;
    } else if (s.limitEnabled) {
      if (!Number.isInteger(limit) || limit < 0) {
        return fail(res, 500, 'Invalid limit settings');
      }

      usageId = `${day}:${guestId}`;
    }

    const jobs = d.collection('compression_jobs');

    // A previously accepted request must not charge again.
    const existing = await jobs.findOne({ _id: requestId });

    if (existing) {
      const sameOwner = user
        ? String(existing.userId || '') === String(user._id)
        : !existing.userId && existing.guestId === guestId;

      if (!sameOwner) {
        return fail(res, 409, 'Request ID already used');
      }

      return res.json({
        ok: true,
        jobId: existing._id,
        mode: existing.mode,
        status: existing.status,
        duplicate: true,
        charged: existing.charged || 0,
        remainingPoints: existing.remainingPoints,
        unlimited: existing.unlimited
      });
    }

    let response;

    try {
      response = await withTransaction(async (database, session) => {
        const txJobs = database.collection('compression_jobs');
        const txUsers = database.collection('users');
        const txUsage = database.collection('daily_usage');

        // Recheck inside the transaction to reduce duplicate charging.
        const duplicate = await txJobs.findOne(
          { _id: requestId },
          { session }
        );

        if (duplicate) {
          const sameOwner = user
            ? String(duplicate.userId || '') === String(user._id)
            : !duplicate.userId &&
              duplicate.guestId === guestId;

          if (!sameOwner) {
            throw Object.assign(
              new Error('Request ID already used'),
              { statusCode: 409 }
            );
          }

          return {
            ok: true,
            jobId: duplicate._id,
            mode: duplicate.mode,
            status: duplicate.status,
            duplicate: true,
            charged: duplicate.charged || 0,
            remainingPoints: duplicate.remainingPoints,
            unlimited: duplicate.unlimited
          };
        }

        let remainingPoints;
        let used;
        let unlimited = false;

        if (mode === 'points') {
          const updatedUser = await txUsers.findOneAndUpdate(
            {
              _id: user._id,
              points: { $gte: price }
            },
            { $inc: { points: -price } },
            {
              returnDocument: 'after',
              session
            }
          );

          if (!updatedUser) {
            throw Object.assign(
              new Error('Insufficient points'),
              { statusCode: 402 }
            );
          }

          remainingPoints = updatedUser.points;
        } else if (!s.limitEnabled) {
          unlimited = true;
        } else {
          await txUsage.updateOne(
            { _id: usageId },
            {
              $setOnInsert: {
                used: 0,
                day,
                guestId,
                createdAt: new Date()
              }
            },
            { upsert: true, session }
          );

          const updatedUsage = await txUsage.findOneAndUpdate(
            {
              _id: usageId,
              used: { $lt: limit }
            },
            { $inc: { used: 1 } },
            {
              returnDocument: 'after',
              session
            }
          );

          if (!updatedUsage) {
            throw Object.assign(
              new Error(
                'Daily free limit reached. Try tomorrow or use points.'
              ),
              { statusCode: 429 }
            );
          }

          used = updatedUsage.used;
        }

        const job = {
          _id: requestId,
          mode,
          status: 'processing',
          day,
          guestId: mode === 'free' ? guestId : null,
          userId: user?._id || null,
          charged: mode === 'points' ? price : (unlimited ? 0 : 1),
          usageId,
          sizeMB: mode === 'points' ? mb : undefined,
          unlimited,
          refunded: false,
          createdAt: new Date(),
          updatedAt: new Date()
        };

        if (remainingPoints !== undefined) {
          job.remainingPoints = remainingPoints;
        }

        await txJobs.insertOne(job, { session });

        return {
          ok: true,
          jobId: requestId,
          mode,
          status: 'processing',
          charged: job.charged,
          remainingPoints,
          used,
          limit: mode === 'free' && !unlimited ? limit : undefined,
          remaining:
            mode === 'free' && !unlimited
              ? Math.max(0, limit - used)
              : undefined,
          unlimited
        };
      });
    } catch (error) {
      if (error.statusCode) {
        return fail(res, error.statusCode, error.message);
      }

      // A concurrent request may have created the same ID.
      if (error.code === 11000) {
        return fail(res, 409, 'Duplicate request ID');
      }

      throw error;
    }

    return res.json(response);
  });
}
