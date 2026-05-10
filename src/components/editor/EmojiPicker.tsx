/**
 * Emoji 选择器：工具栏触发的 Popover，按分类 Tab 列出常用 emoji。
 *
 * 不引入第三方 emoji 数据库（emoji-mart 等体积 ~500KB+），用手写常用集 ~280 个。
 * 90% 笔记场景够用；用户输入特殊 emoji 仍可直接粘贴。
 *
 * 选中后通过 editor.chain().focus().insertContent(emoji) 插入到光标处。
 */
import { useState } from "react";
import { Popover, Tooltip, Button } from "antd";
import { Smile } from "lucide-react";
import type { Editor } from "@tiptap/react";

const CATEGORIES: { key: string; label: string; icon: string; emojis: string }[] = [
  {
    key: "common",
    label: "常用",
    icon: "⭐",
    emojis: "😀 😂 🥰 😍 🤔 😎 😴 🥺 ❤️ 👍 👎 👏 🙏 🎉 🔥 💯 ✨ ⭐ ✅ ❌ ⚠️ 💡 📌 🚀",
  },
  {
    key: "smileys",
    label: "表情",
    icon: "😊",
    emojis:
      "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 🥲 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 😮‍💨 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 🥸 😎 🤓 🧐",
  },
  {
    key: "gestures",
    label: "手势",
    icon: "👍",
    emojis:
      "👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💪 🦾",
  },
  {
    key: "people",
    label: "人物",
    icon: "👨",
    emojis:
      "👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 👮 🕵 💂 👷 🤴 👸 👲 🧕 🤵 👰 🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💁 🙅 🙆 🙋 🧏 🤦 🤷 🙇 🤳 💆 💇 🚶 🏃 💃 🕺",
  },
  {
    key: "animals",
    label: "动物",
    icon: "🐶",
    emojis:
      "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🦄 🐴 🦓 🦒 🦌 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🐝 🐛 🦋 🐌 🐞 🐜 🦗 🕷 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊",
  },
  {
    key: "food",
    label: "食物",
    icon: "🍎",
    emojis:
      "🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶 🌽 🥕 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪",
  },
  {
    key: "activities",
    label: "活动",
    icon: "⚽",
    emojis:
      "⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🎱 🪀 🏓 🏸 🥅 ⛳ 🪁 🏹 🎣 🤿 🥊 🥋 🎽 🛹 🛷 ⛸ 🥌 🎿 ⛷ 🏂 🪂 🏋 🤼 🤸 ⛹ 🤺 🤾 🏌 🏇 🧘 🏄 🏊 🤽 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖 🏵 🎗 🎫 🎟 🎪 🤹 🎭 🩰 🎨 🎬 🎤 🎧 🎼 🎵 🎶 🥁 🎷 🎺 🎸 🪕 🎻",
  },
  {
    key: "objects",
    label: "物品",
    icon: "💡",
    emojis:
      "💡 🔦 🕯 🪔 🧯 🛢 💸 💵 💴 💶 💷 🪙 💰 💳 🧾 ✉️ 📧 📨 📩 📤 📥 📦 🏷 📪 📫 📬 📭 📮 🗳 ✏️ ✒️ 🖋 🖊 🖌 🖍 📝 💼 📁 📂 🗂 📅 📆 🗒 🗓 📇 📈 📉 📊 📋 📌 📍 📎 🖇 📏 📐 ✂️ 🗃 🗄 🗑 🔒 🔓 🔏 🔐 🔑 🗝 🔨 🪓 ⛏ ⚒ 🛠 🗡 ⚔️ 🔫 🪃 🏹 🛡 🪚 🔧 🪛 🔩 ⚙️ 🗜 ⚖️ 🦯 🔗 ⛓ 🪝 🧰 🧲 🪜 ⚗️ 🧪 🧫 🧬 🔬 🔭 📡 💉 🩸 💊",
  },
  {
    key: "symbols",
    label: "符号",
    icon: "❤️",
    emojis:
      "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎ ♈️ ♉️ ♊️ ♋️ ♌️ ♍️ ♎️ ♏️ ♐️ ♑️ ♒️ ♓️ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚️ 🈸 🈺 🈷 ✴️ 🆚 💮 🉐 ㊙️ ㊗️ 🈴 🈵 🈹 🈲 🅰️ 🅱️ 🆎 🆑 🅾️ 🆘 ❌ ⭕️ 🛑 ⛔️ 📛 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗️ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆 〽️ ⚠️ 🚸 🔱 ⚜️ 🔰 ♻️ ✅ 🈯️ 💹 ❇️ ✳️ ❎ 🌐 💠",
  },
  // 旗帜（不含国旗）：Windows 默认 Segoe UI Emoji 不支持区域指示符
  // 双字符组合（🇨🇳/🇺🇸 等会显示成 "CN"/"US" 字母），所以只放普通旗帜符号
  {
    key: "flags",
    label: "旗帜",
    icon: "🚩",
    emojis: "🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🏴‍☠️",
  },
];

interface EmojiPickerProps {
  editor: Editor;
}

export function EmojiPicker({ editor }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string>("common");

  function insertEmoji(emoji: string) {
    editor.chain().focus().insertContent(emoji).run();
    setOpen(false);
  }

  function stopMouseDown(e: React.MouseEvent) {
    e.stopPropagation();
  }

  const active = CATEGORIES.find((c) => c.key === activeKey) ?? CATEGORIES[0];

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      open={open}
      onOpenChange={setOpen}
      content={
        <div onMouseDown={stopMouseDown} style={{ width: 380 }}>
          {/* 顶部水平分类条：emoji 图标按钮，紧凑布局，10 个全部直接展示 */}
          <div className="emoji-cat-bar">
            {CATEGORIES.map((cat) => (
              <button
                type="button"
                key={cat.key}
                className={`emoji-cat-btn ${cat.key === activeKey ? "active" : ""}`}
                onClick={() => setActiveKey(cat.key)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          {/* 当前分类的 emoji 网格 */}
          <div
            className="emoji-grid"
            style={{ maxHeight: 280, overflowY: "auto", paddingRight: 4 }}
          >
            {active.emojis.split(/\s+/).filter(Boolean).map((e, i) => (
              <button
                type="button"
                key={`${e}-${i}`}
                className="emoji-grid-item"
                onClick={() => insertEmoji(e)}
                title={e}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <Tooltip title="插入 Emoji" mouseEnterDelay={0.5}>
        <Button
          type="text"
          size="small"
          icon={<Smile size={15} />}
          style={{ minWidth: 28, height: 28, padding: 0 }}
        />
      </Tooltip>
    </Popover>
  );
}
