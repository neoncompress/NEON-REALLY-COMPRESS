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

    // Refresh the custom dark dropdown menus.
    window.neonDropdowns?.package?.render();
    window.neonDropdowns?.method?.render();

    await showAccount();

  } catch (e) {
    el('quotaStatus').textContent = 'Backend not connected';
    el('neonPaymentInfo').textContent = e.message;
  }
}

async function showAccount() {
  const adminLink = el('adminDashboardLink');

  // The dashboard link is visible only to an authenticated admin account.
  if (adminLink) {
    adminLink.hidden = true;
    adminLink.style.display = 'none';
  }

  const pointBadge = el('mainPointBalance');

  if (!token()) {
    el('neonAccount').textContent = 'Not logged in';
    if (pointBadge) pointBadge.hidden = true;
    return;
  }

  try {
    const u = await api('auth');

    el('neonAccount').textContent =
      `${u.email} • ${u.points} points`;

    if (pointBadge) {
      const points = Number(u.points || 0);
      pointBadge.textContent =
        `${points.toLocaleString()} POINTS LEFT`;
      pointBadge.hidden = false;
    }

    if (adminLink && u.role === 'admin') {
      adminLink.hidden = false;
      adminLink.style.display = 'inline-block';
    }

  } catch {
    localStorage.removeItem(key);
    el('neonAccount').textContent = 'Please log in again';
    if (pointBadge) pointBadge.hidden = true;
  }
}

// GET POINT page navigation. The entry remains visible to guests;
// opening it requires a valid logged-in account.
const getPointEntry = el('getPointEntry');
const getPointPage = el('getPointPage');
const unlimitedHome = el('unlimitedHome');
const backFromGetPoint = el('backFromGetPoint');

if (getPointEntry && getPointPage && unlimitedHome) {
  getPointEntry.addEventListener('click', async () => {
    if (!token()) {
      el('neonAccount').textContent =
        'Login required — please log in to get points.';
      return;
    }

    try {
      await api('auth');
      unlimitedHome.classList.add('hidden');
      getPointEntry.parentElement.classList.add('hidden');
      getPointPage.classList.remove('hidden');
      el('neonPaymentInfo').textContent = '';
    } catch {
      localStorage.removeItem(key);
      el('neonAccount').textContent =
        'Login required — please log in again to get points.';
      const pointBadge = el('mainPointBalance');
      if (pointBadge) pointBadge.hidden = true;
    }
  });
}

if (backFromGetPoint && getPointPage && unlimitedHome) {
  backFromGetPoint.addEventListener('click', () => {
    getPointPage.classList.add('hidden');
    unlimitedHome.classList.remove('hidden');
    getPointEntry.parentElement.classList.remove('hidden');
  });
}

// Show / hide the account password.
const passwordInput = el('neonPassword');
const passwordToggle = el('toggleNeonPassword');
if (passwordInput && passwordToggle) {
  passwordToggle.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    passwordToggle.setAttribute('aria-pressed', String(show));
    passwordToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    passwordToggle.title = show ? 'Hide password' : 'Show password';
  });
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

  const requestId = crypto.randomUUID();

  localStorage.setItem(pendingKey, requestId);

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
window.neonFinish = async (
  job,
  success,
  errorMessage = ''
) => {
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
