import { NextRequest } from "next/server";
import { handleChat } from "./handler";
import { store } from "@/lib/store";

export async function POST(req: NextRequest) {
  return handleChat(req, { sessionStore: store() });
}
