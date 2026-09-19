---
name: grok-brand-media
description: Prompt recipes for Grok image/video generation from Codex (OG images, README banners, launch clips)
user-invocable: true
---

# Grok brand & media recipes

Use with `grok_media kind=image` and `grok_media kind=video` (or companion `image` / `video` commands).

## Output conventions

- Images → `.grok-media/image/`
- Videos → `.grok-media/video/`
- Grok’s tools usually write under `~/.grok/sessions/…/images|videos/`. The companion **copies** finished assets into `.grok-media/` so the project path contract holds without needing shell/`write_file` (those stay denylisted).
- Video resolution is limited by Grok’s model tier (often **480p**); that is not a plugin bug.

## Image recipes

### README / GitHub social banner (16:9)
```text
grok_media kind=image aspect=16:9 prompt="Dark developer-tool banner for Grok in Codex. Minimal typography, abstract node graph, high contrast, no cluttered UI chrome, space for title text on the left."
```

### OG / link preview (1.91:1-ish → use 16:9)
```text
grok_media kind=image aspect=16:9 prompt="Open Graph image for a SaaS launch. Bold product name area, subtle grid background, one hero metaphor only."
```

### App icon concept (1:1)
```text
grok_media kind=image aspect=1:1 prompt="App icon concept, simple geometric mark, readable at 32px, flat with slight depth, no text."
```

### Edit existing asset
```text
grok_media kind=image edit=./assets/logo.png prompt="Make it monochrome, tighter padding, production-ready PNG"
```

## Video recipes

### Animate a still
```text
grok_media kind=video image=./.grok-media/image/hero.png duration=6 prompt="gentle camera push-in, soft parallax, premium product feel"
```

### Multi-reference cutdown
```text
grok_media kind=video refs=["shot1.png","shot2.png"] aspect=16:9 duration=6 prompt="product launch cutdown, clean transitions, no on-screen UI clutter"
```

## Prompt quality tips

- One primary subject
- Name the aspect ratio and destination (banner, icon, social)
- Say what to avoid (busy UI, tiny illegible text, watermark clutter)
- Prefer background for video: set `background: true`
- After background jobs finish, `grok_job action=result` lists project-local paths under `.grok-media/`
