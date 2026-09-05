import { describe, expect, it } from "vitest";

import { collectUpstreamOutputFileIds } from "./upstream-output-resources";

describe("collectUpstreamOutputFileIds", () => {
  it("finds and deduplicates nested generated image files", () => {
    expect(
      collectUpstreamOutputFileIds({
        output: [
          {
            type: "message",
            content: [
              { type: "output_image", file_id: "logo-file" },
              { type: "output_file", fileId: "hero-file" },
              {
                type: "image",
                image_url:
                  "https://api.example.test/v1/files/product-file/content",
              },
              { type: "output_image", file_id: "logo-file" },
              { type: "output_image", file_id: "bad/id" },
              { type: "output_image", file_id: "x".repeat(256) },
            ],
          },
        ],
      }),
    ).toEqual(new Set(["logo-file", "hero-file", "product-file"]));
  });
});
