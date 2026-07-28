import { cmsPlaywrightConfig } from "./tooling/playwright-config/index.js";

export default cmsPlaywrightConfig({
  nextPort: Number(process.env.CMS_E2E_NEXT_PORT ?? "41731"),
  astroPort: Number(process.env.CMS_E2E_ASTRO_PORT ?? "41732"),
});
