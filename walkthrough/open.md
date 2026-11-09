# Open the diff of a file

Double-click a row, or select it and press Enter.

| File | What you see |
|---|---|
| Text and code | The VS Code diff editor on the real files. You can edit and save. |
| .docx, .doc, .odt | Both documents as Markdown, side by side. |
| .xlsx, .xls, .ods, .csv, .parquet | Every sheet as CSV rows, side by side. |
| .pdf | The text of every page, side by side. |
| Anything else | Hex lines around every range of bytes that differs, with a count. |

The converters run in a separate thread with a time limit, so a broken or huge file shows a message instead of a hang.
