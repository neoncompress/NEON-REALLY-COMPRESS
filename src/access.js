const el = id => document.getElementById(id);

const key = 'neon_access_token';
const guestKey = 'neon_guest_id';
const pendingKey = 'neon_pending_request_id';

let config = null;

let guest = localStorage.getItem(guestKey);

if (!guest) {
  guest = crypto.randomUUID();
  localStorage.setItem(guestKey, guest);
}

const token = () => localStorage.getItem(key);

async function api(path, method = 'GET', body) {
  let r;

  try {
    r = await fetch('/api/' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token()
          ? { Authorization: 'Bearer ' + token() }
          : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch {
    throw Error(
      'Backend unavailable. Deploy to Vercel to use access controls.'
    );
  }

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    throw Error(data.error || 'Request failed');
  }

  return data;
}

// Load the real saved quota from MongoDB.
async function refreshQuota() {
  if (!config) return;

  if (!config.limitEnabled) {
    el('quotaStatus').textContent = 'Free: unlimited';
    return;
  }

  try {
    const r = await api(
      'usage?guestId=' + encodeURIComponent(guest)
    );

    el('quotaStatus').textContent =
      `Free remaining: ${r.remaining}/${r.limit}`;
  } catch (e) {
    el('quotaStatus').textContent = 'Quota unavailable';
    console.error('Quota refresh failed:', e);
  }
}

async function refresh() {
  try {
    config = await api('config');

    await refreshQuota();

    el('neonPackage').replaceChildren(
      ...config.pointPackages.map(p => {
        const o = document.createElement('option');

        o.value = p.points;
        o.textContent =
          `${p.points} points — ${p.ks.toLocaleString()} Ks`;

        return o;
      })
    );

    el('neonMethod').replaceChildren(
      ...Object.entries(config.payments)
        .filter(([, v]) => v)
        .map(([k]) => {
          const o = document.createElement('option');

          o.value = k;
          o.textContent = k;

          return o;
        })
    );

    await showAccount();
  } catch (e) {
    el('quotaStatus').textContent = 'Backend not connected';
    el('neonPaymentInfo').textContent = e.message;
  }
}

async function showAccount() {
  if (!token()) {
    el('neonAccount').textContent = 'Not logged in';
    return;
  }

  try {
    const u = await api('auth');

    el('neonAccount').textContent =
      `${u.email} • ${u.points} points`;
  } catch {
    localStorage.removeItem(key);
    el('neonAccount').textContent = 'Please log in again';
  }
}

// Register and login.
for (const action of ['register', 'login']) {
  el(
    'neon' + action[0].toUpperCase() + action.slice(1)
  ).onclick = async () => {
    try {
      const r = await api('auth', 'POST', {
        action,
        email: el('neonEmail').value,
        password: el('neonPassword').value
      });

      localStorage.setItem(key, r.token);
      el('neonPassword').value = '';

      await showAccount();
      await refreshQuota();
    } catch (e) {
      el('neonAccount').textContent = e.message;
    }
  };
}

// Logout.
el('neonLogout').onclick = () => {
  localStorage.removeItem(key);
  showAccount();
};

// Request to buy points.
el('neonPay').onclick = async () => {
  try {
    const method = el('neonMethod').value;

    if (!method) {
      throw Error('No payment method configured yet');
    }

    const r = await api('payments', 'POST', {
      points: Number(el('neonPackage').value),
      method,
      reference: el('neonReference').value
    });

    el('neonPaymentInfo').textContent =
      `Request submitted (${r.status}). ` +
      'Admin must verify payment before points are added.';
  } catch (e) {
    el('neonPaymentInfo').textContent = e.message;
  }
};

el('neonMethod').onchange = () => {
  const method = el('neonMethod').value;

  el('neonPaymentInfo').textContent = method
    ? `${method} payment account: ${
        config?.payments?.[method] || 'Not configured'
      }. Pay manually and enter transaction reference.`
    : '';
};

// Authorize compression.
// Keep the same request ID if the request must be retried.
window.neonAuthorize = async file => {
  const mode = el('neonMode').value;

  let requestId = localStorage.getItem(pendingKey);

  if (!requestId) {
    requestId = crypto.randomUUID();
    localStorage.setItem(pendingKey, requestId);
  }

  const r = await api('usage', 'POST', {
    requestId,
    mode,
    guestId: guest,
    sizeMB: file.size / 1048576
  });

  if (!r.jobId) {
    throw Error('Backend did not return a compression job ID');
  }

  if (mode === 'free') {
    el('quotaStatus').textContent = r.unlimited
      ? 'Free: unlimited'
      : `Free remaining: ${r.remaining}/${r.limit}`;
  } else if (Number.isFinite(r.remainingPoints)) {
    el('quotaStatus').textContent =
      `Points remaining: ${r.remainingPoints}`;
  }

  await showAccount();

  return r;
};

// Notify the backend when a compression job ends.
// This requires api/refund.js to support these parameters.
window.neonFinish = async (job, success, errorMessage = '') => {
  if (!job?.jobId) {
    throw Error('Missing compression job ID');
  }

  const result = await api('refund', 'POST', {
    jobId: job.jobId,
    guestId: guest,
    outcome: success ? 'success' : 'failed',
    errorMessage: String(errorMessage).slice(0, 300)
  });

  localStorage.removeItem(pendingKey);

  await refreshQuota();
  await showAccount();

  return result;
};

refresh();
