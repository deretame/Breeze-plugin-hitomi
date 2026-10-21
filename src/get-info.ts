import type { InfoContract } from "breeze-plugin-kit";
import { PLUGIN_ID } from "./common";

export function buildPluginInfo(): InfoContract {
  return {
    name: "hitomi",
    uuid: PLUGIN_ID,
    iconUrl: "https://hitomi.la/favicon.ico",
    describe: "hitomi.la 漫画源插件",
    version: "0.2.0",
    home: "https://hitomi.la",
    npmName: "breeze-plugin-hitomi",
    haveHome: true,
    function: [
      {
        id: "index",
        title: "最新",
        action: {
          type: "openComicList" as const,
          payload: {
            scene: {
              title: "hitomi 最新",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList" as const,
                request: {
                  fnPath: "getRankingData",
                  core: {},
                  extern: { source: "index", language: "all" },
                },
              },
              filter: {
                fnPath: "getRankingFilterBundle",
                extern: { source: "index" },
              },
            },
          },
        },
      },
      {
        id: "chinese",
        title: "汉化",
        action: {
          type: "openComicList" as const,
          payload: {
            scene: {
              title: "hitomi 汉化",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList" as const,
                request: {
                  fnPath: "getRankingData",
                  core: {},
                  extern: { source: "index", language: "chinese" },
                },
              },
              filter: {
                fnPath: "getRankingFilterBundle",
                extern: { source: "index" },
              },
            },
          },
        },
      },
    ],
  };
}

export function buildManifestInfo(): InfoContract {
  return buildPluginInfo();
}
