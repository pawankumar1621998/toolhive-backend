---
name: Redact PDF Bug — Fake Redaction
description: The redact-pdf tool adds a text note overlay but does NOT actually black out or remove the keyword text from the PDF — security flaw
type: project
---

## Bug
In /api/tools/process/route.ts, the redact-pdf case draws a transparent black rectangle (opacity: 0) and adds a visible text note saying "[REDACTED: keyword]" but does NOT:
1. Find the keyword in the PDF text
2. Draw a black box OVER the keyword location
3. Remove the keyword text from the PDF content stream

## Code Location
C:/Users/M.K COMPUTERS/Desktop/PDF/toolhive/src/app/api/tools/process/route.ts
Lines ~841-858, case "redact-pdf"

## Security Impact
HIGH — Users believe their sensitive text is redacted, but it remains fully readable in the output PDF. The rectangle opacity is 0 (invisible). This is a security vulnerability.

## Fix Required
Use pdf-parse to find the keyword, then draw solid black rectangles (opacity: 1, color: rgb(0,0,0)) over the approximate text locations on each page. A proper fix requires PDF text position data which pdf-lib doesn't expose — consider using a different approach or clearly labeling the tool as "mark for redaction" rather than actual redaction.
