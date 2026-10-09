// The "About the chef" page: one set of rules for the admin console
// (any kitchen) and the kitchen desk (own kitchen).
import { AppError } from "../../common/errors/AppError.js";
import { cleanLink } from "../../common/links.js";
import { assertOwnFileUrl } from "../upload/upload.service.js";

// field → max length. `title` is the small eyebrow line ("THE MAN BEHIND THE FLAME").
const TEXT_FIELDS = { chefName: 80, title: 120, tagline: 60, quote: 240, story: 2000, standardTitle: 60, ctaLabel: 30 };
const ICON = /^[a-z0-9_-]{1,30}$/;
const MAX_PILLARS = 6;

/** Splits the story into the paragraphs the app prints (blank line = new paragraph). */
export function storyParagraphs(story) {
  return String(story || "").split(/\n\s*\n/).map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export function toAbout(about = {}) {
  return {
    chefName: about.chefName ?? null,
    title: about.title ?? null,
    tagline: about.tagline ?? null,
    quote: about.quote ?? null,
    story: about.story ?? null,
    paragraphs: storyParagraphs(about.story),
    standardTitle: about.standardTitle ?? null,
    pillars: (about.pillars || []).map((pillar) => ({ icon: pillar.icon || null, title: pillar.title, description: pillar.description || null })),
    ctaLabel: about.ctaLabel ?? null,
    ctaDeepLink: about.ctaDeepLink ?? null,
    imageUrl: about.imageUrl ?? null,
    gallery: about.gallery || [],
  };
}

/** Applies the sent fields to kitchen.about; 422 with field errors when something is wrong. */
export function applyAbout(kitchen, input = {}) {
  const errors = [];
  const about = { ...(kitchen.about?.toObject?.() || kitchen.about || {}) };
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (input[key] === undefined) continue;
    const value = input[key] == null ? "" : String(input[key]).trim();
    if (value.length > max) errors.push({ field: key, message: `Up to ${max} characters` });
    else about[key] = value || null;
  }
  if (input.ctaDeepLink !== undefined) about.ctaDeepLink = cleanLink(input.ctaDeepLink, "ctaDeepLink", errors);
  if (input.pillars !== undefined) {
    const pillars = input.pillars || [];
    const bad = !Array.isArray(pillars) || pillars.length > MAX_PILLARS || pillars.some((pillar) => !pillar
      || typeof pillar.title !== "string" || !pillar.title.trim() || pillar.title.length > 60
      || (pillar.description != null && (typeof pillar.description !== "string" || pillar.description.length > 160))
      || (pillar.icon != null && pillar.icon !== "" && !ICON.test(String(pillar.icon))));
    if (bad) errors.push({ field: "pillars", message: `Up to ${MAX_PILLARS} points, each with a title (max 60), a description (max 160) and an icon name (a-z, 0-9, - or _)` });
    else about.pillars = pillars.map((pillar) => ({ icon: pillar.icon || null, title: pillar.title.trim(), description: pillar.description?.trim() || null }));
  }
  if (errors.length) throw new AppError(422, errors[0].message, errors);
  if (input.imageUrl !== undefined) about.imageUrl = input.imageUrl ? assertOwnFileUrl(input.imageUrl) : null;
  if (input.gallery !== undefined) {
    if (!Array.isArray(input.gallery) || input.gallery.length > 12) throw new AppError(422, "Up to 12 gallery photos", [{ field: "gallery", message: "Up to 12 gallery photos" }]);
    about.gallery = input.gallery.map((url) => assertOwnFileUrl(url));
  }
  kitchen.about = about;
  return kitchen;
}
