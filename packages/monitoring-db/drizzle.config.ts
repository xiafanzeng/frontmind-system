import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "mysql://root:root@127.0.0.1:3306/frontmind_monitoring",
  },
  strict: true,
  verbose: true,
});
