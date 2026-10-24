import { db, auth, settings, handler, method, fail } from '../lib/core.js';

export default async function (req, res) {
  if (!method(req, res, ['GET', 'POST'])) return;

  await handler(req, res, async () => {
    const user = await auth(req);

    if (!user) {
      return fail(res, 401, 'Login required');
    }

    const d = await db();
    const coll = d.collection('payments');

    // GET: Current user's payment history
    if (req.method === 'GET') {
      const rows = await coll
        .find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(30)
        .toArray();

      return res.json({
        requests: rows.map(x => ({
          id: String(x._id),
          status: x.status,
          points: x.points,
          ks: x.ks,
          method: x.method,
          reference: x.reference,
          createdAt: x.createdAt
        }))
      });
    }

    // POST: Create payment request
    const {
      points,
      method: payMethod,
      reference
    } = req.body || {};

    const s = await settings(d);

    if (
      !Number.isSafeInteger(Number(points)) ||
      !['KBZPay', 'WavePay', 'uabpay'].includes(payMethod) ||
      typeof reference !== 'string'
    ) {
      return fail(res, 400, 'Invalid payment details');
    }

    const normalizedReference = reference.trim();

    if (
      normalizedReference.length < 4 ||
      normalizedReference.length > 120
    ) {
      return fail(res, 400, 'Invalid transaction reference');
    }

    const pkg = s.pointPackages.find(
      p => p.points === Number(points)
    );

    if (!pkg) {
      return fail(res, 400, 'Invalid point package');
    }

    if (
      typeof s.payments?.[payMethod] !== 'string' ||
      !s.payments[payMethod].trim()
    ) {
      return fail(res, 400, 'Payment method unavailable');
    }

    // Reject duplicate transaction references.
    // A database unique index is also required for race safety.
    const existing = await coll.findOne({
      method: payMethod,
      reference: normalizedReference,
      status: { $in: ['pending', 'processing_review', 'approved'] }
    });

    if (existing) {
      return fail(
        res,
        409,
        'This transaction reference has already been submitted'
      );
    }

    try {
      const result = await coll.insertOne({
        userId: user._id,
        email: user.email,
        points: pkg.points,
        ks: pkg.ks,
        method: payMethod,
        reference: normalizedReference,
        status: 'pending',
        createdAt: new Date()
      });

      return res.status(201).json({
        id: String(result.insertedId),
        status: 'pending',
        message: 'Payment submitted. Admin must verify the actual payment before approving.'
      });
    } catch (error) {
      if (error.code === 11000) {
        return fail(
          res,
          409,
          'This transaction reference has already been submitted'
        );
      }

      throw error;
    }
  });
}
