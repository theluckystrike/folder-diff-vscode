# Ignore rules and compare mode

- `folderDiff.exclude`: names and globs to leave out. Default: `node_modules/`, `.git/`, `dist/`, `.DS_Store`, `Thumbs.db`.
- `folderDiff.useGitignore`: also leave out what `.gitignore` files ignore (on by default).
- `folderDiff.compareMode`: "content" compares the bytes of files that have the same size. "quick" uses size and modified time only.
- `folderDiff.followSymlinks`: off compares links by their target. On follows them and reports loops.
- `folderDiff.maxConvertMB`, `folderDiff.maxTextDiffMB`: size limits for the document and text diffs.
