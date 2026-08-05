import { query } from './db.js';

// Helpers: strip HTML, decode common entities, normalize text
function stripHtml(html = '') {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

function decodeEntities(str = '') {
  return String(str || '')
    .replace(/&quot;|&#34;|#x22;/gi, '"')
    .replace(/&apos;|&#39;|#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ');
}

function normalizeText(s = '') {
  return decodeEntities(String(s || ''))
    .toLowerCase()
    .replace(/\u00A0/g, ' ')
    .replace(/[^a-z0-9а-яё\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Very small heuristic auto-verifier: checks review.link_or_screenshot and text
// against order metadata. Returns { confidence: 0..1, reason }
export async function autoVerifyReviewById(review) {
  if (!review) return { confidence: 0, reason: 'no review' };

  // fetch order metadata
  const orderRes = await query(`SELECT id, funpay_order_id, buyer FROM orders WHERE id = $1 LIMIT 1`, [review.order_id]);
  const order = orderRes.rows[0] || null;

  if (!order) return { confidence: 0, reason: 'order not found' };

  const link = String(review.link_or_screenshot || '').toLowerCase();
  const rawText = String(review.text || '').trim();
  const text = normalizeText(rawText);
  const buyer = normalizeText(String(order.buyer || ''));
  const funpayId = String(order.funpay_order_id || '').toLowerCase();

  // If link contains funpay order id or buyer name, high confidence
  if (funpayId && link.includes(funpayId)) {
    return { confidence: 0.95, reason: 'link contains funpay order id' };
  }

  if (buyer && (link.includes(buyer) || text.includes(buyer))) {
    return { confidence: 0.85, reason: 'buyer nickname present' };
  }

  // If link is present but no exact match, medium confidence
  if (link) return { confidence: 0.5, reason: 'link present but no match' };

  // fallback to checking textual overlap (very weak)
  const common = (text.split(/\s+/).filter(Boolean) || []).filter((w) => buyer.includes(w)).length;
  if (common >= 2) return { confidence: 0.6, reason: 'text overlap with buyer' };

  // Try platform-specific checks for FunPay when order id is known
  try {
    if ((review.platform || '').toLowerCase() === 'funpay' && funpayId) {
      const candidates = [
        `https://funpay.ru/orders/${funpayId}`,
        `https://funpay.ru/order/${funpayId}`,
        `https://funpay.com/orders/${funpayId}`,
      ];

      for (const url of candidates) {
        try {
          const resp = await globalThis.fetch(url, { method: 'GET' });
          if (!resp || !resp.ok) continue;
          const htmlRaw = await resp.text();
          const html = normalizeText(stripHtml(htmlRaw));

          // if the page contains the normalized review text - strong signal
          if (text && text.length > 10 && html.includes(text)) {
            return { confidence: 0.98, reason: 'funpay page contains review text' };
          }

          // match submitter username or buyer name on the page (normalized)
          if (review.user_id && html.includes(normalizeText(String(review.user_id)))) {
            return { confidence: 0.9, reason: 'funpay page contains submitter username' };
          }

          if (buyer && html.includes(buyer)) {
            return { confidence: 0.85, reason: 'funpay page contains buyer name' };
          }
        } catch (err) {
          // ignore and try next
          continue;
        }
      }
    }
  } catch (err) {
    // non-fatal; fall through to low evidence
  }

  return { confidence: 0.2, reason: 'no evidence' };
}

export default { autoVerifyReviewById };
