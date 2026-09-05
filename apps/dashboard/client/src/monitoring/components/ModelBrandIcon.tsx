type ModelBrandIconProps = {
  code: string;
  name: string;
};

export type ModelBrandKey =
  | "doubao"
  | "yuanbao"
  | "deepseek"
  | "qianwen"
  | "baidu"
  | "kimi"
  | "chatgpt"
  | "quark"
  | "weibo"
  | "douyin"
  | "antafu"
  | "fallback";

function normalizedIdentity(code: string, name: string) {
  return `${code} ${name}`.toLocaleLowerCase("en-US").replace(/[\s_-]+/gu, "");
}

export function resolveModelBrand(code: string, name: string): ModelBrandKey {
  const identity = normalizedIdentity(code, name);
  if (/deepseek|深度求索/u.test(identity)) return "deepseek";
  if (/doubao|豆包/u.test(identity)) return "doubao";
  if (/yuanbao|腾讯元宝|元宝/u.test(identity)) return "yuanbao";
  if (/qianwen|qwen|tongyi|通义|千问/u.test(identity)) return "qianwen";
  if (/baidu|wenxin|ernie|百度|文心/u.test(identity)) return "baidu";
  if (/kimi|月之暗面/u.test(identity)) return "kimi";
  if (/chatgpt|openai|gpt/u.test(identity)) return "chatgpt";
  if (/quark|夸克/u.test(identity)) return "quark";
  if (/weibo|微博/u.test(identity)) return "weibo";
  if (/douyin|抖音/u.test(identity)) return "douyin";
  if (/antafu|mayiafu|蚂蚁阿福|阿福/u.test(identity)) return "antafu";
  return "fallback";
}

function fallbackGlyph(name: string) {
  return (
    name
      .trim()
      .match(/[\p{L}\p{N}]/u)?.[0]
      ?.toLocaleUpperCase() || "?"
  );
}

function BrandSvg({ brand }: { brand: Exclude<ModelBrandKey, "fallback"> }) {
  const sharedProps = {
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    focusable: "false" as const,
  };

  switch (brand) {
    case "doubao":
      return (
        <svg {...sharedProps}>
          <path
            d="M12 3.25a8.75 8.75 0 0 1 7.72 4.62"
            fill="none"
            stroke="#6b55f7"
            strokeLinecap="round"
            strokeWidth="3.15"
          />
          <path
            d="M19.73 7.9a8.75 8.75 0 0 1-1.36 9.7"
            fill="none"
            stroke="#ef4eb8"
            strokeLinecap="round"
            strokeWidth="3.15"
          />
          <path
            d="M18.33 17.62A8.75 8.75 0 0 1 4.1 16.8"
            fill="none"
            stroke="#7d55ed"
            strokeLinecap="round"
            strokeWidth="3.15"
          />
          <path
            d="M4.08 16.78A8.75 8.75 0 0 1 12 3.25"
            fill="none"
            stroke="#12bfe3"
            strokeLinecap="round"
            strokeWidth="3.15"
          />
          <path
            d="M9.1 8.15c2.22-1.28 5.07-.52 6.35 1.7 1.28 2.21.52 5.05-1.7 6.33-2.22 1.29-5.06.53-6.35-1.69"
            fill="none"
            stroke="#7553ef"
            strokeLinecap="round"
            strokeWidth="2.1"
          />
        </svg>
      );
    case "yuanbao":
      return (
        <svg {...sharedProps}>
          <path
            d="M12.1 3.1a8.9 8.9 0 0 0-5.76 15.68c-1.03-3.86.85-7.15 4.06-8.5 2.34-.98 4.58-.52 6.23.55-.53-2.2-2.08-4.16-4.53-5.1"
            fill="#20b968"
          />
          <path
            d="M11.9 20.9a8.9 8.9 0 0 0 5.75-15.67c1.04 3.85-.84 7.15-4.05 8.49-2.34.98-4.58.53-6.23-.54.53 2.2 2.08 4.16 4.53 5.1"
            fill="#42d17b"
          />
          <circle cx="12" cy="12" r="1.55" fill="#fff" />
        </svg>
      );
    case "deepseek":
      return (
        <svg {...sharedProps}>
          <path
            d="M2.6 13.16c1.43-3.47 4.95-5.84 8.93-5.84 3.02 0 5.73 1.23 7.52 3.18.98-.18 1.82-.75 2.37-1.55.31 1.8-.42 3.38-1.96 4.27.14.42.22.86.22 1.32 0 3.42-3.25 6.2-7.26 6.2-3.53 0-6.52-2.14-7.81-5.12-.37-.86-.7-1.7-2.01-2.46Z"
            fill="#4d6bfe"
          />
          <path
            d="M7.14 8.53c1.46-2.8 4.56-4.53 7.75-4.16-1.43.73-2.49 1.91-3.06 3.34-1.77-.3-3.21.02-4.69.82Z"
            fill="#8fc5ff"
          />
          <path
            d="M6.17 16.08c2.24 1.58 5.78 1.91 8.36.29"
            fill="none"
            stroke="#cce6ff"
            strokeLinecap="round"
            strokeWidth="1.2"
          />
          <circle cx="6.63" cy="12.72" r="1.13" fill="#fff" />
          <circle cx="6.72" cy="12.7" r="0.42" fill="#284be3" />
          <path
            d="M18.74 10.7c.62.2 1.26.19 1.9-.05-.28.77-.72 1.4-1.35 1.86"
            fill="none"
            stroke="#294bdc"
            strokeLinecap="round"
            strokeWidth="1.1"
          />
        </svg>
      );
    case "qianwen":
      return (
        <svg {...sharedProps}>
          <path
            d="m12 2.75 2.75 4.02 4.76.93-1.98 4.42 1.98 4.18-4.76.93L12 21.25l-2.75-4.02-4.76-.93 1.98-4.18L4.49 7.7l4.76-.93L12 2.75Z"
            fill="none"
            stroke="#7355dc"
            strokeLinejoin="round"
            strokeWidth="1.8"
          />
          <path
            d="m8.4 8.42 3.6-2.08 3.6 2.08v4.16L12 14.66l-3.6-2.08V8.42Z"
            fill="none"
            stroke="#a368ef"
            strokeLinejoin="round"
            strokeWidth="1.55"
          />
          <circle cx="12" cy="12" r="1.35" fill="#7652d8" />
        </svg>
      );
    case "baidu":
      return (
        <svg {...sharedProps}>
          <ellipse cx="12" cy="15.1" rx="5.2" ry="4.05" fill="#356af6" />
          <ellipse
            cx="6.1"
            cy="10.2"
            rx="2.05"
            ry="2.55"
            fill="#4b80ff"
            transform="rotate(-24 6.1 10.2)"
          />
          <ellipse
            cx="9.55"
            cy="6.55"
            rx="1.85"
            ry="2.45"
            fill="#356af6"
            transform="rotate(-8 9.55 6.55)"
          />
          <ellipse
            cx="14.45"
            cy="6.55"
            rx="1.85"
            ry="2.45"
            fill="#356af6"
            transform="rotate(8 14.45 6.55)"
          />
          <ellipse
            cx="17.9"
            cy="10.2"
            rx="2.05"
            ry="2.55"
            fill="#7a55ef"
            transform="rotate(24 17.9 10.2)"
          />
          <path
            d="M9.2 15.5h5.6"
            stroke="#fff"
            strokeLinecap="round"
            strokeWidth="1.2"
          />
        </svg>
      );
    case "kimi":
      return (
        <svg {...sharedProps}>
          <path
            d="M6 4.1v15.8M7 12l7-7.9M7 12l7.4 7.9"
            fill="none"
            stroke="#15171d"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.35"
          />
          <path
            d="M17.1 4.15h2.8v2.8h-2.8z"
            fill="#15171d"
            transform="rotate(45 18.5 5.55)"
          />
        </svg>
      );
    case "chatgpt":
      return (
        <svg {...sharedProps}>
          <g
            fill="none"
            stroke="#202522"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.65"
          >
            <path d="M12 3.25a4 4 0 0 1 4 4v2.18L12 11.75 8 9.43V7.25a4 4 0 0 1 4-4Z" />
            <path d="M19.58 7.63a4 4 0 0 1-1.46 5.46l-1.9 1.1-4.02-2.3.02-4.62 1.88-1.1a4 4 0 0 1 5.48 1.46Z" />
            <path d="M19.58 16.37a4 4 0 0 1-5.48 1.46l-1.88-1.1-.02-4.62 4.02-2.3 1.9 1.1a4 4 0 0 1 1.46 5.46Z" />
            <path d="M12 20.75a4 4 0 0 1-4-4v-2.18l4-2.32 4 2.32v2.18a4 4 0 0 1-4 4Z" />
            <path d="M4.42 16.37a4 4 0 0 1 1.46-5.46l1.9-1.1 4.02 2.3-.02 4.62-1.88 1.1a4 4 0 0 1-5.48-1.46Z" />
            <path d="M4.42 7.63A4 4 0 0 1 9.9 6.17l1.88 1.1.02 4.62-4.02 2.3-1.9-1.1a4 4 0 0 1-1.46-5.46Z" />
          </g>
        </svg>
      );
    case "quark":
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="8.5" fill="#1976f3" />
          <path
            d="M8.2 9.2 12 7l3.8 2.2v4.4L12 15.8l-3.8-2.2V9.2Z"
            fill="#fff"
          />
          <circle cx="12" cy="11.5" r="1.65" fill="#1976f3" />
        </svg>
      );
    case "weibo":
      return (
        <svg {...sharedProps}>
          <path
            d="M4.1 15.4c0-3.2 3.6-6.1 8.2-6.1 3.9 0 7.1 2.1 7.1 4.8 0 3.3-3.8 6-8.5 6-3.8 0-6.8-1.8-6.8-4.7Z"
            fill="#e93b3f"
          />
          <ellipse cx="11.4" cy="14.7" rx="4.25" ry="2.8" fill="#fff" />
          <circle cx="10.4" cy="14.5" r="1.55" fill="#292b31" />
          <circle cx="9.9" cy="14" r="0.45" fill="#fff" />
          <path
            d="M14.7 7.8c1.25-1.03 3.23-.66 3.95.78M14.15 5.28c2.83-1.41 6.37.1 6.83 3.32"
            fill="none"
            stroke="#e93b3f"
            strokeLinecap="round"
            strokeWidth="1.45"
          />
          <circle cx="7.3" cy="9.2" r="1.65" fill="#ffc239" />
        </svg>
      );
    case "douyin":
      return (
        <svg {...sharedProps}>
          <path
            d="M13.9 4.1v10.1a4.2 4.2 0 1 1-3.65-4.15"
            fill="none"
            stroke="#20e4dd"
            strokeLinecap="round"
            strokeWidth="3.2"
            transform="translate(-1 1)"
          />
          <path
            d="M13.9 4.1c.55 2.82 2.3 4.48 5 4.9v3.05c-1.8-.18-3.48-.83-5-2v4.15a4.2 4.2 0 1 1-3.65-4.15"
            fill="none"
            stroke="#ff315d"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3.2"
            transform="translate(1 -1)"
          />
          <path
            d="M13.9 4.1c.55 2.82 2.3 4.48 5 4.9v3.05c-1.8-.18-3.48-.83-5-2v4.15a4.2 4.2 0 1 1-3.65-4.15"
            fill="none"
            stroke="#15171c"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.35"
          />
        </svg>
      );
    case "antafu":
      return (
        <svg {...sharedProps}>
          <path
            d="m12 3.2 1.68 5.12L18.8 10l-5.12 1.68L12 16.8l-1.68-5.12L5.2 10l5.12-1.68L12 3.2Z"
            fill="#7559dd"
          />
          <path
            d="m18.2 13.1.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7Z"
            fill="#34b4d8"
          />
          <path
            d="m6.35 14.4.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"
            fill="#a263ef"
          />
        </svg>
      );
  }

  return null;
}

export default function ModelBrandIcon({ code, name }: ModelBrandIconProps) {
  const brand = resolveModelBrand(code, name);
  return (
    <span
      className={`model-brand-icon model-brand-icon--${brand}`}
      data-model-brand={brand}
      aria-hidden="true"
    >
      {brand === "fallback" ? (
        <span className="model-brand-fallback-glyph">
          {fallbackGlyph(name)}
        </span>
      ) : (
        <BrandSvg brand={brand} />
      )}
    </span>
  );
}
