// shared/forge/diyForms.js —— `requiredUnitForms`：工作坊包校验「自选编队需要哪些形态」时用。
//
// 0.3.0 的 `shared/diy.js` 有 `diySlot` / `diySlotIds`（本文件直接用它们），但没有这个聚合函数。
import { diySlot, diySlotIds } from '../diy.js';

function statusKey(s) { return String(s && s.key ? s.key : s); }

export function requiredUnitForms(data, { tier = null } = {}) {
  const statuses = new Set();
  for (const slotId of diySlotIds(data)) {
    const slot = diySlot(slotId, data);
    if (!slot || (tier !== null && slot.tier !== tier)) continue;
    for (const rec of [slot.normal, slot.golden]) {
      if (rec && rec.status) statuses.add(statusKey(rec.status));
    }
  }
  return [...statuses].sort();
}
