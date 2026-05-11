---
name: Render Backend Down Status
description: Render backend returns 503 on cold start — free tier spins down after 15min inactivity; video downloader and job queue are affected
type: project
---

## Status
As of 2026-04-20: https://toolhive-backend.onrender.com returns 503 (Service Unavailable).

## Impact
- Video Downloader: fully broken (calls /api/video/info which proxies to Render)
- AI writing tools: try Render first but fall back to direct provider calls — mostly unaffected
- PDF/Image tools: not affected (run in Next.js serverless functions)
- Resume file analysis (upload): broken if it tries Render

## Why
Free-tier Render instances spin down after 15 minutes of inactivity. The first request after spin-down triggers a cold start that can take 30-90 seconds. During this window all requests return 503.

**How to apply**: When debugging video downloader failures or job queue issues, check Render dashboard first.
