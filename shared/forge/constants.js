// shared/forge/constants.js —— Forge 工坊包里用到、但 0.3.0 上游 `shared/constants.js` **没有**的常量。
//
// 为什么不加进上游常量文件：那是上游文件，往里塞只属于我们这条线的常量，等于把叠加层写进上游体内。
// 值是逐字搬过来的（工作坊包的 voices / api 判据依赖它们，改一个字节就会让老包的 `api` 区间失配）。
export const VOICE_SLOTS = Object.freeze(['start', 'faceEnemy', 'select', 'place',
  'skill1', 'skill2', 'skill3', 'skill4', 'resultFour', 'resultThree', 'resultTwo', 'resultLose']);
export const VOICE_LANGS = Object.freeze(['cn', 'jp', 'en', 'kr']);
export const DEFAULT_VOICE_LANG = 'jp';
export const MOD_API_VERSION = 1;
export const DEPLOY_CAP_MAX = 12;
