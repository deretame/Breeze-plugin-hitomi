/* bytesFromBase64 由运行时全局注入（见 breeze-plugin-kit 类型声明），无需导入。 */

/**
 * hitomi.la 数据层：nozomi 列表 / galleries 元数据 / B+ 树搜索索引 / 图片 URL。
 *
 * 链路来源（2026-10 实测）：
 * - 列表：`{CDN}/{area}/{tag}-{language}.nozomi`（Range 分页，big-endian int32 ID）
 * - 详情：`{CDN}/galleries/{id}.js`（`var galleryinfo = {...}`）
 * - 搜索：tagindex B+ 树（tag → galleries 索引）+ nozomi 取交并集
 * - 图片：gg.js 的 `gg.b/gg.s/gg.m` 算法拼 `w{sub}.gold-usergeneratedcontent.net` 原图
 */

export const WEB_BASE = "https://hitomi.la";
export const DATA_CDN = "https://ltn.gold-usergeneratedcontent.net";
export const IMAGE_DOMAIN = "gold-usergeneratedcontent.net";
export const UA = "Breeze-plugin-hitomi/0.1.0";

export const PAGE_SIZE = 25;

export type JsonRecord = Record<string, unknown>;

export type HitomiFile = {
  hash?: string;
  name?: string;
  width?: number;
  height?: number;
  hasavif?: number;
  haswebp?: number;
};

export type HitomiTag = {
  tag?: string;
  url?: string;
  male?: string;
  female?: string;
};

export type HitomiGallery = {
  id?: number | string;
  title?: string | null;
  japanese_title?: string | null;
  type?: string;
  language?: string;
  language_localname?: string;
  language_url?: string;
  galleryurl?: string;
  date?: string;
  datepublished?: string;
  files?: HitomiFile[];
  tags?: HitomiTag[];
  artists?: Array<{ artist?: string; url?: string }>;
  groups?: Array<{ group?: string; url?: string }>;
  parodys?: Array<{ parody?: string; url?: string }>;
  characters?: Array<{ character?: string; url?: string }>;
  related?: Array<number | string>;
  video?: unknown;
  blocked?: unknown;
  [key: string]: unknown;
};

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function toNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function toText(value: unknown): string {
  return String(value ?? "").trim();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export async function fetchText(url: string, timeoutMs = 30000): Promise<string> {
  const res = await fetch(url, {
    headers: { Referer: `${WEB_BASE}/`, "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hitomi 请求失败: HTTP ${res.status}`);
  return res.text();
}

export async function fetchRange(
  url: string,
  start: number,
  end: number,
  timeoutMs = 30000,
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: {
      Referer: `${WEB_BASE}/`,
      "User-Agent": UA,
      Range: `bytes=${start}-${end}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`hitomi Range 请求失败: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchWhole(url: string, timeoutMs = 30000): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Referer: `${WEB_BASE}/`, "User-Agent": UA },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`hitomi 请求失败: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// gg.js 图片 URL 算法（内联，避免运行时拉取 gg.js 解析执行）
// ---------------------------------------------------------------------------

/** gg.b：galleries 索引版本对应的图片目录前缀，变化时从 gg.js 同步。 */
const GG_B = "1791547201/";
/** gg.s：hash 尾部 1.5 字节 → 十进制目录。 */
function ggS(hash: string): string {
  const m = /(..)(.)$/.exec(hash);
  if (!m) return "0";
  return parseInt(m[2] + m[1], 16).toString(10);
}

/**
 * gg.m：12 bit 输入 → 0/1（图片子域名二选一）。hitomi gg.js 是 1984 个 case 的
 * switch，本表逐位打包（bit i = gg.m(i)），生成自 2026-10-09 的 gg.js。
 * gg.js 更新时用仓库脚本从新版 gg.js 重新生成此字符串。
 */
const GG_M_BITS =
  "lUyf5mgAELERdNGVlktnoMaiQGRlSiQsnoBLzpiZJnKV4/F8F1CczWNQPsM0wawPNYQ+jsZWaIAUzMzQs4Z+tsLsSLm9+UkQC45jK+GfhIi/hcT23jxitMms2mr3TbMgl75Z23lSFeE4K3cc6EqynTlPPgCmUzWaCYFNvlIClOQAtPuWJQvlAt8YnEEZ2DUIpndsmsKPYcnX7Roj1HwSO8ruV44p1tlaekGpRavM/KzKVC6bl80JFTYTK4XSOrcSvgo9BEvI2QmuURCkZaLi9LAZarTMrRwkQw1tH0o3p430tOHUOIbskbJgnoZCtnhwVHpWJAlxYqNZ9SfFAvANkJioddja3+ExYnsrObCw56iQoj/bQ3236vLvKQIh9ky8Riyo0Z5I3AUYxFtAeiESHmbbtP5IGOpeHgQ5VhniCe4qZrA9qYnU7ZwwTfJrDwlbaTX9qhuwiq1/WnkgGClyDjyXoeXxQ0B2pslnLBNMPw26UOC4rs0+jVUV1wSuS01RyOYByhtKTOh9YbiWCUaA1Pi+Bovjv2yCqp7H9dYjUVhJLiy9z3HRjs0N92VZGKr8EWDhVONJ2d8kvhvg9r7o72X6fTI33SPe0itJapMmFBalJ72MZnCKOcA47elpHJkBaOUtmlAomXUGieJeH6S4eXWPyjHxdgOe84tnn/fmpGU=";

let ggMTable: Uint8Array | null = null;

function ggM(g: number): number {
  if (!Number.isInteger(g) || g < 0 || g >= 4095) return 0;
  if (!ggMTable) {
    const bin = bytesFromBase64(GG_M_BITS);
    ggMTable = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  }
  return (ggMTable[g >> 3] >> (g & 7)) & 1;
}

/** 子域名序号：`1 + gg.m(parseInt(尾字节拼接, 16))`，与 common.js 一致。 */
export function imageSubdomain(hash: string): number {
  const m = /([0-9a-f]{2})([0-9a-f])$/.exec(toText(hash).toLowerCase());
  if (!m) return 1;
  const g = parseInt(m[2] + m[1], 16);
  if (Number.isNaN(g)) return 1;
  return 1 + ggM(g);
}

/** 原图（webp 优先，avif 兜底由调用方按 hasavif 决定扩展名）。 */
export function imageUrl(hash: string, ext = "webp"): string {
  const h = toText(hash).toLowerCase();
  const sub = imageSubdomain(h);
  return `https://w${sub}.${IMAGE_DOMAIN}/${GG_B}${ggS(h)}/${h}.${ext}`;
}

/** 缩略图：`tn` 域 + `real_full_path_from_hash`（尾 1.5 字节目录）。 */
export function thumbUrl(hash: string, ext = "webp"): string {
  const h = toText(hash).toLowerCase();
  const m = /^(.*)(..)(.)$/.exec(h);
  const path = m ? `${m[3]}/${m[2]}/${h}` : h;
  return `https://tn.${IMAGE_DOMAIN}/webpbigtn/${path}.${ext}`;
}

// ---------------------------------------------------------------------------
// nozomi 列表
// ---------------------------------------------------------------------------

export function decodeNozomiIds(buf: Uint8Array): number[] {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ids: number[] = [];
  for (let i = 0; i + 4 <= view.byteLength; i += 4) {
    ids.push(view.getInt32(i, false));
  }
  return ids;
}

export async function fetchNozomiPage(
  nozomiUrl: string,
  page: number,
): Promise<{ ids: number[]; total: number }> {
  const start = (page - 1) * PAGE_SIZE * 4;
  const end = start + PAGE_SIZE * 4 - 1;
  const res = await fetch(nozomiUrl, {
    headers: {
      Referer: `${WEB_BASE}/`,
      "User-Agent": UA,
      Range: `bytes=${start}-${end}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`hitomi 列表请求失败: HTTP ${res.status}`);
  }
  const range = res.headers.get("Content-Range") ?? "";
  const totalMatch = /\/(\d+)\s*$/.exec(range);
  const total = totalMatch ? Math.floor(toNumber(totalMatch[1]) / 4) : 0;
  const buf = new Uint8Array(await res.arrayBuffer());
  return { ids: decodeNozomiIds(buf), total };
}

/** `index-{language}.nozomi` / `tag/{ns}:{tag}-{language}.nozomi` 地址拼装。 */
export function nozomiListUrl(area: string, tag: string, language: string): string {
  const file = `${tag}-${language}.nozomi`;
  if (!area || area === "all") return `${DATA_CDN}/${file}`;
  return `${DATA_CDN}/${area}/${file}`;
}

// ---------------------------------------------------------------------------
// galleries 元数据
// ---------------------------------------------------------------------------

export async function fetchGallery(id: string | number): Promise<HitomiGallery> {
  const text = await fetchText(`${DATA_CDN}/galleries/${id}.js`);
  const jsonText = text
    .replace(/^var galleryinfo\s*=\s*/, "")
    .replace(/;\s*$/, "")
    .trim();
  return JSON.parse(jsonText) as HitomiGallery;
}

export async function fetchGalleries(
  ids: Array<number | string>,
  concurrency = 6,
): Promise<HitomiGallery[]> {
  const out: HitomiGallery[] = Array.from({ length: ids.length }) as HitomiGallery[];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < ids.length) {
      const i = cursor++;
      try {
        out[i] = await fetchGallery(ids[i]);
      } catch {
        out[i] = { id: ids[i] };
      }
    }
  }
  const n = Math.min(concurrency, ids.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out.filter((g) => g && toText(g.id));
}
