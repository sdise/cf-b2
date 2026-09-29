/* 冒烟测试：校验内置 AWS SigV4 实现与 AWS 官方文档示例完全一致
 * 运行：node tests/sigv4.test.mjs
 *
 * 说明：AWS 官方示例（docs.aws.amazon.com/IAM/latest/UserGuide/signing-requests.html）
 * 的请求中没有 x-amz-content-sha256 头，而本实现为了让 S3 兼容 UNSIGNED-PAYLOAD
 * 总会带上该头。因此测试时把源码里的这一行临时替换掉，其余（编码、排序、
 * canonical request、string-to-sign、HMAC 派生链）全部保持原样进行比对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'src', 'b2-worker.js'), 'utf8');

const patched = source.replace("h.set('x-amz-content-sha256', payload);", '/* removed for test */');
const tmpFile = path.join(os.tmpdir(), 'cf-b2-worker-test-' + Date.now() + '.mjs');
fs.writeFileSync(tmpFile, patched);

const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super('2015-08-30T12:36:00.000Z');
    else super(...args);
  }
  static now() { return new RealDate('2015-08-30T12:36:00.000Z').getTime(); }
}
globalThis.Date = FixedDate;

const { SigV4, uriEncode, normalizeKey } = await import(pathToFileURL(tmpFile).href);
fs.rmSync(tmpFile, { force: true });

let failed = 0;
function assert(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label);
  if (!ok) console.log('       expected: ' + expected + '\n       actual:   ' + actual);
}

// --- 1. RFC3986 编码 ---
assert('uriEncode 保留 -_.~', uriEncode('a-b_c.d~e'), 'a-b_c.d~e');
assert('uriEncode 空格为 %20', uriEncode('a b'), 'a%20b');
assert('uriEncode 转义斜杠', uriEncode('a/b'), 'a%2Fb');
assert('uriEncode 保留斜杠', uriEncode('a/b', false), 'a/b');
assert('uriEncode 中文', uriEncode('中文.jpg', false), '%E4%B8%AD%E6%96%87.jpg');

// --- 2. key 归一化 / 路径穿越防护 ---
assert('normalizeKey 去多余斜杠', normalizeKey('//a//b//'), 'a/b');
assert('normalizeKey 阻挡 ../', normalizeKey('../../etc/passwd'), 'etc/passwd');

// --- 3. AWS 官方 SigV4 示例 ---
const signer = new SigV4({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'iam',
});

const request = await signer.sign('GET', 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', {
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
});

assert('amz-date', request.headers.get('x-amz-date'), '20150830T123600Z');
assert('请求 URL 规范化', request.url,
  'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08');
assert('Authorization 与官方示例一致', request.headers.get('authorization'),
  'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20150830/us-east-1/iam/aws4_request, '
  + 'SignedHeaders=content-type;host;x-amz-date, '
  + 'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');

console.log(failed === 0 ? '\n全部通过 ✅' : '\n失败 ' + failed + ' 项 ❌');
process.exit(failed === 0 ? 0 : 1);
