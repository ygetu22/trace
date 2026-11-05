import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { TraceError } from "./errors.ts";

export function parseTarget(input: unknown): URL {
  if (typeof input !== "string" || input.length > 2048) {
    throw new TraceError("Enter a website URL of at most 2,048 characters.", 400);
  }

  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new TraceError("Enter a complete URL, starting with https:// or http://.", 400);
  }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TraceError("Use an HTTP or HTTPS URL without embedded credentials.", 400);
  }
  if (url.port) {
    throw new TraceError("Only the standard HTTP and HTTPS ports are supported.", 400);
  }
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address) || address.includes("%")) return false;
  // process() turns IPv4-mapped IPv6 into IPv4 before classifying its range.
  const parsed = ipaddr.process(address);
  if (parsed.range() !== "unicast") return false;
  // Only global IPv6 space; exclude legacy IPv4-compatible and scoped addresses.
  if (parsed instanceof ipaddr.IPv6) return parsed.match(ipaddr.IPv6.parse("2000::"), 3);
  return true;
}

export type Resolver = (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>;

export async function resolvePublicHost(host: string, resolver: Resolver = lookup): Promise<string> {
  const hostname = host.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new TraceError("Trace only visits public internet addresses.");
    }
    return hostname;
  }

  let timer: NodeJS.Timeout | undefined;
  const addresses = await Promise.race([
    resolver(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TraceError("The website's address took too long to resolve.")), 4_000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new TraceError("Trace only visits hosts that resolve to public internet addresses.");
  }
  return addresses[0]!.address;
}
