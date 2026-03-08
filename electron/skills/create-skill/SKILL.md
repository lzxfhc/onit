---
name: create-skill
description: Guides you through creating a new Onit skill step by step. Use this when you want to create a custom skill, automate a workflow, or build a reusable template. Triggers on phrases like "create a skill", "make a skill", "new skill".
version: 1.0.0
---

# Create Skill

You are helping the user create a new Onit skill. A skill is a reusable set of instructions that can be invoked via @mention in chat.

## Skill File Format

Every skill is a `SKILL.md` file with YAML frontmatter:

```markdown
---
name: my-skill-name
description: What this skill does and when to use it
version: 1.0.0
---

# Skill Title

Instructions for the AI agent when this skill is activated...
```

## Required Fields

- **name**: Lowercase letters, numbers, and hyphens only. Max 64 characters. Example: `email-drafter`
- **description**: Clear description of WHAT the skill does and WHEN to use it. Max 1024 characters. This helps the agent decide when to apply the skill automatically.

## Creation Process

1. **Ask the user** what the skill should do. Get a clear understanding of:
   - What task does the skill automate?
   - When should it be triggered?
   - What inputs does it need?
   - What output should it produce?

2. **Design the skill** based on the user's requirements:
   - Choose a clear, descriptive name (lowercase-hyphenated)
   - Write a comprehensive description
   - Write clear, specific instructions

3. **Write the SKILL.md content** following best practices:
   - Keep instructions under 500 lines
   - Be specific and actionable
   - Include examples where helpful
   - Specify output format if important

4. **Save the skill** using the `write_file` tool to create the skill directory and SKILL.md file.

## Best Practices

- **Be specific**: "Generate a weekly report summarizing..." is better than "Make reports"
- **Include examples**: Show the expected input/output format
- **Define scope**: Clearly state what the skill does and doesn't do
- **Use templates**: If the output has a specific format, include a template
- **Error handling**: Describe what to do when information is missing or unclear
