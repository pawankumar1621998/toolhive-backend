---
name: Image Tool 404 Pages
description: 9 image tools appear in the /tools/image category listing but have no entry in TOOLS registry — they resolve to 404
type: project
---

## 404 Image Tool Routes (as of 2026-04-20)
These URLs return HTTP 404:
- /tools/image/crop — NOT in TOOLS registry
- /tools/image/remove-watermark — NOT in TOOLS registry
- /tools/image/blur-background — NOT in TOOLS registry
- /tools/image/pixelate — NOT in TOOLS registry
- /tools/image/color-filter — NOT in TOOLS registry
- /tools/image/adjust — NOT in TOOLS registry
- /tools/image/draw — NOT in TOOLS registry
- /tools/image/cleanup — NOT in TOOLS registry
- /tools/image/collage — NOT in TOOLS registry
- /tools/image/combine — NOT in TOOLS registry
- /tools/image/profile-photo — NOT in TOOLS registry
- /tools/image/add-border — NOT in TOOLS registry
- /tools/image/round-image — NOT in TOOLS registry
- /tools/image/thumbnail-creator — NOT in TOOLS registry

## Root Cause
The category page (/tools/image) fetches the tool list from a data source that includes more tools than TOOLS registry in tools.ts. The [category]/[tool]/page.tsx calls getToolBySlug() which returns null for unregistered slugs → notFound() → 404.

## Fix
Either add these tools to TOOLS registry in src/config/tools.ts, or remove them from the category listing.
