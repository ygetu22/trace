import type { Page } from "playwright";

export interface JourneyPlan {
  name: string;
  reason: string;
  keywords: string[];
  goal?: "locations" | "browse" | "work" | "service";
}

export interface Journey {
  name: string;
  reason: string;
  outcome: "passed" | "failed" | "review";
  detail: string;
  steps: number[];
}

const profiles: (JourneyPlan & { context: RegExp })[] = [
  {
    name: "Find a location and inspect its details",
    goal: "locations",
    context: /\b(gym|fitness|health club)\b/i,
    keywords: ["location", "membership", "clubs", "classes"],
    reason:
      "Fitness-related page text; prioritize locations and membership information.",
  },
  {
    name: "Browse the collection",
    context: /\b(shop|store|products|shopping)\b/i,
    keywords: ["shop", "products", "collection", "catalog", "category"],
    reason: "Shopping-related page text; prioritize browsing products.",
  },
  {
    name: "Explore work and contact details",
    context:
      /\b(portfolio|software engineer|developer|designer|photographer)\b/i,
    keywords: ["projects", "work", "portfolio", "resume", "contact"],
    reason:
      "Portfolio-related page text; prioritize work and contact information.",
  },
  {
    name: "Explore the service",
    context: /\b(service|platform|software|tool)\b/i,
    keywords: ["services", "features", "product", "how it works", "pricing"],
    reason:
      "Service-related page text; prioritize features and service information.",
  },
];

// A small, inspectable heuristic chooses browsing priorities. It does not infer business success.
export async function planJourney(page: Page): Promise<JourneyPlan> {
  const context = await page.evaluate(() =>
    [
      document.title,
      ...Array.from(document.querySelectorAll("h1, main h2, [role=main] h2"))
        .slice(0, 6)
        .map((node) => node.textContent),
    ]
      .join(" ")
      .slice(0, 2000),
  );
  const profile = profiles.find((item) => item.context.test(context));
  return profile
    ? {
        name: profile.name,
        reason: profile.reason,
        keywords: profile.keywords,
        goal: profile.goal,
      }
    : {
        name: "Explore the main pages",
        reason:
          "No clear site type detected; prioritize prominent content and navigation links.",
        keywords: ["explore", "learn more", "about", "contact"],
      };
}

export function linkPriority(
  label: string,
  pathname: string,
  prominent: boolean,
  plan: JourneyPlan,
): number {
  const text = `${label} ${pathname.replace(/[-_/]/g, " ")}`.toLowerCase();
  let score = prominent ? 10 : 0;
  for (const [index, keyword] of plan.keywords.entries()) {
    if (new RegExp(`\\b${keyword}s?\\b`, "i").test(text))
      score += (plan.keywords.length - index) * 20;
  }
  if (/\b(corporate|healthcare|partnerships|franchise|careers)\b/i.test(text))
    score -= 100;
  if (/\b(privacy|terms|cookies|legal|accessibility)\b/i.test(text))
    score -= 50;
  return score;
}

export function controlPriority(label: string): number {
  if (
    /\b(accessibe|accessibility options|widget|theme|light mode|dark mode|particles|glass|slide|previous|next)\b/i.test(
      label,
    )
  )
    return -1;
  return /\b(menu|navigation|search|filter|sort)\b/i.test(label) ? 10 : 0;
}
