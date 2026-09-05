import { z } from "zod";

import {
  siteBriefSchema,
  visualTaxonomySchema,
  type SiteBrief,
} from "./siteops";
import {
  boundedSiteDesignPaletteSize,
  referenceBlueprintSchema,
  siteDesignResultV2Schema,
  type ReferenceBlueprint,
  type SiteDesignSpecV2,
} from "./siteops-design";

type VisualTaxonomy = z.infer<typeof visualTaxonomySchema>;
type RouteComposition = SiteDesignSpecV2["routeCompositions"][number];

export type HostOwnedSiteDesignInput = {
  operationToken: string;
  brief: SiteBrief;
  referenceBlueprint: ReferenceBlueprint;
  taxonomy: VisualTaxonomy;
};

const ROUTE_HINTS = {
  faq: /(?:faq|question|help|问答|问题|帮助)/iu,
  contact: /(?:contact|inquiry|quote|联系|咨询|询价)/iu,
  timeline: /(?:history|journey|milestone|news|blog|历程|发展|动态|新闻)/iu,
  cards:
    /(?:product|service|solution|application|case|产品|服务|方案|应用|案例)/iu,
  proof: /(?:about|company|case|trust|关于|企业|实力|案例)/iu,
} as const;

function boundedText(value: string, maximum: number) {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, maximum).join("");
}

function routeSearchText(route: SiteBrief["routes"][number]) {
  return `${route.id} ${route.slug} ${route.title}`.normalize("NFKC");
}

function hasInventoryKind(
  brief: SiteBrief,
  kind: SiteBrief["contentInventory"]["entries"][number]["kind"],
) {
  return brief.contentInventory.entries.some((entry) => entry.kind === kind);
}

function hostOwnedRouteComposition(
  brief: SiteBrief,
  route: SiteBrief["routes"][number],
): RouteComposition {
  const routeText = routeSearchText(route);
  if (route.id === "news" && !hasInventoryKind(brief, "company_news")) {
    return {
      routeId: route.id,
      slots: [{ slotId: "news-empty", variant: "statement" }],
    };
  }

  const slots: RouteComposition["slots"] = [
    { slotId: "overview", variant: "statement" },
  ];
  const add = (
    slotId: string,
    variant: RouteComposition["slots"][number]["variant"],
  ) => {
    if (!slots.some((slot) => slot.slotId === slotId) && slots.length < 16) {
      slots.push({ slotId, variant });
    }
  };

  if (
    ROUTE_HINTS.cards.test(routeText) ||
    (route.id === "home" && brief.offerings.length > 0)
  ) {
    add("offerings", "cards");
  }
  if (
    ROUTE_HINTS.proof.test(routeText) ||
    (route.id === "home" && brief.verifiedFacts.length > 0)
  ) {
    add("proof", "proof");
  }
  if (ROUTE_HINTS.timeline.test(routeText)) add("timeline", "timeline");
  if (ROUTE_HINTS.faq.test(routeText) || hasInventoryKind(brief, "faq")) {
    add("questions", "faq");
  }
  if (ROUTE_HINTS.contact.test(routeText) || route.id === "home") {
    add("contact", "cta");
  }
  return { routeId: route.id, slots };
}

function layoutForBlueprint(
  referenceBlueprint: ReferenceBlueprint,
): SiteDesignSpecV2["layoutArchetype"] {
  switch (referenceBlueprint.composition) {
    case "split":
      return "split";
    case "editorial":
      return "editorial";
    case "modular":
      return "modular";
    case "immersive":
      return "asymmetric";
    case "centered":
    default:
      return "hero_led";
  }
}

function imageTreatmentForBlueprint(
  referenceBlueprint: ReferenceBlueprint,
): SiteDesignSpecV2["imageTreatment"] {
  switch (referenceBlueprint.mediaRegion) {
    case "none":
      return "none";
    case "full_bleed":
      return "wide";
    case "surround":
      return "masked";
    case "inline":
    case "split":
    default:
      return "contained";
  }
}

function typeScaleForBlueprint(
  referenceBlueprint: ReferenceBlueprint,
): SiteDesignSpecV2["typeScale"] {
  if (referenceBlueprint.typographyStyle === "editorial") return "editorial";
  if (referenceBlueprint.typographyStyle === "display") return "display";
  return "restrained";
}

/**
 * Create the complete host-owned design contract without accepting any
 * provider-owned route, slot, layout or palette coordinates. Normal 2.4
 * builds pass V4; the native first-build fallback may pass the historical V3
 * single-preview coordinate when no independent realization was frozen.
 */
export function createHostOwnedSiteDesignResultV2(
  input: HostOwnedSiteDesignInput,
) {
  const brief = siteBriefSchema.parse(input.brief);
  const referenceBlueprint = referenceBlueprintSchema.parse(
    input.referenceBlueprint,
  );
  const taxonomy = visualTaxonomySchema.parse(input.taxonomy);
  const paletteSize = boundedSiteDesignPaletteSize(taxonomy.palette.length);
  const title = boundedText(brief.companyName, 80) || "企业官网";
  const description =
    boundedText(brief.verifiedFacts[0]?.statement ?? "", 200) ||
    boundedText(`${brief.companyName}：${brief.conversionGoal}`, 200) ||
    `${title}官方网站`;

  return siteDesignResultV2Schema.parse({
    operationToken: input.operationToken,
    designSpec: {
      schemaVersion: 2,
      referenceBlueprint,
      layoutArchetype: layoutForBlueprint(referenceBlueprint),
      density: referenceBlueprint.density,
      surfaceStyle: referenceBlueprint.cardStyle,
      typeScale: typeScaleForBlueprint(referenceBlueprint),
      imageTreatment: imageTreatmentForBlueprint(referenceBlueprint),
      motionLevel:
        referenceBlueprint.motionLevel === "none" ? "none" : "subtle",
      colorRoles: {
        backgroundPaletteIndex: 0,
        textPaletteIndex: Math.min(1, paletteSize - 1),
        accentPaletteIndex: Math.min(2, paletteSize - 1),
      },
      routeCompositions: brief.routes.map((route) =>
        hostOwnedRouteComposition(brief, route),
      ),
      seoPlan: {
        siteTitle: title,
        description,
        organizationType: "Organization",
      },
    },
  });
}
