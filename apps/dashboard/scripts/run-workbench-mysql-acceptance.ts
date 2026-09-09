import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import mysql from "mysql2/promise";

// Starts only a newly initialized, loopback-only MySQL and destroys only its
// own temporary directory. No Docker, installation, production URL or data.
const require = createRequire(import.meta.url);
const tsx = require.resolve("tsx/cli");
const dashboard = new URL("..", import.meta.url).pathname;
const mysqld = process.env.FRONTMIND_LOCAL_MYSQLD || "mysqld";
const root = await mkdtemp(join(tmpdir(), "frontmind-workbench-acceptance-"));
const data = join(root, "data");
await mkdir(data);
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = (server.address() as { port: number }).port;
    server.close((error) => (error ? reject(error) : resolve(value)));
  });
});
const database = `frontmind_workbench_acceptance_${Date.now()}`;
const url = `mysql://root@127.0.0.1:${port}/${database}`;
let server: ReturnType<typeof spawn> | undefined;
const child = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const process = spawn(processExecutable, args, {
      cwd: dashboard,
      env: childEnv,
      stdio: "inherit",
    });
    process.once("error", reject);
    process.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Acceptance command exited ${code}`)),
    );
  });
const processExecutable = process.execPath;
const childEnv = {
  ...process.env,
  DATABASE_URL: "",
  FRONTMIND_RELEASE_DATABASE_URL: "",
  FRONTMIND_WORKBENCH_TEST_MYSQL_URL: url,
  FRONTMIND_PUBLISHER_PROJECT_TEST_MYSQL_URL: url,
};
try {
  execFileSync(
    mysqld,
    [
      "--no-defaults",
      "--initialize-insecure",
      `--datadir=${data}`,
      `--log-error=${join(root, "initialize.log")}`,
    ],
    { stdio: "pipe" },
  );
  server = spawn(
    mysqld,
    [
      "--no-defaults",
      `--datadir=${data}`,
      `--port=${port}`,
      "--bind-address=127.0.0.1",
      `--socket=${join(root, "mysql.sock")}`,
      `--pid-file=${join(root, "mysql.pid")}`,
      `--log-error=${join(root, "server.log")}`,
      "--mysqlx=OFF",
    ],
    { stdio: "ignore" },
  );
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Isolated MySQL exited before readiness");
    try {
      const connection = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: "root",
        connectTimeout: 500,
      });
      await connection.query("SELECT 1");
      await connection.end();
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!ready) throw new Error("Isolated MySQL readiness timed out");
  console.log(
    `WORKBENCH_MYSQL_ACCEPTANCE loopback:${port} database:${database}`,
  );
  await child([tsx, "scripts/bootstrap-workbench-mysql-acceptance.ts"]);
  await child([
    require.resolve("vitest/vitest.mjs"),
    "run",
    "--config",
    "vitest.node.config.ts",
    "server/workbench-task-mysql.test.ts",
    "server/publisher-enterprise-mysql.test.ts",
    "server/workbench-task-service.test.ts",
  ]);
} finally {
  if (server && server.exitCode === null) {
    try {
      const connection = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: "root",
        connectTimeout: 500,
      });
      await connection.query("SHUTDOWN");
      await connection.end();
    } catch {
      server.kill("SIGTERM");
    }
    await new Promise<void>((resolve) => {
      if (server!.exitCode !== null) return resolve();
      server!.once("exit", () => resolve());
    });
  }
  await rm(root, { recursive: true, force: true });
}
