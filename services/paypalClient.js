const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = process.env.PAYPAL_API;

function assertConfig() {
  if (!PAYPAL_CLIENT || !PAYPAL_SECRET || !PAYPAL_API) {
    throw new Error('PayPal environment variables are not configured.');
  }
}

async function getAccessToken() {
  assertConfig();
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal token request failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

async function createOrder(amount) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: {
          currency_code: 'SGD',
          value: amount
        }
      }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal create order failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function captureOrder(orderId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal capture order failed: ${response.status} ${body}`);
  }

  const data = await response.json();
  console.log('PayPal captureOrder response:', data);
  return data;
}

async function refundCapture(captureId, amount) {
  const accessToken = await getAccessToken();
  const payload = amount
    ? {
        amount: {
          currency_code: 'SGD',
          value: amount
        }
      }
    : {};

  const response = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PayPal refund failed: ${response.status} ${body}`);
  }

  return response.json();
}

module.exports = { createOrder, captureOrder, refundCapture };
