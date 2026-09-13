'use strict';
// HS256 JWT 签发（零依赖，Node crypto）
// Cube v1.x 对 u/p 载荷有弃用告警但仍可用；后续可迁移新 authInfo 格式
const crypto = require('crypto');

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign({
  secret,
  days = 30,
  user = 'service-account',
  context = { service: true },
  audience,
  scopes,
  jwtId,
} = {}) {
  if (!secret) throw new Error('CUBEJS_API_SECRET 缺失');
  const now = Math.floor(Date.now() / 1000);
  const header = b64u({ alg: 'HS256', typ: 'JWT' });
  const payload = b64u({
    u: user,
    p: context,
    sub: user,
    ...(audience ? { aud: audience } : {}),
    ...(Array.isArray(scopes) && scopes.length ? { scope: scopes.join(' ') } : {}),
    ...(jwtId ? { jti: jwtId } : {}),
    iat: now,
    exp: now + days * 86400,
  });
  const sig = crypto.createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function verifyClaims(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256') return null;
  } catch (_) { return null; }
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const actual = Buffer.from(parts[2]);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && Number(payload.exp) <= now) return null;
    if (payload.nbf && Number(payload.nbf) > now) return null;
    return payload;
  } catch (_) { return null; }
}

function verify(token, secret) {
  return !!verifyClaims(token, secret);
}

module.exports = { sign, verify, verifyClaims };
