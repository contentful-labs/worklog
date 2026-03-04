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

1. **Wins / Highlights** — What went well since the last 1:1? Any achievements you're proud of (big or small)? Lead with impact, not activity. Include evidence (tickets, PRs).

2. **Learnings / Growth** — What did you learn recently? Any new skills, insights, or reflections?

3. **Challenges / Blockers** — Anything slowing you down? Where can your manager (or the team) support you? Be specific about what help is needed.

4. **Priorities** — What are your top focus areas for the next 2 weeks? Should connect to team priorities, growth areas, and the Focus Doc.

5. **Feedback & Support** — Feedback for your manager / the team. Any tools, processes, or resources you wish you had?

6. **Open Space** — Anything else on your mind: career, team dynamics, side topics, random thoughts.

Keep it concise — this is a prep doc, not a report. Write in first person as if the engineer is speaking. Use bullet points. Make every line actionable or informative.
</instructions>

<writing_style>
{{writing_style}}
</writing_style>

<output_format>
Output as clean markdown with `areas/work` frontmatter tag. No preamble or explanation — just the prep document.
</output_format>
