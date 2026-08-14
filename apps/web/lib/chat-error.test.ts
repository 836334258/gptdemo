import { describe, expect, it } from "vitest";
import { ChatStreamError, toPublicChatError, toUserFacingChatError } from "./chat-error";

describe("chat error sanitization", () => {
  it("turns auth sentinels into an actionable public error", () => {
    expect(toPublicChatError(new Error("AUTH_REQUIRED"))).toEqual({
      code: "AUTH_REQUIRED",
      message: "请先登录后再发送消息。",
    });
  });

  it("does not expose raw persistence details", () => {
    const error = toPublicChatError(new Error("ASSISTANT_WRITE_FAILED: secret database detail"));
    expect(error.code).toBe("PERSISTENCE_FAILED");
    expect(error.message).not.toContain("secret database detail");
  });

  it("adds a short request id to infrastructure failures", () => {
    expect(toUserFacingChatError("CHAT_FAILED", "12345678-abcd")).toContain("12345678");
    expect(new ChatStreamError("AUTH_REQUIRED", "12345678").message).toBe("请先登录后再发送消息。");
  });
});
