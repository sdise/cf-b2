/* 由 src/b2-worker.js 拆分而来：原 L166-L277 */

import { ALGORITHM, SERVICE, UNSIGNABLE_HEADERS } from './constants.js';
import { canonicalPath, encoder, hmac, nowAmz, sha256Hex, toHex, uriEncode } from './crypto.js';

export class SigV4 {
  constructor({ accessKeyId, secretAccessKey, region, service = SERVICE, keyCache = null }) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.service = service;
    // 派生签名密钥（4 次 HMAC）对同一凭据/日期是常量；由 cfg 传入的请求级缓存可省去重复计算
    this.keyCache = keyCache;
  }

  async signingKey(dateStamp) {
    const cacheKey = this.accessKeyId + '|' + this.region + '|' + this.service + '|' + dateStamp;
    if (this.keyCache && this.keyCache.has(cacheKey)) return this.keyCache.get(cacheKey);
    let k = await hmac(encoder.encode('AWS4' + this.secretAccessKey), dateStamp);
    k = await hmac(k, this.region);
    k = await hmac(k, this.service);
    const key = await hmac(k, 'aws4_request');
    if (this.keyCache) this.keyCache.set(cacheKey, key);
    return key;
  }

  /**
   * 生成签名请求；expiresIn > 0 时返回预签名 URL 字符串
   * @param {string} method
   * @param {string} urlStr
   * @param {object} opts {headers, body, query, unsignedPayload, payloadHash, expiresIn}
   */
  async sign(method, urlStr, opts = {}) {
    const {
      headers = {}, body = null, query = {},
      unsignedPayload = false, payloadHash = null, expiresIn = 0,
    } = opts;

    const url = new URL(urlStr);
    const { amzDate, dateStamp } = nowAmz();
    const scope = dateStamp + '/' + this.region + '/' + this.service + '/aws4_request';

    const h = new Headers(headers);
    h.set('host', url.host);

    // 无请求体时按 AWS 规范用空串哈希；流式或客户端直传用 UNSIGNED-PAYLOAD
    let payload = payloadHash;
    if (!payload) payload = unsignedPayload ? 'UNSIGNED-PAYLOAD' : await sha256Hex(body === null ? '' : body);

    // 预签名（查询串认证）时：日期由 X-Amz-Date 查询参数携带、载荷哈希只写进 canonical request，
    // 二者都不能作为请求头要求客户端发送，否则 B2 会返回
    // "header 'x-amz-date' is listed in signed headers, but is not present"（400）
    if (expiresIn <= 0) {
      h.set('x-amz-date', amzDate);
      h.set('x-amz-content-sha256', payload);
    }

    const pairs = [];
    for (const [rawKey, rawValue] of h.entries()) {
      const key = rawKey.toLowerCase();
      if (UNSIGNABLE_HEADERS.has(key)) continue;
      pairs.push([key, String(rawValue).trim().replace(/\s+/g, ' ')]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const signedHeaders = pairs.map((p) => p[0]).join(';');
    const canonicalHeaders = pairs.map((p) => p[0] + ':' + p[1] + '\n').join('');

    const params = new Map();
    if (expiresIn > 0) {
      params.set('X-Amz-Algorithm', ALGORITHM);
      params.set('X-Amz-Credential', this.accessKeyId + '/' + scope);
      params.set('X-Amz-Date', amzDate);
      params.set('X-Amz-Expires', String(expiresIn));
      params.set('X-Amz-SignedHeaders', signedHeaders);
    }
    for (const [k, v] of url.searchParams.entries()) params.set(k, v);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }

    const canonicalQuery = [...params.keys()].sort()
      .map((k) => uriEncode(k) + '=' + uriEncode(params.get(k)))
      .join('&');

    const canonicalRequest = [
      method.toUpperCase(),
      canonicalPath(url.pathname),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payload,
    ].join('\n');

    const stringToSign = [
      ALGORITHM, amzDate, scope, await sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = toHex(await hmac(await this.signingKey(dateStamp), stringToSign));
    const target = url.origin + canonicalPath(url.pathname) + (canonicalQuery ? '?' + canonicalQuery : '');

    if (expiresIn > 0) return target + '&X-Amz-Signature=' + signature;

    h.set('authorization',
      ALGORITHM + ' Credential=' + this.accessKeyId + '/' + scope
      + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature);

    return new Request(target, {
      method: method.toUpperCase(),
      headers: h,
      body: body === null ? undefined : body,
    });
  }
}

/* ============================ 3. 配置加载 ============================ */

/** 前缀归一化：去掉首尾斜杠，中间保留；结果为空串表示"不限制" */
