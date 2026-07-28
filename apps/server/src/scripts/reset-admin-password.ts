import { stdin, stdout } from "node:process";
import { loadLocalEnv } from "../env.js";

loadLocalEnv();

async function main() {
  if (await isBackendRunning()) {
    throw new Error("小松鼠后端仍在运行。请先在启动窗口按 Control+C 停止服务，再执行重置命令。");
  }

  const [password, passwordConfirm] = await readPasswordPair();
  if (password !== passwordConfirm) throw new Error("两次输入的密码不一致。");

  const [{ getDatabasePath, initDb }, { resetBuiltInPassword }] = await Promise.all([
    import("../db.js"),
    import("../auth.js"),
  ]);
  await initDb();
  resetBuiltInPassword("admin", password);

  stdout.write(`管理员密码已重置，原有管理员登录已全部失效。\n数据库：${getDatabasePath()}\n`);
}

async function isBackendRunning() {
  const port = Number(process.env.PORT || 5175);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function readPasswordPair(): Promise<[string, string]> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const [password = "", passwordConfirm = ""] = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
    return [password, passwordConfirm];
  }

  const password = await readMaskedLine("请输入新的 admin 密码（至少8位）：");
  const passwordConfirm = await readMaskedLine("请再次输入新密码：");
  return [password, passwordConfirm];
}

function readMaskedLine(prompt: string) {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const finish = (error?: Error) => {
      stdin.off("data", handleInput);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const handleInput = (input: string | Buffer) => {
      for (const character of String(input)) {
        if (character === "\u0003" || character === "\u0004") {
          finish(new Error("已取消管理员密码重置。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          const characters = Array.from(value);
          if (characters.length) {
            characters.pop();
            value = characters.join("");
            stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          stdout.write("*");
        }
      }
    };

    stdin.on("data", handleInput);
  });
}

void main().catch((error) => {
  process.stderr.write(`重置失败：${error instanceof Error ? error.message : "未知错误"}\n`);
  process.exitCode = 1;
});
