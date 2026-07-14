import { describe, expect, it } from "vitest";
import { renderTelegramMiniAppPage } from "./page.js";

const TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS = 15_000;

describe("renderTelegramMiniAppPage", () => {
  it("builds the dashboard redirect from the authenticated payload", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "nonce" });

    expect(html).toContain('const accountId = "ops";');
    expect(html).toContain("new URL(payload.controlUiUrl)");
    expect(html).not.toContain("const controlUiUrl =");
  });

  it("escapes the nonce for its quoted HTML attribute", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: `&<>"'` });

    expect(html).toContain('nonce="&amp;&lt;&gt;&quot;&#39;"');
  });

  it("bounds the auth fetch with AbortController and a cleared timer", () => {
    const html = renderTelegramMiniAppPage({ accountId: "ops", scriptNonce: "nonce" });

    expect(html).toContain("const authController = new AbortController()");
    expect(html).toContain(`}, ${TELEGRAM_MINIAPP_AUTH_TIMEOUT_MS});`);
    expect(html).toContain("signal: authController.signal");
    expect(html).toContain("clearTimeout(authTimeout)");
    expect(html).not.toContain("AbortSignal.timeout");
  });
});
