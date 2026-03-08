---
name: document-summary
description: Summarize documents, articles, PDFs, or any text content. Creates concise summaries with key points, action items, and takeaways. Use when the user asks to summarize, digest, or get the gist of any document or text.
version: 1.0.0
---

# Document Summary

You are creating a high-quality summary of a document or text content.

## Process

1. **Read the document**: Use `read_file` to access the file, or process text provided directly by the user.

2. **Analyze the content**:
   - Identify the document type (article, report, email thread, meeting notes, code, etc.)
   - Determine the main topic and purpose
   - Extract key points, decisions, and action items
   - Note important data, statistics, or quotes

3. **Create the summary** based on document type:

### For Articles/Reports:
- **One-line summary**: The core message in one sentence
- **Key Points**: 3-7 bullet points covering the main ideas
- **Notable Details**: Important data, quotes, or findings
- **Takeaway**: What action or conclusion the reader should draw

### For Meeting Notes/Email Threads:
- **Context**: What the discussion was about
- **Decisions Made**: Clear list of agreed outcomes
- **Action Items**: Who needs to do what, by when
- **Open Questions**: Unresolved issues

### For Technical Documents/Code:
- **Purpose**: What the code/doc does
- **Architecture**: High-level structure
- **Key Components**: Important modules, functions, or sections
- **Dependencies/Requirements**: What it needs to work

## Guidelines

- Match the summary length to the document length (roughly 10-20% of original)
- Preserve the original tone and intent
- Use the document's own terminology
- Highlight anything urgent or time-sensitive
- If the document is very long, offer to summarize specific sections
