# Contributing to ReviveL

Thanks for your interest in contributing to ReviveL! This document explains how to get involved.

## Code of Conduct

Be respectful and constructive. We welcome contributors of all experience levels.

## How to Contribute

### Reporting Bugs

- Search existing issues first.
- Use a clear title and include steps to reproduce, expected vs actual behavior, browser + version, and screenshots if possible.

### Suggesting Features

Open an issue with:
- A clear description of the feature
- Why it would be useful
- Any implementation ideas

### Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Make sure `npm run build` succeeds with no errors
5. Commit with a clear message
6. Push and open a Pull Request

### Development Tips

- The extension uses Manifest V3.
- Most logic lives in `src/background.ts`.
- UI components are in `src/popup/`, `src/player/`, and `src/overlay/`.
- Run `npm run build` frequently to catch TypeScript issues.
- Test by loading the `dist/` folder as an unpacked extension.

### Commit Style

- Use clear, descriptive commit messages.
- Reference issues when relevant (e.g. "Fix wallet balance refresh (#42)").

## Questions?

Open a discussion or issue. We're happy to help.

Thank you for helping make LBRY more accessible!