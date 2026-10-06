import { server } from "vitest/browser";
import { checkDocument } from "./check";
checkDocument("custom view", () => (server.commands as any).installLeakingScript());
