import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { safeArchivedMediaUrl, safePublisherLogoUrl } from "./mediaUrls";
import {
  archivedMediaAttachmentUrl,
  safeArchivedMediaUrl as safeWorkspaceMediaUrl,
} from "./features/monitoring/selectors";
import { MediaMark } from "./features/publishing/components/PublishingUi";

const id = "b2cd0fe5-2358-431a-8145-901fa2660ca0";
const media = `/api/monitoring/media/${id}`;
const logo = `/api/monitoring/publisher/media-logos/${id}/${"a".repeat(64)}`;

describe("authenticated monitoring media paths", () => {
  it.each([media, `${media}?variant=display`, `${media}?variant=thumbnail`])(
    "accepts protected screenshot path %s",
    (value) => {
      expect(safeArchivedMediaUrl(value)).toBe(value);
      expect(safeWorkspaceMediaUrl(value)).toBe(value);
    },
  );

  it("downloads an archived screenshot through the same tenant-checked endpoint", () => {
    expect(archivedMediaAttachmentUrl(media)).toBe(
      `${media}?disposition=attachment`,
    );
    expect(archivedMediaAttachmentUrl(`${media}?variant=display`)).toBe(
      `${media}?variant=display&disposition=attachment`,
    );
  });

  it.each([
    undefined,
    `/api/media/${id}`,
    `https://external.example${media}`,
    `//external.example${media}`,
    `/api/monitoring/media/../${id}`,
    `/api/monitoring/media/%2e%2e/${id}`,
    `${media}?variant=original`,
    `${media}?variant=display&redirect=https://external.example`,
    `${media}#fragment`,
    `${media}\n`,
    `${media}/extra`,
    `/api/monitoring/media/not-a-uuid`,
    `javascript:alert(1)`,
  ])("rejects an untrusted screenshot path %s", (value) => {
    expect(safeArchivedMediaUrl(value)).toBeUndefined();
    expect(archivedMediaAttachmentUrl(value)).toBeUndefined();
  });

  it("renders archived media logos using the fused API prefix", () => {
    expect(safePublisherLogoUrl(logo)).toBe(logo);
    render(
      <MediaMark
        id={id}
        name="测试媒体"
        logoUrl={logo}
        logoResolutionStatus="archived"
      />,
    );
    expect(screen.getByRole("img").querySelector("img")).toHaveAttribute(
      "src",
      logo,
    );
  });

  it.each([
    logo.replace("/api/monitoring/", "/api/"),
    `https://external.example${logo}`,
    `//external.example${logo}`,
    logo.replace("media-logos/", "media-logos/../"),
    `${logo}?redirect=https://external.example`,
    `${logo}#fragment`,
    `${logo}\n`,
    `${logo}/extra`,
    logo.slice(0, -1),
  ])("rejects untrusted media logo paths %s", (value) => {
    expect(safePublisherLogoUrl(value)).toBeUndefined();
    render(
      <MediaMark
        id={id}
        name="测试媒体"
        logoUrl={value}
        logoResolutionStatus="archived"
      />,
    );
    expect(screen.getByRole("img").querySelector("img")).toBeNull();
    expect(screen.getByRole("img")).toHaveClass("is-placeholder");
  });
});
