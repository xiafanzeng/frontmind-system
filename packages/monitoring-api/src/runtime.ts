import type { Express } from "express";
type Pool = ReturnType<typeof createDatabase>["pool"];
import type { RuntimeConfig } from "@frontmind/monitoring-config";
import { runtimeConfigSchema } from "@frontmind/monitoring-config";
import {
  createDatabase,
  MonitoringRepository,
  PublishingRepository,
} from "@frontmind/monitoring-db";
import {
  AliOssPrivateObjectStore,
  LocalPrivateObjectStore,
} from "@frontmind/monitoring-object-store";
import { resolvePaymentConfiguration } from "@frontmind/monitoring-payment";
import type { AuthenticationService } from "./auth.js";
import { OssMediaSigner } from "./media-signer.js";
import { createApiApp } from "./server.js";
import { createPublisherHttpService } from "./publisher-service.js";

export type MonitoringRuntime = {
  app: Express; repository: MonitoringRepository;
  publishingRepository: PublishingRepository; pool: Pool; config: RuntimeConfig;
};
export function createMonitoringRuntime(input: { env: NodeJS.ProcessEnv; auth: AuthenticationService }): MonitoringRuntime {
const config = runtimeConfigSchema.parse({
  ...input.env,
  EMBEDDED_DASHBOARD: true,
  WEB_DIST_DIR: undefined,
  COOKIE_SECURE: input.env.COOKIE_SECURE ?? (input.env.NODE_ENV === "production" ? "true" : "false"),
});
const { db, pool } = createDatabase(config.DATABASE_URL);
const repository = new MonitoringRepository(db);
const publishingRepository = new PublishingRepository(db);
const auth = input.auth;
const paymentConfiguration = resolvePaymentConfiguration(input.env);
const readOssValues = [
  config.OSS_MEDIA_BUCKET,
  config.OSS_READ_ACCESS_KEY_ID,
  config.OSS_READ_ACCESS_KEY_SECRET,
];
if (
  config.OBJECT_STORE_DRIVER === "oss" &&
  readOssValues.some(Boolean) &&
  !readOssValues.every(Boolean)
) {
  throw new Error(
    "OSS_MEDIA_BUCKET, OSS_READ_ACCESS_KEY_ID and OSS_READ_ACCESS_KEY_SECRET must be configured together",
  );
}
const mediaSigner =
  config.OBJECT_STORE_DRIVER === "oss" &&
  config.OSS_MEDIA_BUCKET &&
  config.OSS_READ_ACCESS_KEY_ID &&
  config.OSS_READ_ACCESS_KEY_SECRET
    ? new OssMediaSigner({
        bucket: config.OSS_MEDIA_BUCKET,
        endpoint: config.OSS_ENDPOINT,
        accessKeyId: config.OSS_READ_ACCESS_KEY_ID,
        accessKeySecret: config.OSS_READ_ACCESS_KEY_SECRET,
      })
    : undefined;
const mediaReader =
  config.OBJECT_STORE_DRIVER === "oss" &&
  config.OSS_MEDIA_BUCKET &&
  config.OSS_READ_ACCESS_KEY_ID &&
  config.OSS_READ_ACCESS_KEY_SECRET
    ? new AliOssPrivateObjectStore({
        bucket: config.OSS_MEDIA_BUCKET,
        endpoint: config.OSS_ENDPOINT,
        credentials: {
          accessKeyId: config.OSS_READ_ACCESS_KEY_ID,
          accessKeySecret: config.OSS_READ_ACCESS_KEY_SECRET,
        },
      })
    : config.OBJECT_STORE_DRIVER === "local" && config.LOCAL_OBJECT_STORE_DIR
      ? new LocalPrivateObjectStore({
          rootDirectory: config.LOCAL_OBJECT_STORE_DIR,
        })
      : undefined;
const localPublisherStore =
  (config.PUBLISHER_FEATURE_ENABLED ||
    config.PUBLISHER_PUBLIC_ASSETS_ENABLED) &&
  config.OBJECT_STORE_DRIVER === "local" &&
  config.LOCAL_OBJECT_STORE_DIR
    ? new LocalPrivateObjectStore({
        rootDirectory: config.LOCAL_OBJECT_STORE_DIR,
      })
    : undefined;
const publisherWriter =
  config.PUBLISHER_FEATURE_ENABLED &&
  config.OBJECT_STORE_DRIVER === "oss" &&
  config.OSS_MEDIA_BUCKET &&
  config.PUBLISHER_OSS_WRITE_ACCESS_KEY_ID &&
  config.PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET
    ? new AliOssPrivateObjectStore({
        bucket: config.OSS_MEDIA_BUCKET,
        endpoint: config.OSS_ENDPOINT,
        credentials: {
          accessKeyId: config.PUBLISHER_OSS_WRITE_ACCESS_KEY_ID,
          accessKeySecret: config.PUBLISHER_OSS_WRITE_ACCESS_KEY_SECRET,
        },
      })
    : localPublisherStore;
const publisherReader =
  (config.PUBLISHER_FEATURE_ENABLED ||
    config.PUBLISHER_PUBLIC_ASSETS_ENABLED) &&
  config.OBJECT_STORE_DRIVER === "oss" &&
  config.OSS_MEDIA_BUCKET &&
  config.OSS_READ_ACCESS_KEY_ID &&
  config.OSS_READ_ACCESS_KEY_SECRET
    ? new AliOssPrivateObjectStore({
        bucket: config.OSS_MEDIA_BUCKET,
        endpoint: config.OSS_ENDPOINT,
        credentials: {
          accessKeyId: config.OSS_READ_ACCESS_KEY_ID,
          accessKeySecret: config.OSS_READ_ACCESS_KEY_SECRET,
        },
      })
    : localPublisherStore;
const publisherHttpService =
  publisherReader
    ? createPublisherHttpService({
        repository: publishingRepository,
        ...(publisherWriter ? { writer: publisherWriter } : {}),
        reader: publisherReader,
        capabilitySecret: config.SESSION_SECRET,
        publicOrigin: config.PUBLIC_ORIGIN,
      })
    : undefined;
const app = createApiApp({
  repository,
  publishingRepository,
  auth,
  config,
  paymentConfiguration,
  ...(mediaSigner ? { mediaSigner } : {}),
  ...(mediaReader ? { mediaReader } : {}),
  ...(publisherHttpService ? { publisherHttpService } : {}),
});

return { app, repository, publishingRepository, pool, config };
}
export type { AuthenticationService } from "./auth.js";
