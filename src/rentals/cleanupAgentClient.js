const DEFAULT_TIMEOUT_MS = 45_000;

function asPositiveInteger(value, name, fallback) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getCleanupAgentConfig(env = process.env) {
  const baseUrl = String(env.RENTAL_VM_AGENT_URL || '').trim();
  const token = String(env.RENTAL_VM_AGENT_TOKEN || '').trim();

  if (!baseUrl && !token) {
    return { enabled: false };
  }
  if (!baseUrl || !token) {
    throw new Error('RENTAL_VM_AGENT_URL and RENTAL_VM_AGENT_TOKEN must be configured together');
  }

  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('RENTAL_VM_AGENT_URL must use http or https');
  }

  return {
    enabled: true,
    baseUrl: url.toString().replace(/\/$/, ''),
    token,
    timeoutMs: asPositiveInteger(env.RENTAL_VM_AGENT_TIMEOUT_MS, 'RENTAL_VM_AGENT_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };
}

function safeErrorMessage(value, fallback = 'VM agent request failed') {
  const message = String(value || fallback).replace(/[\r\n]+/g, ' ').trim();
  return message.slice(0, 500) || fallback;
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

/**
 * Calls a private agent running on the Windows VM that owns a rented account.
 * Steam credentials and maFile secrets are deliberately never sent to this agent.
 */
export function createCleanupAgentClient({ config = getCleanupAgentConfig(), fetchImpl = globalThis.fetch } = {}) {
  if (!config.enabled) {
    return {
      async cleanupRental() {
        return { ok: false, reason: 'not-configured', retryable: false };
      },
    };
  }

  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for the VM cleanup agent');
  }

  return {
    async cleanupRental({ rentalId, accountId, attempt }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
      const url = `${config.baseUrl}/v1/rentals/${encodeURIComponent(String(rentalId))}/cleanup`;

      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.token}`,
            'content-type': 'application/json',
            'x-request-id': `rental-cleanup-${rentalId}-${attempt}`,
          },
          body: JSON.stringify({ rentalId, accountId, attempt }),
          signal: controller.signal,
        });
        const body = await readResponse(response);

        if (!response.ok || body.ok !== true) {
          return {
            ok: false,
            reason: body.reason || `http-${response.status}`,
            error: safeErrorMessage(body.error || body.message || `VM agent returned HTTP ${response.status}`),
            retryable: response.status >= 500 || response.status === 408 || response.status === 429,
          };
        }

        return { ok: true, details: body };
      } catch (error) {
        return {
          ok: false,
          reason: error?.name === 'AbortError' ? 'timeout' : 'network-error',
          error: safeErrorMessage(error?.message),
          retryable: true,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

