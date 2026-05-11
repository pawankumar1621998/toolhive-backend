---
name: ImageToolWorkspace Design Pattern
description: Three-state dashboard design for ImageToolWorkspace — idle upload zone, two-column editing view, results panel. Modeled after iloveimg.com.
type: project
---

ImageToolWorkspace was redesigned to a three-state dashboard pattern (inspired by iloveimg.com):

1. **Idle** — full-width dashed upload zone, teal "Select Images" button, `ImageIcon` in rounded square, drag-over scales the box
2. **Files selected** — `flex-col lg:flex-row` two-column layout: `flex-1` left grid of image thumbnail cards + `w-72 shrink-0` sticky right panel (ToolOptions + teal process button)
3. **Done** — header with `CheckCircle2`, responsive results grid of `ResultCard` components with `aspect-video` thumbnail + emerald Download button

**Why:** User wanted professional tool UI matching iloveimg/imgonline reference sites.

**How to apply:** Use this same three-state pattern for any future multi-image workspace. Keep `handleProcess` fetch logic untouched — only UI rendering changes.

Key implementation details:
- `FileWithPreview` interface pairs `File` with `previewUrl` (object URL)
- `URL.revokeObjectURL` called on remove, reset, and unmount cleanup effects
- `addFiles` uses functional updater to safely slice to `maxFiles` and revoke dropped URLs
- Checkerboard background (`repeating-conic-gradient`) on thumbnail areas to show transparency
- Processing overlay uses `backdrop-blur-sm` over the left panel only; right panel stays interactive
- Two `<input ref>` elements: `inputRef` for initial select (idle state), `addMoreRef` for "Add More" in selected state
- Error rendered inside the right options panel, not as a global banner
