import type {
  ActionItem,
  AdvancedSearchContract,
  ChapterContentContract,
  ChapterPage,
  ChapterPayload,
  ChapterSummary,
  ChapterWithPages,
  ComicDetailContract,
  ComicDetailNormal,
  ComicDetailPayload,
  ComicListItem,
  ComicListScene,
  ComicListSceneBundleContract,
  ComicPagedListContract,
  CommentFeedContract,
  CommentFeedPayload,
  FetchImageBytesPayload,
  FilterBundleContract,
  ImageItem,
  InfoContract,
  MetadataListItem,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  RecommendItem,
  SearchComicPayload,
  SearchResultContract,
  PluginHomePagesBundleContract,
  SettingsBundleContract,
  CapabilitiesBundleContract,
} from "breeze-plugin-kit";
import { NOT_FOUND_IMAGE_URL, PLUGIN_ID, createActionItem, createImage } from "./common";
import { buildPluginInfo } from "./get-info";
import {
  PAGE_SIZE,
  WEB_BASE,
  asArray,
  asRecord,
  fetchGalleries,
  fetchGallery,
  fetchNozomiPage,
  imageSubdomain,
  imageUrl,
  nozomiListUrl,
  thumbUrl,
  toNumber,
  toText,
  type HitomiGallery,
} from "./hitomi";
import { searchGalleryIds } from "./search";

const MAIN_CHAPTER_ID = "main";
const IMAGE_HOSTS = [1, 2, 3] as const;

// ---------------------------------------------------------------------------
// mappers
// ---------------------------------------------------------------------------

function galleryId(g: HitomiGallery): string {
  return toText(g.id);
}

function galleryTitle(g: HitomiGallery): string {
  return toText(g.title) || toText(g.japanese_title) || `hitomi ${galleryId(g)}`;
}

function galleryDate(g: HitomiGallery): string {
  return toText(g.datepublished ?? g.date).slice(0, 10);
}

function coverHash(g: HitomiGallery): string {
  const files = asArray<{ hash?: unknown }>(g.files);
  return toText(files[0]?.hash);
}

function buildCover(g: HitomiGallery): ImageItem {
  const id = galleryId(g);
  const hash = coverHash(g);
  const url = hash ? thumbUrl(hash, "webp") : NOT_FOUND_IMAGE_URL;
  return createImage({
    id,
    url,
    name: `${id || "cover"}.webp`,
    path: hash ? `hitomi/${id}/cover.webp` : `hitomi/${id}/cover-missing`,
    extern: { hash },
  });
}

function searchAction(ns: string, tag: string, label?: string): ActionItem {
  const keyword = ns === "tag" ? tag : `${ns}:${tag}`;
  return createActionItem(label ?? tag, {
    type: "openSearch",
    payload: { source: PLUGIN_ID, keyword },
  });
}

function namesOf(items: unknown, key: string): Array<{ name: string; url: string }> {
  return asArray<Record<string, unknown>>(items)
    .map((it) => ({
      name: toText(it[key]),
      url: toText(it.url),
    }))
    .filter((it) => it.name);
}

function buildMetadata(g: HitomiGallery): MetadataListItem[] {
  const metadata: MetadataListItem[] = [];
  const push = (type: string, name: string, values: ActionItem[]) => {
    if (values.length > 0) metadata.push({ type, name, value: values });
  };

  if (toText(g.language)) {
    push("language", "语言", [
      searchAction(
        "language",
        toText(g.language),
        toText(g.language_localname) || toText(g.language),
      ),
    ]);
  }
  push("type", "类型", toText(g.type) ? [searchAction("type", toText(g.type))] : []);
  push(
    "artist",
    "作者",
    namesOf(g.artists, "artist").map((a) => searchAction("artist", a.name)),
  );
  push(
    "group",
    "社团",
    namesOf(g.groups, "group").map((a) => searchAction("group", a.name)),
  );
  push(
    "parody",
    "原作",
    namesOf(g.parodys, "parody").map((a) => searchAction("series", a.name, a.name)),
  );
  push(
    "character",
    "角色",
    namesOf(g.characters, "character").map((a) => searchAction("character", a.name)),
  );
  const tags = asArray<{ tag?: unknown; male?: unknown; female?: unknown }>(g.tags);
  const female = tags
    .filter((t) => toText(t.female) === "1")
    .map((t) => searchAction("female", toText(t.tag)));
  const male = tags
    .filter((t) => toText(t.male) === "1")
    .map((t) => searchAction("male", toText(t.tag)));
  const plain = tags
    .filter((t) => !toText(t.female) && !toText(t.male))
    .map((t) => searchAction("tag", toText(t.tag)));
  push("female", "女性向标签", female);
  push("male", "男性向标签", male);
  push("tag", "标签", plain);

  const id = galleryId(g);
  if (id) {
    metadata.push({
      type: "web",
      name: "网页",
      value: [
        createActionItem("在网页打开", {
          type: "openWeb",
          payload: {
            title: galleryTitle(g),
            url: `${WEB_BASE}/galleries/${id}.html`,
          },
        }),
      ],
    });
  }
  return metadata;
}

function buildListItem(g: HitomiGallery): ComicListItem {
  const id = galleryId(g);
  const title = galleryTitle(g);
  const date = galleryDate(g);
  const files = asArray(g.files);
  const subtitle = [files.length ? `${files.length} pages` : "", date].filter(Boolean).join(" / ");
  return {
    source: PLUGIN_ID,
    id,
    title,
    subtitle,
    finished: true,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: date,
    cover: buildCover(g),
    metadata: buildMetadata(g),
    raw: g as Record<string, unknown>,
    extern: { webUrl: `${WEB_BASE}/galleries/${id}.html` },
  };
}

function buildRecommendItem(g: HitomiGallery): RecommendItem {
  return buildListItem(g);
}

function chapterSummary(g: HitomiGallery): ChapterSummary {
  const id = galleryId(g);
  return {
    id: MAIN_CHAPTER_ID,
    requestId: MAIN_CHAPTER_ID,
    logicalKey: MAIN_CHAPTER_ID,
    storageChapterId: id || MAIN_CHAPTER_ID,
    name: "本篇",
    order: 1,
    extern: {},
  };
}

/** 页图 URL 写入 url；同时把 hash/尺寸/多 CDN 候选写入 extern 供容灾。 */
function buildPages(g: HitomiGallery): ChapterPage[] {
  return asArray<{ hash?: unknown; name?: unknown; width?: unknown; height?: unknown }>(
    g.files,
  ).map((file, index) => {
    const hash = toText(file.hash);
    const pageNo = index + 1;
    const name = toText(file.name) || `${pageNo}.webp`;
    const width = toNumber(file.width);
    const height = toNumber(file.height);
    const sub = imageSubdomain(hash);
    const hosts = [`w${sub}`, ...IMAGE_HOSTS.filter((h) => h !== sub).map((h) => `w${h}`)];
    return {
      id: String(pageNo),
      name,
      path: hash ? `hitomi/${galleryId(g)}/${name}` : name,
      url: hash ? imageUrl(hash, "webp") : NOT_FOUND_IMAGE_URL,
      extern: {
        hash,
        width: width || null,
        height: height || null,
        hosts,
      },
    };
  });
}

function chapterWithPages(g: HitomiGallery): ChapterWithPages {
  return { ...chapterSummary(g), pages: buildPages(g) };
}

function normalDetail(g: HitomiGallery): ComicDetailNormal {
  const id = galleryId(g);
  const title = galleryTitle(g);
  const japanese = toText(g.japanese_title);
  const files = asArray(g.files);
  const date = galleryDate(g);
  const titleMeta = [
    japanese && japanese !== title ? createActionItem(`Japanese: ${japanese}`) : null,
    id ? createActionItem(`ID: ${id}`) : null,
    toText(g.type) ? createActionItem(toText(g.type)) : null,
    files.length ? createActionItem(`${files.length} pages`) : null,
    date ? createActionItem(date) : null,
  ].filter((a): a is ActionItem => a !== null);

  return {
    comicInfo: {
      id,
      title,
      titleMeta,
      creator: {
        id: "",
        name: "",
        // 不走 createImage：空 avatar 才能让宿主隐藏作者卡片（见 comic_info.dart 判断）。
        avatar: { id: "", url: "", name: "", path: "", extern: {} },
        onTap: null,
        extern: {},
      },
      description: japanese && japanese !== title ? japanese : "",
      cover: buildCover(g),
      metadata: buildMetadata(g),
      extern: { webUrl: `${WEB_BASE}/galleries/${id}.html` },
    },
    eps: [chapterSummary(g)],
    recommend: [],
    totalViews: 0,
    totalLikes: 0,
    totalComments: 0,
    isFavourite: false,
    isLiked: false,
    allowComments: false,
    allowCommentsReason: "hitomi.la 不提供评论接口",
    allowLike: false,
    allowLikeReason: "hitomi.la 不支持点赞",
    allowCollected: false,
    allowCollectedReason: "hitomi.la 无需登录，不支持云端收藏",
    allowDownload: true,
    extern: {},
  };
}

function pagingOf(
  page: number,
  total: number,
): {
  page: number;
  pages: number;
  total: number;
  hasReachedMax: boolean;
} {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return {
    page,
    pages,
    total,
    hasReachedMax: page >= pages || total === 0,
  };
}

// ---------------------------------------------------------------------------
// 列表（nozomi 分页 + galleries 详情补全）
// ---------------------------------------------------------------------------

function listParams(extern: unknown): {
  area: string;
  tag: string;
  language: string;
} {
  const map = asRecord(extern);
  return {
    area: toText(map.area) || "all",
    tag: toText(map.tag) || "index",
    language: toText(map.language) || "all",
  };
}

async function loadListPage(
  extern: unknown,
  page: number,
): Promise<{ items: ComicListItem[]; total: number }> {
  const { area, tag, language } = listParams(extern);
  const url = nozomiListUrl(area, tag, language);
  const { ids, total } = await fetchNozomiPage(url, page);
  if (ids.length === 0) return { items: [], total };
  const galleries = await fetchGalleries(ids);
  return { items: galleries.map(buildListItem), total };
}

// ---------------------------------------------------------------------------
// fnPath 实现
// ---------------------------------------------------------------------------

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  return { source: PLUGIN_ID, data: { ok: true } };
}

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

async function searchComic(payload: SearchComicPayload = {}): Promise<SearchResultContract> {
  const page = Math.max(1, toNumber(payload.page, 1));
  const keyword = toText(payload.keyword);

  // 纯数字：直达画廊 ID（nhentai 插件同款行为）
  if (/^\d+$/.test(keyword) && page === 1) {
    try {
      const gallery = await fetchGallery(keyword);
      if (toText(gallery.id)) {
        const item = buildListItem(gallery);
        const paging = { page: 1, pages: 1, total: 1, hasReachedMax: true };
        return {
          source: PLUGIN_ID,
          extern: payload.extern ?? null,
          scheme: {
            version: "1.0.0",
            type: "searchResult",
            source: PLUGIN_ID,
            list: "comicGrid",
          },
          data: { paging, items: [item] },
          paging,
          items: [item],
        };
      }
    } catch {
      // 回退普通搜索
    }
  }

  const externMap = asRecord(payload.extern);
  const language = toText(externMap.language) || "all";
  if (!keyword) {
    const { items, total } = await loadListPage({ area: "all", tag: "index", language }, page);
    const paging = pagingOf(page, total);
    return {
      source: PLUGIN_ID,
      extern: payload.extern ?? null,
      scheme: {
        version: "1.0.0",
        type: "searchResult",
        source: PLUGIN_ID,
        list: "comicGrid",
      },
      data: { paging, items },
      paging,
      items,
    };
  }

  const ids = await searchGalleryIds(keyword);
  const total = ids.length;
  const slice = ids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const items = (await fetchGalleries(slice)).map(buildListItem);
  const paging = pagingOf(page, total);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { paging, items },
    paging,
    items,
  };
}

async function getComicDetail(payload: ComicDetailPayload = {}): Promise<ComicDetailContract> {
  const comicId = toText(payload.comicId);
  if (!comicId) throw new Error("comicId 不能为空");
  const gallery = await fetchGallery(comicId);
  if (!toText(gallery.id)) throw new Error(`画廊 ${comicId} 不存在`);
  const related = asArray<number | string>(gallery.related).slice(0, 12);
  const detail = normalDetail(gallery);
  if (related.length > 0) {
    const relatedGalleries = await fetchGalleries(related, 4);
    detail.recommend = relatedGalleries.map(buildRecommendItem);
  }
  return {
    source: PLUGIN_ID,
    comicId: galleryId(gallery),
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
    data: { normal: detail, raw: gallery },
  };
}

async function comicChapter(
  payload: ReadSnapshotPayload | ChapterPayload = {},
): Promise<{ gallery: HitomiGallery; summary: ChapterSummary }> {
  const comicId =
    payload && typeof payload === "object" && "comicId" in payload ? toText(payload.comicId) : "";
  if (!comicId) throw new Error("comicId 不能为空");
  const gallery = await fetchGallery(comicId);
  if (!toText(gallery.id)) throw new Error(`画廊 ${comicId} 不存在`);
  return { gallery, summary: chapterSummary(gallery) };
}

async function getReadSnapshot(payload: ReadSnapshotPayload = {}): Promise<ReadSnapshotContract> {
  const { gallery, summary } = await comicChapter(payload);
  const chapter = chapterWithPages(gallery);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: galleryId(gallery),
        source: PLUGIN_ID,
        title: galleryTitle(gallery),
        extern: {
          webUrl: `${WEB_BASE}/galleries/${galleryId(gallery)}.html`,
        },
      },
      chapter,
      chapters: [
        {
          id: summary.id,
          name: summary.name,
          order: summary.order,
          extern: summary.extern,
        },
      ],
    },
  };
}

async function getChapter(payload: ChapterPayload = {}): Promise<ChapterContentContract> {
  const { gallery, summary } = await comicChapter(payload);
  const chapter = chapterWithPages(gallery);
  const comicId = galleryId(gallery);
  return {
    source: PLUGIN_ID,
    comicId,
    chapterId: summary.requestId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: galleryTitle(gallery),
        extern: { webUrl: `${WEB_BASE}/galleries/${comicId}.html` },
      },
      chapter,
      chapters: [summary],
    },
  };
}

async function getDownloadConcurrency(): Promise<{ concurrency: number }> {
  return { concurrency: 4 };
}

/** 图片下载：主 URL 失败时按 extern.hosts 轮换子域名 + webp/avif 互换。 */
async function fetchImageBytes(
  payload: FetchImageBytesPayload = {},
): Promise<Uint8Array<ArrayBufferLike>> {
  const extern = asRecord(payload.extern);
  const hash = toText(extern.hash);
  const timeoutMs = toNumber(payload.timeoutMs, 30000);
  const candidates: string[] = [];
  if (hash) {
    const hosts = asArray<string | number>(extern.hosts);
    const subs = hosts.length > 0 ? hosts : [`w${imageSubdomain(hash)}`];
    for (const host of subs) {
      candidates.push(
        `https://${host}.gold-usergeneratedcontent.net/1791547201/${imagePathSuffix(hash)}.webp`,
      );
    }
    for (const host of subs) {
      candidates.push(
        `https://${host}.gold-usergeneratedcontent.net/1791547201/${imagePathSuffix(hash)}.jpg`,
      );
    }
  }
  const primary = toText(payload.url);
  if (primary) candidates.unshift(primary);
  const tried = new Set<string>();
  let lastError = "";
  for (const url of candidates) {
    if (!url || tried.has(url)) continue;
    tried.add(url);
    try {
      const res = await fetch(url, {
        headers: {
          Referer: `${WEB_BASE}/`,
          "x-rquickjs-host-offload-binary-v1": "1",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`图片下载失败${lastError ? `: ${lastError}` : ""}`);
}

function imagePathSuffix(hash: string): string {
  const h = hash.toLowerCase();
  const m = /(..)(.)$/.exec(h);
  const dir = m ? parseInt(m[2] + m[1], 16).toString(10) : "0";
  return `${dir}/${h}`;
}

async function getAdvancedSearchScheme(): Promise<AdvancedSearchContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "advancedSearch",
      title: "高级搜索",
      fields: [
        {
          key: "language",
          kind: "choice",
          label: "语言",
          options: [
            { label: "全部", value: "all" },
            { label: "中文", value: "chinese" },
            { label: "英文", value: "english" },
            { label: "日文", value: "japanese" },
          ],
        },
      ],
    },
    data: { values: { language: "all" } },
  };
}

async function getComicListSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "comicListSceneBundle" },
    data: {
      scene: {
        title: "hitomi",
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: {
            fnPath: "getRankingData",
            core: {},
            extern: { area: "all", tag: "index", language: "all" },
          },
        },
        filter: { fnPath: "getRankingFilterBundle", extern: {} },
      },
    },
  };
}

function hitomiScene(title: string, language: string): ComicListScene {
  return {
    title,
    source: PLUGIN_ID,
    body: {
      type: "pluginPagedComicList" as const,
      request: {
        fnPath: "getRankingData",
        core: {},
        extern: { area: "all", tag: "index", language },
      },
    },
    filter: { fnPath: "getRankingFilterBundle", extern: {} },
  };
}

async function getPluginHomePagesBundle(): Promise<PluginHomePagesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "homePagesBundle" },
    data: {
      tabs: [
        { id: "index", title: "最新", scene: hitomiScene("hitomi 最新", "all") },
        { id: "chinese", title: "汉化", scene: hitomiScene("hitomi 汉化", "chinese") },
      ],
    },
  };
}

async function getRankingData(payload: SearchComicPayload = {}): Promise<ComicPagedListContract> {
  const page = Math.max(1, toNumber(payload.page, 1));
  const extern = { ...asRecord(payload.extern) };
  const keyword = toText((payload as SearchComicPayload & { keyword?: unknown }).keyword);
  if (keyword) {
    const result = await searchComic({ ...payload, page });
    return {
      source: PLUGIN_ID,
      extern: payload.extern ?? null,
      scheme: {
        version: "1.0.0",
        type: "comicPagedList",
        source: PLUGIN_ID,
      },
      data: { items: result.items, hasReachedMax: result.paging.hasReachedMax },
    };
  }
  const { items, total } = await loadListPage(extern, page);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "comicPagedList",
      source: PLUGIN_ID,
    },
    data: {
      items,
      hasReachedMax: page * PAGE_SIZE >= total || items.length === 0,
    },
  };
}

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选",
      fields: [
        {
          key: "language",
          kind: "choice",
          label: "语言",
          options: [
            {
              label: "全部",
              value: "all",
              result: { extern: { area: "all", tag: "index", language: "all" } },
            },
            {
              label: "中文",
              value: "chinese",
              result: {
                extern: { area: "all", tag: "index", language: "chinese" },
              },
            },
            {
              label: "英文",
              value: "english",
              result: {
                extern: { area: "all", tag: "index", language: "english" },
              },
            },
            {
              label: "日文",
              value: "japanese",
              result: {
                extern: { area: "all", tag: "index", language: "japanese" },
              },
            },
          ],
        },
        {
          key: "category",
          kind: "choice",
          label: "分类",
          options: [
            {
              label: "全部",
              value: "all",
              result: { extern: { area: "all", tag: "index" } },
            },
            {
              label: "同人",
              value: "doujinshi",
              result: { extern: { area: "all", tag: "index", language: "all" } },
              children: [
                {
                  label: "汉化同人",
                  value: "doujinshi-chinese",
                  result: {
                    extern: { area: "tag", tag: "doujinshi-chinese" },
                  },
                },
              ],
            },
            {
              label: "漫画",
              value: "manga",
              result: { extern: { area: "tag", tag: "manga" } },
            },
            {
              label: "画师CG",
              value: "artistcg",
              result: { extern: { area: "tag", tag: "artistcg" } },
            },
          ],
        },
      ],
    },
    data: { values: { language: "all", category: "all" } },
  };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "settings", sections: [] },
    data: { canShowUserInfo: false, values: {} },
  };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "capabilities", actions: [] },
    data: {},
  };
}

async function getCommentFeed(_payload: CommentFeedPayload = {}): Promise<CommentFeedContract> {
  return {
    source: PLUGIN_ID,
    extern: null,
    scheme: { version: "1.0.0", type: "commentFeed" },
    data: {
      topItems: [],
      items: [],
      paging: { hasReachedMax: true },
      replyMode: "embedded",
      canComment: { comic: false, reply: false },
    },
  };
}

async function toggleLike(): Promise<{ liked: boolean }> {
  throw new Error("hitomi.la 不支持点赞");
}

async function toggleFavorite(): Promise<{
  favorited: boolean;
  nextStep: "none";
}> {
  throw new Error("hitomi.la 无需登录，不支持收藏");
}

export default {
  init,
  getInfo,
  searchComic,
  getComicDetail,
  getReadSnapshot,
  getChapter,
  getDownloadConcurrency,
  fetchImageBytes,
  getAdvancedSearchScheme,
  getComicListSceneBundle,
  getRankingData,
  getPluginHomePagesBundle,
  getRankingFilterBundle,
  getSettingsBundle,
  getCapabilitiesBundle,
  getCommentFeed,
  toggleLike,
  toggleFavorite,
};
