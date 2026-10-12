// The catalogue's entry point: every part, looked up by type, and its custom elements defined.
import { CATALOG } from "./data"
import { definePart } from "./look"
import type { CatalogPart } from "./types"

export { CATALOG }
export * from "./types"

const byType = new Map<string, CatalogPart>()
for (const p of CATALOG) if (!byType.has(p.type)) byType.set(p.type, p)
export const catalogPart = (type: string): CatalogPart | undefined => byType.get(type)

/** Define every catalogue part's element (after @wokwi/elements, which some extend). */
export function defineCatalog() { for (const p of CATALOG) definePart(p) }
