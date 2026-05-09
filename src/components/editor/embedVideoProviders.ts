/**
 * 网络视频 URL → 嵌入播放器 URL 的解析器
 *
 * 支持平台：B站 / YouTube / 腾讯视频 / 优酷 / Vimeo / Twitch / Dailymotion。
 * 设计：每个平台一条 ProviderRule（{ id, name, match, toEmbedUrl }），
 *      新增平台只需追加一条规则。统一返回 { provider, embedUrl, originalUrl }，
 *      由 EmbedVideoNode 渲染。
 *
 * 平台限制说明：
 * - YouTube：国内网络通常无法访问，但 iframe 协议本身没问题
 * - 腾讯视频/优酷：部分 VIP / 独家视频会被服务端 X-Frame-Options 拦截，
 *   表现为 iframe 黑屏 —— 这是平台行为，前端无法绕过，提示用户在浏览器打开即可
 * - Vimeo / Twitch / Dailymotion：海外标准平台，iframe 稳定
 */

export type EmbedProviderId =
  | "bilibili"
  | "youtube"
  | "qq"
  | "youku"
  | "vimeo"
  | "twitch"
  | "dailymotion"
  | "generic";

export interface ParsedEmbed {
  /** 平台 ID（后续可用于差异化样式 / 图标） */
  provider: EmbedProviderId;
  /** 平台中文名（用于 UI 显示） */
  providerName: string;
  /** 真正塞进 iframe 的 src */
  embedUrl: string;
  /** 用户输入的原始 URL（保留用于跳浏览器 / 失效兜底） */
  originalUrl: string;
}

interface ProviderRule {
  id: EmbedProviderId;
  name: string;
  /** 命中则提取关键 ID；返回 null 表示不匹配 */
  match: (url: string) => string | null;
  /** 用关键 ID 拼出 iframe src */
  toEmbedUrl: (id: string) => string;
}

const RULES: ProviderRule[] = [
  // ─── B 站 ──────────────────────────────────────────
  // 视频页：https://www.bilibili.com/video/BV18ooTB2E7T/?spm_id_from=...
  // 短链：https://b23.tv/xxxx（不解析，让用户先在浏览器跳一次拿到 BV）
  {
    id: "bilibili",
    name: "B站",
    match: (url) => {
      const m = url.match(/\b(BV[A-Za-z0-9]{10})\b/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (bvid) =>
      `https://player.bilibili.com/player.html?bvid=${bvid}&autoplay=0&high_quality=1&danmaku=0`,
  },

  // ─── YouTube ──────────────────────────────────────
  // 长链：https://www.youtube.com/watch?v=XXXX
  // 短链：https://youtu.be/XXXX
  // embed：https://www.youtube.com/embed/XXXX
  {
    id: "youtube",
    name: "YouTube",
    match: (url) => {
      const m =
        url.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
        url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
        url.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (id) => `https://www.youtube.com/embed/${id}`,
  },

  // ─── 腾讯视频 ──────────────────────────────────────
  // 视频页：https://v.qq.com/x/cover/xxx/{vid}.html
  //         https://v.qq.com/x/page/{vid}.html
  // vid 是字母数字串，长度通常 11–16
  {
    id: "qq",
    name: "腾讯视频",
    match: (url) => {
      const m =
        url.match(/v\.qq\.com\/[^\s]*?\/([a-zA-Z0-9]{10,20})\.html/) ||
        url.match(/[?&]vid=([a-zA-Z0-9]{10,20})/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (vid) =>
      `https://v.qq.com/txp/iframe/player.html?vid=${vid}&autoplay=0`,
  },

  // ─── 优酷 ──────────────────────────────────────────
  // 视频页：https://v.youku.com/v_show/id_XNTU2OTcwODc0MA==.html
  // id 是 base64 风格串（含 == 结尾），出现在 id_ 后面
  {
    id: "youku",
    name: "优酷",
    match: (url) => {
      const m = url.match(/youku\.com\/v_show\/id_([A-Za-z0-9=]+)\.html/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (id) => `https://player.youku.com/embed/${id}`,
  },

  // ─── Vimeo ────────────────────────────────────────
  // 视频页：https://vimeo.com/{id}（id 全数字，9 位左右）
  // 频道页：https://vimeo.com/channels/xxx/{id}
  // embed：https://player.vimeo.com/video/{id}
  {
    id: "vimeo",
    name: "Vimeo",
    match: (url) => {
      const m =
        url.match(/vimeo\.com\/(?:channels\/[^/]+\/|groups\/[^/]+\/videos\/)?(\d{6,})/) ||
        url.match(/player\.vimeo\.com\/video\/(\d{6,})/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (id) => `https://player.vimeo.com/video/${id}`,
  },

  // ─── Twitch ───────────────────────────────────────
  // 录播：https://www.twitch.tv/videos/{video_id}（纯数字）
  // 直播：https://www.twitch.tv/{channel}（用 channel 名）
  // 注意：Twitch 嵌入要求 parent 参数指明嵌入域名，桌面 WebView 没有真实
  //       公网域名，传 "tauri.localhost" 可在大多数 Tauri WebView 通过；
  //       不行的话提示用户在浏览器打开
  {
    id: "twitch",
    name: "Twitch",
    match: (url) => {
      const vod = url.match(/twitch\.tv\/videos\/(\d+)/);
      if (vod) return `v:${vod[1]}`;
      const live = url.match(/twitch\.tv\/([A-Za-z0-9_]+)(?:\/|$|\?)/);
      // 排除 Twitch 内部路径关键字
      if (live && !["videos", "directory", "p", "search"].includes(live[1])) {
        return `c:${live[1]}`;
      }
      return null;
    },
    toEmbedUrl: (key) => {
      const parent = "tauri.localhost";
      if (key.startsWith("v:")) {
        return `https://player.twitch.tv/?video=${key.slice(2)}&parent=${parent}&autoplay=false`;
      }
      return `https://player.twitch.tv/?channel=${key.slice(2)}&parent=${parent}&autoplay=false`;
    },
  },

  // ─── Dailymotion ──────────────────────────────────
  // 视频页：https://www.dailymotion.com/video/{id}（id 是字母数字短串）
  // 短链：https://dai.ly/{id}
  // embed：https://www.dailymotion.com/embed/video/{id}
  {
    id: "dailymotion",
    name: "Dailymotion",
    match: (url) => {
      const m =
        url.match(/dailymotion\.com\/(?:embed\/)?video\/([a-zA-Z0-9]+)/) ||
        url.match(/dai\.ly\/([a-zA-Z0-9]+)/);
      return m ? m[1] : null;
    },
    toEmbedUrl: (id) => `https://www.dailymotion.com/embed/video/${id}`,
  },
];

/**
 * 解析 URL，识别平台并生成 iframe src。
 *
 * 返回 null 表示无法识别 → UI 层应该 message.warning 提示。
 *
 * 对于已经是 player.bilibili.com / youtube.com/embed 等"嵌入态"URL，
 * 也能识别（match 规则同时覆盖）。
 */
export function parseEmbedUrl(rawUrl: string): ParsedEmbed | null {
  const url = rawUrl.trim();
  if (!url) return null;

  for (const rule of RULES) {
    const id = rule.match(url);
    if (id) {
      return {
        provider: rule.id,
        providerName: rule.name,
        embedUrl: rule.toEmbedUrl(id),
        originalUrl: url,
      };
    }
  }
  return null;
}

/** 已支持的平台名列表（给 UI 提示用） */
export const SUPPORTED_PROVIDERS = RULES.map((r) => r.name).join(" / ");
