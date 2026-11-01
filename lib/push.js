import webpush from 'web-push';
import { db } from './core.js';

function configured() {
  return Boolean(
    process.env.VAPID_PUBLIC_KEY &&
    process.env.VAPID_PRIVATE_KEY &&
    process.env.VAPID_SUBJECT
  );
}

export function getVapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || '';
}

export async function sendAdminPaymentNotification(payment) {
  if (!configured()) {
    console.warn('Web Push skipped: VAPID environment variables are not configured.');
    return;
  }

  const database = await db();
  const subscriptions = await database
    .collection('admin_push_subscriptions')
    .find({})
    .toArray();

  if (!subscriptions.length) return;

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = JSON.stringify({
    title: 'NEON COMPRESS',
    body: `New payment: ${payment.points} points • ${payment.ks} Ks • ${payment.method}`,
    url: '/admin/',
    tag: `neon-payment-${payment.id}`
  });

  await Promise.all(subscriptions.map(async item => {
    try {
      await webpush.sendNotification(item.subscription, payload, {
        TTL: 60 * 60,
        urgency: 'high'
      });
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        await database.collection('admin_push_subscriptions').deleteOne({
          _id: item._id
        });
      } else {
        console.error('Admin push delivery failed:', error.message);
      }
    }
  }));
}
