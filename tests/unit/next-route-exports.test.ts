import { describe, expect, it } from "vitest";
import * as chatRoute from "../../app/api/chat/route";
import * as finalizeRoute from "../../app/api/chat/finalize/route";
import * as startRoute from "../../app/api/chat/start/route";
import * as healthRoute from "../../app/api/healthz/route";
import * as linkRoute from "../../app/api/link/route";

describe("Next App Router route module exports", () => {
  it.each([
    ["chat", chatRoute, ["POST"]],
    ["chat/finalize", finalizeRoute, ["POST"]],
    ["chat/start", startRoute, ["POST"]],
    ["healthz", healthRoute, ["GET", "dynamic"]],
    ["link", linkRoute, ["POST", "runtime", "dynamic"]],
  ])("keeps %s limited to values accepted by Next", (_name, route, expected) => {
    expect(Object.keys(route).sort()).toEqual([...expected].sort());
  });
});
