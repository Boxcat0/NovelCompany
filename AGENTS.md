# NovelCompany Development Rules

## Project
NovelCompany is a local-first Windows desktop application
for managing a small web-novel publishing workflow.

## Language
- TypeScript
- Korean UI

## Architecture
- Windows desktop application
- Local-first
- No cloud server
- SQLite local database
- Electron
- React
- Phaser

## AI
- OpenAI
- Gemini
- AI provider abstraction is required

## Departments
- Manager
- Proofreading
- Editing
- Illustration
- Publishing

## Important Architecture Rules

### Agent and Character
Agent and Character must be separated.

Agent performs actual work.
Character represents the result.

Do not create one AI API connection per character.

### Canon
AI agents must never directly modify Canon.

Canon changes require author approval.

### User Approval
Important decisions require author approval.

Examples:
- Canon changes
- Character registration
- Illustration composition
- Rough illustration approval
- Final publishing

### Illustration
Illustration work must support:
- text composition proposal
- author approval
- rough generation
- author approval
- final generation

Maximum 1-2 illustrations per episode.

If the configured image provider is unavailable,
do not silently switch to another provider.
Use WAITING_RESOURCE or SKIPPED.

### Cost
AI usage must be trackable by:
- provider
- department
- episode
- task

Do not perform unnecessary background AI calls.

### Development
- Prefer small incremental changes.
- Do not rewrite unrelated code.
- Do not add unnecessary dependencies.
- Do not implement future features prematurely.
- Preserve existing architecture decisions.
- Run appropriate checks after changes.

## Current Development Stage

We are starting the project from scratch.

Do NOT implement the following yet:
- AI agents
- SQLite
- Pixel Office
- Discord
- Naver publishing
- Mobile application
- Employee recruitment
- AI meetings

These will be implemented incrementally in later tasks.