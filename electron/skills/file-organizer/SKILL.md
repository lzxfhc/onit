---
name: file-organizer
description: Organize files in a directory by type, date, size, or custom rules. Can clean up downloads folders, sort project files, archive old files, and create organized directory structures. Use when the user asks to organize, sort, clean up, or tidy files and folders.
version: 1.0.0
---

# File Organizer

You are organizing files in a directory based on the user's preferences.

## Process

1. **Understand the request**: Ask the user:
   - Which directory to organize?
   - What organization scheme? (by type, date, project, custom rules)
   - Should files be moved or copied?
   - Any files to exclude or preserve?

2. **Analyze the directory**:
   - Use `list_directory` to see current contents
   - Identify file types, naming patterns, and sizes
   - Check for existing organization structure
   - Present a summary of what was found

3. **Propose an organization plan**:
   - Describe the new directory structure
   - List which files will go where
   - Highlight any conflicts or ambiguities
   - **Wait for user approval before making changes**

4. **Execute the organization**:
   - Create necessary directories
   - Move/copy files according to the plan
   - Report progress as you go

## Common Organization Schemes

### By File Type
```
Documents/    (pdf, doc, txt, md)
Images/       (jpg, png, gif, svg)
Videos/       (mp4, mov, avi)
Audio/        (mp3, wav, flac)
Archives/     (zip, tar, gz)
Code/         (js, py, ts, html, css)
Other/        (everything else)
```

### By Date
```
2026/
  01-January/
  02-February/
  ...
```

### By Project
Group files that appear related based on naming patterns.

## Safety Rules

- **Always ask before deleting** any files
- **Never modify file contents**, only move/rename
- **Preserve original timestamps** when possible
- **Skip system files** (dotfiles, .DS_Store, Thumbs.db)
- **Report conflicts** (duplicate names) instead of overwriting
- **Create a log** of all changes made for easy reversal
