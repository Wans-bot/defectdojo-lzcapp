// 把 3.4.200-1 的清单/脚本/证据归档进 KB：examples/cloud.lazycat.app.defectdojo/3.4.200-1/
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SRC = '/tmp/dd-src';
const ACC = path.join(SRC, 'acceptance/3.4.200-1');
const DST = '/home/wans/wans-agent-kb/examples/cloud.lazycat.app.defectdojo/3.4.200-1';
const LPK = path.join(SRC, 'dist/cloud.lazycat.app.defectdojo-3.4.200-1.lpk');

mkdirSync(path.join(DST, 'shots'), { recursive: true });
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');

for (const f of ['lzc-manifest.yml', 'package.yml', 'lzc-build.yml', 'icon.png']) {
  copyFileSync(path.join(SRC, f), path.join(DST, f));
}
// 验收脚本与证据
copyFileSync(path.join(SRC, 'acceptance/verify-api.mjs'), path.join(DST, 'verify-api.mjs'));
copyFileSync(path.join(SRC, 'acceptance/archive-evidence.mjs'), path.join(DST, 'archive-evidence.mjs'));
copyFileSync(path.join(SRC, 'audit/teardown.mjs'), path.join(DST, 'teardown.mjs'));
for (const f of ['EVIDENCE.md', 'RESULT.json', 'RESULT.box-accept-failed.json']) {
  copyFileSync(path.join(ACC, f), path.join(DST, f));
}
const result = JSON.parse(readFileSync(path.join(ACC, 'RESULT.json'), 'utf8'));
for (const s of result.screenshots) copyFileSync(path.join(ACC, s), path.join(DST, s));

const lpkSize = readFileSync(LPK).length;
const manifest = `archive_time: ${new Date().toISOString()}
package: cloud.lazycat.app.defectdojo
version: 3.4.200-1
route: action
repo: Wans-bot/defectdojo-lzcapp
lpk:
  path: cloud.lazycat.app.defectdojo-3.4.200-1.lpk
  size_bytes: ${lpkSize}
  sha256: ${sha256(LPK)}
icon:
  md5: ${md5(path.join(SRC, 'icon.png'))}
acceptance:
  local_box_test: passed
  harness: acc-tappdefectdojo
  domain: https://defectdojo.wans.heiyu.space
  basis: 平台 SSO 登录后的浏览器真实会话（7/7 断言通过）
  evidence: EVIDENCE.md
  result: RESULT.json
  screenshots: ${result.screenshots.length}
store_review: pending #20964 v3.4.200-1
box_cleanup: 已卸载测试实例，应用容器/数据目录/脚手架 0 残留
upstream_archive_before: cloud.lazycat.app.defectdojo/3.4.101
fix_for_review: "#20850 api 接口没有放通，调用会被微服网关拦截"
`;
writeFileSync(path.join(DST, 'ARCHIVE-MANIFEST.yml'), manifest);
console.log(`归档完成 ${DST}\n  lpk ${lpkSize}B sha256=${sha256(LPK).slice(0, 16)}…\n  shots=${result.screenshots.length}`);
