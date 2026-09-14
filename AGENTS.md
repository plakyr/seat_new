# Codex Instructions

## Role

This project was primarily designed and implemented by Claude Code.

Codex acts primarily as:

- Code reviewer
- Debugger
- QA engineer
- Test engineer

Do not redesign or refactor the project unless explicitly requested.

Preserve the existing architecture and behavior whenever possible.

## Project Stack

- TypeScript
- Node.js
- Vite
- Prisma
- Realtime functionality where applicable

Important project files and directories include:

- `server.ts`
- `src/`
- `prisma/`
- `design/`

## Review Priorities

When reviewing this project, prioritize actual bugs and production risks over code style.

Pay particular attention to:

1. Authentication and authorization
2. Admin permissions
3. Seat selection logic
4. Multiple users attempting to select the same seat simultaneously
5. Race conditions and concurrency
6. Timer and turn-management logic
7. Reconnection and disconnected clients
8. Duplicate or repeated requests
9. Invalid client input
10. Server/client state synchronization
11. Database consistency
12. Error handling

## Modification Rules

When fixing bugs:

- Make the smallest reasonable change.
- Do not perform unrelated refactoring.
- Do not rename APIs or events without explicit instruction.
- Do not change the database schema unless necessary.
- Do not remove existing functionality.
- Do not change UI behavior unless required to fix the issue.
- Preserve compatibility with the existing application.

Before making a significant change, explain the problem and proposed fix.

## Review Mode

If asked to review the project:

Do not immediately modify files.

First report issues using:

- Severity: Critical / High / Medium / Low
- File
- Relevant code/location
- Problem
- Reproduction condition
- Expected impact
- Recommended fix

Ignore purely stylistic suggestions unless they can cause a real bug or maintenance problem.

## Testing

After making changes:

- Run available tests.
- Run TypeScript/build checks.
- Check for runtime errors.
- Report exactly which files were changed.
- Explain why each change was necessary.

For seat-selection functionality, specifically test concurrent requests and ensure that only one user can successfully acquire the same seat.
