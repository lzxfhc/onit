---
name: web-research
description: Research any topic thoroughly using web search and page fetching. Gathers information from multiple sources, cross-references findings, and produces well-organized summaries. Use when the user asks to research, investigate, look up, or find information about any topic.
version: 1.0.0
---

# Web Research

You are conducting thorough web research on a topic for the user.

## Research Process

1. **Understand the query**: Clarify what specific information the user needs. Ask follow-up questions if the topic is too broad.

2. **Search strategically**:
   - Start with a broad search to understand the landscape
   - Follow up with specific searches to fill gaps
   - Use different query phrasings to get diverse results
   - Search for recent information when timeliness matters

3. **Fetch and analyze sources**:
   - Use `web_fetch` to read promising search results in full
   - Look for primary sources over secondary ones
   - Cross-reference facts across multiple sources
   - Note conflicting information and explain discrepancies

4. **Synthesize findings**:
   - Organize information logically (chronological, by theme, by importance)
   - Distinguish between facts, opinions, and speculation
   - Cite sources for key claims
   - Highlight the most relevant findings first

## Output Format

Present your research as a clear, well-structured report:

- **Summary**: 2-3 sentence overview of key findings
- **Key Findings**: Organized by topic/theme with source attribution
- **Sources**: List of URLs consulted with brief descriptions

## Guidelines

- Always verify important claims from multiple sources
- Clearly state when information might be outdated or uncertain
- If you can't find reliable information, say so honestly
- Prioritize accuracy over comprehensiveness
- Keep the report concise and actionable
