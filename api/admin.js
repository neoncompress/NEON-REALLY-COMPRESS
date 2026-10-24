import { ObjectId } from 'mongodb';
import {
  db,
  auth,
  settings,
  handler,
  method,
  fail
} from '../lib/core.js';

export default async function (req, res) {
  if (!method(req, res, ['GET', 'POST'])) return;

  await handler(req, res, async () => {
    const user = await auth(req);

    if (!user || user.role !== 'admin') {
      return fail(res, 403, 'Admin only');
    }

    const d = await db();

    // GET: Admin settings and pending payment requests
    if (req.method === 'GET') {
      const s = await settings(d);

      const requests = await d
        .collection('payments')
        .find({ status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(100)
        .toArray();

      return res.json({
        settings: s,
        requests: requests.map(p => ({
          id: String(p._id),
          email: p.email,
          points: p.points,
          ks: p.ks,
          method: p.method,
          reference: p.reference,
          status: p.status,
          createdAt: p.createdAt
        }))
      });
    }

    const { action } = req.body || {};

    // UPDATE SETTINGS
    if (action === 'settings') {
      const {
        dailyLimit,
        limitEnabled,
        maintenance,
        pointPackages,
        sizePricing,
        payments
      } = req.body;

      const validPackages =
        Array.isArray(pointPackages) &&
        pointPackages.length > 0 &&
        pointPackages.length <= 20 &&
        pointPackages.every(p =>
          Number.isSafeInteger(p.points) &&
          p.points > 0 &&
          Number.isSafeInteger(p.ks) &&
          p.ks > 0
        ) &&
        new Set(pointPackages.map(p => p.points)).size ===
          pointPackages.length;

      const validSizes =
        Array.isArray(sizePricing) &&
        sizePricing.length > 0 &&
        sizePricing.length <= 30 &&
        sizePricing.every(p =>
          Number.isFinite(p.maxMB) &&
          p.maxMB > 0 &&
          Number.isSafeInteger(p.points) &&
          p.points >= 0
        ) &&
        [...sizePricing]
          .sort((a, b) => a.maxMB - b.maxMB)
          .every((p, i, arr) =>
            i === 0 || p.maxMB > arr[i - 1].maxMB
          );

      const validPayments =
        payments &&
        ['KBZPay', 'WavePay', 'uabpay'].every(k =>
          typeof payments[k] === 'string' &&
          payments[k].length <= 120
        );

      if (
        !Number.isInteger(dailyLimit) ||
        dailyLimit < 0 ||
        dailyLimit > 10000 ||
        typeof limitEnabled !== 'boolean' ||
        typeof maintenance !== 'boolean' ||
        !validPackages ||
        !validSizes ||
        !validPayments
      ) {
        return fail(res, 400, 'Invalid settings');
      }

      await d.collection('settings').updateOne(
        { _id: 'main' },
        {
          $set: {
            dailyLimit,
            limitEnabled,
            maintenance,
            pointPackages,
            sizePricing: [...sizePricing].sort(
              (a, b) => a.maxMB - b.maxMB
            ),
            payments: {
              KBZPay: payments.KBZPay,
              WavePay: payments.WavePay,
              uabpay: payments.uabpay
            },
            updatedAt: new Date(),
            updatedBy: user.email
          }
        },
        { upsert: true }
      );

      return res.json({ ok: true });
    }

    // REVIEW PAYMENT
    if (action === 'review') {
      const { id, decision } = req.body || {};

      if (
        typeof id !== 'string' ||
        !ObjectId.isValid(id) ||
        !['approved', 'rejected'].includes(decision)
      ) {
        return fail(res, 400, 'Invalid review');
      }

      const payments = d.collection('payments');
      const paymentId = new ObjectId(id);

      // Claim the pending request so it cannot be reviewed twice.
      const claimed = await payments.findOneAndUpdate(
        {
          _id: paymentId,
          status: 'pending'
        },
        {
          $set: {
            status: 'processing_review',
            reviewDecision: decision,
            reviewStartedAt: new Date(),
            reviewedBy: user.email
          }
        },
        { returnDocument: 'after' }
      );

      const payment = claimed;

      if (!payment) {
        return fail(
          res,
          409,
          'Payment is already being reviewed or has been reviewed'
        );
      }

      // Rejection does not add points.
      if (decision === 'rejected') {
        await payments.updateOne(
          {
            _id: paymentId,
            status: 'processing_review',
            reviewDecision: 'rejected'
          },
          {
            $set: {
              status: 'rejected',
              reviewedAt: new Date()
            },
            $unset: {
              reviewDecision: '',
              reviewStartedAt: ''
            }
          }
        );

        return res.json({ ok: true, status: 'rejected' });
      }

      // Credit points idempotently using the payment ID as a ledger key.
      const users = d.collection('users');
      const creditKey = String(paymentId);

      const credit = await users.updateOne(
        {
          _id: payment.userId,
          creditedPayments: { $ne: creditKey }
        },
        {
          $inc: { points: payment.points },
          $addToSet: { creditedPayments: creditKey }
        }
      );

      if (credit.modifiedCount !== 1) {
        // Do not falsely mark this payment as approved.
        // Keep it recoverable for manual admin investigation.
        await payments.updateOne(
          {
            _id: paymentId,
            status: 'processing_review'
          },
          {
            $set: {
              status: 'credit_error',
              creditErrorAt: new Date()
            }
          }
        );

        return fail(
          res,
          500,
          'Points credit failed. Check the user and payment records before retrying.'
        );
      }

      await payments.updateOne(
        {
          _id: paymentId,
          status: 'processing_review',
          reviewDecision: 'approved'
        },
        {
          $set: {
            status: 'approved',
            reviewedAt: new Date()
          },
          $unset: {
            reviewDecision: '',
            reviewStartedAt: ''
          }
        }
      );

      return res.json({
        ok: true,
        status: 'approved',
        points: payment.points
      });
    }

    return fail(res, 400, 'Unknown action');
  });
}
