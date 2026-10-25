import {
  db,
  auth,
  handler,
  method,
  fail
} from '../lib/core.js';

export default async function (req, res) {
  if (!method(req, res, ['POST'])) return;

  await handler(req, res, async () => {
    const d = await db();

    const {
      jobId,
      guestId,
      outcome
    } = req.body || {};

    if (
      typeof jobId !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(jobId)
    ) {
      return fail(res, 400, 'Invalid job ID');
    }

    if (!['success', 'failed'].includes(outcome)) {
      return fail(res, 400, 'Invalid outcome');
    }

    const user = await auth(req);
    const jobs = d.collection('compression_jobs');

    const job = await jobs.findOne({ _id: jobId });

    if (!job) {
      return fail(res, 404, 'Compression job not found');
    }

    // Verify ownership.
    if (job.userId) {
      if (!user || String(user._id) !== String(job.userId)) {
        return fail(res, 403, 'Not authorized for this job');
      }
    } else if (
      !guestId ||
      guestId !== job.guestId
    ) {
      return fail(res, 403, 'Guest ID does not match');
    }

    // A completed job cannot be refunded again.
    if (job.status === 'refunded') {
      return res.json({
        ok: true,
        status: 'refunded',
        duplicate: true
      });
    }

    if (job.status !== 'processing') {
      return fail(res, 409, 'Job is no longer processing');
    }

    // Successful compression: no refund.
    if (outcome === 'success') {
      const result = await jobs.updateOne(
        {
          _id: jobId,
          status: 'processing',
          refunded: false
        },
        {
          $set: {
            status: 'completed',
            updatedAt: new Date()
          }
        }
      );

      if (!result.modifiedCount) {
        return fail(res, 409, 'Job status already changed');
      }

      return res.json({
        ok: true,
        status: 'completed',
        refunded: false
      });
    }

    // Claim the refund first to prevent duplicate refunds.
    const claim = await jobs.updateOne(
      {
        _id: jobId,
        status: 'processing',
        refunded: false
      },
      {
        $set: {
          status: 'refunding',
          updatedAt: new Date()
        }
      }
    );

    if (!claim.modifiedCount) {
      return fail(res, 409, 'Refund already processed');
    }

    // Restore the exact points or free quota charged for this job.
    if (job.mode === 'points' && job.userId) {
      await d.collection('users').updateOne(
        { _id: job.userId },
        { $inc: { points: Number(job.charged) || 0 } }
      );
    } else if (
      job.mode === 'free' &&
      !job.unlimited &&
      job.usageId
    ) {
      await d.collection('daily_usage').updateOne(
        {
          _id: job.usageId,
          used: { $gt: 0 }
        },
        { $inc: { used: -1 } }
      );
    }

    await jobs.updateOne(
      {
        _id: jobId,
        status: 'refunding'
      },
      {
        $set: {
          status: 'refunded',
          refunded: true,
          refundReason: 'client_reported_failure',
          updatedAt: new Date()
        }
      }
    );

    return res.json({
      ok: true,
      status: 'refunded',
      refunded: true,
      mode: job.mode
    });
  });
}
