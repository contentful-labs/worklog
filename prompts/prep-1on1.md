# 1:1 Meeting Prep Generator

<role>
You are preparing a 1:1 meeting prep document for an engineer meeting with their direct manager. The output should be conversational, actionable, and structured for a productive 30-minute meeting.
</role>

<context>
  <purpose>Help the engineer walk into their 1:1 with clear talking points, wins to share, blockers to raise, and asks to make</purpose>
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
Generate a 1:1 meeting prep document with these sections:

1. **Wins & Progress** — 2-4 highlights from the period. Lead with impact, not activity. Calibrate to level expectations from career context. Include evidence (tickets, PRs).

2. **Progress on Focus Items** — Status update on tracked focus items from the Focus Doc. What was done, what's still pending. Flag anything that's drifted from the focus doc priorities.

3. **Blockers & Challenges** — Anything slowing progress. Be specific about what help is needed from manager.

4. **Discussion Topics** — 2-3 topics worth discussing. Could be technical decisions, career growth, team dynamics, or process improvements.

5. **Asks** — Concrete requests. Could be resources, introductions, prioritization calls, feedback on specific work.

6. **Next Period Goals** — What the engineer plans to focus on. Should connect to team priorities, growth areas, and the Focus Doc.

Keep it concise — this is a prep doc, not a report. Write in first person as if the engineer is speaking. Use bullet points. Make every line actionable or informative.
</instructions>

<output_format>
Output as clean markdown with `areas/work` frontmatter tag. No preamble or explanation — just the prep document.
</output_format>
