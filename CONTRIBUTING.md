# Contributing to SubmitLog

We welcome contributions! Please follow these guidelines to help maintain code quality and project consistency.

## Prerequisites

- Node.js >= 22
- npm

## Setup Steps

1. Fork the repository.
2. Clone your fork locally: `git clone <your-fork-url>`
3. Navigate to the project directory: `cd submitlog`
4. Install dependencies: `npm install`

## Development Commands

- `npm run dev` - Start dev server (Chrome/Chromium)
- `npm run dev:firefox` - Start dev server (Firefox)
- `npm run build` - Build extension (Chrome)
- `npm run build:firefox` - Build extension (Firefox)
- `npm run test` - Run tests
- `npm run lint` - Lint code
- `npm run typecheck` - Check TypeScript types

## Code Standards

- **TypeScript:** Strict mode is enabled. Ensure all new code is strongly typed and passes `npm run typecheck` without errors.
- **ESLint & Prettier:** Code must adhere to the project's ESLint rules and Prettier formatting. Run `npm run lint` before submitting a PR.

## Pull Request Process

1. Create a new branch for your feature or bug fix: `git checkout -b feature/your-feature-name`.
2. Make your changes and commit them with descriptive messages.
3. Ensure all tests pass.
4. Push your branch to your fork.
5. Open a Pull Request against the `main` branch. Provide a clear description of the changes.

## Testing Expectations

- Write tests for new features and bug fixes.
- Ensure existing tests pass before submitting a PR.
