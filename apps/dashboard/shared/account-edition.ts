import { z } from "zod";

export const accountMarketEditionSchema = z.enum(["domestic", "overseas"]);

export type AccountMarketEdition = z.infer<typeof accountMarketEditionSchema>;

export const ACCOUNT_MARKET_EDITION_LABELS: Record<
  AccountMarketEdition,
  string
> = {
  domestic: "国内版",
  overseas: "海外版",
};
