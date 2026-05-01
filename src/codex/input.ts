import type { JsonObject } from "./ws-client.js";

export function textInput(text: string): JsonObject {
  return {
    type: "text",
    text,
    text_elements: []
  };
}
