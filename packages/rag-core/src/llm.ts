import { ChatOpenAI } from "@langchain/openai";
import { getConfig } from "./config";

export function createGatewayModel(model?: string, temperature = 0.2) {
  const config = getConfig();
  return new ChatOpenAI({
    model: model || config.CHAT_MODEL,
    temperature,
    apiKey: config.LITELLM_API_KEY || "missing-key",
    configuration: { baseURL: config.LITELLM_BASE_URL },
  });
}
