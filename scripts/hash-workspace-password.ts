import { hashWorkspacePassword } from "../lib/workspace-auth";

async function main(): Promise<void> {
  if (process.argv.length !== 2 || process.stdin.isTTY) {
    throw new Error("Read a password from stdin; command-line passwords are not accepted");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_026) throw new Error("Password input is too long");
    chunks.push(bytes);
  }
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  if (/[\r\n]/u.test(password)) throw new Error("Expected one password line");
  process.stdout.write(`${await hashWorkspacePassword(password)}\n`);
}

void main().catch(() => {
  process.stderr.write("Unable to hash password: use one stdin line of 12+ characters, at most 1024 bytes.\n");
  process.exitCode = 1;
});
