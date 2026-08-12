(() => {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/account/dashboard.css';
  document.head.append(stylesheet);

  const app = document.querySelector('#trackApp');
  const form = document.querySelector('#track');
  const query = new URLSearchParams(location.search);
  const status = value => String(value || '').replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  const escapeHtml = value => String(value || '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

  if (query.get('order')) form.querySelector('[name="orderId"]').value = query.get('order');
  if (query.get('email')) form.querySelector('[name="email"]').value = query.get('email');

  form.onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    app.innerHTML = '<p class="note">Finding your order…</p>';
    try {
      const response = await fetch('/.netlify/functions/admin?action=store/track-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'We could not find that order.');
      const order = result.order;
      const tracking = order.trackingNumber
        ? `<p><strong>${escapeHtml(order.deliveryPartner || 'Courier')} tracking:</strong> ${escapeHtml(order.trackingNumber)}</p>`
        : '<p class="note">Tracking details will appear here once the order has been shipped.</p>';
      app.innerHTML = `<article class="order-card"><div class="order-top"><div><strong>${escapeHtml(order.id)}</strong><small>Placed ${new Date(order.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</small></div><span class="order-status">${escapeHtml(status(order.fulfillmentStatus))}</span></div><div class="order-items">${order.items.map(item => `<p>${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</p>`).join('')}</div><p class="order-total">Total <strong>₹${Number(order.total || 0).toLocaleString('en-IN')}</strong></p>${tracking}</article>`;
    } catch (error) {
      app.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
    }
  };

  if (query.get('order') && query.get('email')) form.requestSubmit();
})();
