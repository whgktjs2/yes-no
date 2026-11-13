import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { buildPushPayload } from '@block65/webcrypto-web-push';

function keyPair() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url'),
    privateKey: jwk.d,
  };
}
test('Web Push creates the encrypted payload and VAPID authorization accepted by modern browsers', async () => {
  const sender = keyPair(), receiver = keyPair();
  const request = await buildPushPayload({ data: JSON.stringify({ title: 'YES / NO', body: '상대방의 상태가 YES로 변경되었습니다.' }), options: { ttl: 60 } }, {
    endpoint: 'https://web.push.apple.com/test', expirationTime: null,
    keys: { p256dh: receiver.publicKey, auth: randomBytes(16).toString('base64url') },
  }, { ...sender, subject: 'mailto:test@example.com' });
  const headers = new Headers(request.headers);
  assert.equal(request.method.toUpperCase(), 'POST');
  assert.equal(headers.get('Content-Encoding'), 'aes128gcm');
  assert.match(headers.get('Authorization'), /^vapid /);
  assert.equal(headers.get('TTL'), '60');
  assert.ok(request.body);
});
