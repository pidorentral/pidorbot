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
    const orderPathMatch = url.pathname.match(/\/(?:orders?|chats?)\/([^/?#]+)(?:\/)?$/i);
    if (orderPathMatch) {
      const value = orderPathMatch[1].trim();
      if (!value) return null;
      const numeric = Number(value);
      return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : value;
    }

    if (/\/(?:orders?|chats?)(?:\/)?$/i.test(url.pathname)) {
      const orderIdFromQuery = ['id', 'order_id', 'orderId'].find((key) => url.searchParams.has(key));
      if (orderIdFromQuery) {
        const rawValue = String(url.searchParams.get(orderIdFromQuery) ?? '').trim();
        if (!rawValue) return null;
        const numeric = Number(rawValue);
        if (/^\d+$/.test(rawValue) && Number.isSafeInteger(numeric) && numeric > 0) return numeric;
        return rawValue;
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

function isCanonicalOfferCandidate(rawValue) {
  if (typeof rawValue !== 'string') return false;
  const trimmed = rawValue.trim();
  return /^\d+$/.test(trimmed) && trimmed.length >= 5;
}

function isLikelyCanonicalOfferId(rawValue, { url, decoded = '' } = {}) {
  if (typeof rawValue !== 'string') return false;

  const trimmed = rawValue.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  if (trimmed.length < 5) return false;

  const hasExplicitOfferPattern = /(?:\/lots\/\w+|\/offer\/|\/lot\/|\/product\/|offer_id=|lot_id=|data-.*offer-id)/i.test(decoded || '');
  const pathLooksLikeOffer = Boolean(url && /(?:\/lots\/\w+|\/offer\/|\/lot\/|\/product\/)/i.test(url.pathname));

  if (pathLooksLikeOffer) return true;
  if (hasExplicitOfferPattern) return trimmed.length >= 5;
  return trimmed.length >= 5;
}

export function parseLotId(html, logger = console) {
  const input = String(html || '').trim();
  if (input && /^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      const isOrderPage = /\/(?:orders?|chats?)(?:\/|$)/i.test(url.pathname);
      if (isOrderPage) {
        return null;
      }

      const invalidOfferPath = url.pathname.match(/\/(?:orders?|chats?|offer|lot|product|lots)(?:\/)?(?:[^/?#]+)?(?:\/)?$/i);
      if (invalidOfferPath && !/\/(?:offer|lot|product)\/(\d+)(?:\/)?$/i.test(url.pathname) && !/\/(?:lots)\/(?:offer|lot)\?(?:.*)?(?:offer_id|lot_id|id)=(\d+)/i.test(url.toString())) {
        const message = `Malformed FunPay offer URL: ${url.toString()}`;
        logger?.error?.(message);
        throw new Error(message);
      }
    } catch (error) {
      if (error instanceof Error && /Malformed FunPay offer URL/.test(error.message)) {
        throw error;
      }
      // If the direct string is not a valid URL, fallback to HTML parsing below.
    }
  }

  const decoded = input
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');

  const hrefMatches = [...decoded.matchAll(/(?:data-)?href\s*=\s*(['"])(.*?)\1/gi)];
  for (const match of hrefMatches) {
    const rawUrl = match[2];
    try {
      const normalized = rawUrl.trim();
      if (!normalized) continue;

      const url = new URL(normalized.startsWith('http') ? normalized : normalized.startsWith('//') ? `https:${normalized}` : `https://funpay.com${normalized}`);

      if (parseFunpayOrderIdFromUrl(url.toString()) !== null) {
        continue;
      }

      const isOrderOrChatPage = /\/(?:orders?|chats?)(?:\/|$)/i.test(url.pathname);
      if (isOrderOrChatPage) {
        continue;
      }

      const pathLooksLikeOffer = /(?:\/lots\/\w+|\/offer\/|\/lot\/|\/product\/)/i.test(url.pathname);
      const explicitOfferKeys = ['offer_id', 'lot_id', 'offerId', 'lotId'];
      const explicitOfferKey = explicitOfferKeys.find((key) => url.searchParams.has(key));
      const canonicalOfferQueryPath = /\/lots\/(?:offer|lot)\b/i.test(url.pathname);
      const genericQueryId = !explicitOfferKey && canonicalOfferQueryPath && url.searchParams.has('id') ? 'id' : null;
      const queryId = explicitOfferKey || genericQueryId;

      if (queryId) {
        const rawValue = String(url.searchParams.get(queryId) ?? '').trim();
        if (!/^\d+$/.test(rawValue)) {
          const message = `Invalid FunPay offer id in URL: ${url.toString()}`;
          logger?.error?.(message);
          throw new Error(message);
        }

        const isExplicitOfferKey = explicitOfferKeys.includes(queryId);
        if (!isExplicitOfferKey && rawValue.length < 5) {
          logger?.debug?.(`Ignoring short incidental numeric id in URL: ${url.toString()}`);
          continue;
        }
        if (!isCanonicalOfferCandidate(rawValue)) {
          logger?.debug?.(`Ignoring short incidental numeric id in URL: ${url.toString()}`);
          continue;
        }

        return Number(rawValue);
      }

      const pathMatch = url.pathname.match(/\/(?:offer|lot|product)\/(\d+)(?:\/)?$/i);
      if (pathMatch) {
        if (!isCanonicalOfferCandidate(pathMatch[1])) {
          logger?.debug?.(`Ignoring short incidental numeric id in URL: ${url.toString()}`);
          continue;
        }
        return Number(pathMatch[1]);
      }

      if (/(?:\/)(?:offer|lot|product|lots)(?:\/|$)/i.test(url.pathname)) {
        const numericPart = url.pathname.match(/\d+/);
        if (numericPart) {
          return Number(numericPart[0]);
        }
        const message = `Malformed FunPay offer URL: ${url.toString()}`;
        logger?.error?.(message);
        throw new Error(message);
      }
    } catch (error) {
      const targetUrl = String(match[2] || '').trim();
      if (error instanceof Error && /Invalid FunPay offer id in URL|Malformed FunPay offer URL|Failed to parse FunPay offer id/.test(error.message)) {
        logger?.error?.(`FunPay offer parsing failed for URL "${targetUrl}": ${error.message}`);
        throw error;
      }
      logger?.debug?.(`Ignoring invalid href while parsing lot id: ${targetUrl}`);
    }
  }

  const patterns = [
    /(?:data-)?offer-id\s*=\s*(['"])(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/offer\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/lot\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])https?:\/\/[^\/]+\/product\/(\d+)\/??\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?offer_id=(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?lot_id=(\d+)\1/i,
    /(?:data-)?href\s*=\s*(['"])(?:https?:\/\/[^'"]*?)?\/lots\/(?:offer|lot)(?:\/)?\?(?:[^'"]*?[&;])?id=(\d+)\1/i,
    /(?:data-)?lot-id\s*=\s*(['"])(\d+)\1/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern) || decoded.match(pattern);
    if (match) {
      const rawValue = String(match[2] || match[1] || '').trim();
      if (!/^\d+$/.test(rawValue)) {
        const message = `Invalid FunPay offer id literal in markup: ${rawValue}`;
        logger?.error?.(message);
        throw new Error(message);
      }

      if (!isLikelyCanonicalOfferId(rawValue, { decoded })) {
        logger?.debug?.(`Ignoring short incidental numeric id in markup: ${rawValue}`);
        continue;
      }

      return Number(rawValue);
    }
  }

  const containsOfferPatternMarker = /(\/lots\/(?:offer|lot)|\/offer\/|\/lot\/|\/product\/|offer_id=|lot_id=)/i.test(decoded);
  const hasOnlyShortNumericOfferId = /\/lots\/(?:offer|lot)\?(?:[^'"\s]*[&;])?id=(\d{1,4})(?:&|$|["'])/i.test(decoded);
  if (containsOfferPatternMarker && !hasOnlyShortNumericOfferId) {
    const message = `Malformed FunPay offer markup: ${String(html || '').slice(0, 500).replace(/\s+/g, ' ').trim()}`;
    logger?.error?.(message);
    throw new Error(message);
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
