import { randomUUID } from 'node:crypto';
import {
  db,
  settings,
  auth,
  handler,
  method,
  fail,
  dateMM
} from '../lib/core.js';

const validGuestId = value =>
  typeof value === 'string' &&
  /^[a-f0-9-]{36}$/i.test(value);

const validRequestId = value =>
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
    const jobs = d.collection('compression_jobs');

    // GET: Read current free quota.
    if (req.method === 'GET') {
      const guestId = req.query?.guestId;

      if (!validGuestId(guestId)) {
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

    // POST: Authorize one compression job.
    const {
      guestId,
      mode = 'free',
      sizeMB,
      requestId
    } = req.body || {};

    if (!validRequestId(requestId)) {
      return fail(res, 400, 'Valid requestId is required');
    }

    if (!['free', 'points'].includes(mode)) {
      return fail(res, 400, 'Invalid access mode');
    }

    const user = await auth(req);

    // A request ID can only be used by its original owner.
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

    const jobBase = {
      _id: requestId,
      mode,
      status: 'processing',
      day,
      guestId: validGuestId(guestId) ? guestId : null,
      userId: user?._id || null,
      refunded: false,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Points mode.
    if (mode === 'points') {
      if (!user) {
        return fail(res, 401, 'Login required for points');
      }

      const mb = Number(sizeMB);

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

      const price = tier.points;

      // Reserve this request ID before charging.
      try {
        await jobs.insertOne({
          ...jobBase,
          charged: price,
          sizeMB: mb
        });
      } catch (e) {
        if (e.code === 11000) {
          return fail(res, 409, 'Duplicate request ID');
        }
        throw e;
      }

      const result = await d.collection('users').findOneAndUpdate(
        {
          _id: user._id,
          points: { $gte: price }
        },
        { $inc: { points: -price } },
        { returnDocument: 'after' }
      );

      if (!result) {
        await jobs.updateOne(
          { _id: requestId, status: 'processing' },
          {
            $set: {
              status: 'rejected',
              updatedAt: new Date()
            }
          }
        );

        return fail(res, 402, 'Insufficient points');
      }

      await jobs.updateOne(
        { _id: requestId },
        {
          $set: {
            remainingPoints: result.points,
            updatedAt: new Date()
          }
        }
      );

      return res.json({
        ok: true,
        jobId: requestId,
        mode: 'points',
        status: 'processing',
        charged: price,
        remainingPoints: result.points
      });
    }

    // Free mode requires a guest ID.
    if (!validGuestId(guestId)) {
      return fail(res, 400, 'Invalid guest ID');
    }

    // Unlimited mode still receives a job ID, but has no quota to refund.
    if (!s.limitEnabled) {
      await jobs.insertOne({
        ...jobBase,
        unlimited: true,
        charged: 0
      });

      return res.json({
        ok: true,
        jobId: requestId,
        mode: 'free',
        status: 'processing',
        unlimited: true
      });
    }

    if (!Number.isInteger(limit) || limit < 0) {
      return fail(res, 500, 'Invalid limit settings');
    }

    const usage = d.collection('daily_usage');
    const usageId = `${day}:${guestId}`;

    await usage.updateOne(
      { _id: usageId },
      {
        $setOnInsert: {
          used: 0,
          day,
          guestId,
          createdAt: new Date()
        }
      },
      { upsert: true }
    );

    // Reserve job first, then charge quota.
    try {
      await jobs.insertOne({
        ...jobBase,
        charged: 1,
        usageId
      });
    } catch (e) {
      if (e.code === 11000) {
        return fail(res, 409, 'Duplicate request ID');
      }
      throw e;
    }

    const result = await usage.findOneAndUpdate(
      {
        _id: usageId,
        used: { $lt: limit }
      },
      { $inc: { used: 1 } },
      { returnDocument: 'after' }
    );

    if (!result) {
      await jobs.updateOne(
        { _id: requestId, status: 'processing' },
        {
          $set: {
            status: 'rejected',
            updatedAt: new Date()
          }
        }
      );

      return fail(
        res,
        429,
        'Daily free limit reached. Try tomorrow or use points.'
      );
    }

    return res.json({
      ok: true,
      jobId: requestId,
      mode: 'free',
      status: 'processing',
      used: result.used,
      limit,
      remaining: Math.max(0, limit - result.used)
    });
  });
}
