import { describe, expect, it } from "vitest";
import { planContextCompression } from "./policy";
import type { ChatMessage } from "../types";

const policy = {
  modelWindowTokens: 100,
  softLimit: 0.65,
  hardLimit: 0.8,
  emergencyLimit: 0.92,
  recentMessages: 4,
};

function messages(content: string): ChatMessage[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? "assistant" : "user",
    content,
  }));
}

describe("planContextCompression", () => {
  it("keeps recent messages outside the summary range", () => {
    const plan = planContextCompression(messages("短消息"), policy);
    expect(plan.recentMessages).toHaveLength(4);
    expect(plan.messagesToSummarize).toHaveLength(4);
  });

  it("enters emergency mode near the model limit", () => {
    const plan = planContextCompression(messages("这是一段足够长的中文内容，用来快速增加估算 token。"), policy);
    expect(plan.action).toBe("emergency");
  });
});
