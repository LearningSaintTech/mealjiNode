// Step 01 · App start — Splash and Onboarding screens.
import { Client, createSuite, headOk } from "./harness.js";

export default async function step01() {
  const s = createSuite("01", "App start");
  const anon = new Client("step01-device-001");

  const config = await anon.call("GET", "/app/config");
  const cfg = config.data || {};
  await s.run("01-01", "App config loads before sign-in", "Splash decides update/maintenance before anything else", () => ({
    ok: config.status === 200 && config.body?.success === true && typeof cfg.minSupportedVersion === "string" && typeof cfg.forceUpdate === "boolean" && typeof cfg.maintenanceMode === "boolean",
    detail: `${config.status} minSupportedVersion ${cfg.minSupportedVersion} forceUpdate ${cfg.forceUpdate} maintenance ${cfg.maintenanceMode}`,
  }));
  await s.run("01-02", "Config gives the OTP rules the screens use", "OTP screen: 6 boxes, 30-second resend timer, +91 prefix", () => ({
    ok: cfg.otpLength === 6 && cfg.otpResendSeconds === 30 && Array.isArray(cfg.countryCodes) && cfg.countryCodes.includes("+91"),
    detail: `otpLength ${cfg.otpLength} otpResendSeconds ${cfg.otpResendSeconds} countryCodes ${JSON.stringify(cfg.countryCodes)}`,
  }));
  await s.run("01-03", "Config gives the delivery promise", "Onboarding: “We deliver in 25–35 minutes, or you pick it up in 15”; Addresses: “We deliver to N cities”", () => ({
    ok: typeof cfg.deliveryEtaLabel === "string" && Number.isInteger(cfg.pickupReadyMinutes) && Number.isInteger(cfg.servedCitiesCount) && cfg.servedCitiesCount >= 1,
    detail: `deliveryEtaLabel ${cfg.deliveryEtaLabel} pickupReadyMinutes ${cfg.pickupReadyMinutes} servedCitiesCount ${cfg.servedCitiesCount}`,
  }));
  await s.run("01-04", "Config shows only the meal slots the app uses", "App shows lunch only", () => ({
    ok: Array.isArray(cfg.mealSlotsShown) && cfg.mealSlotsShown.includes("lunch"),
    detail: JSON.stringify(cfg.mealSlotsShown),
  }));

  const slides = await anon.call("GET", "/onboarding/slides");
  const list = Array.isArray(slides.data) ? slides.data : [];
  await s.run("01-05", "Onboarding has the app's 3 steps in order", "Onboarding: chef → menu → fresh, each with title, subtitle, image and button", () => ({
    ok: slides.status === 200 && list.length === 3 && list.every((slide) => slide.title && slide.subtitle && slide.imageUrl && slide.ctaLabel),
    detail: list.map((slide) => `${slide.layout || "?"}: ${slide.title} [${slide.ctaLabel || "no button"}]`).join(" | "),
  }));
  await s.run("01-06", "Each step tells the app which layout to draw", "Steps are custom layouts (chef, menu grid, fresh benefits)", () => ({
    ok: list.map((slide) => slide.layout).join() === "chef,menu,fresh",
    detail: list.map((slide) => slide.layout).join(","),
  }));
  const menuSlide = list.find((slide) => slide.layout === "menu");
  const freshSlide = list.find((slide) => slide.layout === "fresh");
  await s.run("01-07", "Menu step carries its 6-photo category grid", "Onboarding menu step: Signature Bowls, Steamed Bao, Global Wraps, Street Snacks, Comfort Curries, Desserts", () => ({
    ok: menuSlide?.items?.length === 6 && menuSlide.items.every((item) => item.title && item.imageUrl),
    detail: (menuSlide?.items || []).map((item) => item.title).join(", "),
  }));
  await s.run("01-08", "Fresh step carries its benefit strip", "Onboarding fresh step: Hot Meals / Real Ingredients / Happier You", () => ({
    ok: freshSlide?.items?.length === 3 && freshSlide.items.every((item) => item.title),
    detail: (freshSlide?.items || []).map((item) => item.title).join(", "),
  }));
  await s.run("01-09", "Accent words are marked", "Onboarding titles colour some words (e.g. “Meal Ji.”, “hero.”)", () => ({
    ok: list.length === 3 && list.every((slide) => slide.highlight && slide.title.includes(slide.highlight)),
    detail: list.map((slide) => slide.highlight).join(" | "),
  }));
  const images = [...new Set(list.flatMap((slide) => [slide.imageUrl, ...(slide.items || []).map((item) => item.imageUrl)]).filter(Boolean))];
  const broken = [];
  for (const url of images) if (!(await headOk(url))) broken.push(url);
  await s.run("01-10", "Every onboarding image loads", "Images are remote CDN URLs", () => ({ ok: images.length > 0 && broken.length === 0, detail: `${images.length - broken.length}/${images.length} load` }));
  await s.run("01-11", "Slides are cacheable", "Shown on every fresh install; should be cheap", () => ({
    ok: /max-age=\d+/.test(slides.headers.get("cache-control") || ""),
    detail: slides.headers.get("cache-control"),
  }));
  return s;
}
