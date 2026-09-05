import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as AliDnsSdk from "@alicloud/alidns20150109";
import * as CredentialsSdk from "@alicloud/credentials";
import * as EsaSdk from "@alicloud/esa20240910";
import * as OpenApi from "@alicloud/openapi-client";
import { describe, expect, it } from "vitest";

import {
  AliyunCredential,
  AliyunDnsClient,
  AliyunEsaClient,
  resolveAliyunSdkConstructor,
} from "./aliyun-sdk-constructors";

const require = createRequire(import.meta.url);
const commonJsExports = {
  dns: require("@alicloud/alidns20150109") as typeof AliDnsSdk,
  credential: require("@alicloud/credentials") as typeof CredentialsSdk,
  esa: require("@alicloud/esa20240910") as typeof EsaSdk,
};

function sdkConfig(endpoint: string) {
  return new OpenApi.Config({
    accessKeyId: "LTAI5frontmindtest",
    accessKeySecret: "frontmind-test-access-key-secret",
    endpoint,
    protocol: "HTTPS",
    regionId: "cn-hangzhou",
  });
}

describe("Alibaba Cloud SDK constructor resolution", () => {
  it("resolves all installed clients from their ESM and CJS export shapes", () => {
    const modules = [
      [AliyunDnsClient, AliDnsSdk, commonJsExports.dns],
      [AliyunCredential, CredentialsSdk, commonJsExports.credential],
      [AliyunEsaClient, EsaSdk, commonJsExports.esa],
    ] as const;

    for (const [resolvedConstructor, esmNamespace, cjsModule] of modules) {
      expect(typeof cjsModule.default).toBe("function");
      expect(resolvedConstructor).toBe(cjsModule.default);
      expect(
        resolveAliyunSdkConstructor<typeof resolvedConstructor>(esmNamespace),
      ).toBe(cjsModule.default);
      expect(
        resolveAliyunSdkConstructor<typeof resolvedConstructor>(cjsModule),
      ).toBe(cjsModule.default);
      expect(
        resolveAliyunSdkConstructor<typeof resolvedConstructor>({
          default: cjsModule,
        }),
      ).toBe(cjsModule.default);
    }
  });

  it("constructs the three installed clients without making requests", () => {
    const dns = new AliyunDnsClient(
      sdkConfig("alidns.cn-hangzhou.aliyuncs.com"),
    );
    const credential = new AliyunCredential();
    const esa = new AliyunEsaClient(sdkConfig("esa.cn-hangzhou.aliyuncs.com"));

    expect(dns).toBeInstanceOf(commonJsExports.dns.default);
    expect(dns.describeDomains).toEqual(expect.any(Function));
    expect(credential).toBeInstanceOf(commonJsExports.credential.default);
    expect(credential.getCredential).toEqual(expect.any(Function));
    expect(esa).toBeInstanceOf(commonJsExports.esa.default);
    expect(esa.getRoutine).toEqual(expect.any(Function));
  });

  it("constructs the three installed clients through native Node ESM interop", () => {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), "server/siteops/aliyun-sdk-constructors.ts"),
    ).href;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `
          import * as OpenApi from "@alicloud/openapi-client";
          const constructors = await import(${JSON.stringify(moduleUrl)});
          const config = (endpoint) => new OpenApi.Config({
            accessKeyId: "LTAI5frontmindtest",
            accessKeySecret: "frontmind-test-access-key-secret",
            endpoint,
            regionId: "cn-hangzhou",
          });
          const clients = [
            new constructors.AliyunDnsClient(config("alidns.cn-hangzhou.aliyuncs.com")),
            new constructors.AliyunCredential(),
            new constructors.AliyunEsaClient(config("esa.cn-hangzhou.aliyuncs.com")),
          ];
          process.stdout.write(JSON.stringify({
            constructorNames: clients.map((client) => client.constructor.name),
            methods: [
              typeof clients[0].describeDomains,
              typeof clients[1].getCredential,
              typeof clients[2].getRoutine,
            ],
          }));
        `,
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(JSON.parse(output)).toEqual({
      constructorNames: ["Client", "Credential", "Client"],
      methods: ["function", "function", "function"],
    });
  });
});
