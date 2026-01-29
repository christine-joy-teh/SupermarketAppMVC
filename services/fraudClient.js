const DEFAULT_TIMEOUT_MS = 2000;

function buildFraudApiUrl() {
  if (process.env.FRAUD_API_URL) return process.env.FRAUD_API_URL;
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/api/fraud/check`;
}

async function checkTransaction(payload = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(buildFraudApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!response.ok) {
      return { suspicious: false, reason: null };
    }
    const data = await response.json();
    return data || { suspicious: false, reason: null };
  } catch (err) {
    return { suspicious: false, reason: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { checkTransaction };
