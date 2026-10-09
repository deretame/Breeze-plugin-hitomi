# Breeze Plugin hitomi

hitomi.la 漫画源插件。数据源全部走站内 Web 链路（无官方 App、无公开 API）：

- 列表：`ltn.gold-usergeneratedcontent.net` 的 `index-{language}.nozomi` /
  `tag/{ns}:{tag}-{language}.nozomi`，Range 分页读取 big-endian int32 画廊 ID。
- 详情：`galleries/{id}.js`（`var galleryinfo = {...}`），含标题、语言、类型、
  作者/社团/原作/角色、标签、文件 hash 尺寸、关联推荐。
- 搜索：复刻站内 `search.js`——命名空间词（`female:xxx` / `language:xxx` /
  `artist:xxx` …）直读 nozomi 全量；裸词经 `galleries.{version}.index` B+ 树
 （`sha256(term)[0..4]` 为 key）查 ID；多词按站内语义求交/求差。
- 图片：内联 `gg.js` 的 `gg.b/gg.s/gg.m` 算法（`gg.m` 以位图内嵌），拼
  `w{sub}.gold-usergeneratedcontent.net` 原图（webp），`tn.` 缩略图做封面；
  下载失败时按候选子域名 + webp/jpg 轮换重试。

本插件依赖 [`breeze-plugin-kit`](https://www.npmjs.com/package/breeze-plugin-kit)
提供类型声明和常用工具函数。

## 文档

插件开发文档：[https://deretame.github.io/plugin-dev-docs/](https://deretame.github.io/plugin-dev-docs/)

## 已导出的 fnPath

- `init` / `getInfo`
- `searchComic`（空关键词退化为最新列表；纯数字直达画廊 ID）
- `getComicDetail`（含关联推荐；评论/点赞/收藏明示不支持原因）
- `getReadSnapshot` / `getChapter`（单章节“本篇”）
- `getDownloadConcurrency`（4） / `fetchImageBytes`（二进制透传头 + 多候选重试）
- `getAdvancedSearchScheme`（语言） / `getComicListSceneBundle`
- `getRankingData` / `getRankingFilterBundle`（语言 + 分类）
- `getCommentFeed`（空列表，`canComment` 全 false）
- `toggleLike` / `toggleFavorite`（抛错明示不支持）

## 搜索语法（与站内一致）

- `female:anal`、`male:sole male`、`language:chinese`、`artist:xxx`、
  `series:xxx`、`character:xxx`、`type:doujinshi`
- 裸词如 `anal` 走标题/tag 索引；**含空格的裸 tag（如 `schoolgirl uniform`）
  在站内索引中不存在**，请用 `female:schoolgirl uniform` 形式。
- 多词空格分隔求交集，`-` 前缀排除（如 `anal -language:japanese`）。

## 维护注意

- `src/hitomi.ts` 的 `GG_B`（图片目录前缀）与 `GG_M_BITS`（`gg.m` 位图）生成自
  某版 `gg.js`；若图片大面积 404，先比对线上 `gg.js` 是否更新并重新生成。
- `galleriesindex/version` 会滚动，插件每次搜索时实时读取，无需硬编码。

## 开发

```bash
pnpm run dev
```

dev server 启动后输出 bundle 地址，在 Breeze 中通过“网络安装”加载即可调试。支持热更新。

## 构建

```bash
pnpm run build
```

构建流程：typecheck → 同步版本号 → 生成 `manifest.json` → rspack 打包 → Brotli 压缩。

**构建前请先更新 `src/get-info.ts` 中的 `version` 字段。**
