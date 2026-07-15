import { NextRequest } from "next/server";
import { handleFinalize } from "./handler";
import { store } from "@/lib/store";

export async function POST(req: NextRequest) {
  return handleFinalize(req, { sessionStore: store() });
}
