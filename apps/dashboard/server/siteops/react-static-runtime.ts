import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";

import type { SiteBrief } from "../../shared/siteops";
import type {
  ReferenceBlueprintV3,
  TrustedVisualPreviewBlueprintV3,
  TrustedVisualPreviewBlueprintV4,
} from "../../shared/siteops-design";
import { TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2 } from "./react-static-component-library-v2_2";

export { TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2 } from "./react-static-component-library-v2_2";

export const REACT_STATIC_RENDERER_V1 = "react_static_v1" as const;
export const REACT_STATIC_RENDERER = "react_static_v2" as const;
export const REACT_STATIC_COMPONENT_LIBRARY_VERSION = "2.6.0" as const;
export const REACT_STATIC_MATERIALIZER_VERSION = "2.6.0" as const;
export const REACT_STATIC_REACT_VERSION = "19.2.1" as const;
const VISUAL_PREVIEW_RENDER_BUDGET_MS = 75_000;
const VISUAL_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Aborted", "AbortError");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject<T>(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export const REACT_STATIC_HERO_FAMILIES = [
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
] as const satisfies readonly ReferenceBlueprintV3["heroFamily"][];

/**
 * This is the complete, host-owned component library placed in every trusted
 * source bundle. Customer/provider values are loaded only from JSON files and
 * are never interpolated into this module.
 */
const TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_3 = String.raw`import React from "react";

const h = React.createElement;

export const HERO_FAMILIES = Object.freeze([
  "floating_orbit",
  "feature_grid",
  "bento",
  "split_media",
  "editorial",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "proof_grid",
  "full_bleed_statement"
]);

const LEGACY_HERO_FAMILIES = Object.freeze({
  centered_statement: "centered_dual_cta",
  editorial_lede: "editorial",
  proof_grid: "proof_grid",
  split_media: "split_media"
});

function safeHeroFamily(value) {
  const mapped = LEGACY_HERO_FAMILIES[value] || value;
  return HERO_FAMILIES.includes(mapped) ? mapped : "split_media";
}

function Eyebrow(props) {
  return h("p", { className: "eyebrow" }, props.children);
}

function HeroCopy({ page }) {
  return h(
    "div",
    { className: "hero-copy" },
    h(Eyebrow, null, page.hero.eyebrow),
    h("h1", null, page.hero.heading),
    h("p", { className: "lede" }, page.hero.summary)
  );
}

/* frontmind-v4-component:start */
function V4HeroCopy({ page }) {
  return h(
    "div",
    { className: "copy hero-copy" },
    h(Eyebrow, null, page.hero.eyebrow),
    h("h1", null, page.hero.heading),
    h("p", { className: "lede" }, page.hero.summary),
    h(
      "div",
      { className: "actions hero-actions" },
      h("a", { className: "button primary button--primary", href: "#content" }, "探索核心能力"),
      h("a", { className: "button button--secondary", href: "#contact" }, "了解服务流程")
    )
  );
}

function v4HeroOfferings(page) {
  const values = page.sections.slice(0, 3).map((section) => section.heading).filter(Boolean);
  return values.length > 0 ? values : [page.hero.eyebrow, page.hero.heading, "持续连接"];
}

/** The production V4 hero uses the same host-owned visual language and CSS
 * contract as the candidate realization. No provider image or provider code
 * is accepted here; only frozen render coordinates and customer content are
 * consumed from JSON. */
function V4SiteHero({ page }) {
  const family = safeHeroFamily(page.visualContract.heroFamily);
  const offerings = v4HeroOfferings(page);
  const copy = h(V4HeroCopy, { page });
  const common = {
    className: "hero hero--" + family + " " + family,
    "data-hero-family": family,
    "data-visual-blueprint": page.visualContract.blueprintHash,
    "data-visual-style-signature": page.visualContract.styleSignature
  };
  if (family === "floating_orbit") {
    return h(
      "section",
      common,
      h(
        "div",
        { className: "visual-region aurora-orbits", "data-visual-language": "aurora-orbit", "aria-hidden": "true" },
        h("span", { className: "aurora-ring" }, h("i")),
        h("span", { className: "aurora-ring" }, h("i"))
      ),
      copy
    );
  }
  if (family === "split_media") {
    return h(
      "section",
      common,
      copy,
      h(
        "div",
        { className: "visual-region surface atelier-art", "data-visual-language": "atelier-editorial", role: "img", "aria-label": page.hero.heading + " 编辑构成" },
        h("span", { className: "atelier-index" }, "01 — " + page.hero.eyebrow),
        h("span", { className: "atelier-caption" }, offerings.join(" / "))
      )
    );
  }
  if (family === "editorial") {
    return h(
      "section",
      common,
      copy,
      h(
        "aside",
        { className: "visual-region surface swiss-stats", "data-visual-language": "swiss-evidence", "aria-label": "重点能力" },
        ...offerings.map((offering, index) => h("div", { className: "swiss-stat", key: offering + "-" + index }, h("strong", null, String(index + 1).padStart(2, "0")), h("span", null, offering)))
      )
    );
  }
  if (family === "bento") {
    return h(
      "section",
      common,
      h("div", null, copy, h("div", { className: "micro-proof" }, ...offerings.map((offering, index) => h("span", { key: offering + "-" + index }, h("strong", null, offering), ["规范路径", "可信信息", "清晰沟通"][index])))),
      h("div", { className: "visual-region organic-art", "data-visual-language": "organic-human", "aria-hidden": "true" }, h("i", { className: "surface organic-blob organic-blob--one" }), h("i", { className: "surface organic-blob organic-blob--two" }))
    );
  }
  if (family === "feature_grid") {
    return h(
      "section",
      common,
      copy,
      h(
        "div",
        { className: "visual-region surface chrome-window", "data-visual-language": "chrome-product", role: "img", "aria-label": page.hero.heading + " 产品界面示意" },
        h("div", { className: "chrome-bar" }, h("i"), h("i"), h("i")),
        h("div", { className: "chrome-body" }, h("aside", { className: "chrome-side", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i")), h("div", { className: "chrome-panel" }, h("strong", null, "能力概览"), h("div", { className: "chrome-cards" }, ...offerings.map((offering, index) => h("div", { className: "surface chrome-card", key: offering }, h("b", null, String(index + 1).padStart(2, "0")), h("span", null, offering))), h("div", { className: "surface chrome-card" }, h("b", null, "∞"), h("span", null, "持续连接")))))
      )
    );
  }
  if (family === "centered_dual_cta") {
    return h("section", common, copy, h("i", { className: "visual-region zen-sun", "data-visual-language": "eastern-minimal", "aria-hidden": "true" }), h("p", { className: "zen-note" }, page.hero.summary));
  }
  if (family === "immersive_visual") {
    return h("section", common, copy, h("div", { className: "visual-region electric-collage", "data-visual-language": "electric-brutalist", "aria-hidden": "true" }, h("i", { className: "surface electric-block", "data-label": offerings[0] }), h("i", { className: "surface electric-block", "data-label": offerings[1] || offerings[0] })));
  }
  if (family === "product_stage") {
    return h("section", common, copy, h("div", { className: "visual-region lux-orbit", "data-visual-language": "nocturne-luxury", "aria-hidden": "true" }, h("i", { className: "lux-dot lux-dot--one" }), h("i", { className: "lux-dot lux-dot--two" }), h("div", { className: "surface lux-core" }, page.hero.eyebrow)));
  }
  return h(
    "section",
    common,
    copy,
    h(
      "div",
      { className: "visual-region surface neural-graph", "data-visual-language": "neural-glass", "aria-label": "能力连接网络" },
      h("i", { className: "neural-connector neural-connector--one" }),
      h("i", { className: "neural-connector neural-connector--two" }),
      h("i", { className: "neural-connector neural-connector--three" }),
      ...offerings.map((offering, index) => h("div", { className: "surface neural-node neural-node--" + ["one", "two", "three"][index], key: offering }, offering)),
      h("div", { className: "surface neural-node neural-node--four" }, "连接")
    )
  );
}
/* frontmind-v4-component:end */
function OrbitMotif({ kind, label }) {
  const art = {
    dna: [
      h("path", { key: "a", d: "M52 28 C148 57 92 178 190 210" }),
      h("path", { key: "b", d: "M91 20 C16 86 204 145 150 220" }),
      h("path", { key: "c", d: "M62 54 L103 38 M55 91 L127 71 M77 128 L151 106 M108 163 L177 143 M139 197 L181 184" }),
      h("circle", { key: "d", cx: "52", cy: "28", r: "8" }),
      h("circle", { key: "e", cx: "150", cy: "220", r: "8" })
    ],
    molecule: [
      h("path", { key: "a", d: "M38 118 L87 58 L154 78 L197 140 L141 194 L70 176 Z" }),
      ...[[38,118,13],[87,58,11],[154,78,16],[197,140,12],[141,194,15],[70,176,10]].map((point, index) => h("circle", { key: "m" + index, cx: point[0], cy: point[1], r: point[2] }))
    ],
    cell: [
      h("path", { key: "a", d: "M54 44 C111 3 196 41 211 108 C228 181 157 230 91 210 C22 189 11 96 54 44 Z" }),
      h("circle", { key: "b", cx: "128", cy: "120", r: "39" }),
      h("path", { key: "c", d: "M62 139 C91 165 126 179 167 169 M93 55 C126 39 168 50 187 78" }),
      h("circle", { key: "d", cx: "180", cy: "151", r: "9" }),
      h("circle", { key: "e", cx: "69", cy: "91", r: "7" })
    ],
    timeline: [
      h("path", { key: "a", d: "M20 171 C66 210 116 196 144 151 C168 112 175 69 221 35" }),
      ...[[20,171],[72,195],[121,177],[154,132],[177,78],[221,35]].map((point, index) => h("circle", { key: "t" + index, cx: point[0], cy: point[1], r: "8" }))
    ]
  };
  return h(
    "div",
    { className: "orbit-motif orbit-motif--" + kind, "data-motif": kind },
    h("svg", { viewBox: "0 0 240 240", role: "img", "aria-label": label + " · " + kind }, h("circle", { className: "orbit-motif__halo", cx: "120", cy: "120", r: "112" }), h("g", { className: "orbit-motif__drawing" }, ...art[kind]))
  );
}

function FloatingOrbitHero({ page }) {
  return h(
    "section",
    { className: "hero hero--floating_orbit", "data-hero-family": "floating_orbit" },
    h(
      "div",
      { className: "shell hero-orbit-stage" },
      h("div", { className: "hero-orbit__copy" }, h(HeroCopy, { page }), h("div", { className: "hero-actions" }, h("a", { className: "button button--primary", href: "#content" }, "探索能力"), h("a", { className: "button button--secondary", href: "#contact" }, "联系我们"))),
      h(OrbitMotif, { kind: "dna", label: page.hero.heading }),
      h(OrbitMotif, { kind: "molecule", label: page.hero.heading }),
      h(OrbitMotif, { kind: "cell", label: page.hero.heading }),
      h(OrbitMotif, { kind: "timeline", label: page.hero.heading })
    )
  );
}

function FeatureGridHero({ page }) {
  const items = page.sections.slice(0, 3);
  return h(
    "section",
    { className: "hero hero--feature_grid", "data-hero-family": "feature_grid" },
    h(
      "div",
      { className: "shell" },
      h(HeroCopy, { page }),
      h(
        "ul",
        { className: "hero-feature-grid", "aria-label": "重点能力" },
        ...items.map((item, index) =>
          h("li", { key: item.slotId }, h("span", null, String(index + 1).padStart(2, "0")), h("strong", null, item.heading))
        )
      )
    )
  );
}

function BentoHero({ page }) {
  return h(
    "section",
    { className: "hero hero--bento", "data-hero-family": "bento" },
    h(
      "div",
      { className: "shell hero-bento" },
      h("div", { className: "hero-bento__copy" }, h(HeroCopy, { page })),
      h("aside", { className: "hero-bento__signal", "aria-label": "品牌信号" }, h("span", null, "01"), h("strong", null, page.sections[0]?.heading || page.hero.eyebrow)),
      h("aside", { className: "hero-bento__summary" }, page.hero.summary),
      h("div", { className: "hero-bento__mark", "aria-hidden": "true" }, "✦")
    )
  );
}

function SplitMediaHero({ page }) {
  return h(
    "section",
    { className: "hero hero--split_media", "data-hero-family": "split_media" },
    h(
      "div",
      { className: "shell hero-split" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "hero-split__media", role: "img", "aria-label": "品牌能力抽象图" },
        h("span", { className: "hero-split__disc hero-split__disc--one" }),
        h("span", { className: "hero-split__disc hero-split__disc--two" }),
        h("strong", null, page.sections[0]?.heading || page.hero.eyebrow)
      )
    )
  );
}

function EditorialHero({ page }) {
  return h(
    "section",
    { className: "hero hero--editorial", "data-hero-family": "editorial" },
    h(
      "div",
      { className: "shell hero-editorial" },
      h("div", { className: "hero-editorial__folio", "aria-hidden": "true" }, "VOL. 01"),
      h(HeroCopy, { page }),
      h("p", { className: "hero-editorial__note" }, page.sections[0]?.heading || page.hero.eyebrow)
    )
  );
}

function CenteredDualCtaHero({ page }) {
  return h(
    "section",
    { className: "hero hero--centered_dual_cta", "data-hero-family": "centered_dual_cta" },
    h(
      "div",
      { className: "shell hero-centered" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "hero-actions" },
        h("a", { className: "button button--primary", href: "#content" }, "了解更多"),
        h("a", { className: "button button--secondary", href: "#contact" }, "联系我们")
      )
    )
  );
}

function ImmersiveVisualHero({ page }) {
  return h(
    "section",
    { className: "hero hero--immersive_visual", "data-hero-family": "immersive_visual" },
    h("div", { className: "hero-immersive__field", "aria-hidden": "true" }, h("i"), h("i"), h("i")),
    h("div", { className: "shell hero-immersive__copy" }, h(HeroCopy, { page }))
  );
}

function ProductStageHero({ page }) {
  return h(
    "section",
    { className: "hero hero--product_stage", "data-hero-family": "product_stage" },
    h(
      "div",
      { className: "shell" },
      h(HeroCopy, { page }),
      h(
        "div",
        { className: "product-stage", role: "img", "aria-label": "产品界面抽象舞台" },
        h("div", { className: "product-stage__bar" }, h("span"), h("span"), h("span")),
        h("div", { className: "product-stage__body" }, h("aside"), h("div", null, h("strong", null, page.sections[0]?.heading || page.hero.eyebrow), h("span"), h("span")))
      )
    )
  );
}

function ProofGridHero({ page }) {
  return h(
    "section",
    { className: "hero hero--proof_grid", "data-hero-family": "proof_grid" },
    h(
      "div",
      { className: "shell hero-proof" },
      h(HeroCopy, { page }),
      h(
        "dl",
        { className: "hero-proof__grid" },
        ...page.sections.slice(0, 3).flatMap((item, index) => [
          h("dt", { key: item.slotId + "-term" }, String(index + 1).padStart(2, "0")),
          h("dd", { key: item.slotId + "-description" }, item.heading)
        ])
      )
    )
  );
}

function FullBleedStatementHero({ page }) {
  return h(
    "section",
    { className: "hero hero--full_bleed_statement", "data-hero-family": "full_bleed_statement" },
    h("div", { className: "hero-statement__rail", "aria-hidden": "true" }, page.hero.eyebrow),
    h("div", { className: "shell hero-statement" }, h(Eyebrow, null, page.hero.eyebrow), h("h1", null, page.hero.heading), h("p", { className: "lede" }, page.hero.summary))
  );
}

const HERO_COMPONENTS = Object.freeze({
  floating_orbit: FloatingOrbitHero,
  feature_grid: FeatureGridHero,
  bento: BentoHero,
  split_media: SplitMediaHero,
  editorial: EditorialHero,
  centered_dual_cta: CenteredDualCtaHero,
  immersive_visual: ImmersiveVisualHero,
  product_stage: ProductStageHero,
  proof_grid: ProofGridHero,
  full_bleed_statement: FullBleedStatementHero
});

function SourceNote() { return null; }

function Paragraphs({ values, className }) {
  return h("div", { className: className || "section-prose" }, ...values.map((value, index) => h("p", { key: index }, value)));
}

function StatementSection({ section }) {
  return h("section", { className: "section section--statement", "data-slot": section.slotId }, h("span", { className: "section-index" }, "观点"), h("h2", null, section.heading), h("blockquote", null, section.paragraphs[0]), section.paragraphs.length > 1 ? h(Paragraphs, { values: section.paragraphs.slice(1) }) : null, h(SourceNote, { ids: section.sourceDocumentIds }));
}

function SplitSection({ section }) {
  return h("section", { className: "section section--split", "data-slot": section.slotId }, h("header", { className: "section-split__header" }, h("span", { className: "section-index" }, "聚焦"), h("h2", null, section.heading)), h(Paragraphs, { className: "section-split__body", values: section.paragraphs }), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function CardsSection({ section }) {
  return h("section", { className: "section section--cards", "data-slot": section.slotId }, h("header", null, h("span", { className: "section-index" }, "能力"), h("h2", null, section.heading)), h("div", { className: "mini-card-grid" }, ...section.paragraphs.map((paragraph, index) => h("article", { className: "mini-card", key: index }, h("span", null, String(index + 1).padStart(2, "0")), h("p", null, paragraph)))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function TimelineSection({ section }) {
  return h("section", { className: "section section--timeline", "data-slot": section.slotId }, h("header", null, h("span", { className: "section-index" }, "路径"), h("h2", null, section.heading)), h("ol", { className: "timeline-list" }, ...section.paragraphs.map((paragraph, index) => h("li", { key: index }, h("span", null, String(index + 1).padStart(2, "0")), h("p", null, paragraph)))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function FaqSection({ section }) {
  return h("section", { className: "section section--faq", "data-slot": section.slotId }, h("span", { className: "section-index" }, "问答"), h("dl", null, h("div", null, h("dt", null, h("span", { "aria-hidden": "true" }, "Q"), section.heading), h("dd", null, ...section.paragraphs.map((paragraph, index) => h("p", { key: index }, paragraph))))), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function ProofSection({ section }) {
  return h("section", { className: "section section--proof", "data-slot": section.slotId }, h("figure", null, h("figcaption", null, h("span", { className: "section-index" }, "证据"), h("h2", null, section.heading)), h("blockquote", null, section.paragraphs[0]), section.paragraphs.length > 1 ? h(Paragraphs, { values: section.paragraphs.slice(1) }) : null), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function CtaSection({ section }) {
  return h("section", { className: "section section--cta", "data-slot": section.slotId }, h("div", null, h("span", { className: "section-index" }, "下一步"), h("h2", null, section.heading), h(Paragraphs, { values: section.paragraphs })), h("a", { className: "button button--inverse", href: "#contact" }, "开始沟通"), h(SourceNote, { ids: section.sourceDocumentIds }));
}

function TypedBlock({ section, hasContact }) {
  const common = { className: "section section--typed section--" + section.blockType, "data-slot": section.slotId, "data-block-type": section.blockType };
  const heading = h("header", null, h("span", { className: "section-index" }, "内容"), h("h2", null, section.heading));
  if (section.blockType === "feature_list") {
    return h("section", common, heading, h("ul", { className: "typed-list" }, ...section.items.map((item, index) => h("li", { key: index }, item))), h(Paragraphs, { values: section.paragraphs }));
  }
  if (section.blockType === "steps") {
    return h("section", common, heading, h("ol", { className: "timeline-list" }, ...section.items.map((item, index) => h("li", { key: index }, h("span", null, String(index + 1).padStart(2, "0")), h("p", null, item)))), h(Paragraphs, { values: section.paragraphs }));
  }
  if (section.blockType === "metrics") {
    return h("section", common, heading, h("ul", { className: "metric-grid" }, ...section.items.map((item, index) => h("li", { key: index }, h("strong", null, item)))), h(Paragraphs, { values: section.paragraphs }));
  }
  if (section.blockType === "quote") {
    return h("section", common, heading, h("blockquote", null, section.paragraphs[0]), section.paragraphs.length > 1 ? h(Paragraphs, { values: section.paragraphs.slice(1) }) : null);
  }
  if (section.blockType === "entity_grid") {
    return h("section", common, heading, h(Paragraphs, { values: section.paragraphs }), h("div", { className: "entity-grid" }, ...section.entities.map((entity) => h("article", { className: "entity-card", key: entity.entityId }, h("h3", null, h("a", { href: entity.href }, entity.title)), h("p", null, entity.summary), entity.tags.length > 0 ? h("ul", { className: "tag-list", "aria-label": "标签" }, ...entity.tags.map((tag) => h("li", { key: tag }, tag))) : null))));
  }
  if (section.blockType === "faq_preview") {
    return h(
      "section",
      common,
      heading,
      h(Paragraphs, { values: section.paragraphs }),
      h(
        "dl",
        { className: "faq-list" },
        ...section.faqs.map((faq) =>
          h(
            "div",
            { key: faq.faqId },
            h("dt", null, faq.question),
            h(
              "dd",
              null,
              ...faq.answers.map((answer, index) =>
                h("p", { key: index }, answer)
              )
            )
          )
        )
      )
    );
  }
  if (section.blockType === "cta") {
    return h("section", common, heading, h(Paragraphs, { values: section.paragraphs }), hasContact ? h("a", { className: "button button--inverse", href: "#contact" }, "开始沟通") : h("button", { className: "button button--inverse", type: "button", disabled: true, "aria-disabled": "true" }, "咨询入口待开放"));
  }
  return h("section", common, heading, h(Paragraphs, { values: section.paragraphs }), section.items.length > 0 ? h("ul", { className: "typed-list" }, ...section.items.map((item, index) => h("li", { key: index }, item))) : null);
}

const SECTION_COMPONENTS = Object.freeze({
  statement: StatementSection,
  split: SplitSection,
  cards: CardsSection,
  timeline: TimelineSection,
  faq: FaqSection,
  proof: ProofSection,
  cta: CtaSection
});

function SiteHeader({ site }) {
  return h("header", { className: "site-header" }, h("nav", { className: "shell nav", "aria-label": "主导航" }, h("a", { className: "brand", href: "/" }, site.brandLogo ? h("img", { className: "brand-logo", src: site.brandLogo, width: site.brandLogoWidth, height: site.brandLogoHeight, alt: site.companyName + " Logo" }) : null, h("span", null, site.companyName)), h("div", { className: "nav-links" }, ...site.navigation.map((item) => h("a", { href: item.href, key: item.href }, item.title)))));
}

function SiteFooter({ site }) {
  return h("footer", { className: "site-footer" }, h("div", { className: "shell footer-row" }, h("strong", null, site.companyName)));
}

export function SiteHero({ page }) {
/* frontmind-v4-component:start */
  if (page.visualContract && page.visualContract.schemaVersion === 4) {
    return h(V4SiteHero, { page });
  }
/* frontmind-v4-component:end */
  const family = safeHeroFamily(page.heroFamily);
  const Hero = HERO_COMPONENTS[family];
  return h(Hero, { page });
}

function SitePage({ page }) {
  const body = page.emptyState === "company_news_unavailable"
    ? h("section", { className: "section section--empty", role: "status", "data-content-state": "empty" }, h("h2", null, "暂无企业动态"), h("p", null, "新的企业动态将在这里发布。"))
    : page.sections.map((section) => {
        if (section.blockType) return h(TypedBlock, { key: section.slotId, section, hasContact: page.contacts.length > 0 });
        const Component = SECTION_COMPONENTS[section.variant] || CardsSection;
        return h(Component, { key: section.slotId, section });
      });
  return h(React.Fragment, null, h(SiteHero, { page }), h("div", { className: "shell facts", id: "content" }, ...(Array.isArray(body) ? body : [body])), page.contacts.length > 0 ? h("section", { className: "contact", id: "contact" }, h("div", { className: "shell" }, h("p", { className: "eyebrow" }, "Contact"), h("h2", null, "联系我们"), h("ul", { className: "contact-list" }, ...page.contacts.map((contact, index) => h("li", { key: index }, contact.href ? h("a", { href: contact.href }, contact.label) : contact.label))))) : h("span", { id: "contact", hidden: true }));
}

function jsonLdMarkup(value) {
  if (!value) return null;
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");
}

export function SiteDocument({ site, page }) {
  const jsonLd = jsonLdMarkup(page.jsonLd);
  return h(
    "html",
    { lang: site.language },
    h(
      "head",
      null,
      h("meta", { charSet: "UTF-8" }),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      h("meta", { name: "description", content: page.description }),
      h("meta", { name: "robots", content: site.robots }),
      h("meta", { property: "og:type", content: "website" }),
      h("meta", { property: "og:title", content: page.title }),
      h("meta", { property: "og:description", content: page.description }),
      page.canonical ? h("link", { rel: "canonical", href: page.canonical }) : null,
      page.canonical ? h("meta", { property: "og:url", content: page.canonical }) : null,
      site.socialImage ? h("meta", { property: "og:image", content: site.socialImage }) : null,
      site.socialImage ? h("meta", { name: "twitter:card", content: "summary_large_image" }) : null,
      site.socialImage ? h("meta", { name: "twitter:image", content: site.socialImage }) : null,
      jsonLd ? h("script", { type: "application/ld+json", dangerouslySetInnerHTML: { __html: jsonLd } }) : null,
      h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }),
      h("link", { rel: "stylesheet", href: "/styles.css" }),
      h("title", null, page.title)
    ),
    h("body", { className: site.bodyClass }, h(SiteHeader, { site }), h("main", null, h(SitePage, { page })), h(SiteFooter, { site }))
  );
}

export function NotFoundDocument({ site, page }) {
  return h(
    "html",
    { lang: site.language },
    h("head", null, h("meta", { charSet: "UTF-8" }), h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }), h("meta", { name: "description", content: page.description }), h("meta", { name: "robots", content: site.robots }), h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }), h("link", { rel: "stylesheet", href: "/styles.css" }), h("title", null, page.title)),
    h("body", { className: site.bodyClass }, h(SiteHeader, { site }), h("main", null, h("section", { className: "hero hero--not-found" }, h("div", { className: "shell" }, h(Eyebrow, null, "404"), h("h1", null, "页面未找到"), h("p", { className: "lede" }, h("a", { href: "/" }, "返回首页"))))), h(SiteFooter, { site }))
  );
}
`;

/** Current 2.3 source; only this version carries the V4 realization DOM. */
export const TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE =
  TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_3;

/** Host-owned build entrypoint copied verbatim into source.zip. */
export const TRUSTED_REACT_RENDERER_SOURCE = String.raw`import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NotFoundDocument, SiteDocument } from "./component-library.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(projectRoot, "dist");
const sourceRoot = path.join(projectRoot, "src");

function trustedPath(root, relative) {
  if (typeof relative !== "string" || relative.startsWith("/") || relative.includes("\\") || relative.includes("\0") || relative.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("SITEOPS_REACT_PROJECT_PATH_INVALID");
  }
  const absolute = path.join(root, ...relative.split("/"));
  const resolved = path.relative(root, absolute);
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("SITEOPS_REACT_PROJECT_PATH_ESCAPE");
  return absolute;
}

async function json(relative) {
  const raw = await readFile(trustedPath(sourceRoot, relative), "utf8");
  return JSON.parse(raw);
}

async function emit(outputPath, element) {
  const target = trustedPath(distRoot, outputPath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const html = "<!doctype html>" + renderToStaticMarkup(element) + "\n";
  await writeFile(target, html, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const manifest = await json("route-manifest.json");
const site = await json("data/site.json");
if (![1, 2].includes(manifest.schemaVersion) || !["react_static_v1", "react_static_v2"].includes(manifest.renderer) || !Array.isArray(manifest.routes)) {
  throw new Error("SITEOPS_REACT_PROJECT_MANIFEST_INVALID");
}

await rm(distRoot, { recursive: true, force: true });
await cp(path.join(projectRoot, "public"), distRoot, { recursive: true, force: false, errorOnExist: true });
for (const route of manifest.routes) {
  const page = await json(route.dataPath);
  await emit(route.outputPath, React.createElement(SiteDocument, { site, page }));
}
const notFound = await json(manifest.notFound.dataPath);
await emit(manifest.notFound.outputPath, React.createElement(NotFoundDocument, { site, page: notFound }));
process.stdout.write(JSON.stringify({ renderer: manifest.renderer, routes: manifest.routes.length, htmlFiles: manifest.routes.length + 1 }) + "\n");
`;

type TrustedVisualPreviewBlueprint =
  | TrustedVisualPreviewBlueprintV3
  | TrustedVisualPreviewBlueprintV4;

function isTrustedVisualPreviewBlueprintV4(
  blueprint: TrustedVisualPreviewBlueprint,
): blueprint is TrustedVisualPreviewBlueprintV4 {
  return "alignment" in blueprint;
}

const PREVIEW_CSS = String.raw`
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--canvas);color:var(--ink)}body.type-system--editorial_serif{font-family:Georgia,"Times New Roman",serif}body.type-system--technical_sans{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}body.type-system--humanist_sans{font-family:"Trebuchet MS",ui-sans-serif,system-ui,sans-serif}.frame{position:relative;width:1200px;height:900px;overflow:hidden;background:var(--canvas)}.radius--none{--radius:0px}.radius--soft{--radius:8px}.radius--rounded{--radius:22px}.radius--pill{--radius:999px}.frame:before{pointer-events:none;position:absolute;inset:0;z-index:0}.decoration--grid:before{content:"";background-image:linear-gradient(color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px);background-size:46px 46px}.decoration--editorial_lines:before{content:"";left:68px;right:68px;border-inline:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}.decoration--glow:before{content:"";background:radial-gradient(circle at 78% 18%,color-mix(in srgb,var(--accent) 32%,transparent),transparent 34%)}.decoration--orbital:before{content:"";width:520px;height:520px;left:auto;right:-180px;top:120px;border:1px solid color-mix(in srgb,var(--accent) 32%,transparent);border-radius:50%}.nav{height:82px;display:flex;align-items:center;justify-content:space-between;padding:0 68px;border-bottom:1px solid color-mix(in srgb,var(--ink) 16%,transparent);position:relative;z-index:5}.brand{display:flex;align-items:center;gap:12px;font-weight:800;letter-spacing:-.03em}.brand-mark{width:32px;height:32px;border-radius:10px;background:var(--accent);display:grid;place-items:center;color:var(--canvas)}.links{display:flex;gap:26px;font-size:14px}.hero{position:relative;height:818px;padding:74px 68px}.density--compact .hero{padding-top:48px;padding-bottom:48px}.density--spacious .hero{padding-top:92px;padding-bottom:92px}.eyebrow{font-size:13px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}h1{font-size:76px;line-height:.94;letter-spacing:-.065em;margin:18px 0 24px;max-width:850px}p{font-size:20px;line-height:1.55;max-width:660px;margin:0}.actions{display:flex;gap:12px;margin-top:34px}.button{padding:14px 22px;border-radius:999px;border:1px solid currentColor;font-weight:750}.button.primary{background:var(--ink);color:var(--canvas)}.floating_orbit .copy,.centered_dual_cta .copy{text-align:center;margin:auto}.floating_orbit h1,.floating_orbit p,.centered_dual_cta h1,.centered_dual_cta p{margin-left:auto;margin-right:auto}.floating_orbit .actions,.centered_dual_cta .actions{justify-content:center}.orbit{position:absolute;border:1px solid color-mix(in srgb,var(--ink) 28%,transparent);border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--canvas) 82%,var(--accent));font-size:30px}.o1{width:160px;height:160px;left:55px;top:135px}.o2{width:120px;height:120px;right:95px;top:90px}.o3{width:190px;height:190px;right:55px;bottom:70px}.o4{width:108px;height:108px;left:145px;bottom:110px}.split_media{display:grid;grid-template-columns:1.08fr .92fr;gap:58px;align-items:center}.split-visual{height:610px;border-radius:var(--radius);background:linear-gradient(145deg,var(--ink),var(--accent));position:relative;overflow:hidden}.split-visual:before,.split-visual:after{content:"";position:absolute;border:1px solid color-mix(in srgb,var(--canvas) 65%,transparent);border-radius:50%;aspect-ratio:1}.split-visual:before{width:520px;right:-190px;top:-130px}.split-visual:after{width:250px;left:45px;bottom:50px;background:color-mix(in srgb,var(--accent) 70%,transparent)}.editorial{padding-top:42px}.editorial .folio{font:700 12px ui-monospace,monospace;letter-spacing:.22em;border-bottom:1px solid currentColor;padding-bottom:16px}.editorial h1{font-family:Georgia,serif;font-size:102px;max-width:1040px}.editorial .deck{margin-left:auto;max-width:380px;border-left:4px solid var(--accent);padding-left:22px}.bento{display:grid;grid-template-columns:1.35fr .65fr .65fr;grid-template-rows:1fr 1fr;gap:18px;padding-top:44px}.tile{border-radius:var(--radius);background:var(--muted);padding:30px}.bento .copy{grid-row:span 2;border:1px solid color-mix(in srgb,var(--ink) 18%,transparent);background:var(--canvas)}.bento .signal{display:flex;flex-direction:column;justify-content:space-between}.bento .mark{display:grid;place-items:center;background:var(--accent);color:var(--canvas);font-size:86px}.feature_grid h1{max-width:980px}.feature-row{display:grid;grid-template-columns:repeat(3,1fr);margin-top:62px;border-block:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.feature{min-height:190px;padding:28px;border-right:1px solid color-mix(in srgb,var(--ink) 24%,transparent)}.feature:last-child{border:0}.feature small{color:var(--accent);font-weight:800}.feature strong{display:block;font-size:24px;margin-top:52px}.centered_dual_cta{display:grid;place-items:center}.centered_dual_cta h1{font-size:92px;max-width:980px}.immersive_visual{background:var(--ink);color:var(--canvas);display:flex;align-items:flex-end}.immersive_visual .eyebrow{color:var(--accent)}.immersive_visual .field{position:absolute;inset:0;background:radial-gradient(circle at 18% 18%,var(--accent),transparent 30%),radial-gradient(circle at 82% 42%,color-mix(in srgb,var(--canvas) 24%,transparent),transparent 28%)}.immersive_visual .sphere{position:absolute;border:1px solid color-mix(in srgb,var(--canvas) 50%,transparent);border-radius:50%;aspect-ratio:1}.immersive_visual .s1{width:430px;right:40px;top:40px}.immersive_visual .s2{width:210px;right:300px;top:230px}.immersive_visual .copy{position:relative;padding-bottom:60px}.product_stage{padding-top:42px;text-align:center}.product_stage h1,.product_stage p{margin-left:auto;margin-right:auto}.stage{height:410px;margin-top:45px;border:1px solid color-mix(in srgb,var(--ink) 24%,transparent);border-radius:var(--radius);overflow:hidden;background:color-mix(in srgb,var(--canvas) 84%,white);box-shadow:0 34px 90px color-mix(in srgb,var(--ink) 18%,transparent);text-align:left}.stage-bar{height:46px;border-bottom:1px solid color-mix(in srgb,var(--ink) 18%,transparent);display:flex;align-items:center;gap:7px;padding:0 18px}.stage-bar i{width:10px;height:10px;border-radius:50%;background:var(--accent)}.stage-body{display:grid;grid-template-columns:180px 1fr;height:364px}.stage-body aside{background:var(--ink)}.stage-content{padding:54px}.stage-content strong{font-size:42px}.line{height:13px;background:var(--muted);border-radius:20px;margin-top:25px}.line.short{width:62%}.full_bleed_statement{background:var(--accent);color:var(--canvas);display:flex;align-items:center}.full_bleed_statement h1{font-size:126px;max-width:1080px}.full_bleed_statement .eyebrow{color:var(--canvas)}.full_bleed_statement .rail{position:absolute;right:28px;top:40px;writing-mode:vertical-rl;letter-spacing:.22em;text-transform:uppercase;font-size:11px}
`;

/** V4 layers the nine approved visual languages on top of the historical V3
 * stylesheet. Every trusted blueprint coordinate below either controls a CSS
 * variable, a selector, or concrete DOM visibility/layout. */
const PREVIEW_CSS_V4 = String.raw`
.preview-contract--v4{isolation:isolate;--page-gutter:64px;--hero-pad-block:64px;--hero-gap:54px;--line-width:1px;--line-color:color-mix(in srgb,var(--ink) 20%,transparent);--media-ratio:16/10;--layout-columns:minmax(0,1fr) minmax(320px,.8fr);background:var(--canvas)}
.preview-contract--v4:after{content:"";position:absolute;pointer-events:none;inset:0;z-index:0}.preview-contract--v4 .nav,.preview-contract--v4 .hero{position:relative;z-index:2}.preview-contract--v4 .nav{padding-inline:var(--page-gutter);border-bottom:var(--line-width) solid var(--line-color)}.preview-contract--v4 .hero{height:818px;padding:var(--hero-pad-block) var(--page-gutter);gap:var(--hero-gap)}.preview-contract--v4 .copy{position:relative;z-index:4;max-width:760px}.preview-contract--v4 h1{font-family:inherit;text-wrap:balance}.preview-contract--v4 .visual-region{position:relative;z-index:3;min-width:0;aspect-ratio:var(--media-ratio)}

/* A · Aurora Orbit */
.preview-contract--v4 .floating_orbit{display:grid;place-items:center;overflow:hidden}.preview-contract--v4 .floating_orbit .copy{max-width:880px;text-align:center}.preview-contract--v4 .floating_orbit h1{background:linear-gradient(120deg,var(--ink) 18%,color-mix(in srgb,var(--ink) 72%,var(--accent)),var(--accent));background-clip:text;color:transparent}.preview-contract--v4 .floating_orbit p{color:color-mix(in srgb,var(--ink) 72%,var(--canvas))}.aurora-orbits{position:absolute!important;inset:-70px 90px!important;aspect-ratio:auto!important;pointer-events:none}.aurora-ring{position:absolute;left:50%;top:50%;border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:50%;transform:translate(-50%,-50%) rotate(20deg)}.aurora-ring:first-child{width:530px;height:530px}.aurora-ring:last-child{width:760px;height:760px;transform:translate(-50%,-50%) rotate(-28deg)}.aurora-ring i{position:absolute;width:11px;height:11px;border-radius:50%;left:11%;top:22%;background:var(--accent);box-shadow:0 0 24px var(--accent)}.aurora-ring:last-child i{left:auto;right:12%;top:18%;background:color-mix(in srgb,var(--accent) 35%,#8575ff)}

/* B · Atelier Editorial */
.preview-contract--v4 .split_media{display:grid;grid-template-columns:var(--layout-columns);align-items:center}.preview-contract--v4 .split_media h1{font-size:88px;font-weight:500;line-height:.88}.atelier-art{height:620px!important;aspect-ratio:auto!important;overflow:hidden;background:var(--accent);border-radius:var(--radius)}.atelier-art:before{content:"";position:absolute;width:95%;aspect-ratio:1;border-radius:50%;left:-42%;top:7%;background:var(--ink)}.atelier-art:after{content:"";position:absolute;width:74%;height:122%;right:-14%;bottom:-34%;border-radius:52% 52% 10% 10%;background:color-mix(in srgb,var(--accent) 22%,#f2d76f);transform:rotate(18deg)}.atelier-index,.atelier-caption{position:absolute;z-index:2;color:var(--canvas);font-family:ui-sans-serif,system-ui,sans-serif;font-weight:800}.atelier-index{left:22px;top:20px;font-size:12px}.atelier-caption{right:24px;bottom:24px;width:170px;font-size:11px;line-height:1.5;letter-spacing:.08em;text-transform:uppercase}

/* C · Swiss Evidence */
.preview-contract--v4 .editorial{display:grid;grid-template-columns:var(--layout-columns);align-items:stretch;padding-top:var(--hero-pad-block)}.preview-contract--v4 .editorial h1{font-family:inherit;font-size:80px;font-weight:900;line-height:.84;text-transform:uppercase}.preview-contract--v4 .editorial .eyebrow{display:inline-block;width:max-content;padding:6px 9px;background:var(--accent);color:var(--canvas)}.swiss-stats{display:grid;grid-template-rows:repeat(3,1fr);aspect-ratio:auto!important;border-left:var(--line-width) solid var(--ink)}.swiss-stat{display:flex;flex-direction:column;justify-content:space-between;padding:23px;border-bottom:var(--line-width) solid var(--ink)}.swiss-stat strong{font-size:44px;letter-spacing:-.07em}.swiss-stat span{font-size:11px;font-weight:850;text-transform:uppercase}

/* D · Organic Human */
.preview-contract--v4 .bento{display:grid;grid-template-columns:var(--layout-columns);grid-template-rows:1fr;align-items:center;padding-top:var(--hero-pad-block)}.preview-contract--v4 .bento h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;line-height:.98}.organic-art{height:610px!important;aspect-ratio:auto!important}.organic-blob{position:absolute;border-radius:38px;background:color-mix(in srgb,var(--canvas) 65%,white);border:var(--line-width) solid var(--line-color);box-shadow:0 28px 60px color-mix(in srgb,var(--ink) 14%,transparent)}.organic-blob:before,.organic-blob:after{content:"";position:absolute}.organic-blob:before{inset:16%;border:3px solid var(--ink);border-radius:68% 32% 66% 34%;transform:rotate(35deg)}.organic-blob:after{left:50%;top:20%;bottom:20%;border-left:2px solid var(--ink);transform:rotate(29deg)}.organic-blob--one{width:58%;height:70%;right:3%;top:8%;transform:rotate(7deg)}.organic-blob--two{width:38%;height:44%;left:2%;bottom:4%;transform:rotate(-8deg);background:var(--ink)}.organic-blob--two:before{border-color:var(--canvas);border-radius:50%}.organic-blob--two:after{border-color:var(--canvas)}.micro-proof{display:flex;gap:24px;margin-top:32px}.micro-proof span{display:grid;gap:4px;font-size:11px}.micro-proof strong{font-size:17px}

/* E · Chrome Product */
.preview-contract--v4 .feature_grid{display:grid;grid-template-columns:var(--layout-columns);align-items:center}.preview-contract--v4 .feature_grid h1{font-size:70px}.chrome-window{height:570px!important;aspect-ratio:auto!important;overflow:hidden;border:var(--line-width) solid var(--line-color);border-radius:calc(var(--radius) + 4px);background:color-mix(in srgb,var(--canvas) 60%,white);box-shadow:0 38px 90px color-mix(in srgb,var(--accent) 22%,transparent);transform:perspective(1200px) rotateY(-6deg) rotateX(2deg)}.chrome-bar{height:48px;display:flex;align-items:center;gap:7px;padding:0 18px;border-bottom:var(--line-width) solid var(--line-color)}.chrome-bar i{width:10px;height:10px;border-radius:50%;background:var(--accent)}.chrome-body{height:calc(100% - 48px);display:grid;grid-template-columns:116px 1fr}.chrome-side{background:var(--ink);padding:20px}.chrome-side i{display:block;height:9px;margin-bottom:16px;border-radius:99px;background:color-mix(in srgb,var(--canvas) 28%,transparent)}.chrome-panel{padding:28px}.chrome-panel strong{font-size:24px}.chrome-cards{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:24px}.chrome-card{min-height:120px;padding:18px;border:var(--line-width) solid var(--line-color);border-radius:max(12px,var(--radius));background:color-mix(in srgb,var(--canvas) 52%,white)}.chrome-card b{display:block;font-size:27px}.chrome-card span{font-size:11px}

/* F · Eastern Minimal */
.preview-contract--v4 .centered_dual_cta{display:grid;grid-template-columns:var(--layout-columns);place-items:center normal;overflow:hidden}.preview-contract--v4 .centered_dual_cta .copy{text-align:inherit;margin:0}.preview-contract--v4 .centered_dual_cta h1,.preview-contract--v4 .centered_dual_cta p{margin-left:0;margin-right:0}.preview-contract--v4 .centered_dual_cta h1{font-size:94px;font-weight:500;line-height:.92}.preview-contract--v4 .centered_dual_cta .actions{justify-content:flex-start}.zen-sun{position:absolute!important;width:330px;right:10%;top:12%;border-radius:50%;background:var(--accent)}.zen-note{align-self:end;justify-self:end;z-index:2;width:170px;padding-top:14px;border-top:1px solid var(--ink);font-size:12px;line-height:1.8;letter-spacing:.12em;writing-mode:vertical-rl}

/* G · Electric Brutalist */
.preview-contract--v4 .immersive_visual{display:grid;grid-template-columns:var(--layout-columns);align-items:center;background:transparent;color:inherit}.preview-contract--v4 .immersive_visual .copy{padding-bottom:0}.preview-contract--v4 .immersive_visual h1{font-size:94px;font-weight:950;line-height:.8;text-transform:uppercase;text-shadow:7px 7px 0 var(--muted)}.preview-contract--v4 .immersive_visual .eyebrow{display:inline-block;width:max-content;padding:7px 10px;background:var(--ink);color:var(--canvas)}.preview-contract--v4 .immersive_visual p{padding:12px;background:var(--accent);color:var(--muted);border:3px solid var(--muted);box-shadow:7px 7px 0 var(--muted);font-weight:750}.electric-collage{height:570px!important;aspect-ratio:auto!important}.electric-block{position:absolute;border:3px solid var(--muted);box-shadow:9px 9px 0 var(--muted)}.electric-block:first-child{width:75%;height:42%;right:0;top:5%;background:color-mix(in srgb,var(--canvas) 32%,#ff56bc);transform:rotate(5deg)}.electric-block:last-child{width:68%;height:40%;left:0;bottom:5%;background:var(--accent);transform:rotate(-5deg)}.electric-block:after{content:attr(data-label);position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:26px;font-weight:950}.electric-block:last-child:after{font-size:48px}

/* H · Nocturne Luxury */
.preview-contract--v4 .product_stage{display:grid;grid-template-columns:var(--layout-columns);align-items:center;padding-top:var(--hero-pad-block);text-align:left}.preview-contract--v4 .product_stage h1,.preview-contract--v4 .product_stage p{margin-left:0;margin-right:0}.preview-contract--v4 .product_stage h1{font-size:82px;font-weight:400;line-height:.94}.lux-orbit{height:600px!important;aspect-ratio:auto!important}.lux-orbit:before,.lux-orbit:after{content:"";position:absolute;border:1px solid color-mix(in srgb,var(--accent) 42%,transparent);border-radius:50%}.lux-orbit:before{width:500px;height:500px;right:2%;top:3%}.lux-orbit:after{width:350px;height:350px;right:14%;top:16%;border-style:dashed}.lux-core{position:absolute;display:grid;place-items:center;width:238px;height:238px;right:23%;top:27%;border-radius:50%;background:radial-gradient(circle at 34% 28%,color-mix(in srgb,var(--ink) 80%,white),var(--accent) 34%,var(--muted) 78%);box-shadow:0 0 90px color-mix(in srgb,var(--accent) 28%,transparent);color:var(--canvas);font-family:ui-sans-serif,system-ui,sans-serif;font-size:11px;font-weight:900;letter-spacing:.16em}.lux-dot{position:absolute;width:13px;height:13px;border-radius:50%;background:var(--accent);box-shadow:0 0 20px var(--accent)}.lux-dot--one{right:26%;top:13%}.lux-dot--two{right:52%;bottom:14%}

/* I · Neural Glass */
.preview-contract--v4 .full_bleed_statement{display:grid;grid-template-columns:var(--layout-columns);align-items:center;background:transparent;color:inherit}.preview-contract--v4 .full_bleed_statement h1{font-size:78px;max-width:780px}.preview-contract--v4 .full_bleed_statement .eyebrow{color:var(--accent)}.neural-graph{height:590px!important;aspect-ratio:auto!important;border:var(--line-width) solid var(--line-color);border-radius:max(28px,var(--radius));background-image:linear-gradient(color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px),linear-gradient(90deg,color-mix(in srgb,var(--ink) 8%,transparent) 1px,transparent 1px);background-size:38px 38px;box-shadow:inset 0 0 80px color-mix(in srgb,var(--accent) 14%,transparent)}.neural-node{position:absolute;display:grid;place-items:center;border:var(--line-width) solid var(--line-color);border-radius:max(18px,var(--radius));background:color-mix(in srgb,var(--canvas) 72%,white);box-shadow:0 20px 45px color-mix(in srgb,var(--accent) 14%,transparent);font-size:11px;font-weight:800}.neural-node:after{content:"";position:absolute;width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 14px var(--accent)}.neural-node--one{width:180px;height:110px;left:6%;top:11%}.neural-node--two{width:220px;height:135px;right:5%;top:34%}.neural-node--three{width:190px;height:115px;left:16%;bottom:8%}.neural-node--four{width:125px;height:125px;right:18%;bottom:4%;border-radius:50%;background:var(--ink);color:var(--canvas)}.neural-connector{position:absolute;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);transform-origin:left}.neural-connector--one{width:330px;left:22%;top:30%;transform:rotate(21deg)}.neural-connector--two{width:310px;left:28%;bottom:28%;transform:rotate(-18deg)}.neural-connector--three{width:260px;right:16%;bottom:29%;transform:rotate(62deg)}

/* Complete render-coordinate consumption. */
.preview-contract--v4.align--center .copy{text-align:center;margin-inline:auto}.preview-contract--v4.align--center .actions{justify-content:center}.preview-contract--v4.align--right .copy{text-align:right;margin-left:auto}.preview-contract--v4.align--right .actions{justify-content:flex-end}.preview-contract--v4.align--right .copy p{margin-left:auto}.preview-contract--v4.align--left .copy{text-align:left;margin-right:auto}.preview-contract--v4.align--left .actions{justify-content:flex-start}
.preview-contract--v4.emphasis--statement h1{font-size:clamp(76px,8vw,112px)}.preview-contract--v4.emphasis--balanced h1{font-size:clamp(66px,7vw,94px)}.preview-contract--v4.emphasis--product h1{font-size:clamp(60px,6.2vw,86px)}.preview-contract--v4.emphasis--proof h1{font-size:clamp(58px,5.8vw,80px)}
.preview-contract--v4.media-region--none .visual-region{display:none}.preview-contract--v4.media-region--inline .visual-region{max-width:780px;outline:var(--line-width) solid var(--line-color)}.preview-contract--v4.media-region--split .visual-region{width:100%;border-color:var(--line-color)}.preview-contract--v4.media-region--surround .visual-region{filter:drop-shadow(0 28px 55px color-mix(in srgb,var(--ink) 12%,transparent))}.preview-contract--v4.media-region--full_bleed .visual-region{position:absolute;inset:0;max-width:none;aspect-ratio:auto;opacity:.72}
.preview-contract--v4.media-ratio--none{--media-ratio:auto}.preview-contract--v4.media-ratio--square{--media-ratio:1/1}.preview-contract--v4.media-ratio--portrait{--media-ratio:4/5}.preview-contract--v4.media-ratio--landscape{--media-ratio:16/10}.preview-contract--v4.media-ratio--wide{--media-ratio:21/9}
.preview-contract--v4.composition--centered{--layout-columns:1fr}.preview-contract--v4.composition--split{--layout-columns:minmax(0,1.08fr) minmax(330px,.92fr)}.preview-contract--v4.composition--editorial{--layout-columns:minmax(0,1.2fr) minmax(250px,.8fr)}.preview-contract--v4.composition--modular{--layout-columns:minmax(0,1fr) minmax(250px,.38fr)}.preview-contract--v4.composition--immersive{--layout-columns:minmax(0,1.28fr) minmax(310px,.72fr)}
.preview-contract--v4.background--warm_light{background:linear-gradient(135deg,var(--canvas),color-mix(in srgb,var(--canvas) 88%,var(--muted)))}.preview-contract--v4.background--cool_light{background:linear-gradient(145deg,var(--canvas),color-mix(in srgb,var(--canvas) 82%,#d9f5ff))}.preview-contract--v4.background--dark{background:var(--canvas)}.preview-contract--v4.background--gradient{background:linear-gradient(135deg,var(--canvas),color-mix(in srgb,var(--canvas) 76%,var(--accent)))}.preview-contract--v4.background--image_stage{background:linear-gradient(115deg,var(--canvas) 0 56%,color-mix(in srgb,var(--canvas) 62%,var(--accent)) 100%)}
.preview-contract--v4.gradient--none:after{display:none}.preview-contract--v4.gradient--soft_radial:after{background:radial-gradient(circle at 82% 22%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 34%)}.preview-contract--v4.gradient--mesh:after{background:radial-gradient(circle at 18% 18%,color-mix(in srgb,var(--accent) 34%,transparent),transparent 27%),radial-gradient(circle at 79% 36%,color-mix(in srgb,var(--muted) 78%,transparent),transparent 30%),radial-gradient(circle at 58% 86%,color-mix(in srgb,var(--accent) 18%,transparent),transparent 28%)}.preview-contract--v4.gradient--spotlight:after{background:radial-gradient(circle at 72% 45%,color-mix(in srgb,var(--accent) 25%,transparent),transparent 30%)}
.preview-contract--v4.border--none{--line-width:0px}.preview-contract--v4.border--subtle{--line-width:1px;--line-color:color-mix(in srgb,var(--ink) 18%,transparent)}.preview-contract--v4.border--defined{--line-width:3px;--line-color:var(--ink)}
.preview-contract--v4.decoration--none:before{content:none}.preview-contract--v4.decoration--grid:before{opacity:.72}.preview-contract--v4.decoration--editorial_lines:before{left:var(--page-gutter);right:var(--page-gutter)}.preview-contract--v4.decoration--glow:before{filter:blur(8px)}.preview-contract--v4.decoration--orbital:before{box-shadow:0 0 80px color-mix(in srgb,var(--accent) 14%,transparent)}
.preview-contract--v4.nav-style--minimal .nav{border-bottom-width:0;background:transparent}.preview-contract--v4.nav-style--floating .nav{height:66px;margin:16px 28px 0;padding-inline:24px;border:var(--line-width) solid var(--line-color);border-radius:max(18px,var(--radius));background:color-mix(in srgb,var(--canvas) 72%,transparent);backdrop-filter:blur(18px)}.preview-contract--v4.nav-style--bordered .nav{border-bottom:var(--line-width) solid var(--line-color);background:transparent}
.preview-contract--v4.cta-style--single .actions .button:last-child{display:none}.preview-contract--v4.cta-style--dual .button{border-radius:max(2px,var(--radius))}.preview-contract--v4.cta-style--pill .button{border-radius:999px}.preview-contract--v4.cta-style--text_link .button{padding-inline:0;border:0;border-bottom:1px solid currentColor;border-radius:0;background:transparent;color:inherit}.preview-contract--v4.cta-style--text_link .button:last-child{margin-left:18px}
.preview-contract--v4.card-style--flat .surface{box-shadow:none;background:transparent}.preview-contract--v4.card-style--bordered .surface{border:var(--line-width) solid var(--line-color);box-shadow:none}.preview-contract--v4.card-style--soft_depth .surface{background:color-mix(in srgb,var(--canvas) 72%,white);box-shadow:0 24px 60px color-mix(in srgb,var(--ink) 14%,transparent)}.preview-contract--v4.card-style--layered .surface{background:color-mix(in srgb,var(--canvas) 68%,white);box-shadow:12px 12px 0 color-mix(in srgb,var(--accent) 18%,transparent),0 26px 70px color-mix(in srgb,var(--ink) 15%,transparent)}
.preview-contract--v4.container--contained{--page-gutter:86px}.preview-contract--v4.container--wide{--page-gutter:54px}.preview-contract--v4.container--edge_to_edge{--page-gutter:34px}
.preview-contract--v4.typography--restrained h1{font-weight:560;letter-spacing:-.045em}.preview-contract--v4.typography--editorial h1{font-weight:450;letter-spacing:-.055em}.preview-contract--v4.typography--display h1{font-weight:900;letter-spacing:-.07em}.preview-contract--v4.typography--technical h1{font-weight:800;letter-spacing:-.075em;text-transform:uppercase}
.preview-contract--v4.density--compact{--hero-pad-block:42px;--hero-gap:34px}.preview-contract--v4.density--balanced{--hero-pad-block:60px;--hero-gap:48px}.preview-contract--v4.density--spacious{--hero-pad-block:78px;--hero-gap:66px}
.preview-contract--v4.responsive--stack .visual-region{transform-origin:center}.preview-contract--v4.responsive--reflow .hero{align-content:center}.preview-contract--v4.responsive--crop_safe .visual-region{overflow:hidden;object-fit:cover}
.preview-contract--v4.motion--none *{animation:none!important;transition:none!important}.preview-contract--v4.motion--subtle .visual-region{transition:transform .2s ease}.preview-contract--v4.motion--floating_subtle .visual-region{animation:v4-float 7s ease-in-out infinite}.preview-contract--v4.motion--floating_subtle .aurora-ring{animation:v4-spin 28s linear infinite}@keyframes v4-float{50%{transform:translateY(-8px)}}@keyframes v4-spin{to{rotate:360deg}}
.preview-contract--v4.media-strategy--none .visual-region{display:none}.preview-contract--v4.media-strategy--customer_asset .visual-region{outline:1px solid color-mix(in srgb,var(--accent) 24%,transparent);outline-offset:4px}.preview-contract--v4.media-strategy--procedural_brand_svg .visual-region{visibility:visible}
@media(max-width:760px){.preview-contract--v4.responsive--stack .hero,.preview-contract--v4.responsive--reflow .hero{display:block}.preview-contract--v4.responsive--stack .visual-region{max-height:42vh;margin-top:28px}.preview-contract--v4.responsive--reflow{--layout-columns:1fr}.preview-contract--v4.responsive--crop_safe .visual-region{inset:auto;max-height:52vh}}
@media(prefers-reduced-motion:reduce){.preview-contract--v4 *{animation:none!important;transition:none!important}}
`;

/** The exact V4 visual contract used by both the candidate realization and
 * the generated static website. Production overrides only the fixed 1200x900
 * screenshot dimensions; all family and blueprint-coordinate selectors stay
 * shared. */
export const TRUSTED_REACT_VISUAL_CONTRACT_V4_CSS = `${PREVIEW_CSS_V4}
body.preview-contract--v4{position:relative;min-height:100vh;overflow-x:hidden}
body.preview-contract--v4:after{position:fixed}
body.preview-contract--v4 .hero{height:auto;min-height:min(818px,calc(100vh - 76px))}
body.preview-contract--v4 .copy p{margin-top:0}
body.preview-contract--v4 .facts{position:relative;z-index:2}
@media(max-width:760px){body.preview-contract--v4 .hero{min-height:auto;padding-block:54px}body.preview-contract--v4 .visual-region{width:100%;max-width:100%}.zen-note{display:none}}
`;

function previewCopy(brief: SiteBrief) {
  const offerings = brief.offerings.filter(Boolean).slice(0, 3);
  return {
    eyebrow: offerings[0] || "品牌官网",
    heading: brief.companyName,
    summary:
      brief.conversionGoal ||
      offerings.join(" · ") ||
      "用清晰、可信的表达连接企业能力与目标客户。",
    offerings:
      offerings.length > 0 ? offerings : ["企业能力", "产品服务", "客户价值"],
  };
}

function PreviewHeroV4(input: {
  brief: SiteBrief;
  blueprint: TrustedVisualPreviewBlueprintV4;
}) {
  const h = React.createElement;
  const copy = previewCopy(input.brief);
  const family = input.blueprint.heroFamily;
  const copyNode = h(
    "div",
    { className: "copy" },
    h("div", { className: "eyebrow" }, copy.eyebrow),
    h("h1", null, copy.heading),
    h("p", null, copy.summary),
    h(
      "div",
      { className: "actions" },
      h("span", { className: "button primary" }, "探索核心能力"),
      h("span", { className: "button" }, "了解服务流程"),
    ),
  );
  if (family === "floating_orbit") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h(
        "div",
        {
          className: "visual-region aurora-orbits",
          "data-visual-language": "aurora-orbit",
          "aria-hidden": "true",
        },
        h("span", { className: "aurora-ring" }, h("i")),
        h("span", { className: "aurora-ring" }, h("i")),
      ),
      copyNode,
    );
  }
  if (family === "split_media") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        {
          className: "visual-region surface atelier-art",
          "data-visual-language": "atelier-editorial",
          role: "img",
          "aria-label": `${copy.heading} 编辑构成`,
        },
        h("span", { className: "atelier-index" }, `01 — ${copy.eyebrow}`),
        h("span", { className: "atelier-caption" }, copy.offerings.join(" / ")),
      ),
    );
  }
  if (family === "editorial") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "aside",
        {
          className: "visual-region surface swiss-stats",
          "data-visual-language": "swiss-evidence",
          "aria-label": "重点能力",
        },
        ...copy.offerings.map((offering, index) =>
          h(
            "div",
            { className: "swiss-stat", key: `${offering}-${index}` },
            h("strong", null, String(index + 1).padStart(2, "0")),
            h("span", null, offering),
          ),
        ),
      ),
    );
  }
  if (family === "bento") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h(
        "div",
        null,
        copyNode,
        h(
          "div",
          { className: "micro-proof" },
          ...copy.offerings.map((offering, index) =>
            h(
              "span",
              { key: `${offering}-${index}` },
              h("strong", null, offering),
              ["规范路径", "可信信息", "清晰沟通"][index],
            ),
          ),
        ),
      ),
      h(
        "div",
        {
          className: "visual-region organic-art",
          "data-visual-language": "organic-human",
          "aria-hidden": "true",
        },
        h("i", { className: "surface organic-blob organic-blob--one" }),
        h("i", { className: "surface organic-blob organic-blob--two" }),
      ),
    );
  }
  if (family === "feature_grid") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        {
          className: "visual-region surface chrome-window",
          "data-visual-language": "chrome-product",
          role: "img",
          "aria-label": `${copy.heading} 产品界面示意`,
        },
        h("div", { className: "chrome-bar" }, h("i"), h("i"), h("i")),
        h(
          "div",
          { className: "chrome-body" },
          h(
            "aside",
            { className: "chrome-side", "aria-hidden": "true" },
            h("i"),
            h("i"),
            h("i"),
            h("i"),
          ),
          h(
            "div",
            { className: "chrome-panel" },
            h("strong", null, "能力概览"),
            h(
              "div",
              { className: "chrome-cards" },
              ...copy.offerings.map((offering, index) =>
                h(
                  "div",
                  { className: "surface chrome-card", key: offering },
                  h("b", null, String(index + 1).padStart(2, "0")),
                  h("span", null, offering),
                ),
              ),
              h(
                "div",
                { className: "surface chrome-card" },
                h("b", null, "∞"),
                h("span", null, "持续连接"),
              ),
            ),
          ),
        ),
      ),
    );
  }
  if (family === "centered_dual_cta") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h("i", {
        className: "visual-region zen-sun",
        "data-visual-language": "eastern-minimal",
        "aria-hidden": "true",
      }),
      h("p", { className: "zen-note" }, copy.summary),
    );
  }
  if (family === "immersive_visual") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        {
          className: "visual-region electric-collage",
          "data-visual-language": "electric-brutalist",
          "aria-hidden": "true",
        },
        h("i", {
          className: "surface electric-block",
          "data-label": copy.offerings[0],
        }),
        h("i", {
          className: "surface electric-block",
          "data-label": "01 → 09",
        }),
      ),
    );
  }
  if (family === "product_stage") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        {
          className: "visual-region lux-orbit",
          "data-visual-language": "nocturne-luxury",
          "aria-hidden": "true",
        },
        h("i", { className: "lux-dot lux-dot--one" }),
        h("i", { className: "lux-dot lux-dot--two" }),
        h("div", { className: "surface lux-core" }, copy.eyebrow),
      ),
    );
  }
  return h(
    "section",
    { className: `hero ${family}`, "data-hero-family": family },
    copyNode,
    h(
      "div",
      {
        className: "visual-region surface neural-graph",
        "data-visual-language": "neural-glass",
        "aria-label": "能力连接网络",
      },
      h("i", { className: "neural-connector neural-connector--one" }),
      h("i", { className: "neural-connector neural-connector--two" }),
      h("i", { className: "neural-connector neural-connector--three" }),
      ...copy.offerings.map((offering, index) =>
        h(
          "div",
          {
            className: `surface neural-node neural-node--${["one", "two", "three"][index]}`,
            key: offering,
          },
          offering,
        ),
      ),
      h("div", { className: "surface neural-node neural-node--four" }, "连接"),
    ),
  );
}

function PreviewHero(input: {
  brief: SiteBrief;
  blueprint: TrustedVisualPreviewBlueprint;
}) {
  if (isTrustedVisualPreviewBlueprintV4(input.blueprint)) {
    return React.createElement(PreviewHeroV4, {
      brief: input.brief,
      blueprint: input.blueprint,
    });
  }
  const h = React.createElement;
  const copy = previewCopy(input.brief);
  const family = input.blueprint.heroFamily;
  const copyNode = h(
    "div",
    { className: "copy" },
    h("div", { className: "eyebrow" }, copy.eyebrow),
    h("h1", null, copy.heading),
    h("p", null, copy.summary),
    h(
      "div",
      { className: "actions" },
      h("span", { className: "button primary" }, "了解更多"),
      h("span", { className: "button" }, "联系我们"),
    ),
  );
  if (family === "floating_orbit") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      ...["DNA", "✦", "◎", "↗"].map((value, index) =>
        h("span", { className: `orbit o${index + 1}`, key: value }, value),
      ),
    );
  }
  if (family === "split_media") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h("div", { className: "split-visual", "aria-hidden": "true" }),
    );
  }
  if (family === "editorial") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h("div", { className: "folio" }, `${copy.eyebrow} / 01`),
      copyNode,
      h("p", { className: "deck" }, copy.offerings.join(" · ")),
    );
  }
  if (family === "bento") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h("div", { className: "tile copy" }, copyNode),
      h(
        "div",
        { className: "tile signal" },
        h("span", null, "01"),
        h("strong", null, copy.offerings[0]),
      ),
      h("div", { className: "tile" }, copy.summary),
      h("div", { className: "tile mark", "aria-hidden": "true" }, "✦"),
    );
  }
  if (family === "feature_grid") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        { className: "feature-row" },
        ...copy.offerings.map((offering, index) =>
          h(
            "div",
            { className: "feature", key: offering },
            h("small", null, `0${index + 1}`),
            h("strong", null, offering),
          ),
        ),
      ),
    );
  }
  if (family === "immersive_visual") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      h(
        "div",
        { className: "field", "aria-hidden": "true" },
        h("i", { className: "sphere s1" }),
        h("i", { className: "sphere s2" }),
      ),
      copyNode,
    );
  }
  if (family === "product_stage") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h(
        "div",
        { className: "stage" },
        h("div", { className: "stage-bar" }, h("i"), h("i"), h("i")),
        h(
          "div",
          { className: "stage-body" },
          h("aside"),
          h(
            "div",
            { className: "stage-content" },
            h("strong", null, copy.offerings[0]),
            h("div", { className: "line" }),
            h("div", { className: "line short" }),
          ),
        ),
      ),
    );
  }
  if (family === "full_bleed_statement") {
    return h(
      "section",
      { className: `hero ${family}`, "data-hero-family": family },
      copyNode,
      h("span", { className: "rail" }, copy.offerings.join(" / ")),
    );
  }
  return h(
    "section",
    {
      className: `hero centered_dual_cta`,
      "data-hero-family": "centered_dual_cta",
    },
    copyNode,
  );
}

export function renderTrustedVisualCandidateHtml(input: {
  brief: SiteBrief;
  blueprint: TrustedVisualPreviewBlueprint;
}) {
  const h = React.createElement;
  const { palette } = input.blueprint;
  const v4Blueprint = isTrustedVisualPreviewBlueprintV4(input.blueprint)
    ? input.blueprint
    : null;
  const coordinateClasses = v4Blueprint
    ? [
        "preview-contract--v4",
        `align--${v4Blueprint.alignment}`,
        `emphasis--${v4Blueprint.contentEmphasis}`,
        `media-region--${v4Blueprint.mediaRegion}`,
        `media-ratio--${v4Blueprint.mediaRatio}`,
        `media-strategy--${v4Blueprint.mediaStrategy}`,
        `composition--${v4Blueprint.composition}`,
        `background--${v4Blueprint.backgroundStyle}`,
        `gradient--${v4Blueprint.gradientStyle}`,
        `border--${v4Blueprint.borderStyle}`,
        `radius--${v4Blueprint.radiusStyle}`,
        `decoration--${v4Blueprint.decorationStyle}`,
        `nav-style--${v4Blueprint.navStyle}`,
        `cta-style--${v4Blueprint.ctaStyle}`,
        `card-style--${v4Blueprint.cardStyle}`,
        `container--${v4Blueprint.containerStyle}`,
        `typography--${v4Blueprint.typographyStyle}`,
        `density--${v4Blueprint.density}`,
        `responsive--${v4Blueprint.responsiveBehavior}`,
        `motion--${v4Blueprint.motionLevel}`,
      ]
    : [
        "preview-contract--v3",
        `density--${input.blueprint.density}`,
        `radius--${input.blueprint.radiusStyle}`,
        `motion--${input.blueprint.motionLevel}`,
        `decoration--${input.blueprint.decorationStyle}`,
        `background--${input.blueprint.backgroundStyle}`,
      ];
  const companyInitial = Array.from(input.brief.companyName.trim())[0] || "F";
  const page = h(
    "html",
    { lang: input.brief.primaryLanguage },
    h(
      "head",
      null,
      h("meta", { charSet: "utf-8" }),
      h("meta", { name: "viewport", content: "width=1200" }),
      h("style", null, `${PREVIEW_CSS}${PREVIEW_CSS_V4}`),
    ),
    h(
      "body",
      {
        className: `type-system--${input.blueprint.typeSystem}`,
        style: {
          "--canvas": palette.canvas,
          "--ink": palette.ink,
          "--accent": palette.accent,
          "--muted": palette.muted,
        } as React.CSSProperties,
      },
      h(
        "div",
        {
          className: ["frame", ...coordinateClasses].join(" "),
          ...(v4Blueprint
            ? {
                "data-preview-contract": "4",
                "data-visual-coordinates": [
                  v4Blueprint.heroFamily,
                  v4Blueprint.typeSystem,
                  v4Blueprint.alignment,
                  v4Blueprint.mediaRegion,
                  v4Blueprint.navStyle,
                  v4Blueprint.ctaStyle,
                  v4Blueprint.containerStyle,
                  v4Blueprint.cardStyle,
                  v4Blueprint.backgroundStyle,
                  v4Blueprint.gradientStyle,
                  v4Blueprint.decorationStyle,
                ].join(":"),
              }
            : { "data-preview-contract": "3" }),
        },
        h(
          "header",
          { className: "nav" },
          h(
            "div",
            { className: "brand" },
            h("span", { className: "brand-mark" }, companyInitial),
            input.brief.companyName,
          ),
          h(
            "nav",
            { className: "links" },
            h("span", null, "首页"),
            h("span", null, "服务"),
            h("span", null, "关于"),
            h("span", { className: "nav-cta" }, "联系"),
          ),
        ),
        h(PreviewHero, input),
      ),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}

export async function renderTrustedVisualCandidatePreviews(input: {
  brief: SiteBrief;
  blueprints: TrustedVisualPreviewBlueprint[];
  signal: AbortSignal;
}) {
  if (input.signal.aborted) throw new DOMException("Aborted", "AbortError");
  const renderController = new AbortController();
  const forwardAbort = () => renderController.abort(abortReason(input.signal));
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  const renderTimeout = setTimeout(
    () =>
      renderController.abort(
        new DOMException("Visual preview render timed out", "TimeoutError"),
      ),
    VISUAL_PREVIEW_RENDER_BUDGET_MS,
  );
  const signal = renderController.signal;
  const launchPromise = chromium.launch({
    headless: true,
    chromiumSandbox: false,
    timeout: VISUAL_PREVIEW_BROWSER_LAUNCH_TIMEOUT_MS,
  });
  let browser: Awaited<typeof launchPromise> | undefined;
  try {
    try {
      browser = await raceWithAbort(launchPromise, signal);
    } catch (error) {
      if (signal.aborted) {
        void launchPromise
          .then((lateBrowser) => lateBrowser.close())
          .catch(() => undefined);
      }
      throw error;
    }
    const closeOnAbort = () => void browser?.close().catch(() => undefined);
    signal.addEventListener("abort", closeOnAbort, { once: true });
    const page = await raceWithAbort(
      browser.newPage({
        viewport: { width: 1200, height: 900 },
        deviceScaleFactor: 1,
      }),
      signal,
    );
    const previews: Array<{
      heroFamily: ReferenceBlueprintV3["heroFamily"];
      buffer: Buffer;
    }> = [];
    try {
      for (const blueprint of input.blueprints) {
        if (signal.aborted) throw abortReason(signal);
        await raceWithAbort(
          page.setContent(
            renderTrustedVisualCandidateHtml({ brief: input.brief, blueprint }),
            { waitUntil: "domcontentloaded", timeout: 10_000 },
          ),
          signal,
        );
        const buffer = await raceWithAbort(
          page.screenshot({
            type: "png",
            fullPage: false,
            animations: "disabled",
            timeout: 10_000,
          }),
          signal,
        );
        previews.push({
          heroFamily: blueprint.heroFamily,
          buffer: Buffer.from(buffer),
        });
      }
      return previews;
    } finally {
      signal.removeEventListener("abort", closeOnAbort);
    }
  } finally {
    clearTimeout(renderTimeout);
    input.signal.removeEventListener("abort", forwardAbort);
    await browser?.close().catch(() => undefined);
  }
}
