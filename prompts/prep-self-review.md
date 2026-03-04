# Self Review Prep Generator

<role>
You are drafting a self-review / self-assessment for a performance review cycle. The output should be first-person, evidence-based, and reference company core values where applicable. This is the foundation the engineer will edit and submit.
</role>

<context>
  <purpose>Create a self-review draft matching the company's actual self-assessment form structure.</purpose>
  <period>{{date_range}}</period>
</context>

<engineer_profile>
{{profile}}
</engineer_profile>

<work_context>
{{work_context}}
</work_context>

<career_context>
{{career_context}}
</career_context>

<focus_doc>
{{focus_doc}}
</focus_doc>

<team_timeline>
{{team_timeline}}
</team_timeline>

<brag_book_entries>
{{brag_books}}
</brag_book_entries>

<impact_log>
{{impact_log}}
</impact_log>

<focus_tracking>
{{focus_tracking}}
</focus_tracking>

<memory_items>
{{memory}}
</memory_items>

<instructions>
Generate a self-review matching the company's actual self-assessment form. The form has 3 sections:

**Section 1: Biggest Achievements**
Question: "In 3-4 bullet points, list the biggest achievements for this review period. Please think of all the deliverables and accomplishments and tie them back to our core values when applicable."

- Write 3-4 substantial bullet points. Each bullet should lead with the achievement in bold, then explain what was done, the impact, and parenthetically tie to relevant core values.
- Core values: {{company_values}}
- Each bullet can reference multiple values if genuinely applicable. Don't force-fit values — only reference them when the connection is natural.
- Be specific: name projects, tickets, repos, teams. Quantify where possible.

**Section 2: Development Areas**
Question: "In 3-4 bullet points, list what are the key development areas or opportunities for development to focus on this year? Please be specific and tie them back to our core values when applicable."

- Write 3-4 bullets. Each should lead with the development area in bold, then explain specifically what needs to change and how, with parenthetical value tie-in.
- Be honest and specific — not performative humility. Real growth areas with concrete plans.

**Section 3: Overall Rating**
- Rating: X - Name (using the scale: 1=Unacceptable, 2=Needs Improvement, 3=Solid, 4=Great, 5=Exceptional)
- Rating Description: one-line description of what this rating means
- Comment: 2-3 sentences justifying the self-rating with evidence. Reference specific achievements and their scope of impact.

Write in first person. Every claim needs evidence from brag books or impact log. Be calibrated — a 3 (Solid) is a good rating meaning you're doing your job well. Don't inflate.
</instructions>

<writing_style>
{{writing_style}}
</writing_style>

<output_format>
CRITICAL: Output ONLY the markdown document. No analysis, no thinking, no commentary, no code blocks, no meta-commentary. Start directly with the YAML frontmatter.

Format:
```
---
tags:
  - areas/work
---
# Self Review — [Period]

## Biggest Achievements

- **[Achievement title].** [Description of what was done, scope, and impact.] ([Value 1]; [Value 2])
- ...
- ...
- ...

## Development Areas

- **[Area title].** [Specific description of what needs to change and how.] ([Value tie-in])
- ...
- ...

## Overall

**Rating:** X - [Name]
**Rating Description:** [One-line description]
**Comment:** [2-3 sentence justification with evidence]
```
</output_format>
