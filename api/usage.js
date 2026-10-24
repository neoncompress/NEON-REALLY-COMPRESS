import {
  db,
  settings,
  auth,
  handler,
  method,
  fail,
  dateMM
} from '../lib/core.js';

export default async function (req, res) {
  if (!method(req, res, ['POST'])) return;

  await handler(req, res, async () => {
    const d = await db();
    const s = await settings(d);

    // Maintenance mode
    if (s.maintenance) {
      return fail(res, 503, 'Maintenance mode');
    }

    const {
      guestId,
      mode = 'free',
      sizeMB
    } = req.body || {};

    // Reject unsupported modes
    if (!['free', 'points'].includes(mode)) {
      return fail(res, 400, 'Invalid access mode');
    }

    const user = await auth(req);

    // Paid points mode
    if (mode === 'points') {
      if (!user) {
        return fail(res, 401, 'Login required for points');
      }

      const mb = Number(sizeMB);

      if (
        !Number.isFinite(mb) ||
        mb <= 0 ||
        mb > 500
      ) {
        return fail(res, 400, 'Unsupported file size');
      }

      const pricing = Array.isArray(s.sizePricing)
        ? [...s.sizePricing].sort((a, b) => a.maxMB - b.maxMB)
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

      const result = await d.collection('users').findOneAndUpdate(
        {
          _id: user._id,
          points: { $gte: price }
        },
        {
          $inc: { points: -price }
        },
        {
          returnDocument: 'after'
        }
      );

      if (!result) {
        return fail(res, 402, 'Insufficient points');
      }

      return res.json({
        ok: true,
        mode: 'points',
        charged: price,
        remainingPoints: result.points
      });
    }

    // Free daily quota
    if (
      typeof guestId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(guestId)
    ) {
      return fail(res, 400, 'Invalid guest ID');
    }

    if (!s.limitEnabled) {
      return res.json({
        ok: true,
        unlimited: true
      });
    }

    const day = dateMM();
    const limit = Number(s.dailyLimit);

    if (
      !Number.isInteger(limit) ||
      limit < 0
    ) {
      return fail(res, 500, 'Invalid limit settings');
    }

    // Use the collection already created in MongoDB Atlas.
    const coll = d.collection('daily_usage');
    const id = `${day}:${guestId}`;

    await coll.updateOne(
      { _id: id },
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

    const result = await coll.findOneAndUpdate(
      {
        _id: id,
        used: { $lt: limit }
      },
      {
        $inc: { used: 1 }
      },
      {
        returnDocument: 'after'
      }
    );

    if (!result) {
      return fail(
        res,
        429,
        'Daily free limit reached. Try tomorrow or use points.'
      );
    }

    return res.json({
      ok: true,
      mode: 'free',
      used: result.used,
      remaining: Math.max(0, limit - result.used)
    });
  });
}
