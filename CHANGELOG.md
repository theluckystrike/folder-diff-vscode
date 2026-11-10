# Changelog

## 0.1.1

- New name: Folder Compare & Folder Diff (Directory Compare, Word, Excel & Binary Files).
- Three Zovo Pro tools, each with 3 free tries on your computer: Sync folders, Report of document changes, and Three-way compare and merge. A try counts only after the tool gave a result; Escape or Cancel keeps it. Comparing folders, every file diff, filters, copy, delete, export, Git compare and saved compares stay free.
- The Pro panel shows only when you click a Pro tool with no tries left. Nothing about Pro shows when a compare opens. The setting `folderDiff.showProTools` hides the three tools.
- Zovo Pro is USD 19 once, for every Zovo extension. Pay by card, with GitHub Sponsors or with PayPal, or enter a license key ("Zovo Pro" commands in the Command Palette).
- Delete never goes through a folder that is a symbolic link to somewhere outside the compared folder.
- Word and OpenDocument files that would unpack to more than 256 MB are refused before they are unpacked.
- The rating ask follows the shared v2.2 rules: in Cursor and other Open VSX editors, "Rate it" opens the Open VSX page.
- "More free viewers" now starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
- The walkthrough ends with a step that links free Zovo extensions for the files that often come with this one. A link opens the extension page; nothing installs on its own.
- The footer link "Zovo Pro, USD 19" and the Marketplace Sponsor button open the Zovo Pro tier (USD 19 once, for every Zovo extension) instead of the general GitHub Sponsors page.

## 0.1.0

- First release.
- Compare two folders with Left and Right panels, full paths, counts, filters and a progress line with Cancel.
- Content mode (bytes) and Quick mode (size and time). Ignore globs and .gitignore.
- Diff of any file: the VS Code diff editor for text, Markdown for Word and OpenDocument, CSV for Excel, CSV and Parquet, page text for PDF, hex ranges for binary files.
- Copy to left or right and Delete, each after a list of the files. Export as Markdown, CSV or HTML.
- Compare a folder with a Git branch, tag or commit.
- Folder sync with a preview plan, a report of document changes, three-way compare and merge, saved compares.
- Support links and related Zovo tools at the bottom of the view.
