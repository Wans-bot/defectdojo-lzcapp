// 提审后收尾：卸载盒子上的测试实例 → 拆验收脚手架 → 验证 0 残留。
// 注意：应用容器由 `lzc-docker` 管理（LazyCat Core 里），普通 `docker ps` 看不到它们。
import { lpkUninstall, lpkList, ssh, harnessDown, harnessLeftovers, appContainers } from '/home/wans/wans-agent-kb/scripts/lib/box-ops.mjs';

const HOST = 'lzcbox';
const PKG = 'cloud.lazycat.app.defectdojo';
const HARNESS = 'acc-tappdefectdojo';
const out = { pkg: PKG, harness: HARNESS, steps: [] };
const step = (name, ok, note) => { out.steps.push({ name, ok, note }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`); };

// 1. 卸载前快照
const before = appContainers(HOST, PKG);
step('卸载前实例存在', before.length > 0, `${before.length} 个容器`);

// 2. 卸载
const un = lpkUninstall(HOST, PKG);
const text = `${un.stdout || ''}${un.stderr || ''}`;
step('lzc-cli 卸载返回 0', un.code === 0, (text.match(/Uninstall completed|卸载成功/gi) || ['无成功关键字'])[0]);

// 3. 应用容器 0 残留
const after = appContainers(HOST, PKG);
step('应用容器已清空', after.length === 0, after.map((c) => c.name).join(',') || '0 个');

// 4. 安装列表里不再有它
const listed = /cloud\.lazycat\.app\.defectdojo/.test(lpkList(HOST) || '');
step('lpk-manager 列表已移除', !listed, listed ? '仍存在' : '已移除');

// 5. 数据目录
const varDir = ssh(HOST, `ls -d /lzcapp/var/apps/${PKG} /lzcapp/cache/${PKG} 2>/dev/null | wc -l`, { allowFail: true });
step('appvar/appcache 无残留', String(varDir.stdout).trim() === '0', `残留目录 ${String(varDir.stdout).trim()} 个`);

// 6. 拆脚手架（tls / chrome / cdp-proxy + network）
const down = harnessDown(HOST, HARNESS);
step('脚手架已拆除', down.code === 0, (down.text.match(/HARNESS_DOWN.{0,40}/) || ['无 HARNESS_DOWN'])[0].trim());
const left = harnessLeftovers(HOST, HARNESS);
step('脚手架无泄漏', left.length === 0, left.join(',') || '干净');

out.verdict = out.steps.every((s) => s.ok) ? 'passed' : 'failed';
console.log('\nverdict=' + out.verdict);
console.log(JSON.stringify(out, null, 1));
