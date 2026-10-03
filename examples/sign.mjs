import { createHmac } from 'node:crypto';

// Same construction as src/ledger/signature.ts: utf8(timestamp) + "." + raw body bytes.
const [secret, timestamp, body] = process.argv.slice(2);
if (!secret || !timestamp || body === undefined) {
  console.error('usage: node examples/sign.mjs <secret> <unix-seconds> <raw-body>');
  process.exit(1);
}

const hmac = createHmac('sha256', secret);
hmac.update(timestamp);
hmac.update('.');
hmac.update(body);
process.stdout.write(hmac.digest('hex'));
