export function createCommandRouter(handlers = {}) {
  const commands = new Map(Object.entries(handlers));

  return async function route(message, ctx) {
    const text = message.text?.trim().toLowerCase();
    if (!text || !text.startsWith('!')) return false;

    const [command, ...args] = text.split(/\s+/);
    const handler = commands.get(command);

    if (!handler) return false;

    await handler({ message, args, ctx });
    return true;
  };
}

// Использование:
// const router = createCommandRouter({
//   '!code': handleCodeCommand,
//   '!help': handleHelpCommand,
// });