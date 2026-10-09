/**
 * hitomi.la 搜索：复刻站内 search.js 的索引链路。
 *
 * - 带命名空间的词（`female:anal` / `language:chinese` / `artist:xxx` …）→
 *   直接拼 nozomi 地址，一次 Range 读全量 ID 后内存分页。
 * - 裸词（标题/综合搜索）→ galleries B+ 树索引：
 *   `sha256(term)[0..4]` 为 key 查 `galleries.{version}.index`，
 *   拿到 `(offset, length)` 后读 `galleries.{version}.data` 得 ID 列表。
 * - 多词：首个正词定全集，其余正词求交，负词求差（与站内 do_search 一致）。
 */

import { requireCryptoLike } from "breeze-plugin-kit";
import { DATA_CDN, decodeNozomiIds, fetchRange, fetchWhole, toNumber, toText } from "./hitomi";

const MAX_NODE_SIZE = 464;
const B = 16;

let galleriesVersion = "";
let galleriesVersionLoading: Promise<string> | null = null;

async function loadGalleriesVersion(): Promise<string> {
  if (galleriesVersion) return galleriesVersion;
  if (!galleriesVersionLoading) {
    galleriesVersionLoading = (async () => {
      const res = await fetch(`${DATA_CDN}/galleriesindex/version?_=${Date.now()}`, {
        headers: { Referer: "https://hitomi.la/" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`索引版本请求失败: HTTP ${res.status}`);
      galleriesVersion = (await res.text()).trim();
      return galleriesVersion;
    })().catch((err) => {
      galleriesVersionLoading = null;
      throw err;
    });
  }
  return galleriesVersionLoading;
}

function sanitizeTag(input: string): string {
  return input.replace(/[#/]/g, "");
}

async function sha256Prefix(term: string): Promise<Uint8Array> {
  const crypto = requireCryptoLike();
  const hex = await crypto.sha256(term);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const top = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < top; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

type BNode = {
  keys: Uint8Array[];
  datas: Array<[bigint, number]>;
  subnodes: bigint[];
};

function decodeNode(data: Uint8Array): BNode | null {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 0;
    const numKeys = view.getInt32(pos, false);
    pos += 4;
    if (numKeys < 0 || numKeys > 64) return null;
    const keys: Uint8Array[] = [];
    for (let i = 0; i < numKeys; i++) {
      const size = view.getInt32(pos, false);
      pos += 4;
      if (!size || size > 32 || pos + size > view.byteLength) return null;
      keys.push(data.slice(pos, pos + size));
      pos += size;
    }
    const numDatas = view.getInt32(pos, false);
    pos += 4;
    if (numDatas < 0 || numDatas > 64) return null;
    const datas: Array<[bigint, number]> = [];
    for (let i = 0; i < numDatas; i++) {
      const offset =
        BigInt(view.getUint32(pos, false)) * 4294967296n + BigInt(view.getUint32(pos + 4, false));
      pos += 8;
      const length = view.getInt32(pos, false);
      pos += 4;
      datas.push([offset, length]);
    }
    const subnodes: bigint[] = [];
    for (let i = 0; i < B + 1; i++) {
      subnodes.push(
        BigInt(view.getUint32(pos, false)) * 4294967296n + BigInt(view.getUint32(pos + 4, false)),
      );
      pos += 8;
    }
    return { keys, datas, subnodes };
  } catch {
    return null;
  }
}

async function getNodeAt(address: bigint, version: string): Promise<BNode | null> {
  const start = Number(address);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  const buf = await fetchRange(
    `${DATA_CDN}/galleriesindex/galleries.${version}.index`,
    start,
    start + MAX_NODE_SIZE - 1,
  );
  return decodeNode(buf);
}

async function bSearch(
  key: Uint8Array,
  node: BNode,
  version: string,
): Promise<[bigint, number] | null> {
  let locate = -1;
  let found = false;
  for (let i = 0; i < node.keys.length; i++) {
    const cmp = compareBytes(key, node.keys[i]);
    if (cmp <= 0) {
      locate = i;
      found = cmp === 0;
      break;
    }
  }
  if (locate === -1) locate = node.keys.length;
  if (node.keys.length === 0) return null;
  if (found) return node.datas[locate] ?? null;
  const isLeaf = node.subnodes.every((a) => a === 0n);
  if (isLeaf) return null;
  const next = node.subnodes[locate];
  if (next === 0n) return null;
  const child = await getNodeAt(next, version);
  if (!child) return null;
  return bSearch(key, child, version);
}

/**
 * 裸词经 galleries B+ 树查 ID。注意该索引只收录部分词（含空格的常用 tag
 * 也可能 MISS，如 `schoolgirl uniform`），MISS 时与站内一样返回空集，
 * 用户需用 `female:xxx` 等命名空间形式搜索。
 */
async function galleryIdsForBareTerm(term: string): Promise<number[]> {
  const version = await loadGalleriesVersion();
  const key = await sha256Prefix(term);
  const root = await getNodeAt(0n, version);
  if (!root) return [];
  const data = await bSearch(key, root, version);
  if (!data) return [];
  const [offsetBig, length] = data;
  const offset = Number(offsetBig);
  if (!Number.isSafeInteger(offset) || length <= 0 || length > 100_000_000) {
    return [];
  }
  const buf = await fetchRange(
    `${DATA_CDN}/galleriesindex/galleries.${version}.data`,
    offset,
    offset + length - 1,
  );
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = view.getInt32(0, false);
  if (count <= 0 || count > 10_000_000 || buf.byteLength !== count * 4 + 4) {
    return [];
  }
  const ids: number[] = [];
  for (let i = 0; i < count; i++) ids.push(view.getInt32(4 + i * 4, false));
  return ids;
}

/**
 * 命名空间词 → nozomi 全量 ID（如 `language:chinese` → `index-chinese.nozomi`）。
 * 与 `get_galleryids_for_query` 的分支语义一致。
 */
export async function galleryIdsForNamespacedTerm(term: string): Promise<number[]> {
  const [left, ...rest] = term.split(":");
  const right = rest.join(":");
  let url: string;
  if (left === "female" || left === "male") {
    url = `${DATA_CDN}/tag/${encodeURIComponent(term)}-all.nozomi`;
  } else if (left === "language") {
    url = `${DATA_CDN}/index-${encodeURIComponent(right)}-all.nozomi`;
  } else if (right) {
    url = `${DATA_CDN}/${encodeURIComponent(left)}/${encodeURIComponent(right)}-all.nozomi`;
  } else {
    return [];
  }
  const buf = await fetchWhole(url);
  return decodeNozomiIds(buf);
}

export type ParsedQuery = {
  positive: string[];
  negative: string[];
};

export function parseQuery(raw: string): ParsedQuery {
  const terms = toText(raw).toLowerCase().replace(/_/g, " ").split(/\s+/).filter(Boolean);
  const positive: string[] = [];
  const negative: string[] = [];
  for (const term of terms) {
    if (term.startsWith("-") && term.length > 1) negative.push(term.slice(1));
    else if (term !== "or") positive.push(term);
  }
  return { positive, negative };
}

async function galleryIdsForTerm(term: string): Promise<number[]> {
  const clean = sanitizeTag(term);
  if (!clean) return [];
  if (clean.includes(":")) return galleryIdsForNamespacedTerm(clean);
  return galleryIdsForBareTerm(clean);
}

/** 多词搜索：首个正词定全集，其余求交，负词求差。 */
export async function searchGalleryIds(raw: string): Promise<number[]> {
  const { positive, negative } = parseQuery(raw);
  if (positive.length === 0 && negative.length === 0) return [];
  let results: number[] = [];
  if (positive.length > 0) {
    const [first, ...rest] = positive;
    results = await galleryIdsForTerm(first);
    for (const term of rest) {
      if (results.length === 0) break;
      const set = new Set(await galleryIdsForTerm(term));
      results = results.filter((id) => set.has(id));
    }
  } else {
    // 只有负词时无全集可差：退化为空（站内同样无意义）
    return [];
  }
  for (const term of negative) {
    if (results.length === 0) break;
    const set = new Set(await galleryIdsForTerm(term));
    results = results.filter((id) => !set.has(id));
  }
  return results;
}

export function nozomiAddressForLanguage(language: string): string {
  return `${DATA_CDN}/index-${encodeURIComponent(language)}.nozomi`;
}

export function tagToNozomiUrl(area: string, tag: string): string {
  return `${DATA_CDN}/${area}/${encodeURIComponent(tag)}-all.nozomi`;
}

export { sanitizeTag, toNumber };
