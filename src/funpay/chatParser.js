export function parseChatResponse(json) {
  const messages = [];

  // FunPay returns { objects: [...], last_event: N }
  // Each object has type "chat_bookmarks" with html content
  if (!json?.objects) return messages;

  for (const obj of json.objects) {
    if (obj.type !== 'chat_bookmarks') continue;

    const html = obj.data?.html || '';
    // Parse individual messages from the HTML
    const msgBlocks = [...html.matchAll(
      /<div[^>]*class=['"][^'"]*chat-message['"][^>]*data-node=['"](\d+)['"][^>]*data-author=['"](\d+)['"][^>]*>([\s\S]*?)<\/div>/gi
    )];

    for (const block of msgBlocks) {
      const nodeId = Number(block[1]);
      const authorId = Number(block[2]);
      const content = stripHtml(block[3]);

      if (content) {
        messages.push({ nodeId, authorId, text: content, id: json.last_event || 0 });
      }
    }
  }

  // Alternative: FunPay sometimes returns messages differently
  // This handles the "chat_message" object type
  for (const obj of json.objects) {
    if (obj.type !== 'chat_message') continue;
    messages.push({
      nodeId: Number(obj.data?.node),
      authorId: Number(obj.data?.author),
      text: obj.data?.message || '',
      id: json.last_event || 0,
    });
  }

  return messages;
}

function stripHtml(value = '') {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}