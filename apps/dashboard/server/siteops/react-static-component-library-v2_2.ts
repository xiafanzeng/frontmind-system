/**
 * Immutable React Static 2.2 component-library source.
 *
 * Keep this snapshot byte-for-byte stable: historical 2.2 production
 * rematerialization hashes this exact source independently of 2.3 changes.
 */
export const TRUSTED_REACT_COMPONENT_LIBRARY_SOURCE_V2_2 = String.raw`import React from "react";

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
  const family = safeHeroFamily(page.heroFamily);
  const Hero = HERO_COMPONENTS[family];
  return h(Hero, { page });
}

function SitePage({ page }) {
  const body = page.emptyState === "company_news_unavailable"
    ? h("section", { className: "section section--empty", role: "status", "data-content-state": "empty" }, h("h2", null, "暂无企业动态"), h("p", null, "当前知识库暂无可公开的企业动态。"))
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
