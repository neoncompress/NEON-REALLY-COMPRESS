import {
  auth,
  handler,
  method,
  fail,
  withTransaction
} from '../lib/core.js';

const validId = value =>
  typeof value === 'string' &&
  /^[a-f0-9-]{36}$/i.test(value);

export default async function (req, res) {
  if (!method(req, res, ['POST'])) return;

  await handler(req, res, async () => {
    const {
      jobId,
      guestId,
      outcome
    } = req.body || {};

    if (!validId(jobId)) {
      return fail(res, 400, 'Invalid job ID');
    }

    if (!['success', 'failed'].includes(outcome)) {
      return fail(res, 400, 'Invalid outcome');
    }

    const user = await auth(req);

    if (!user && !validId(guestId)) {
      return fail(res, 400, 'Invalid guest ID');
    }

    const result = await withTransaction(async (d, session) => {
      const jobs = d.collection('compression_jobs');
      const users = d.collection('users');
      const usage = d.collection('daily_usage');

      const job = await jobs.findOne(
        { _id: jobId },
        { session }
      );

      if (!job) {
        return {
          statusCode: 404,
          body: { error: 'Compression job not found' }
        };
      }

      // Verify ownership.
      if (job.userId) {
        if (!user || String(user._id) !== String(job.userId)) {
          return {
            statusCode: 403,
            body: { error: 'Not authorized for this job' }
          };
        }
      } else if (job.guestId !== guestId) {
        return {
          statusCode: 403,
          body: { error: 'Guest ID does not match' }
        };
      }

      // Repeated success reports do not modify the job again.
      if (job.status === 'completed' && outcome === 'success') {
        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'completed',
            refunded: false,
            duplicate: true
          }
        };
      }

      // Repeated failure reports cannot issue another refund.
      if (job.status === 'refunded' && outcome === 'failed') {
        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'refunded',
            refunded: true,
            duplicate: true
          }
        };
      }

      if (job.status !== 'processing') {
        return {
          statusCode: 409,
          body: {
            error: 'Job is no longer processing',
            status: job.status
          }
        };
      }

      if (outcome === 'success') {
        await jobs.updateOne(
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
          },
          { session }
        );

        return {
          statusCode: 200,
          body: {
            ok: true,
            status: 'completed',
            refunded: false
          }
        };
      }

      // Refund the amount actually recorded for this job.
      if (job.mode === 'points') {
        if (!job.userId) {
          throw new Error('Points job has no user ID');
        }

        const pointsToReturn = Number(job.charged);

        if (
          !Number.isSafeInteger(pointsToReturn) ||
          pointsToReturn < 0
        ) {
          throw new Error('Invalid recorded points charge');
        }

        await users.updateOne(
          { _id: job.userId },
          { $inc: { points: pointsToReturn } },
          { session }
        );
      } else if (
        job.mode === 'free' &&
        !job.unlimited
      ) {
        if (!job.usageId) {
          throw new Error('Free job has no usage record');
        }

        const usageRecord = await usage.findOne(
          { _id: job.usageId },
          { session }
        );

        if (!usageRecord || Number(usageRecord.used) < 1) {
          throw new Error('Cannot safely restore free quota');
        }

        await usage.updateOne(
          {
            _id: job.usageId,
            used: { $gt: 0 }
          },
          { $inc: { used: -1 } },
          { session }
        );
      }

      await jobs.updateOne(
        {
          _id: jobId,
          status: 'processing',
          refunded: false
        },
        {
          $set: {
            status: 'refunded',
            refunded: true,
            refundReason: 'client_reported_failure',
            updatedAt: new Date()
          }
        },
        { session }
      );

      return {
        statusCode: 200,
        body: {
          ok: true,
          status: 'refunded',
          refunded: true,
          mode: job.mode
        }
      };
    });

    return res.status(result.statusCode).json(result.body);
  });
}
