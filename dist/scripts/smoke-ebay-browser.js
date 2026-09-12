import assert from "node:assert/strict";
import { chromium } from "playwright-core";
const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium", headless: true, chromiumSandbox: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8" },
    args: ["--host-resolver-rules=MAP * ~NOTFOUND", "--no-proxy-server"],
});
try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block", acceptDownloads: false });
    const page = await context.newPage();
    await page.setContent('<p id="status">Auction page</p><script>document.getElementById("status").textContent="Script ran"</script>');
    assert.equal(await page.locator("#status").textContent(), "Auction page");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", requestStage: "Response" }] });
    await cdp.send("Fetch.disable");
    console.log("Chromium launches with its sandbox enabled; page scripts are disabled and request/response interception is available.");
}
finally {
    await browser.close();
}
