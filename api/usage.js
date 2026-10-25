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

const httpError = (statusCode, message) =>
  Object.assign(new Error(message), { statusCode });

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

    // Read quota without consuming it.
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

      const tier = pricing.find(x =>
        Number.isFinite(Number(x.maxMB)) &&
        Number(x.maxMB) > 0 &&
        Number.isSafeInteger(Number(x.points)) &&
        Number(x.points) >= 0 &&
        mb <= Number(x.maxMB)
      );

      if (!tier) {
        return fail(res, 400, 'Pricing unavailable');
      }

      price = Number(tier.points);
    } else if (s.limitEnabled) {
      if (!Number.isInteger(limit) || limit < 0) {
        return fail(res, 500, 'Invalid limit settings');
      }

      usageId = `${day}:${guestId}`;
    }

    const jobs = d.collection('compression_jobs');

    // Check whether this request ID has already been used.
    const existing = await jobs.findOne({ _id: requestId });

    if (existing) {
      const sameOwner = user
        ? String(existing.userId || '') === String(user._id)
        : !existing.userId &&
          existing.guestId === guestId;

      if (!sameOwner) {
        return fail(res, 409, 'Request ID already used');
      }

      // Only a job still processing can be returned for reuse.
      // Completed/refunded jobs must never be restarted with
      // the same request ID.
      if (existing.status !== 'processing') {
        return fail(
          res,
          409,
          `This request has already ended (${existing.status}). Start a new request.`
        );
      }

      // Also reject attempts to reuse the ID for another mode.
      if (existing.mode !== mode) {
        return fail(res, 409, 'Request ID belongs to another mode');
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

        // Recheck inside the transaction.
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
            throw httpError(409, 'Request ID already used');
          }

          if (
            duplicate.status !== 'processing' ||
            duplicate.mode !== mode
          ) {
            throw httpError(
              409,
              'This request has already ended or belongs to another mode. Start a new request.'
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
            throw httpError(402, 'Insufficient points');
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
