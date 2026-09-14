function stripHtml(value = '') {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function getClassText(html, className) {
  const pattern = new RegExp(`<[^>]*class=(['"])[^'"]*\\b${className}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(pattern);
  return match ? stripHtml(match[2]) : null;
}

function getBuyerId(html) {
  const match = html.match(/data-href=(['"])[^'"]*\/users\/(\d+)\/?[^'"]*\1/i);
  return match ? Number(match[2]) : null;
}

export function parseFunpayOrderIdFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;

  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let normalized = trimmed;
  if (normalized.startsWith('//')) normalized = `https:${normalized}`;
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = normalized.startsWith('/')
      ? `https://funpay.com${normalized}`
      : `https://funpay.com/${normalized}`;
  }

  try {
    const url = new URL(normalized);
    const orderPathMatch = url.pathname.match(/\/(?:orders?|chats?)\/(\d+)(?:\/)?$/i);
    if (orderPathMatch) return Number(orderPathMatch[1]);

    if (/\/(?:orders?|chats?)(?:\/)?$/i.test(url.pathname)) {
      const orderIdFromQuery = ['id', 'order_id', 'orderId'].find((key) => url.searchParams.has(key));
      if (orderIdFromQuery) {
        const value = Number(url.searchParams.get(orderIdFromQuery));
        if (Number.isSafeInteger(value) && value > 0) return value;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function parseNumericValue(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseLotId(html, logger = console) {
  const decoded = html
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');

  const hrefMatches = [...decoded.matchAll(/(?:data-)?href\s*=\s*(['"])(.*?)\1/gi)];
  for (const match of hrefMatches) {
    const rawUrl = match[2];
    try {
      const url = new URL(rawUrl.startsWith('http') ? rawUrl : rawUrl.startsWith('//') ? `https:${rawUrl}` : `https://funpay.com${rawUrl}`);

      if (parseFunpayOrderIdFromUrl(url.toString()) !== null) {
        continue;
      }

      const queryId = ['offer_id', 'lot_id', 'offerId', 'lotId', 'id']
        .find((key) => url.searchParams.has(key) && !/\/(?:orders?|chats?)(?:\/)?$/i.test(url.pathname));
      if (queryId) {
        const value = parseNumericValue(url.searchParams.get(queryId));
        if (value !== null) return value;
      }

      const pathMatch = url.pathname.match(/\/(?:offer|lot|product)\/(\d+)(?:\/)?$/i);
      if (pathMatch) {
        const value = parseNumericValue(pathMatch[1]);
        if (value !== null) return value;
      }
    } catch {
      // Ignore invalid href values; the literal regex fallback below still handles direct HTML attributes.
    }
  }

  const patterns = [
    /(?:data-)?lot-id\s*=\s*(['"])(\d+)\1/i,
    /(?:data-)?offer-id\s*=\s*(['"])(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/offer\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/lot\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/product\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?offer_id=(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?lot_id=(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?id=(\d+)\1/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern) || decoded.match(pattern);
    if (match) return Number(match[2] || match[1]);
  }

  logger?.debug?.(`FunPay lot detection failed; sample=${String(html || '').slice(0, 600).replace(/\s+/g, ' ').trim()}`);
  return null;
}

// The quantity is order metadata, not part of the offer description.  Read only
// stable data attributes or a labelled value from FunPay's order markup.
export function parseSelectedLotsCount(html) {
  const source = String(html || '');
  const dataAttribute = source.match(
    /\bdata-(?:selected-)?(?:lot(?:s)?-?count|quantity|qty)\s*=\s*(['"])(\d+)\1/i,
  );
  if (dataAttribute) return parseNumericValue(dataAttribute[2]);

  // Handles markup such as "Количество: <span>3</span>" without depending on
  // generated CSS class names. Do not inspect order-desc: its title may contain
  // unrelated numbers (hours, rating, or #1).
  const labelledValue = source.match(
    /(?:Количество|Кол(?:-?во)?|Quantity|Lots?)\s*(?:<[^>]*>\s*){0,3}[:：]?\s*(?:<[^>]*>\s*){0,3}(\d+)\b/iu,
  );
  return labelledValue ? parseNumericValue(labelledValue[1]) : null;
}

function parsePrice(text) {
  if (!text) return null;
  const num = text.replace(/[^\d.,]/g, '').replace(',', '.');
  return num ? Number(num) : null;
}

export function parseNewOrders(html, logger = console) {
  const starts = [...html.matchAll(/<[^>]*class=(['"])[^'"]*\btc-item\b[^'"]*\binfo\b[^'"]*\1[^>]*>/gi)];
  const orders = [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index;
    const end = starts[index + 1]?.index ?? html.length;
    const row = html.slice(start, end);
    const orderNumber = getClassText(row, 'tc-order')?.replace(/^#/, '').trim();
    if (!orderNumber) continue;

    const description = getClassText(row, 'order-desc');
    const lotId = parseLotId(row, logger);
    if (!lotId) {
      logger?.debug?.(`FunPay order #${orderNumber}: no lotId in trade row; rowPreview=${String(row).slice(0, 600).replace(/\s+/g, ' ').trim()}`);
    }

    orders.push({
      funpayOrderId: orderNumber,
      buyerId: getBuyerId(row),
      buyerUsername: getClassText(row, 'media-user-name'),
      price: parsePrice(getClassText(row, 'tc-price')),
      status: getClassText(row, 'tc-status'),
      description,
      lotId,
      // null deliberately reaches the handler, which applies the safe fallback
      // and logs a warning with the order and offer identifiers.
      selectedLotsCount: parseSelectedLotsCount(row),
      createdLabel: getClassText(row, 'tc-date-time'),
    });
  }

  return orders;
}
