---
name: PDF to JPG — Intentional Hard Error
description: PDF to JPG is intentionally disabled in the Next.js API route with a throw — requires Ghostscript/Poppler which aren't available on Vercel
type: project
---

## Status
BROKEN — by design. The route.ts throws:
"PDF to Image conversion requires a PDF rendering engine (e.g. Ghostscript or Poppler) that is not available in this environment."

## Code Location
C:/Users/M.K COMPUTERS/Desktop/PDF/toolhive/src/app/api/tools/process/route.ts
Lines ~915-920, cases "pdf-to-jpg", "pdf-to-jpeg", "pdf-to-png", "pdf-to-image"

## Why
Vercel serverless functions don't have system dependencies (Ghostscript, Poppler). pdf-lib cannot render PDF pages to images.

## Fix Options
1. Use Cloudinary's PDF-to-image transformation (already implemented in pdfWorker.js — needs backend to be up)
2. Use a third-party PDF rendering service
3. Display clear message to user explaining the limitation with alternative suggestions (currently done — message is clear)
