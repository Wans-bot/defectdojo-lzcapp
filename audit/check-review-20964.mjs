// 提审回读核对：把 review#20964 的 pkg_hash / icon_hash / lpk_size / 截图数量与本地包对齐。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const T = process.env.LZC_USER_TOKEN
  || JSON.parse(readFileSync(require('node:os').homedir() + '/.config/lazycat/box-config.json', 'utf8')).token;
const H = { 'X-User-Token': T, Cookie: 'userToken=' + T, Accept: 'application/json' };
const un = (x) => { const d = x && x.data; return d && typeof d === 'object' ? d : x; };

const list = un(await (await fetch('https://appstore.api.lazycat.cloud/api/v3/developer/app/6579/review/list?size=50', { headers: H })).json());
const r = (list.items || []).find((x) => x.id === 20964);
if (!r) { console.log('未找到 review#20964，实际 ids:', (list.items || []).map((x) => x.id).join(',')); process.exit(1); }

const lpk = '/tmp/dd-src/dist/cloud.lazycat.app.defectdojo-3.4.200-1.lpk';
const sha = createHash('sha256').update(readFileSync(lpk)).digest('hex');
const iconMd5 = createHash('md5').update(readFileSync('/tmp/dd-src/icon.png')).digest('hex');

console.log('review#', r.id, 'status=', r.status, 'version=', r.version);
console.log('字段:', Object.keys(r).join(','));
const pc = r.pc_paths || r.pc_shots || r.screenshots_pc || [];
const mb = r.mobile_paths || r.mobile_shots || r.screenshots_mobile || [];
const eq = (a, b) => (a && b ? String(a).toLowerCase() === String(b).toLowerCase() : 'n/a');
console.log(`pkg_hash  平台=${r.pkg_hash}  本地=${sha}  ${eq(r.pkg_hash, sha) === true ? 'PASS' : 'CHECK'}`);
console.log(`icon_hash 平台=${r.icon_hash} 本地=${iconMd5} ${eq(r.icon_hash, iconMd5) === true ? 'PASS' : 'CHECK'}`);
console.log(`lpk_size  平台=${r.lpk_size} 本地=${readFileSync(lpk).length}`);
console.log(`min_os=${r.min_os} support_mobile=${r.support_mobile} language=${r.language}`);
console.log(`截图 pc=${pc.length} mobile=${mb.length}`);
console.log(`name=${JSON.stringify(r.name).slice(0, 120)}`);
console.log(`changelog=${JSON.stringify(r.changelog).slice(0, 260)}`);
