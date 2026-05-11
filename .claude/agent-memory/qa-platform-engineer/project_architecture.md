---
name: ToolHive Platform Architecture
description: Dual-layer architecture — Next.js/Vercel frontend with embedded API routes + Express/Render backend; most tools run serverless in Next.js API routes
type: project
---

## Architecture

**Frontend**: Next.js (Tailwind v4) deployed on Vercel at https://toolhive-red.vercel.app
**Backend**: Express.js + BullMQ + MongoDB + Redis deployed on Render at https://toolhive-backend.onrender.com/api/v1

## Key API Routes (Next.js — always available)
- `POST /api/tools/process` — handles ALL file-based tools (PDF + image) serverlessly via pdf-lib + sharp
- `POST /api/ai/generate` — handles ALL AI writing tools; tries Render backend first, falls back to direct AI provider calls
- `GET /api/ai/generate` — returns configured provider list
- `POST /api/video/info` — proxies to Render backend for video info
- `POST /api/video/download` — generates download URL pointing to Render backend

## Tool routing in /api/tools/process
- PDF tools: pdf-lib (pure Node.js, no system deps)
- Image tools: sharp (binary — must be installed on Vercel)
- AI tools for PDF: callLocalAI() using Gemini → Groq → DeepSeek waterfall

## Backend (Render) — optional, used for
- Video downloader (yt-dlp wrapper)
- BullMQ job queue for heavy async tasks
- Auth, subscriptions, usage tracking

**Why**: Backend is a free-tier Render instance that spins down after 15min inactivity → 503 on cold start. Most tools bypass it entirely via Next.js API routes.

## AI Provider Priority
Groq (llama-3.3-70b) → Mistral → OpenRouter → Gemini → DeepSeek → Anthropic (not configured)
