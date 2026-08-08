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
function parseLotId(html) {
  const patterns = [
    /data-lot-id=(['"])(\d+)\1/i,
    /data-offer-id=(['"])(\d+)\1/i,
    /href=(['"])https?:\/\/[^\/]+\/offer\/(\d+)\/?\1/i,
    /href=(['"])https?:\/\/[^\/]+\/lot\/(\d+)\/?\1/i,
    /href=(['"])https?:\/\/[^\/]+\/product\/(\d+)\/?\1/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return Number(match[2]);
  }

  return null;
}

function parseLotCount(html, description) {
  const text = `${html} ${description || ''}`;
  const patterns = [
    /(?:data-(?:lot|quantity|qty)=['"]?)(\d+)['"]?/i,
    /(?:quantity|qty|кол-во)\s*[:=]?\s*(\d+)/i,
    /(?:\b|\s)(?:x|х)\s*(\d+)\b/i,
    /(?:^|\s)(\d+)\s*(?:лот(?:а|ов)?|lot(?:s)?)(?![\p{L}\p{N}])/iu,
    /(?:^|\s)(\d+)\s*(?:шт|pcs?|items?)(?![\p{L}\p{N}])/iu,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }

  return 1;
}
function parsePrice(text) {
  if (!text) return null;
  const num = text.replace(/[^\d.,]/g, '').replace(',', '.');
  return num ? Number(num) : null;
}

function parseDesiredMmr(description = '') {
  const normalized = String(description || '').toLowerCase().replace(/\u00A0/g, ' ');

  const labelBeforeMatch = normalized.match(/(?:ммр|mmr)\D*(\d[\d\s]*(?:[.,]\d+)?)(?:\s*(k|к))?(?=\s|$)/);
  if (labelBeforeMatch) {
    const value = labelBeforeMatch[1].replace(/\s+/g, '').replace(',', '.');
    const mmr = Number(value);
    if (!Number.isFinite(mmr)) return null;
    return Math.round(mmr * (labelBeforeMatch[2] ? 1000 : 1));
  }

  const labelAfterMatch = normalized.match(/(\d[\d\s]*(?:[.,]\d+)?)(?:\s*(k|к))?\s*(?:ммр|mmr)(?=\s|$)/);
  if (labelAfterMatch) {
    const value = labelAfterMatch[1].replace(/\s+/g, '').replace(',', '.');
    const mmr = Number(value);
    if (!Number.isFinite(mmr)) return null;
    return Math.round(mmr * (labelAfterMatch[2] ? 1000 : 1));
  }

  const shortMatch = normalized.match(/(\d[\d\s]*(?:[.,]\d+)?)\s*(k|к)(?=\s|$)/);
  if (!shortMatch) return null;

  const value = shortMatch[1].replace(/\s+/g, '').replace(',', '.');
  const mmr = Number(value);
  if (!Number.isFinite(mmr)) return null;

  return Math.round(mmr * 1000);
}

export function parseNewOrders(html) {
  const starts = [...html.matchAll(/<[^>]*class=(['"])[^'"]*\btc-item\b[^'"]*\binfo\b[^'"]*\1[^>]*>/gi)];
  const orders = [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index].index;
    const end = starts[index + 1]?.index ?? html.length;
    const row = html.slice(start, end);
    const orderNumber = getClassText(row, 'tc-order')?.replace(/^#/, '').trim();
    if (!orderNumber) continue;

    const description = getClassText(row, 'order-desc');
    orders.push({
      funpayOrderId: orderNumber,
      buyerId: getBuyerId(row),
      buyerUsername: getClassText(row, 'media-user-name'),
      price: parsePrice(getClassText(row, 'tc-price')),
      status: getClassText(row, 'tc-status'),
      description,
      desiredMmr: parseDesiredMmr(description),
      lotId: parseLotId(row),
      lotCount: parseLotCount(row, description),
      createdLabel: getClassText(row, 'tc-date-time'),
    });
  }

  return orders;
}
