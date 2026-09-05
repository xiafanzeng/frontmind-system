# FrontMind Dashboard Adapter 2.6.0

## One provider stage

Dashboard creates one new root build, one operation token and one AI task. The
task returns only the flat `SiteContentPatchWireV1` transport and the identical
JSON attachment. Dashboard projects its values into the nested host patch and
applies them to an immutable baseline. There is no provider design stage and no provider-owned
route, slot, component, palette, typography, layout or responsive coordinate.

## Host-owned design

Dashboard calls `createHostOwnedSiteDesignResultV2` with the exact operation
token, frozen `SiteBrief`, immutable selected `ReferenceBlueprintV4` and its
safe taxonomy. The deterministic result contains every frozen route, including
the legal `news-empty` slot when the frozen inventory has no company news.

## Content completion

Dashboard applies bounded JSON intake and validates the exact operation token.
Unknown routes and fields are discarded. Slot kinds must match the frozen slot
manifest, and source ids are intersected with the route's frozen source
allowlist. Invalid child fields do not reject otherwise usable content. Missing
or conflicting provider values keep the trusted defaults already present in
`CanonicalPreviewModelV1`.

Only the canonical model is passed as escaped data to host-owned renderers.
Provider bytes are never interpolated into source, markup, styles or scripts.

## Delivery

The primary React static renderer and the no-JavaScript trusted fallback both
produce complete route documents. Artifact safety and binding checks remain
blocking. Axe, Lighthouse and presentation findings are preserved as warnings
and do not suppress an otherwise safe private preview.
