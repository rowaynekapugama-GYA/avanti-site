// What happens after an order changes status. Called only when the status really changed,
// so a webhook delivered twice never sends two emails.
import { config } from './core.js';
import { transition, loadOrder, recordCustomer } from './orders.js';
import { sendEmail, orderEmail } from './email.js';

export async function afterTransition(d, orderId, from, to, cfg = config()) {
  const o = await loadOrder(d, orderId);
  if (!o) return;
  if (to === 'paid') await recordCustomer(d, o);
  // an unpaid checkout that is cancelled is housekeeping, not something to email about
  if (to === 'cancelled' && from === 'pending_payment') return;
  if (to === 'delivered') return;
  const m = orderEmail(to, o, cfg);
  if (m) await sendEmail(d, { kind: 'transactional', template: `order-${to}`, to: o.email, order_id: o.id, customer_id: o.customer_id, ...m }, cfg);
}

export const move = (d, orderId, to, actor, note, data, cfg = config()) =>
  transition(d, orderId, to, actor, note, data, { after: (id, from, status) => afterTransition(d, id, from, status, cfg) });

// Payment confirmed by the provider (webhook or server-side capture). Checks the amount matches.
export async function markPaid(d, order, { actor, providerRef, providerStatus, amountCents }, cfg = config()) {
  if (amountCents != null && amountCents !== order.total_cents) {
    await d.insert('order_events', { order_id: order.id, from_status: order.status, to_status: order.status, actor,
      note: `Payment amount ${amountCents} does not match order total ${order.total_cents}; not marked paid. Please check with the payment provider.` });
    return { changed: false, mismatch: true };
  }
  return move(d, order.id, 'paid', actor, null, { provider_ref: providerRef || '', provider_status: providerStatus || 'paid' }, cfg);
}
