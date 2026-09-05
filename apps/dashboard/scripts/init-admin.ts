import "dotenv/config";
import { createManagedUser, normalizeUsername } from "../server/auth-service";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from "../shared/auth-constraints";

function readFlag(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).replace(/[\r\n]+$/, ""));
    });
    process.stdin.once("error", reject);
  });
}

function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("管理员密码必须通过交互式 TTY 隐藏输入");
  }

  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const previousRaw = input.isRaw;
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(previousRaw));
      input.pause();
    };
    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("已取消"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " " && character !== "\u007f") {
          value += character;
          process.stdout.write("*");
        }
      }
    };

    process.stdout.write(question);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "请先设置 DATABASE_URL，并通过当前环境的受控迁移流程完成数据库初始化",
    );
  }

  const usernameInput =
    readFlag("--username") ?? (await promptLine("管理员用户名："));
  const username = normalizeUsername(usernameInput);
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
    throw new Error("用户名需为 3-64 位字母、数字、点、下划线或连字符");
  }

  const displayName =
    readFlag("--display-name") ?? (await promptLine("显示名称（可留空）："));
  const password = await promptHidden(
    `管理员密码（至少 ${MIN_PASSWORD_LENGTH} 位）：`,
  );
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `密码长度需为 ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} 位`,
    );
  }
  const confirmation = await promptHidden("再次输入密码：");
  if (password !== confirmation) throw new Error("两次输入的密码不一致");

  const user = await createManagedUser({
    username,
    password,
    displayName: displayName.trim() || null,
    role: "admin",
    adminAccessLevel: "system_admin",
  });
  console.log(`管理员已创建：${user.username}（ID ${user.id}）`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
