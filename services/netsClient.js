const axios = require('axios');
const https = require('https');
const { URL } = require('url');

const NETS_API = process.env.NETS_API || 'https://sandbox.nets.openapipaas.com';

function getCourseInitIdParam() {
  try {
    require.resolve('../course_init_id');
    const { courseInitId } = require('../course_init_id');
    console.log('Loaded courseInitId:', courseInitId);
    return courseInitId ? `${courseInitId}` : '';
  } catch (error) {
    return '';
  }
}

function buildErrorPayload(qrData, fallbackMessage) {
  let errorMsg = fallbackMessage || 'An error occurred while generating the QR code.';
  if (qrData && qrData.network_status !== 0) {
    errorMsg = qrData.error_message || 'Transaction failed. Please try again.';
  }
  return {
    title: 'Error',
    responseCode: (qrData && qrData.response_code) ? qrData.response_code : 'N.A.',
    instructions: (qrData && qrData.instruction) ? qrData.instruction : '',
    errorMsg
  };
}

async function requestQrCode(cartTotal) {
  const requestBody = {
    txn_id: 'sandbox_nets|m|8ff8e5b6-d43e-4786-8ac5-7accf8c5bd9b',
    amt_in_dollars: cartTotal,
    notify_mobile: 0
  };

  try {
    const response = await axios.post(
      `${NETS_API}/api/v1/common/payments/nets-qr/request`,
      requestBody,
      {
        headers: {
          'api-key': process.env.API_KEY,
          'project-id': process.env.PROJECT_ID
        }
      }
    );

    const qrData = response.data.result.data;
    if (
      qrData.response_code === '00' &&
      qrData.txn_status === 1 &&
      qrData.qr_code
    ) {
      return { ok: true, qrData, responseData: response.data };
    }

    return { ok: false, error: buildErrorPayload(qrData), responseData: response.data };
  } catch (error) {
    console.error('Error in requestQrCode:', error.message);
    return { ok: false, error: buildErrorPayload(null, error.message || 'Unable to generate NETS QR code.') };
  }
}

async function generateQrCode(req, res) {
  const { cartTotal } = req.body;
  console.log(cartTotal);

  const result = await requestQrCode(cartTotal);
  if (result.ok) {
    const qrData = result.qrData;
    console.log({ qrData });
    console.log('QR code generated successfully');

    const txnRetrievalRef = qrData.txn_retrieval_ref;
    const courseInitId = getCourseInitIdParam();
    const webhookUrl = `${NETS_API}/api/v1/common/payments/nets/webhook?txn_retrieval_ref=${txnRetrievalRef}&course_init_id=${courseInitId}`;

    console.log('Transaction retrieval ref:' + txnRetrievalRef);
    console.log('courseInitId:' + courseInitId);
    console.log('webhookUrl:' + webhookUrl);

    const viewData = req.netsViewData || {};
    if (req.session) {
      req.session.lastNetsQr = {
        txnRetrievalRef: txnRetrievalRef,
        responseData: result.responseData || null
      };
    }
    return res.render('netsQr', {
      total: cartTotal,
      title: 'Scan to Pay',
      qrCodeUrl: `data:image/png;base64,${qrData.qr_code}`,
      txnRetrievalRef: txnRetrievalRef,
      courseInitId: courseInitId,
      networkCode: qrData.network_status,
      timer: 300,
      webhookUrl: webhookUrl,
      fullNetsResponse: result.responseData,
      apiKey: process.env.API_KEY,
      projectId: process.env.PROJECT_ID,
      ...viewData
    });
  }

  const errorPayload = result.error || buildErrorPayload(null, 'Unable to generate NETS QR code.');
  return res.render('netsQrFail', errorPayload);
}

function parseWebhookPayload(rawPayload) {
  if (!rawPayload) return null;
  try {
    const parsed = JSON.parse(rawPayload);
    if (parsed && parsed.result && parsed.result.data) {
      return parsed.result.data;
    }
    if (parsed && parsed.data) {
      return parsed.data;
    }
    return parsed;
  } catch (err) {
    console.error('Unable to parse NETS webhook payload:', err.message);
    return null;
  }
}

function interpretPaymentStatus(payload) {
  if (!payload) return null;
  const normalizedResponseCode = String(payload.response_code ?? payload.responseCode ?? '').trim();
  const normalizedTxnStatus = String(payload.txn_status ?? payload.txnStatus ?? payload.status ?? '').trim().toUpperCase();
  const result = {
    payload,
    responseCode: normalizedResponseCode,
    txnStatus: normalizedTxnStatus,
    success: false,
    fail: false,
    message: payload.response_message || payload.instructions || payload.message || ''
  };
  if (normalizedResponseCode === '00' || normalizedResponseCode === '0') {
    result.success = true;
    return result;
  }
  if (['1', 'SUCCESS', 'PAID', 'CONFIRMED'].includes(normalizedTxnStatus)) {
    result.success = true;
    return result;
  }
  if (['2', 'FAILED', 'CANCELLED', 'ABORTED', 'EXPIRED', 'REJECTED'].includes(normalizedTxnStatus)) {
    result.fail = true;
    if (!result.message) {
      result.message = 'NETS payment failed.';
    }
    return result;
  }
  return result;
}

function streamPaymentStatus(txnRetrievalRef, courseInitId, handlers = {}) {
  if (!txnRetrievalRef) {
    throw new Error('Missing txnRetrievalRef for NETS status stream.');
  }
  const streamUrl = new URL('/api/v1/common/payments/nets/webhook', NETS_API);
  streamUrl.searchParams.set('txn_retrieval_ref', txnRetrievalRef);
  if (courseInitId) {
    streamUrl.searchParams.set('course_init_id', courseInitId);
  }

  const requestHeaders = {
    'api-key': process.env.API_KEY,
    'project-id': process.env.PROJECT_ID,
    'Accept': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  };

  const req = https.get(streamUrl, { headers: requestHeaders }, (res) => {
    let buffer = '';
    let pendingPayload = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        line = line.replace(/\r$/, '');
        if (!line) {
          if (pendingPayload) {
            const payload = parseWebhookPayload(pendingPayload);
            pendingPayload = '';
            if (payload && handlers.onPayload) {
              handlers.onPayload(payload);
            }
          }
          continue;
        }
        if (line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('data:')) {
          pendingPayload += (pendingPayload ? '\n' : '') + line.slice(5).trim();
        }
      }
    });
    res.on('end', () => {
      if (pendingPayload && handlers.onPayload) {
        const payload = parseWebhookPayload(pendingPayload);
        pendingPayload = '';
        if (payload) handlers.onPayload(payload);
      }
      if (handlers.onEnd) handlers.onEnd();
    });
    res.on('error', (err) => {
      if (handlers.onError) handlers.onError(err);
    });
  });
  req.on('error', (err) => {
    if (handlers.onError) handlers.onError(err);
  });
  return req;
}

module.exports = {
  generateQrCode,
  requestQrCode,
  NETS_API,
  getCourseInitIdParam,
  streamPaymentStatus,
  interpretPaymentStatus
};
