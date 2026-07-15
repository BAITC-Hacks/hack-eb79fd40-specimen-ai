import { MemorySessionStore } from "../../lib/store";

async function readonlyContract() {
  const session = await new MemorySessionStore().getSession("session-id");
  if (!session) return;

  // If getSession ever returns mutable messages, this directive becomes unused and tsc fails.
  // @ts-expect-error ReadonlySession forbids mutation through the public store contract.
  session.messages.push({ role: "user", content: "mutation" });
}

void readonlyContract;
