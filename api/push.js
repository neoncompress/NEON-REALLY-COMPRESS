import { db, auth, handler, method, fail } from '../lib/core.js';
import { getVapidPublicKey } from '../lib/push.js';

export default async function (req, res) {
  if (!method(req, res, ['GET', 'POST', 'DELETE'])) return;

  await handler(req, res, async () => {
    const user = await auth(req);
    if (!user || user.role !== 'admin') {
      return fail(res, 403, 'Admin only');
    }

    if (req.method === 'GET') {
      if (!getVapidPublicKey()) {
        return fail(res, 503, 'Push notifications are not configured on the server.');
      }
      return res.json({ publicKey: getVapidPublicKey() });
    }

    const d = await db();
    const collection = d.collection('admin_push_subscriptions');

    if (req.method === 'DELETE') {
      const { endpoint } = req.body || {};
      if (typeof endpoint === 'string') {
        await collection.deleteOne({ endpoint, userId: user._id });
      }
      return res.json({ ok: true });
    }

    const { subscription } = req.body || {};
    if (
      !subscription ||
      typeof subscription.endpoint !== 'string' ||
      !subscription.keys ||
      typeof subscription.keys.p256dh !== 'string' ||
      typeof subscription.keys.auth !== 'string' ||
      subscription.endpoint.length > 3000
    ) {
      return fail(res, 400, 'Invalid push subscription');
    }

    await collection.updateOne(
      { endpoint: subscription.endpoint },
      {
        $set: {
          userId: user._id,
          email: user.email,
          subscription,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    return res.json({ ok: true });
  });
}
